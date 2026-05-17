package main

import (
	"net"
	"net/http"
	"os"
	"strings"

	"github.com/redis/go-redis/v9"
)

func registerAdminRoutes(mux *http.ServeMux, db *DB, hub *Hub, rdb *redis.Client) {
	mux.HandleFunc("/admin/health", rateLimit(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !authorizeAdminRequest(w, r) {
			return
		}
		writeHealthReport(w, r, db, hub, rdb)
	}))
}

func authorizeAdminRequest(w http.ResponseWriter, r *http.Request) bool {
	configuredToken := strings.TrimSpace(os.Getenv("ADMIN_TOKEN"))
	if configuredToken != "" {
		if subtleConstantTimeEqual(r.Header.Get("X-Admin-Token"), configuredToken) {
			return true
		}
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return false
	}

	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(strings.TrimSpace(host))
	if ip != nil && ip.IsLoopback() {
		return true
	}

	http.Error(w, "Admin token is not configured", http.StatusServiceUnavailable)
	return false
}

func subtleConstantTimeEqual(left, right string) bool {
	left = strings.TrimSpace(left)
	right = strings.TrimSpace(right)
	if len(left) != len(right) {
		return false
	}
	var diff byte
	for i := 0; i < len(left); i++ {
		diff |= left[i] ^ right[i]
	}
	return diff == 0
}
