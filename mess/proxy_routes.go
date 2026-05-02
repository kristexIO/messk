package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"time"
)

func registerProxyRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/proxy", rateLimit(func(w http.ResponseWriter, r *http.Request) {
		if os.Getenv("ENABLE_METADATA_PROXY") != "true" {
			http.Error(w, "Proxy disabled", http.StatusForbidden)
			return
		}

		target := r.URL.Query().Get("url")
		if target == "" {
			http.Error(w, "Missing url", http.StatusBadRequest)
			return
		}

		parsedURL, err := validateProxyTargetURL(target)
		if errors.Is(err, errInvalidProxyURL) {
			http.Error(w, "Invalid url", http.StatusBadRequest)
			return
		}
		if errors.Is(err, errForbiddenProxyTarget) {
			http.Error(w, "Forbidden target", http.StatusForbidden)
			return
		}
		if err != nil {
			http.Error(w, "Invalid url", http.StatusBadRequest)
			return
		}

		proxyClient := newSafeProxyClient(5 * time.Second)
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, parsedURL.String(), nil)
		if err != nil {
			http.Error(w, "Invalid url", http.StatusBadRequest)
			return
		}
		resp, err := proxyClient.Do(req)
		if err != nil {
			http.Error(w, "Failed to fetch", http.StatusInternalServerError)
			return
		}
		defer resp.Body.Close()

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	}))
}
