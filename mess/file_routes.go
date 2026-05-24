package main

import (
	"context"
	crypto_rand "crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func registerFileRoutes(mux *http.ServeMux, hub *Hub, db *DB) {
	mux.HandleFunc("/upload", rateLimit(func(w http.ResponseWriter, r *http.Request) {
		uploaderPubKey, ok := authorizeSession(hub, w, r)
		if !ok {
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		if err := r.ParseMultipartForm(getMaxUploadBytes()); err != nil {
			logEvent("upload_rejected", map[string]any{"reason": "multipart"})
			http.Error(w, "File too large", http.StatusBadRequest)
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			logEvent("upload_rejected", map[string]any{"reason": "missing_file"})
			http.Error(w, "Missing file", http.StatusBadRequest)
			return
		}
		defer file.Close()

		if header.Size <= 0 || header.Size > getMaxUploadBytes() {
			logEvent("upload_rejected", map[string]any{"reason": "size"})
			http.Error(w, "Invalid file size", http.StatusBadRequest)
			return
		}
		if !isAllowedUploadContentType(header.Header.Get("Content-Type")) {
			logEvent("upload_rejected", map[string]any{"reason": "mime"})
			http.Error(w, "Unsupported file type", http.StatusBadRequest)
			return
		}

		allowedPubKeys, accessErr := resolveUploadAccess(r.Context(), db, uploaderPubKey, r.FormValue("recipient_pub_key"), r.FormValue("group_id"))
		if accessErr != nil {
			logEvent("upload_rejected", map[string]any{"reason": "access"})
			http.Error(w, accessErr.message, accessErr.status)
			return
		}

		filename, err := newUploadFilename(header.Filename)
		if err != nil {
			logEvent("upload_store_failed", map[string]any{"stage": "filename"})
			http.Error(w, "Internal error", http.StatusInternalServerError)
			return
		}
		path := filepath.Join(getUploadDir(), filename)
		out, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			logEvent("upload_store_failed", map[string]any{"stage": "create"})
			http.Error(w, "Internal error", http.StatusInternalServerError)
			return
		}
		defer out.Close()
		written, err := io.Copy(out, file)
		if err != nil {
			_ = os.Remove(path)
			logEvent("upload_store_failed", map[string]any{"stage": "write"})
			http.Error(w, "Failed to store file", http.StatusInternalServerError)
			return
		}
		if written == 0 {
			_ = os.Remove(path)
			logEvent("upload_rejected", map[string]any{"reason": "empty"})
			http.Error(w, "Empty file", http.StatusBadRequest)
			return
		}

		downloadTokenBytes := make([]byte, 32)
		if _, err := crypto_rand.Read(downloadTokenBytes); err != nil {
			logEvent("upload_store_failed", map[string]any{"stage": "token"})
			http.Error(w, "Internal error", http.StatusInternalServerError)
			return
		}
		downloadToken := fmt.Sprintf("%x", downloadTokenBytes)
		hub.StoreFileToken(downloadToken, filename)
		hub.StoreFileAccess(filename, allowedPubKeys...)

		logEvent("upload_succeeded", map[string]any{"size": written})
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"url": "/download/" + filename + "?token=" + downloadToken})
	}))

	mux.HandleFunc("/download/", func(w http.ResponseWriter, r *http.Request) {
		filename := filepath.Base(r.URL.Path)
		if !authorizeDownload(hub, w, r, filename) {
			return
		}
		path := filepath.Join(getUploadDir(), filename)
		w.Header().Set("Content-Disposition", "attachment; filename=\""+filename+"\"")
		http.ServeFile(w, r, path)
	})
}

type uploadAccessResultError struct {
	message string
	status  int
}

func resolveUploadAccess(ctx context.Context, db *DB, uploaderPubKey, recipientPubKey, roomID string) ([]string, *uploadAccessResultError) {
	recipientPubKey = strings.TrimSpace(recipientPubKey)
	roomID = strings.TrimSpace(roomID)
	allowedPubKeys := []string{uploaderPubKey}

	switch {
	case recipientPubKey != "":
		if !isValidPublicKey(recipientPubKey) {
			return nil, &uploadAccessResultError{message: "Invalid recipient_pub_key", status: http.StatusBadRequest}
		}
		return append(allowedPubKeys, recipientPubKey), nil
	case roomID != "":
		resolveCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if _, err := db.GetGroupMemberRole(resolveCtx, roomID, uploaderPubKey); err == nil {
			memberPubKeys, err := db.ListGroupMemberPubKeys(resolveCtx, roomID)
			if err != nil || len(memberPubKeys) == 0 {
				return nil, &uploadAccessResultError{message: "Failed to resolve group members", status: http.StatusInternalServerError}
			}
			return append(allowedPubKeys, memberPubKeys...), nil
		}
		if _, err := db.GetChannelSubscriberRole(resolveCtx, roomID, uploaderPubKey); err == nil {
			subscriberPubKeys, err := db.ListChannelSubscriberPubKeys(resolveCtx, roomID)
			if err != nil || len(subscriberPubKeys) == 0 {
				return nil, &uploadAccessResultError{message: "Failed to resolve channel subscribers", status: http.StatusInternalServerError}
			}
			return append(allowedPubKeys, subscriberPubKeys...), nil
		}
		return nil, &uploadAccessResultError{message: "Forbidden", status: http.StatusForbidden}
	default:
		return nil, &uploadAccessResultError{message: "Missing recipient_pub_key or group_id", status: http.StatusBadRequest}
	}
}
