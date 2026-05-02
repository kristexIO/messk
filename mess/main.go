package main

import (
	"bufio"
	"context"
	crypto_rand "crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	"github.com/redis/go-redis/v9"
	"github.com/rs/cors"
)

var (
	appVersion = "dev"
	commitSHA  = "unknown"
	buildTime  = "unknown"

	defaultRateLimiter = newIPRateLimiter(getRateLimitPerMinute, time.Minute)

	errInvalidProxyURL      = errors.New("invalid proxy url")
	errForbiddenProxyTarget = errors.New("forbidden proxy target")
)

const (
	maxGroupMembersPerCreate = 200
	maxProxyRedirects        = 5
)

func main() {
	// Load environment variables from .env file
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found, using system environment variables")
	}

	// Глобальный контекст для Graceful Shutdown
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Шаг 2: Инициализация базы данных SQLite и внутреннего кэша
	// Используем локальный файл messenger.db
	dbConnString := getDBPath()
	db := InitDB(ctx, dbConnString)
	defer db.Close()
	log.Println("SQLite database initialized.")

	// Инициализируем in-memory кэш
	cache := InitCache()
	defer cache.Close()
	log.Println("In-Memory Cache initialized.")

	// Инициализируем Redis для Pub/Sub (Point 29)
	redisAddr := os.Getenv("REDIS_ADDR")
	if redisAddr == "" {
		redisAddr = "127.0.0.1:6379"
	}
	rdb := redis.NewClient(&redis.Options{
		Addr: redisAddr,
	})

	// Проверяем подключение к Redis
	if err := rdb.Ping(context.Background()).Err(); err != nil {
		log.Printf("WARNING: Redis not found at localhost:6379. Horizontal scaling disabled. Error: %v", err)
		rdb = nil // Hub should handle nil rdb
	} else {
		log.Println("Redis client connected.")
	}

	// Передаем db, cache и rdb в Hub
	hub := NewHub(db, cache, rdb)
	go hub.Run()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWs(hub, w, r, ctx)
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		healthCtx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()

		dbStatus := "ok"
		if err := db.Ping(healthCtx); err != nil {
			dbStatus = "error"
		}

		redisStatus := "disabled"
		if rdb != nil {
			if err := rdb.Ping(healthCtx).Err(); err != nil {
				redisStatus = "error"
			} else {
				redisStatus = "ok"
			}
		}

		overallStatus := "ok"
		statusCode := http.StatusOK
		if dbStatus != "ok" {
			overallStatus = "error"
			statusCode = http.StatusServiceUnavailable
		} else if redisStatus == "error" {
			overallStatus = "degraded"
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(statusCode)
		json.NewEncoder(w).Encode(map[string]any{
			"status": overallStatus,
			"services": map[string]string{
				"database": dbStatus,
				"cache":    "ok",
				"redis":    redisStatus,
			},
			"time": time.Now().UTC().Format(time.RFC3339),
		})
	})
	mux.HandleFunc("/version", versionHandler)
	registerSessionRoutes(mux, hub)
	registerProfileRoutes(mux, hub, db)
	mux.HandleFunc("/groups", rateLimit(func(w http.ResponseWriter, r *http.Request) {
		pubKey, ok := authorizeSession(hub, w, r)
		if !ok {
			return
		}

		switch r.Method {
		case http.MethodGet:
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()

			groups, err := db.ListGroupsForUser(ctx, pubKey)
			if err != nil {
				http.Error(w, "Failed to load groups", http.StatusInternalServerError)
				return
			}

			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"groups": groups})
		case http.MethodPost:
			var payload struct {
				Title   string   `json:"title"`
				Avatar  string   `json:"avatar"`
				Members []string `json:"members"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload); err != nil {
				http.Error(w, "Bad request", http.StatusBadRequest)
				return
			}
			if strings.TrimSpace(payload.Title) == "" {
				http.Error(w, "Missing title", http.StatusBadRequest)
				return
			}
			members, err := sanitizeMemberPubKeys(payload.Members, pubKey)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}

			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			groupID, err := newEntityID("grp")
			if err != nil {
				http.Error(w, "Internal error", http.StatusInternalServerError)
				return
			}
			if err := db.CreateGroup(ctx, groupID, payload.Title, payload.Avatar, pubKey, members); err != nil {
				http.Error(w, "Failed to create group", http.StatusInternalServerError)
				return
			}
			if err := dispatchGroupInvites(ctx, hub, db, groupID, pubKey, members); err != nil {
				log.Printf("Failed to dispatch group invites for %s: %v", groupID, err)
			}

			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]string{"id": groupID})
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	}))
	mux.HandleFunc("/groups/", rateLimit(func(w http.ResponseWriter, r *http.Request) {
		pubKey, ok := authorizeSession(hub, w, r)
		if !ok {
			return
		}

		trimmed := strings.Trim(strings.TrimPrefix(r.URL.Path, "/groups/"), "/")
		parts := strings.Split(trimmed, "/")
		if len(parts) == 0 || parts[0] == "" || len(parts) > 2 {
			http.NotFound(w, r)
			return
		}
		groupID := parts[0]
		tail := ""
		if len(parts) == 2 {
			tail = parts[1]
		}

		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		role, err := db.GetGroupMemberRole(ctx, groupID, pubKey)
		if err == sql.ErrNoRows {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		if err != nil {
			http.Error(w, "Internal error", http.StatusInternalServerError)
			return
		}

		if tail == "" {
			switch r.Method {
			case http.MethodPatch:
				if role != "owner" {
					http.Error(w, "Forbidden", http.StatusForbidden)
					return
				}
				var payload struct {
					NewOwnerPubKey string `json:"newOwnerPubKey"`
				}
				if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload); err != nil {
					http.Error(w, "Bad request", http.StatusBadRequest)
					return
				}
				payload.NewOwnerPubKey = strings.TrimSpace(payload.NewOwnerPubKey)
				if !isValidPublicKey(payload.NewOwnerPubKey) || payload.NewOwnerPubKey == pubKey {
					http.Error(w, "Invalid new owner", http.StatusBadRequest)
					return
				}
				targetRole, err := db.GetGroupMemberRole(ctx, groupID, payload.NewOwnerPubKey)
				if err == sql.ErrNoRows {
					http.Error(w, "Member not found", http.StatusNotFound)
					return
				}
				if err != nil {
					http.Error(w, "Internal error", http.StatusInternalServerError)
					return
				}
				if targetRole == "owner" {
					http.Error(w, "Already owner", http.StatusBadRequest)
					return
				}
				if err := db.TransferGroupOwnership(ctx, groupID, pubKey, payload.NewOwnerPubKey); err != nil {
					http.Error(w, "Failed to transfer ownership", http.StatusInternalServerError)
					return
				}
				logModerationAuditAsync(db, "group", groupID, pubKey, "ownership_transferred", payload.NewOwnerPubKey, "")
				w.WriteHeader(http.StatusNoContent)
			case http.MethodDelete:
				if role == "owner" {
					if err := db.DeleteGroup(ctx, groupID, pubKey); err != nil {
						http.Error(w, "Failed to delete group", http.StatusInternalServerError)
						return
					}
				} else {
					if err := db.RemoveGroupMember(ctx, groupID, pubKey); err != nil {
						http.Error(w, "Failed to leave group", http.StatusInternalServerError)
						return
					}
				}
				w.WriteHeader(http.StatusNoContent)
			default:
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			}
			return
		}

		if tail == "settings" {
			if r.Method != http.MethodPatch {
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}
			if role != "owner" && role != "admin" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			var payload struct {
				Title  string `json:"title"`
				Avatar string `json:"avatar"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload); err != nil {
				http.Error(w, "Bad request", http.StatusBadRequest)
				return
			}
			payload.Title = strings.TrimSpace(payload.Title)
			if payload.Title == "" {
				http.Error(w, "Missing title", http.StatusBadRequest)
				return
			}
			if err := db.UpdateGroupMeta(ctx, groupID, payload.Title, payload.Avatar); err != nil {
				http.Error(w, "Failed to update group settings", http.StatusInternalServerError)
				return
			}
			logModerationAuditAsync(db, "group", groupID, pubKey, "group_settings_updated", "", payload.Title)
			w.WriteHeader(http.StatusNoContent)
			return
		}

		if tail == "audit" {
			if r.Method != http.MethodGet {
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}
			if role != "owner" && role != "admin" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			entries, err := db.ListModerationAudit(ctx, "group", groupID, 200)
			if err != nil {
				http.Error(w, "Failed to load audit log", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"entries": entries})
			return
		}

		if tail != "members" {
			http.NotFound(w, r)
			return
		}

		switch r.Method {
		case http.MethodGet:
			if role != "owner" && role != "admin" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			members, err := db.ListGroupMembers(ctx, groupID)
			if err != nil {
				http.Error(w, "Failed to load members", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"members": members})
		case http.MethodPost:
			if role != "owner" && role != "admin" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			var payload struct {
				PubKey string `json:"pubKey"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload); err != nil {
				http.Error(w, "Bad request", http.StatusBadRequest)
				return
			}
			payload.PubKey = strings.TrimSpace(payload.PubKey)
			if !isValidPublicKey(payload.PubKey) {
				http.Error(w, "Invalid pubKey", http.StatusBadRequest)
				return
			}
			if err := db.SaveUserIfNotExists(ctx, payload.PubKey); err != nil {
				http.Error(w, "Failed to ensure user", http.StatusInternalServerError)
				return
			}
			if err := db.AddGroupMember(ctx, groupID, payload.PubKey); err != nil {
				http.Error(w, "Failed to add member", http.StatusInternalServerError)
				return
			}
			if err := dispatchGroupInvites(ctx, hub, db, groupID, pubKey, []string{payload.PubKey}); err != nil {
				log.Printf("Failed to dispatch group invite for %s -> %s: %v", groupID, payload.PubKey, err)
			}
			w.WriteHeader(http.StatusNoContent)
		case http.MethodPatch:
			if role != "owner" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			var payload struct {
				PubKey string `json:"pubKey"`
				Role   string `json:"role"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload); err != nil {
				http.Error(w, "Bad request", http.StatusBadRequest)
				return
			}
			payload.PubKey = strings.TrimSpace(payload.PubKey)
			payload.Role = strings.TrimSpace(payload.Role)
			if !isValidPublicKey(payload.PubKey) {
				http.Error(w, "Invalid pubKey", http.StatusBadRequest)
				return
			}
			if payload.PubKey == pubKey {
				http.Error(w, "Owner role cannot be changed here", http.StatusBadRequest)
				return
			}
			if payload.Role != "admin" && payload.Role != "member" {
				http.Error(w, "Invalid role", http.StatusBadRequest)
				return
			}
			targetRole, err := db.GetGroupMemberRole(ctx, groupID, payload.PubKey)
			if err == sql.ErrNoRows {
				http.Error(w, "Member not found", http.StatusNotFound)
				return
			}
			if err != nil {
				http.Error(w, "Internal error", http.StatusInternalServerError)
				return
			}
			if targetRole == "owner" {
				http.Error(w, "Cannot change owner role", http.StatusBadRequest)
				return
			}
			if err := db.UpdateGroupMemberRole(ctx, groupID, payload.PubKey, payload.Role); err != nil {
				http.Error(w, "Failed to update member role", http.StatusInternalServerError)
				return
			}
			logModerationAuditAsync(db, "group", groupID, pubKey, "member_role_changed", payload.PubKey, payload.Role)
			w.WriteHeader(http.StatusNoContent)
		case http.MethodDelete:
			targetPubKey := strings.TrimSpace(r.URL.Query().Get("pubKey"))
			if !isValidPublicKey(targetPubKey) {
				http.Error(w, "Invalid pubKey", http.StatusBadRequest)
				return
			}
			targetRole, err := db.GetGroupMemberRole(ctx, groupID, targetPubKey)
			if err == sql.ErrNoRows {
				http.Error(w, "Member not found", http.StatusNotFound)
				return
			}
			if err != nil {
				http.Error(w, "Internal error", http.StatusInternalServerError)
				return
			}
			if targetRole == "owner" {
				http.Error(w, "Cannot remove owner", http.StatusBadRequest)
				return
			}
			if role == "admin" && targetRole != "member" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			if role != "owner" && role != "admin" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			if err := db.RemoveGroupMember(ctx, groupID, targetPubKey); err != nil {
				http.Error(w, "Failed to remove member", http.StatusInternalServerError)
				return
			}
			logModerationAuditAsync(db, "group", groupID, pubKey, "member_removed", targetPubKey, "")
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	}))
	mux.HandleFunc("/channels", rateLimit(func(w http.ResponseWriter, r *http.Request) {
		pubKey, ok := authorizeSession(hub, w, r)
		if !ok {
			return
		}

		switch r.Method {
		case http.MethodGet:
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()

			channels, err := db.ListChannelsForUser(ctx, pubKey)
			if err != nil {
				http.Error(w, "Failed to load channels", http.StatusInternalServerError)
				return
			}

			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"channels": channels})
		case http.MethodPost:
			var payload struct {
				Title  string `json:"title"`
				Avatar string `json:"avatar"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload); err != nil {
				http.Error(w, "Bad request", http.StatusBadRequest)
				return
			}
			if strings.TrimSpace(payload.Title) == "" {
				http.Error(w, "Missing title", http.StatusBadRequest)
				return
			}

			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			channelID, err := newEntityID("chn")
			if err != nil {
				http.Error(w, "Internal error", http.StatusInternalServerError)
				return
			}
			if err := db.CreateChannel(ctx, channelID, payload.Title, payload.Avatar, pubKey); err != nil {
				http.Error(w, "Failed to create channel", http.StatusInternalServerError)
				return
			}

			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]string{"id": channelID})
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	}))
	mux.HandleFunc("/channels/", rateLimit(func(w http.ResponseWriter, r *http.Request) {
		pubKey, ok := authorizeSession(hub, w, r)
		if !ok {
			return
		}

		trimmed := strings.Trim(strings.TrimPrefix(r.URL.Path, "/channels/"), "/")
		parts := strings.Split(trimmed, "/")
		if len(parts) == 0 || parts[0] == "" || len(parts) > 2 {
			http.NotFound(w, r)
			return
		}
		channelID := parts[0]
		tail := ""
		if len(parts) == 2 {
			tail = parts[1]
		}

		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		role, err := db.GetChannelSubscriberRole(ctx, channelID, pubKey)
		if err == sql.ErrNoRows {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		if err != nil {
			http.Error(w, "Internal error", http.StatusInternalServerError)
			return
		}

		if tail == "" {
			switch r.Method {
			case http.MethodPatch:
				if role != "owner" {
					http.Error(w, "Forbidden", http.StatusForbidden)
					return
				}
				var payload struct {
					NewOwnerPubKey string `json:"newOwnerPubKey"`
				}
				if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload); err != nil {
					http.Error(w, "Bad request", http.StatusBadRequest)
					return
				}
				payload.NewOwnerPubKey = strings.TrimSpace(payload.NewOwnerPubKey)
				if !isValidPublicKey(payload.NewOwnerPubKey) || payload.NewOwnerPubKey == pubKey {
					http.Error(w, "Invalid new owner", http.StatusBadRequest)
					return
				}
				targetRole, err := db.GetChannelSubscriberRole(ctx, channelID, payload.NewOwnerPubKey)
				if err == sql.ErrNoRows {
					http.Error(w, "Subscriber not found", http.StatusNotFound)
					return
				}
				if err != nil {
					http.Error(w, "Internal error", http.StatusInternalServerError)
					return
				}
				if targetRole == "owner" {
					http.Error(w, "Already owner", http.StatusBadRequest)
					return
				}
				if err := db.TransferChannelOwnership(ctx, channelID, pubKey, payload.NewOwnerPubKey); err != nil {
					http.Error(w, "Failed to transfer ownership", http.StatusInternalServerError)
					return
				}
				logModerationAuditAsync(db, "channel", channelID, pubKey, "ownership_transferred", payload.NewOwnerPubKey, "")
				w.WriteHeader(http.StatusNoContent)
			case http.MethodDelete:
				if role == "owner" {
					if err := db.DeleteChannel(ctx, channelID, pubKey); err != nil {
						http.Error(w, "Failed to delete channel", http.StatusInternalServerError)
						return
					}
				} else {
					if err := db.RemoveChannelSubscriber(ctx, channelID, pubKey); err != nil {
						http.Error(w, "Failed to leave channel", http.StatusInternalServerError)
						return
					}
				}
				w.WriteHeader(http.StatusNoContent)
			default:
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			}
			return
		}

		if tail == "settings" {
			if r.Method != http.MethodPatch {
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}
			if role != "owner" && role != "admin" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			var payload struct {
				Title  string `json:"title"`
				Avatar string `json:"avatar"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload); err != nil {
				http.Error(w, "Bad request", http.StatusBadRequest)
				return
			}
			payload.Title = strings.TrimSpace(payload.Title)
			if payload.Title == "" {
				http.Error(w, "Missing title", http.StatusBadRequest)
				return
			}
			if err := db.UpdateChannelMeta(ctx, channelID, payload.Title, payload.Avatar); err != nil {
				http.Error(w, "Failed to update channel settings", http.StatusInternalServerError)
				return
			}
			logModerationAuditAsync(db, "channel", channelID, pubKey, "channel_settings_updated", "", payload.Title)
			w.WriteHeader(http.StatusNoContent)
			return
		}

		if tail == "audit" {
			if r.Method != http.MethodGet {
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}
			if role != "owner" && role != "admin" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			entries, err := db.ListModerationAudit(ctx, "channel", channelID, 200)
			if err != nil {
				http.Error(w, "Failed to load audit log", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"entries": entries})
			return
		}

		if tail != "subscribers" {
			http.NotFound(w, r)
			return
		}

		switch r.Method {
		case http.MethodGet:
			if role != "owner" && role != "admin" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			subscribers, err := db.ListChannelSubscribers(ctx, channelID)
			if err != nil {
				http.Error(w, "Failed to load subscribers", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"subscribers": subscribers})
		case http.MethodPost:
			if role != "owner" && role != "admin" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			var payload struct {
				PubKey string `json:"pubKey"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload); err != nil {
				http.Error(w, "Bad request", http.StatusBadRequest)
				return
			}
			payload.PubKey = strings.TrimSpace(payload.PubKey)
			if !isValidPublicKey(payload.PubKey) {
				http.Error(w, "Invalid pubKey", http.StatusBadRequest)
				return
			}
			if err := db.SaveUserIfNotExists(ctx, payload.PubKey); err != nil {
				http.Error(w, "Failed to ensure user", http.StatusInternalServerError)
				return
			}
			if err := db.AddChannelSubscriber(ctx, channelID, payload.PubKey); err != nil {
				http.Error(w, "Failed to add subscriber", http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		case http.MethodPatch:
			if role != "owner" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			var payload struct {
				PubKey string `json:"pubKey"`
				Role   string `json:"role"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload); err != nil {
				http.Error(w, "Bad request", http.StatusBadRequest)
				return
			}
			payload.PubKey = strings.TrimSpace(payload.PubKey)
			payload.Role = strings.TrimSpace(payload.Role)
			if !isValidPublicKey(payload.PubKey) {
				http.Error(w, "Invalid pubKey", http.StatusBadRequest)
				return
			}
			if payload.PubKey == pubKey {
				http.Error(w, "Owner role cannot be changed here", http.StatusBadRequest)
				return
			}
			if payload.Role != "admin" && payload.Role != "poster" && payload.Role != "subscriber" {
				http.Error(w, "Invalid role", http.StatusBadRequest)
				return
			}
			targetRole, err := db.GetChannelSubscriberRole(ctx, channelID, payload.PubKey)
			if err == sql.ErrNoRows {
				http.Error(w, "Subscriber not found", http.StatusNotFound)
				return
			}
			if err != nil {
				http.Error(w, "Internal error", http.StatusInternalServerError)
				return
			}
			if targetRole == "owner" {
				http.Error(w, "Cannot change owner role", http.StatusBadRequest)
				return
			}
			if err := db.UpdateChannelSubscriberRole(ctx, channelID, payload.PubKey, payload.Role); err != nil {
				http.Error(w, "Failed to update subscriber role", http.StatusInternalServerError)
				return
			}
			logModerationAuditAsync(db, "channel", channelID, pubKey, "subscriber_role_changed", payload.PubKey, payload.Role)
			w.WriteHeader(http.StatusNoContent)
		case http.MethodDelete:
			targetPubKey := strings.TrimSpace(r.URL.Query().Get("pubKey"))
			if !isValidPublicKey(targetPubKey) {
				http.Error(w, "Invalid pubKey", http.StatusBadRequest)
				return
			}
			targetRole, err := db.GetChannelSubscriberRole(ctx, channelID, targetPubKey)
			if err == sql.ErrNoRows {
				http.Error(w, "Subscriber not found", http.StatusNotFound)
				return
			}
			if err != nil {
				http.Error(w, "Internal error", http.StatusInternalServerError)
				return
			}
			if targetRole == "owner" {
				http.Error(w, "Cannot remove owner", http.StatusBadRequest)
				return
			}
			if role != "owner" && role != "admin" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			if role == "admin" && targetRole != "subscriber" && targetRole != "poster" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			if err := db.RemoveChannelSubscriber(ctx, channelID, targetPubKey); err != nil {
				http.Error(w, "Failed to remove subscriber", http.StatusInternalServerError)
				return
			}
			logModerationAuditAsync(db, "channel", channelID, pubKey, "subscriber_removed", targetPubKey, "")
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	}))
	mux.HandleFunc("/group-invite-links", rateLimit(func(w http.ResponseWriter, r *http.Request) {
		pubKey, ok := authorizeSession(hub, w, r)
		if !ok {
			return
		}
		switch r.Method {
		case http.MethodPost:
			var payload struct {
				GroupID    string `json:"groupId"`
				TTLMinutes int    `json:"ttlMinutes"`
				MaxUses    int    `json:"maxUses"`
				Password   string `json:"password"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload); err != nil {
				http.Error(w, "Bad request", http.StatusBadRequest)
				return
			}
			payload.GroupID = strings.TrimSpace(payload.GroupID)
			if payload.GroupID == "" {
				http.Error(w, "Missing groupId", http.StatusBadRequest)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			role, err := db.GetGroupMemberRole(ctx, payload.GroupID, pubKey)
			if err == sql.ErrNoRows {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			if err != nil {
				http.Error(w, "Internal error", http.StatusInternalServerError)
				return
			}
			if role != "owner" && role != "admin" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			var expiresAt *time.Time
			if payload.TTLMinutes > 0 {
				t := time.Now().Add(time.Duration(payload.TTLMinutes) * time.Minute)
				expiresAt = &t
			}
			var maxUses *int
			if payload.MaxUses > 0 {
				maxUses = &payload.MaxUses
			}
			token, err := db.CreateGroupInviteLink(ctx, payload.GroupID, pubKey, expiresAt, maxUses, payload.Password)
			if err != nil {
				http.Error(w, "Failed to create invite link", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"token": token})
		case http.MethodGet:
			groupID := strings.TrimSpace(r.URL.Query().Get("groupId"))
			if groupID == "" {
				http.Error(w, "Missing groupId", http.StatusBadRequest)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			role, err := db.GetGroupMemberRole(ctx, groupID, pubKey)
			if err == sql.ErrNoRows || role == "" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			if err != nil {
				http.Error(w, "Internal error", http.StatusInternalServerError)
				return
			}
			if role != "owner" && role != "admin" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			links, err := db.ListGroupInviteLinks(ctx, groupID)
			if err != nil {
				http.Error(w, "Failed to list invite links", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"links": links})
		case http.MethodDelete:
			groupID := strings.TrimSpace(r.URL.Query().Get("groupId"))
			token := strings.TrimSpace(r.URL.Query().Get("token"))
			if groupID == "" || token == "" {
				http.Error(w, "Missing groupId or token", http.StatusBadRequest)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			role, err := db.GetGroupMemberRole(ctx, groupID, pubKey)
			if err == sql.ErrNoRows || role == "" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			if err != nil {
				http.Error(w, "Internal error", http.StatusInternalServerError)
				return
			}
			if role != "owner" && role != "admin" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			if err := db.RevokeGroupInviteLink(ctx, groupID, token); err != nil {
				http.Error(w, "Failed to revoke invite link", http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	}))
	mux.HandleFunc("/channel-invite-links", rateLimit(func(w http.ResponseWriter, r *http.Request) {
		pubKey, ok := authorizeSession(hub, w, r)
		if !ok {
			return
		}
		switch r.Method {
		case http.MethodPost:
			var payload struct {
				ChannelID  string `json:"channelId"`
				TTLMinutes int    `json:"ttlMinutes"`
				MaxUses    int    `json:"maxUses"`
				Password   string `json:"password"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload); err != nil {
				http.Error(w, "Bad request", http.StatusBadRequest)
				return
			}
			payload.ChannelID = strings.TrimSpace(payload.ChannelID)
			if payload.ChannelID == "" {
				http.Error(w, "Missing channelId", http.StatusBadRequest)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			role, err := db.GetChannelSubscriberRole(ctx, payload.ChannelID, pubKey)
			if err == sql.ErrNoRows {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			if err != nil {
				http.Error(w, "Internal error", http.StatusInternalServerError)
				return
			}
			if role != "owner" && role != "admin" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			var expiresAt *time.Time
			if payload.TTLMinutes > 0 {
				t := time.Now().Add(time.Duration(payload.TTLMinutes) * time.Minute)
				expiresAt = &t
			}
			var maxUses *int
			if payload.MaxUses > 0 {
				maxUses = &payload.MaxUses
			}
			token, err := db.CreateChannelInviteLink(ctx, payload.ChannelID, pubKey, expiresAt, maxUses, payload.Password)
			if err != nil {
				http.Error(w, "Failed to create invite link", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"token": token})
		case http.MethodGet:
			channelID := strings.TrimSpace(r.URL.Query().Get("channelId"))
			if channelID == "" {
				http.Error(w, "Missing channelId", http.StatusBadRequest)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			role, err := db.GetChannelSubscriberRole(ctx, channelID, pubKey)
			if err == sql.ErrNoRows || role == "" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			if err != nil {
				http.Error(w, "Internal error", http.StatusInternalServerError)
				return
			}
			if role != "owner" && role != "admin" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			links, err := db.ListChannelInviteLinks(ctx, channelID)
			if err != nil {
				http.Error(w, "Failed to list invite links", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"links": links})
		case http.MethodDelete:
			channelID := strings.TrimSpace(r.URL.Query().Get("channelId"))
			token := strings.TrimSpace(r.URL.Query().Get("token"))
			if channelID == "" || token == "" {
				http.Error(w, "Missing channelId or token", http.StatusBadRequest)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			role, err := db.GetChannelSubscriberRole(ctx, channelID, pubKey)
			if err == sql.ErrNoRows || role == "" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			if err != nil {
				http.Error(w, "Internal error", http.StatusInternalServerError)
				return
			}
			if role != "owner" && role != "admin" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			if err := db.RevokeChannelInviteLink(ctx, channelID, token); err != nil {
				http.Error(w, "Failed to revoke invite link", http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	}))
	mux.HandleFunc("/invite-links/join", rateLimit(func(w http.ResponseWriter, r *http.Request) {
		pubKey, ok := authorizeSession(hub, w, r)
		if !ok {
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var payload struct {
			Token    string `json:"token"`
			Password string `json:"password"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload); err != nil {
			http.Error(w, "Bad request", http.StatusBadRequest)
			return
		}
		payload.Token = strings.TrimSpace(payload.Token)
		if payload.Token == "" {
			http.Error(w, "Missing token", http.StatusBadRequest)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		if err := db.SaveUserIfNotExists(ctx, pubKey); err != nil {
			http.Error(w, "Failed to ensure user", http.StatusInternalServerError)
			return
		}

		if groupID, err := db.JoinGroupByInviteToken(ctx, payload.Token, pubKey, payload.Password); err == nil {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{
				"entityType": "group",
				"entityId":   groupID,
			})
			return
		} else if err != sql.ErrNoRows {
			switch err {
			case ErrInviteRevoked:
				http.Error(w, "Invite link revoked", http.StatusGone)
			case ErrInviteExpired:
				http.Error(w, "Invite link expired", http.StatusGone)
			case ErrInviteUsageLimit:
				http.Error(w, "Invite link usage limit reached", http.StatusGone)
			case ErrInvitePasswordRequired:
				http.Error(w, "Invite password required", http.StatusUnauthorized)
			case ErrInvitePasswordInvalid:
				http.Error(w, "Invite password invalid", http.StatusForbidden)
			default:
				http.Error(w, "Failed to join invite", http.StatusInternalServerError)
			}
			return
		}

		channelID, err := db.JoinChannelByInviteToken(ctx, payload.Token, pubKey, payload.Password)
		if err == sql.ErrNoRows {
			http.Error(w, "Invite link not found", http.StatusNotFound)
			return
		}
		if err != nil {
			switch err {
			case ErrInviteRevoked:
				http.Error(w, "Invite link revoked", http.StatusGone)
			case ErrInviteExpired:
				http.Error(w, "Invite link expired", http.StatusGone)
			case ErrInviteUsageLimit:
				http.Error(w, "Invite link usage limit reached", http.StatusGone)
			case ErrInvitePasswordRequired:
				http.Error(w, "Invite password required", http.StatusUnauthorized)
			case ErrInvitePasswordInvalid:
				http.Error(w, "Invite password invalid", http.StatusForbidden)
			default:
				http.Error(w, "Failed to join invite", http.StatusInternalServerError)
			}
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"entityType": "channel",
			"entityId":   channelID,
		})
	}))

	// CORS Middleware
	c := cors.New(cors.Options{
		AllowedOrigins:   getAllowedOrigins(),
		AllowCredentials: true,
		AllowedMethods:   []string{"GET", "POST", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
	})
	handler := requestLoggingMiddleware(securityHeadersMiddleware(c.Handler(mux)))

	// Эндпоинты для файлов
	uploadDir := getUploadDir()
	if err := os.MkdirAll(uploadDir, 0700); err != nil {
		log.Fatalf("Failed to create upload directory: %v", err)
	}
	registerFileRoutes(mux, hub, db)
	registerProxyRoutes(mux)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       2 * time.Minute,
		WriteTimeout:      2 * time.Minute,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    1 << 20,
	}

	// Канал для перехвата сигналов ОС
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-quit
		log.Println("Received shutdown signal. Initiating graceful shutdown...")

		// 1. Отмена глобального контекста останавливает все горутины клиентов
		cancel()

		// 2. Остановка HTTP-сервера с таймаутом
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()

		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Fatalf("HTTP Server Shutdown Error: %v", err)
		}
	}()

	log.Printf("E2EE Messenger server started on :%s\n", port)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("HTTP server ListenAndServe: %v", err)
	}

	log.Println("Server gracefully stopped.")
}

func requestLoggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := fmt.Sprintf("%d", time.Now().UnixNano())
		startedAt := time.Now()
		remoteAddr := r.RemoteAddr
		recorder := &statusRecorder{
			ResponseWriter: w,
			statusCode:     http.StatusOK,
		}
		logEvent("request_start", map[string]any{
			"id":     requestID,
			"method": r.Method,
			"path":   r.URL.Path,
			"remote": remoteAddr,
		})
		next.ServeHTTP(recorder, r)
		logEvent("request_end", map[string]any{
			"id":          requestID,
			"method":      r.Method,
			"path":        r.URL.Path,
			"status":      recorder.statusCode,
			"duration_ms": time.Since(startedAt).Milliseconds(),
		})
	})
}

func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()")
		if r.TLS != nil {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

func versionHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"version": appVersion,
		"commit":  commitSHA,
		"builtAt": buildTime,
	})
}

func dispatchGroupInvites(ctx context.Context, hub *Hub, db *DB, groupID, inviterPubKey string, recipients []string) error {
	if hub == nil || db == nil || groupID == "" || inviterPubKey == "" {
		return nil
	}

	memberRecords, err := db.ListGroupMembers(ctx, groupID)
	if err != nil {
		return err
	}
	memberCount := len(memberRecords)
	rolesByPubKey := make(map[string]string, len(memberRecords))
	for _, member := range memberRecords {
		rolesByPubKey[member.MemberPubKey] = member.Role
	}

	seen := map[string]struct{}{}
	for _, recipientPubKey := range recipients {
		recipientPubKey = strings.TrimSpace(recipientPubKey)
		if recipientPubKey == "" || recipientPubKey == inviterPubKey {
			continue
		}
		if _, exists := seen[recipientPubKey]; exists {
			continue
		}
		seen[recipientPubKey] = struct{}{}

		group, err := db.GetGroupForUser(ctx, groupID, recipientPubKey)
		if err != nil {
			if err != sql.ErrNoRows {
				log.Printf("Failed to load group %s for invitee %s: %v", groupID, recipientPubKey, err)
			}
			continue
		}

		payloadJSON, err := json.Marshal(groupInvitePayload{
			GroupID:     group.ID,
			Title:       group.Title,
			Avatar:      group.Avatar,
			Role:        firstNonEmpty(group.Role, rolesByPubKey[recipientPubKey], "member"),
			MemberCount: memberCount,
		})
		if err != nil {
			return err
		}
		encodedPayload, err := json.Marshal(string(payloadJSON))
		if err != nil {
			return err
		}
		msgID, err := newEntityID("ginv")
		if err != nil {
			return err
		}

		envelopeJSON, err := json.Marshal(Envelope{
			Type:            "group_invite",
			MsgID:           msgID,
			RecipientPubKey: recipientPubKey,
			GroupID:         group.ID,
			SenderPubKey:    inviterPubKey,
			Data:            encodedPayload,
		})
		if err != nil {
			return err
		}

		hub.NotifyUser(&Message{
			Type:            "group_invite",
			SenderPubKey:    inviterPubKey,
			RecipientPubKey: recipientPubKey,
			Payload:         envelopeJSON,
		})
	}

	return nil
}

func newEntityID(prefix string) (string, error) {
	randomBytes := make([]byte, 12)
	if _, err := crypto_rand.Read(randomBytes); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s_%x", prefix, randomBytes), nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func splitScopedPath(path, prefix string) (string, string, bool) {
	trimmed := strings.TrimPrefix(path, prefix)
	if trimmed == path || trimmed == "" {
		return "", "", false
	}

	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}

	return parts[0], parts[1], true
}

func sanitizeMemberPubKeys(rawMembers []string, ownerPubKey string) ([]string, error) {
	members := make([]string, 0, len(rawMembers))
	seen := map[string]struct{}{ownerPubKey: {}}

	for _, member := range rawMembers {
		member = strings.TrimSpace(member)
		if member == "" {
			continue
		}
		if !isValidPublicKey(member) {
			return nil, fmt.Errorf("invalid member pub_key")
		}
		if _, exists := seen[member]; exists {
			continue
		}
		if len(members) >= maxGroupMembersPerCreate {
			return nil, fmt.Errorf("too many group members")
		}
		seen[member] = struct{}{}
		members = append(members, member)
	}

	return members, nil
}

type statusRecorder struct {
	http.ResponseWriter
	statusCode int
}

type groupInvitePayload struct {
	GroupID     string `json:"groupId"`
	Title       string `json:"title"`
	Avatar      string `json:"avatar,omitempty"`
	Role        string `json:"role"`
	MemberCount int    `json:"memberCount"`
}

func (r *statusRecorder) WriteHeader(statusCode int) {
	r.statusCode = statusCode
	r.ResponseWriter.WriteHeader(statusCode)
}

func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("websocket: response does not implement http.Hijacker")
	}
	return h.Hijack()
}

func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func logEvent(event string, fields map[string]any) {
	payload := map[string]any{
		"event": event,
		"time":  time.Now().UTC().Format(time.RFC3339),
	}
	for key, value := range fields {
		payload[key] = value
	}

	encoded, err := json.Marshal(payload)
	if err != nil {
		log.Printf("event=%s marshal_error=%v", event, err)
		return
	}

	log.Println(string(encoded))
}

func getAllowedOrigins() []string {
	raw := strings.TrimSpace(os.Getenv("ALLOWED_ORIGINS"))
	if raw == "" {
		return []string{"http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000"}
	}

	parts := strings.Split(raw, ",")
	origins := make([]string, 0, len(parts))
	for _, part := range parts {
		origin := strings.TrimSpace(part)
		if origin != "" {
			origins = append(origins, origin)
		}
	}

	if len(origins) == 0 {
		return []string{"http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000"}
	}
	return origins
}

func getDBPath() string {
	raw := strings.TrimSpace(os.Getenv("DB_PATH"))
	if raw == "" {
		return "messenger.db"
	}
	return raw
}

func getUploadDir() string {
	raw := strings.TrimSpace(os.Getenv("UPLOAD_DIR"))
	if raw == "" {
		return "uploads"
	}
	return raw
}

func newUploadFilename(originalName string) (string, error) {
	randomNameBytes := make([]byte, 32)
	if _, err := crypto_rand.Read(randomNameBytes); err != nil {
		return "", err
	}

	extension := strings.ToLower(filepath.Ext(filepath.Base(originalName)))
	if len(extension) > 16 || !isSafeUploadExtension(extension) {
		extension = ".bin"
	}

	return fmt.Sprintf("%x%s", randomNameBytes, extension), nil
}

func isSafeUploadExtension(extension string) bool {
	if extension == "" {
		return true
	}
	if !strings.HasPrefix(extension, ".") {
		return false
	}
	for _, char := range extension[1:] {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') {
			continue
		}
		return false
	}
	if isExecutableUploadExtension(extension) {
		return false
	}
	return true
}

func isExecutableUploadExtension(extension string) bool {
	switch strings.ToLower(extension) {
	case ".app", ".apk", ".bat", ".cmd", ".com", ".deb", ".dll", ".dmg", ".exe", ".hta",
		".jar", ".js", ".jse", ".msi", ".ps1", ".rpm", ".scr", ".sh", ".vbe", ".vbs", ".wsf":
		return true
	default:
		return false
	}
}

func getMaxUploadBytes() int64 {
	raw := strings.TrimSpace(os.Getenv("MAX_UPLOAD_MB"))
	if raw == "" {
		return 80 << 20
	}

	mb, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || mb <= 0 {
		return 80 << 20
	}
	return mb << 20
}

func getSessionTokenTTL() time.Duration {
	return getDurationFromMinutesEnv("SESSION_TOKEN_TTL_MINUTES", 24*time.Hour)
}

func getFileTokenTTL() time.Duration {
	return getDurationFromMinutesEnv("FILE_TOKEN_TTL_MINUTES", time.Hour)
}

func getDurationFromMinutesEnv(name string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}

	minutes, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || minutes <= 0 {
		return fallback
	}
	return time.Duration(minutes) * time.Minute
}

func logModerationAuditAsync(db *DB, entityType, entityID, actorPubKey, action, target, details string) {
	if db == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := db.InsertModerationAudit(ctx, entityType, entityID, actorPubKey, action, target, details); err != nil {
			log.Printf("Failed to write moderation audit event %s/%s: %v", entityType, action, err)
		}
	}()
}

func getRateLimitPerMinute() int {
	raw := strings.TrimSpace(os.Getenv("RATE_LIMIT_PER_MINUTE"))
	if raw == "" {
		return 200
	}

	limit, err := strconv.Atoi(raw)
	if err != nil || limit <= 0 {
		return 200
	}
	return limit
}

func isAllowedUploadContentType(contentType string) bool {
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	if mediaType == "" {
		return false
	}

	raw := strings.TrimSpace(os.Getenv("ALLOWED_UPLOAD_MIME_TYPES"))
	if raw == "" {
		raw = "application/octet-stream"
	}

	for _, part := range strings.Split(raw, ",") {
		if strings.ToLower(strings.TrimSpace(part)) == mediaType {
			return true
		}
	}
	return false
}

func isForbiddenProxyHost(host string) bool {
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		return true
	}

	for _, ip := range ips {
		addr, ok := netip.AddrFromSlice(ip)
		if !ok || isForbiddenProxyAddr(addr) {
			return true
		}
	}
	return false
}

func validateProxyTargetURL(rawURL string) (*url.URL, error) {
	parsedURL, err := url.Parse(rawURL)
	if err != nil {
		return nil, errInvalidProxyURL
	}
	if err := validateParsedProxyURL(parsedURL); err != nil {
		return nil, err
	}
	return parsedURL, nil
}

func validateParsedProxyURL(parsedURL *url.URL) error {
	if parsedURL == nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
		return errInvalidProxyURL
	}

	host := parsedURL.Hostname()
	if host == "" {
		return errInvalidProxyURL
	}
	if isForbiddenProxyHost(host) {
		return errForbiddenProxyTarget
	}
	return nil
}

func newSafeProxyClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxProxyRedirects {
				return fmt.Errorf("proxy redirect limit exceeded")
			}
			return validateParsedProxyURL(req.URL)
		},
	}
}

func isForbiddenProxyAddr(addr netip.Addr) bool {
	return !addr.IsGlobalUnicast() ||
		addr.IsPrivate() ||
		addr.IsLoopback() ||
		addr.IsLinkLocalUnicast() ||
		addr.IsLinkLocalMulticast() ||
		addr.IsMulticast() ||
		addr.IsUnspecified()
}

type ipRateLimiter struct {
	mu          sync.Mutex
	clients     map[string]rateLimitBucket
	limit       func() int
	window      time.Duration
	now         func() time.Time
	lastCleanup time.Time
}

type rateLimitBucket struct {
	Count   int
	ResetAt time.Time
}

func newIPRateLimiter(limit func() int, window time.Duration) *ipRateLimiter {
	return &ipRateLimiter{
		clients: make(map[string]rateLimitBucket),
		limit:   limit,
		window:  window,
		now:     time.Now,
	}
}

func (l *ipRateLimiter) allow(remoteAddr string) (bool, time.Duration) {
	ip, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		ip = remoteAddr
	}
	if ip == "" {
		ip = "unknown"
	}

	now := l.now()
	limit := l.limit()

	l.mu.Lock()
	defer l.mu.Unlock()

	if l.lastCleanup.IsZero() || now.Sub(l.lastCleanup) >= l.window {
		for key, bucket := range l.clients {
			if now.After(bucket.ResetAt) {
				delete(l.clients, key)
			}
		}
		l.lastCleanup = now
	}

	bucket, ok := l.clients[ip]
	if !ok || now.After(bucket.ResetAt) {
		bucket = rateLimitBucket{ResetAt: now.Add(l.window)}
	}
	bucket.Count++
	l.clients[ip] = bucket

	if bucket.Count > limit {
		return false, bucket.ResetAt.Sub(now)
	}
	return true, 0
}

func rateLimit(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if allowed, retryAfter := defaultRateLimiter.allow(r.RemoteAddr); !allowed {
			logEvent("rate_limit_exceeded", map[string]any{
				"path":        r.URL.Path,
				"remote":      r.RemoteAddr,
				"retry_after": int64(retryAfter.Seconds()) + 1,
			})
			w.Header().Set("Retry-After", strconv.FormatInt(int64(retryAfter.Seconds())+1, 10))
			http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next(w, r)
	}
}
