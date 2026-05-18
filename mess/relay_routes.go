package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	maxRelayAnnouncementBody = 32 << 10
	defaultRelayMaxTTL       = 24 * time.Hour
	defaultRelayMaxNodes     = 256
	maxRelayEndpointOrigins  = 8
)

var (
	errRelayUnauthorized     = errors.New("relay announce unauthorized")
	errRelayRegistryFull     = errors.New("relay registry full")
	errRelayInvalidSignature = errors.New("relay signature invalid")
	errRelayRevoked          = errors.New("relay capability revoked")
)

type RelayCapability struct {
	NodeID          string    `json:"nodeId"`
	PublicKey       string    `json:"publicKey"`
	Transports      []string  `json:"transports"`
	EndpointOrigins []string  `json:"endpointOrigins,omitempty"`
	RegionHint      string    `json:"regionHint,omitempty"`
	CapacityClass   string    `json:"capacityClass"`
	ExpiresAt       time.Time `json:"expiresAt"`
	Signature       string    `json:"signature"`
}

type RelayCredential struct {
	TokenProof      string    `json:"tokenProof,omitempty"`
	Scope           string    `json:"scope,omitempty"`
	ExpiresAt       time.Time `json:"expiresAt,omitempty"`
	RevocationEpoch int       `json:"revocationEpoch,omitempty"`
}

type RelayRecord struct {
	Capability      RelayCapability
	FirstSeen       time.Time
	LastSeen        time.Time
	RemoteAddr      string
	RevocationEpoch int
}

type relayAnnounceRequest struct {
	Capability RelayCapability `json:"capability"`
	Credential RelayCredential `json:"credential"`
}

func registerRelayRoutes(mux *http.ServeMux, hub *Hub) {
	mux.HandleFunc("/relay/announce", rateLimit(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var payload relayAnnounceRequest
		decoder := json.NewDecoder(io.LimitReader(r.Body, maxRelayAnnouncementBody))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil {
			http.Error(w, "Bad request", http.StatusBadRequest)
			return
		}

		if err := authorizeRelayAnnouncement(r, payload.Credential); err != nil {
			logEvent("relay_announce_auth_failed", map[string]any{
				"remote": clientIPFromRequest(r),
			})
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		capability, err := normalizeRelayCapability(payload.Capability)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := validateRelayCredential(payload.Credential); err != nil {
			http.Error(w, err.Error(), http.StatusUnauthorized)
			return
		}
		if err := validateRelayRevocation(capability, payload.Credential); err != nil {
			logEvent("relay_announce_revoked", map[string]any{
				"node_id": capability.NodeID,
				"remote":  clientIPFromRequest(r),
			})
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		if err := verifyRelayCapabilitySignature(capability, payload.Credential.RevocationEpoch); err != nil {
			logEvent("relay_announce_signature_failed", map[string]any{
				"node_id": capability.NodeID,
				"remote":  clientIPFromRequest(r),
			})
			http.Error(w, "Invalid relay signature", http.StatusUnauthorized)
			return
		}
		if hub != nil && len(hub.ListRelayCapabilities(time.Now().UTC())) >= getRelayMaxNodes() {
			hub.relayMu.RLock()
			_, replacing := hub.relays[capability.NodeID]
			hub.relayMu.RUnlock()
			if !replacing {
				http.Error(w, errRelayRegistryFull.Error(), http.StatusServiceUnavailable)
				return
			}
		}

		record := hub.UpsertRelayCapability(capability, clientIPFromRequest(r), payload.Credential.RevocationEpoch)
		logEvent("relay_announced", map[string]any{
			"node_id":          record.Capability.NodeID,
			"transports":       record.Capability.Transports,
			"endpoint_origins": len(record.Capability.EndpointOrigins),
			"remote":           record.RemoteAddr,
		})

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"accepted": true,
			"relay":    record.Capability,
		})
	}))

	mux.HandleFunc("/relay/peers", rateLimit(func(w http.ResponseWriter, r *http.Request) {
		writeRelayPeers(w, r, hub)
	}))
	mux.HandleFunc("/peers", rateLimit(func(w http.ResponseWriter, r *http.Request) {
		writeRelayPeers(w, r, hub)
	}))
	mux.HandleFunc("/relay/health", rateLimit(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		writeRelayHealth(w, hub)
	}))
	mux.HandleFunc("/bootstrap", rateLimit(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"mode":       "bootstrap",
			"transports": allowedRelayTransports(),
			"relays":     hub.ListRelayCapabilities(time.Now().UTC()),
			"relay":      hub.RelayStats(time.Now().UTC()),
			"time":       time.Now().UTC().Format(time.RFC3339),
		})
	}))
}

