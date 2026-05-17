package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	defaultHistoryLimit = 100
	maxHistoryLimit     = 500
)

func registerHistoryRoutes(mux *http.ServeMux, hub *Hub, db *DB) {
	mux.HandleFunc("/history/direct", rateLimit(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		pubKey, ok := authorizeSession(hub, w, r)
		if !ok {
			return
		}
		peerPubKey := strings.TrimSpace(r.URL.Query().Get("peer"))
		if !isValidPublicKey(peerPubKey) {
			http.Error(w, "Invalid peer", http.StatusBadRequest)
			return
		}

		cursor := parseInt64Query(r, "cursor", 0)
		limit := int(parseInt64Query(r, "limit", defaultHistoryLimit))
		if limit <= 0 || limit > maxHistoryLimit {
			limit = defaultHistoryLimit
		}

		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		records, nextCursor, err := db.ListDirectMessageHistory(ctx, pubKey, peerPubKey, cursor, limit)
		if err != nil {
			http.Error(w, "Failed to load history", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"messages":   records,
			"nextCursor": nextCursor,
			"limit":      limit,
		})
	}))
}

func parseInt64Query(r *http.Request, key string, fallback int64) int64 {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return fallback
	}
	return value
}
