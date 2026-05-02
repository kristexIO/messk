package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

func registerSessionRoutes(mux *http.ServeMux, hub *Hub) {
	mux.HandleFunc("/sessions", rateLimit(func(w http.ResponseWriter, r *http.Request) {
		pubKey, ok := authorizeSession(hub, w, r)
		if !ok {
			return
		}
		currentToken := extractSessionToken(r)
		switch r.Method {
		case http.MethodGet:
			sessions := hub.ListSessions(pubKey)
			logEvent("sessions_listed", map[string]any{
				"pub_key": pubKey,
				"count":   len(sessions),
				"remote":  r.RemoteAddr,
			})
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"sessions":     sessions,
				"currentToken": currentToken,
			})
		case http.MethodDelete:
			token := strings.TrimSpace(r.URL.Query().Get("token"))
			if token == "all" || token == "" {
				revoked := hub.RevokeAllSessionTokensForUser(pubKey, currentToken)
				logEvent("sessions_revoked_all", map[string]any{
					"pub_key":  pubKey,
					"revoked":  revoked,
					"remote":   r.RemoteAddr,
					"has_self": currentToken != "",
				})
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"revoked": revoked})
				return
			}
			if !hub.RevokeSessionTokenForUser(pubKey, token) {
				http.Error(w, "Session not found", http.StatusNotFound)
				return
			}
			logEvent("session_revoked", map[string]any{
				"pub_key": pubKey,
				"remote":  r.RemoteAddr,
			})
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	}))
}

func authorizeSession(hub *Hub, w http.ResponseWriter, r *http.Request) (string, bool) {
	token := extractSessionToken(r)

	pubKey, ok := hub.ValidateSessionToken(token)
	if !ok {
		logEvent("session_auth_failed", map[string]any{
			"path":   r.URL.Path,
			"remote": r.RemoteAddr,
		})
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return "", false
	}
	return pubKey, true
}

func authorizeDownload(hub *Hub, w http.ResponseWriter, r *http.Request, filename string) bool {
	if pubKey, ok := authorizeSessionSilently(hub, r); ok && hub.ValidateFileAccess(filename, pubKey) {
		return true
	}

	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if hub.ValidateFileToken(token, filename) {
		return true
	}

	logEvent("download_auth_failed", map[string]any{
		"filename": filename,
		"remote":   r.RemoteAddr,
	})
	http.Error(w, "Unauthorized", http.StatusUnauthorized)
	return false
}

func authorizeSessionSilently(hub *Hub, r *http.Request) (string, bool) {
	token := extractSessionToken(r)
	return hub.ValidateSessionToken(token)
}

func extractSessionToken(r *http.Request) string {
	token := strings.TrimSpace(r.Header.Get("X-Session-Token"))
	if token == "" {
		authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
		if strings.HasPrefix(authHeader, "Bearer ") {
			token = strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
		}
	}
	return token
}

func logSessionPersistenceWarning(scope string, err error) {
	if err == nil {
		return
	}
	log.Printf("Session persistence warning during %s: %v", scope, err)
}