func writeRelayPeers(w http.ResponseWriter, r *http.Request, hub *Hub) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"peers": hub.ListRelayCapabilities(time.Now().UTC()),
		"count": len(hub.ListRelayCapabilities(time.Now().UTC())),
		"time":  time.Now().UTC().Format(time.RFC3339),
	})
}

func writeRelayHealth(w http.ResponseWriter, hub *Hub) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":        "ok",
		"mode":          "bootstrap",
		"tokenRequired": strings.TrimSpace(os.Getenv("RELAY_ANNOUNCE_TOKEN")) != "",
		"transports":    allowedRelayTransports(),
		"relay":         hub.RelayStats(time.Now().UTC()),
		"revocation": map[string]any{
			"minEpoch":          getRelayMinRevocationEpoch(),
			"revokedNodes":      len(getRelayRevocationSet("RELAY_REVOKED_NODES")),
			"revokedPublicKeys": len(getRelayRevocationSet("RELAY_REVOKED_PUBLIC_KEYS")),
		},
		"maxTtlSeconds": int(getRelayMaxTTL().Seconds()),
		"time":          time.Now().UTC().Format(time.RFC3339),
	})
}

func authorizeRelayAnnouncement(r *http.Request, credential RelayCredential) error {
	configuredToken := strings.TrimSpace(os.Getenv("RELAY_ANNOUNCE_TOKEN"))
	presentedToken := strings.TrimSpace(r.Header.Get("X-Relay-Token"))
	if presentedToken == "" {
		presentedToken = credential.TokenProof
	}
	if configuredToken != "" {
		if subtleConstantTimeEqual(presentedToken, configuredToken) {
			return nil
		}
		return errRelayUnauthorized
	}
	if isLoopbackRequest(r) {
		return nil
	}
	return errRelayUnauthorized
}

func validateRelayCredential(credential RelayCredential) error {
	if credential.Scope != "" && credential.Scope != "relay:announce" {
		return errors.New("invalid relay credential scope")
	}
	if !credential.ExpiresAt.IsZero() && !credential.ExpiresAt.After(time.Now().UTC()) {
		return errors.New("relay credential expired")
	}
	return nil
}

func validateRelayRevocation(capability RelayCapability, credential RelayCredential) error {
	if credential.RevocationEpoch < getRelayMinRevocationEpoch() {
		return errRelayRevoked
	}
	if getRelayRevocationSet("RELAY_REVOKED_NODES")[capability.NodeID] {
		return errRelayRevoked
	}
	if getRelayRevocationSet("RELAY_REVOKED_PUBLIC_KEYS")[capability.PublicKey] {
		return errRelayRevoked
	}
	return nil
}

