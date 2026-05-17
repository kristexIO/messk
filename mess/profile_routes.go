package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

func registerProfileRoutes(mux *http.ServeMux, hub *Hub, db *DB) {
	mux.HandleFunc("/profile", rateLimit(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			handleSaveProfile(hub, db, w, r)
		case http.MethodGet:
			handleGetProfile(db, w, r)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	}))

	directoryResolveHandler := rateLimit(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if _, ok := authorizeSession(hub, w, r); !ok {
			return
		}
		username := strings.TrimSpace(r.URL.Query().Get("username"))
		if username == "" {
			http.Error(w, "Missing username", http.StatusBadRequest)
			return
		}
		if strings.HasPrefix(username, "@") {
			username = username[1:]
		}
		writeResolvedUsername(db, w, r, username)
	})

	resolveUsernameHandler := rateLimit(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		username := strings.TrimSpace(r.URL.Query().Get("username"))
		if username == "" {
			http.Error(w, "Missing username", http.StatusBadRequest)
			return
		}
		if strings.HasPrefix(username, "@") {
			username = username[1:]
		}
		writeResolvedUsername(db, w, r, username)
	})

	mux.HandleFunc("/directory/resolve", directoryResolveHandler)
	mux.HandleFunc("/resolve", resolveUsernameHandler)
	mux.HandleFunc("/profile/resolve", resolveUsernameHandler)
}

func writeResolvedUsername(db *DB, w http.ResponseWriter, r *http.Request, username string) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	pubKey, nickname, avatar, err := db.ResolveUsername(ctx, username)
	if err == sql.ErrNoRows {
		http.Error(w, "User not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"username": strings.ToLower(strings.TrimSpace(username)),
		"pubKey":   pubKey,
		"nickname": nickname,
		"avatar":   avatar,
	})
}

func handleSaveProfile(hub *Hub, db *DB, w http.ResponseWriter, r *http.Request) {
	pubKey, ok := authorizeSession(hub, w, r)
	if !ok {
		return
	}

	var payload struct {
		Nickname string  `json:"nickname"`
		Avatar   string  `json:"avatar"`
		Username *string `json:"username"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload); err != nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}

	if err := validateProfileUsername(payload.Username); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := db.SaveUserProfile(ctx, pubKey, payload.Nickname, payload.Avatar, payload.Username); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique constraint failed") {
			http.Error(w, "Username already taken", http.StatusConflict)
			return
		}
		http.Error(w, "Failed to save profile", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func handleGetProfile(db *DB, w http.ResponseWriter, r *http.Request) {
	targetPubKey := strings.TrimSpace(r.URL.Query().Get("pub"))
	if targetPubKey == "" {
		http.Error(w, "Missing pub", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	nickname, avatar, username, err := db.GetUserProfile(ctx, targetPubKey)
	if err == sql.ErrNoRows {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"pubKey":   targetPubKey,
		"nickname": nickname,
		"avatar":   avatar,
		"username": username,
	})
}

func validateProfileUsername(username *string) error {
	if username == nil || *username == "" {
		return nil
	}

	value := *username
	if len(value) < 5 || len(value) > 32 {
		return httpError("Username must be between 5 and 32 characters")
	}
	for _, char := range value {
		if !(char >= 'a' && char <= 'z') && !(char >= 'A' && char <= 'Z') && !(char >= '0' && char <= '9') && char != '_' {
			return httpError("Username can only contain letters, numbers, and underscores")
		}
	}
	return nil
}

type httpError string

func (e httpError) Error() string {
	return string(e)
}
