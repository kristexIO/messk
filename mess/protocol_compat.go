package main

import (
	"encoding/json"
	"net/http"
)

const wireProtocolVersion = 1

func protocolCompatibilityHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"protocolVersion":            wireProtocolVersion,
		"requiredClientStateVersion": requiredClientStateVersion,
		"supportedClientStateVersions": []string{
			requiredClientStateVersion,
		},
	})
}