func normalizeRelayCapability(capability RelayCapability) (RelayCapability, error) {
	capability.NodeID = strings.TrimSpace(capability.NodeID)
	capability.PublicKey = strings.TrimSpace(capability.PublicKey)
	capability.RegionHint = sanitizeRelayToken(capability.RegionHint, 32)
	capability.CapacityClass = strings.ToLower(strings.TrimSpace(capability.CapacityClass))
	if capability.CapacityClass == "" {
		capability.CapacityClass = "small"
	}
	capability.Signature = strings.TrimSpace(capability.Signature)
	capability.ExpiresAt = capability.ExpiresAt.UTC()

	if !isValidRelayNodeID(capability.NodeID) {
		return capability, errors.New("invalid relay node id")
	}
	if !isValidRelayPublicKey(capability.PublicKey) {
		return capability, errors.New("invalid relay public key")
	}
	if !isValidRelayCapacity(capability.CapacityClass) {
		return capability, errors.New("invalid relay capacity class")
	}
	if capability.ExpiresAt.IsZero() || !capability.ExpiresAt.After(time.Now().UTC()) {
		return capability, errors.New("relay expiry must be in the future")
	}
	if time.Until(capability.ExpiresAt) > getRelayMaxTTL() {
		return capability, errors.New("relay expiry exceeds max ttl")
	}
	transports, err := normalizeRelayTransports(capability.Transports)
	if err != nil {
		return capability, err
	}
	capability.Transports = transports
	endpointOrigins, err := normalizeRelayEndpointOrigins(capability.EndpointOrigins)
	if err != nil {
		return capability, err
	}
	capability.EndpointOrigins = endpointOrigins
	if _, err := base64.StdEncoding.DecodeString(capability.Signature); err != nil {
		return capability, errors.New("invalid relay signature encoding")
	}
	return capability, nil
}

func verifyRelayCapabilitySignature(capability RelayCapability, revocationEpoch int) error {
	publicKeyBytes, err := base64.StdEncoding.DecodeString(capability.PublicKey)
	if err != nil || len(publicKeyBytes) != ed25519.PublicKeySize {
		return errors.New("invalid relay public key")
	}
	signatureBytes, err := base64.StdEncoding.DecodeString(capability.Signature)
	if err != nil || len(signatureBytes) != ed25519.SignatureSize {
		return errors.New("invalid relay signature")
	}
	publicKey := ed25519.PublicKey(publicKeyBytes)
	if ed25519.Verify(publicKey, canonicalRelayAnnouncement(capability, revocationEpoch), signatureBytes) {
		return nil
	}
	if len(capability.EndpointOrigins) == 0 && ed25519.Verify(publicKey, canonicalRelayAnnouncementV1(capability, revocationEpoch), signatureBytes) {
		return nil
	}
	return errRelayInvalidSignature
}

func canonicalRelayAnnouncement(capability RelayCapability, revocationEpoch int) []byte {
	parts := []string{
		capability.NodeID,
		capability.PublicKey,
		strings.Join(capability.Transports, ","),
		strings.Join(capability.EndpointOrigins, ","),
		capability.RegionHint,
		capability.CapacityClass,
		capability.ExpiresAt.UTC().Format(time.RFC3339),
		strconv.Itoa(revocationEpoch),
	}
	return []byte(strings.Join(parts, "\n"))
}

func canonicalRelayAnnouncementV1(capability RelayCapability, revocationEpoch int) []byte {
	parts := []string{
		capability.NodeID,
		capability.PublicKey,
		strings.Join(capability.Transports, ","),
		capability.RegionHint,
		capability.CapacityClass,
		capability.ExpiresAt.UTC().Format(time.RFC3339),
		strconv.Itoa(revocationEpoch),
	}
	return []byte(strings.Join(parts, "\n"))
}

func normalizeRelayTransports(transports []string) ([]string, error) {
	if len(transports) == 0 || len(transports) > 5 {
		return nil, errors.New("invalid relay transport count")
	}
	allowed := map[string]bool{}
	for _, transport := range allowedRelayTransports() {
		allowed[transport] = true
	}
	seen := map[string]bool{}
	normalized := make([]string, 0, len(transports))
	for _, transport := range transports {
		value := strings.ToLower(strings.TrimSpace(transport))
		if !allowed[value] {
			return nil, errors.New("unsupported relay transport")
		}
		if seen[value] {
			continue
		}
		seen[value] = true
		normalized = append(normalized, value)
	}
	sort.Strings(normalized)
	if len(normalized) == 0 {
		return nil, errors.New("invalid relay transport count")
	}
	return normalized, nil
}

func normalizeRelayEndpointOrigins(origins []string) ([]string, error) {
	if len(origins) > maxRelayEndpointOrigins {
		return nil, errors.New("too many relay endpoint origins")
	}
	seen := map[string]bool{}
	normalized := make([]string, 0, len(origins))
	for _, raw := range origins {
		origin, err := normalizeRelayEndpointOrigin(raw)
		if err != nil {
			return nil, err
		}
		if origin == "" || seen[origin] {
			continue
		}
		seen[origin] = true
		normalized = append(normalized, origin)
	}
	sort.Strings(normalized)
	return normalized, nil
}

func normalizeRelayEndpointOrigin(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("invalid relay endpoint origin")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "https" && scheme != "http" {
		return "", errors.New("unsupported relay endpoint origin scheme")
	}
	if parsed.User != nil || parsed.Opaque != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("relay endpoint origin must not include credentials, query, or fragment")
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return "", errors.New("relay endpoint origin must not include a path")
	}
	return scheme + "://" + strings.ToLower(parsed.Host), nil
}

func allowedRelayTransports() []string {
	return []string{"central_ws", "mesh_relay", "direct_p2p", "fallback_wss", "user_proxy"}
}

func isValidRelayNodeID(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') ||
			(char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') ||
			char == '-' ||
			char == '_' ||
			char == ':' ||
			char == '.' {
			continue
		}
		return false
	}
	return true
}

func isValidRelayPublicKey(value string) bool {
	decoded, err := base64.StdEncoding.DecodeString(value)
	return err == nil && len(decoded) == ed25519.PublicKeySize
}

func isValidRelayCapacity(value string) bool {
	switch value {
	case "tiny", "small", "medium", "large":
		return true
	default:
		return false
	}
}

func sanitizeRelayToken(value string, maxLen int) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if len(value) > maxLen {
		value = value[:maxLen]
	}
	var builder strings.Builder
	for _, char := range value {
		if (char >= 'a' && char <= 'z') ||
			(char >= '0' && char <= '9') ||
			char == '-' ||
			char == '_' ||
			char == '.' {
			builder.WriteRune(char)
		}
	}
	return builder.String()
}

func isLoopbackRequest(r *http.Request) bool {
	ip := net.ParseIP(clientIPFromRequest(r))
	return ip != nil && ip.IsLoopback()
}

func getRelayMaxTTL() time.Duration {
	raw := strings.TrimSpace(os.Getenv("RELAY_MAX_TTL_MINUTES"))
	if raw == "" {
		return defaultRelayMaxTTL
	}
	minutes, err := strconv.Atoi(raw)
	if err != nil || minutes <= 0 {
		return defaultRelayMaxTTL
	}
	return time.Duration(minutes) * time.Minute
}

func getRelayMaxNodes() int {
	raw := strings.TrimSpace(os.Getenv("RELAY_MAX_NODES"))
	if raw == "" {
		return defaultRelayMaxNodes
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return defaultRelayMaxNodes
	}
	return value
}

func getRelayMinRevocationEpoch() int {
	raw := strings.TrimSpace(os.Getenv("RELAY_MIN_REVOCATION_EPOCH"))
	if raw == "" {
		return 0
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 {
		return 0
	}
	return value
}

func getRelayRevocationSet(envKey string) map[string]bool {
	raw := os.Getenv(envKey)
	revoked := map[string]bool{}
	for _, value := range strings.FieldsFunc(raw, func(character rune) bool {
		return character == ',' || character == ';' || character == '\n' || character == '\r'
	}) {
		value = strings.TrimSpace(value)
		if value != "" {
			revoked[value] = true
		}
	}
	return revoked
}
