package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	defaultBackendOrigin = "http://127.0.0.1:8080"
	maxEndpointOrigins   = 8
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
	Scope           string    `json:"scope,omitempty"`
	ExpiresAt       time.Time `json:"expiresAt,omitempty"`
	RevocationEpoch int       `json:"revocationEpoch,omitempty"`
}

type relayAnnounceRequest struct {
	Capability RelayCapability `json:"capability"`
	Credential RelayCredential `json:"credential"`
}

func main() {
	var (
		backendOrigin       = flag.String("backend", envOrDefault("RELAY_ANNOUNCE_TARGET", defaultBackendOrigin), "bootstrap/backend origin, for example https://bootstrap.example")
		nodeID              = flag.String("node-id", envOrDefault("RELAY_NODE_ID", defaultNodeID()), "stable relay node id")
		keyFile             = flag.String("key-file", envOrDefault("RELAY_SIGNING_KEY_FILE", ""), "path to base64 Ed25519 private key; keep outside git")
		inlinePrivateKey    = flag.String("private-key", envOrDefault("RELAY_SIGNING_PRIVATE_KEY", ""), "base64 Ed25519 private key; prefer -key-file in production")
		createKey           = flag.Bool("generate-key", false, "create -key-file if it does not exist")
		token               = flag.String("token", envOrDefault("RELAY_ANNOUNCE_TOKEN", ""), "operator announce token; never printed")
		tokenFile           = flag.String("token-file", envOrDefault("RELAY_ANNOUNCE_TOKEN_FILE", ""), "file containing the operator announce token")
		transportsRaw       = flag.String("transports", envOrDefault("RELAY_TRANSPORTS", "central_ws,fallback_wss"), "comma/newline separated transport names")
		endpointsRaw        = flag.String("endpoint-origins", envOrDefault("RELAY_ENDPOINT_ORIGINS", ""), "comma/newline separated public http(s) origins clients can use")
		regionHint          = flag.String("region", envOrDefault("RELAY_REGION_HINT", ""), "optional low precision region hint, for example eu")
		capacityClass       = flag.String("capacity", envOrDefault("RELAY_CAPACITY_CLASS", "small"), "capacity class: tiny, small, medium, or large")
		ttl                 = flag.Duration("ttl", envDurationOrDefault("RELAY_TTL", 12*time.Hour), "capability TTL")
		revocationEpoch     = flag.Int("revocation-epoch", envIntOrDefault("RELAY_REVOCATION_EPOCH", 0), "operator revocation epoch")
		allowEmptyEndpoints = flag.Bool("allow-empty-endpoints", false, "allow web transports without endpoint origins")
		timeout             = flag.Duration("timeout", envDurationOrDefault("RELAY_ANNOUNCE_TIMEOUT", 10*time.Second), "HTTP request timeout")
		refreshInterval     = flag.Duration("refresh-interval", envDurationOrDefault("RELAY_REFRESH_INTERVAL", 0), "repeat announce at this interval; 0 sends once")
		dryRun              = flag.Bool("dry-run", false, "print signed announce body without sending it")
	)
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, *backendOrigin, *nodeID, *keyFile, *inlinePrivateKey, *token, *tokenFile, *transportsRaw, *endpointsRaw, *regionHint, *capacityClass, *ttl, *revocationEpoch, *allowEmptyEndpoints, *createKey, *timeout, *refreshInterval, *dryRun); err != nil {
		fmt.Fprintf(os.Stderr, "relay announce failed: %v\n", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, backendOrigin, nodeID, keyFile, inlinePrivateKey, token, tokenFile, transportsRaw, endpointsRaw, regionHint, capacityClass string, ttl time.Duration, revocationEpoch int, allowEmptyEndpoints, createKey bool, timeout, refreshInterval time.Duration, dryRun bool) error {
	origin, err := normalizeEndpointOrigin(backendOrigin)
	if err != nil {
		return fmt.Errorf("invalid backend origin: %w", err)
	}
	if err := validateRefreshInterval(ttl, refreshInterval); err != nil {
		return err
	}
	privateKey, err := loadOrCreatePrivateKey(keyFile, inlinePrivateKey, createKey)
	if err != nil {
		return err
	}
	if strings.TrimSpace(tokenFile) != "" {
		token, err = readSecretFile(tokenFile)
		if err != nil {
			return err
		}
	}
	if dryRun || refreshInterval <= 0 {
		return announceOnce(ctx, origin, token, privateKey, nodeID, transportsRaw, endpointsRaw, regionHint, capacityClass, ttl, revocationEpoch, allowEmptyEndpoints, timeout, dryRun)
	}

	fmt.Fprintf(os.Stderr, "relay refresh loop started for %s; interval=%s ttl=%s\n", nodeID, refreshInterval, ttl)
	for {
		err := announceOnce(ctx, origin, token, privateKey, nodeID, transportsRaw, endpointsRaw, regionHint, capacityClass, ttl, revocationEpoch, allowEmptyEndpoints, timeout, false)
		wait := nextRefreshDelay(refreshInterval, err != nil)
		if err != nil {
			fmt.Fprintf(os.Stderr, "relay announce attempt failed: %v; retrying in %s\n", err, wait)
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			fmt.Fprintln(os.Stderr, "relay refresh loop stopped")
			return nil
		case <-timer.C:
		}
	}
}

func announceOnce(ctx context.Context, origin, token string, privateKey ed25519.PrivateKey, nodeID, transportsRaw, endpointsRaw, regionHint, capacityClass string, ttl time.Duration, revocationEpoch int, allowEmptyEndpoints bool, timeout time.Duration, dryRun bool) error {
	request, err := buildRelayAnnouncement(privateKey, nodeID, transportsRaw, endpointsRaw, regionHint, capacityClass, ttl, revocationEpoch, allowEmptyEndpoints, time.Now().UTC())
	if err != nil {
		return err
	}
	if dryRun {
		return json.NewEncoder(os.Stdout).Encode(request)
	}
	return postRelayAnnouncement(ctx, origin, token, request, timeout)
}

func buildRelayAnnouncement(privateKey ed25519.PrivateKey, nodeID, transportsRaw, endpointsRaw, regionHint, capacityClass string, ttl time.Duration, revocationEpoch int, allowEmptyEndpoints bool, now time.Time) (relayAnnounceRequest, error) {
	nodeID = strings.TrimSpace(nodeID)
	if !isValidRelayNodeID(nodeID) {
		return relayAnnounceRequest{}, errors.New("invalid relay node id")
	}
	transports, err := normalizeRelayTransports(splitList(transportsRaw))
	if err != nil {
		return relayAnnounceRequest{}, err
	}
	endpointOrigins, err := normalizeEndpointOrigins(splitList(endpointsRaw))
	if err != nil {
		return relayAnnounceRequest{}, err
	}
	if len(endpointOrigins) == 0 && !allowEmptyEndpoints && supportsWebsocketEndpoint(transports) {
		return relayAnnounceRequest{}, errors.New("endpoint origins are required for central_ws/fallback_wss; pass -allow-empty-endpoints to announce discovery-only metadata")
	}
	capacityClass = strings.ToLower(strings.TrimSpace(capacityClass))
	if capacityClass == "" {
		capacityClass = "small"
	}
	if !isValidRelayCapacity(capacityClass) {
		return relayAnnounceRequest{}, errors.New("invalid relay capacity class")
	}
	if ttl <= 0 {
		return relayAnnounceRequest{}, errors.New("ttl must be positive")
	}
	publicKey, ok := privateKey.Public().(ed25519.PublicKey)
	if !ok || len(publicKey) != ed25519.PublicKeySize {
		return relayAnnounceRequest{}, errors.New("invalid relay private key")
	}
	capability := RelayCapability{
		NodeID:          nodeID,
		PublicKey:       base64.StdEncoding.EncodeToString(publicKey),
		Transports:      transports,
		EndpointOrigins: endpointOrigins,
		RegionHint:      sanitizeRelayToken(regionHint, 32),
		CapacityClass:   capacityClass,
		ExpiresAt:       now.Add(ttl).UTC().Truncate(time.Second),
	}
	capability.Signature = base64.StdEncoding.EncodeToString(
		ed25519.Sign(privateKey, canonicalRelayAnnouncement(capability, revocationEpoch)),
	)
	return relayAnnounceRequest{
		Capability: capability,
		Credential: RelayCredential{
			Scope:           "relay:announce",
			ExpiresAt:       capability.ExpiresAt,
			RevocationEpoch: revocationEpoch,
		},
	}, nil
}

func postRelayAnnouncement(ctx context.Context, origin, token string, request relayAnnounceRequest, timeout time.Duration) error {
	body, err := json.Marshal(request)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, origin+"/relay/announce", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if strings.TrimSpace(token) != "" {
		req.Header.Set("X-Relay-Token", strings.TrimSpace(token))
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("backend returned %s: %s", response.Status, strings.TrimSpace(string(responseBody)))
	}
	fmt.Printf("relay %s announced to %s with %d endpoint origin(s)\n", request.Capability.NodeID, origin, len(request.Capability.EndpointOrigins))
	return nil
}

func validateRefreshInterval(ttl, refreshInterval time.Duration) error {
	if ttl <= 0 {
		return errors.New("ttl must be positive")
	}
	if refreshInterval < 0 {
		return errors.New("refresh interval must not be negative")
	}
	if refreshInterval > 0 && refreshInterval >= ttl {
		return errors.New("refresh interval must be shorter than ttl")
	}
	return nil
}

func nextRefreshDelay(refreshInterval time.Duration, failed bool) time.Duration {
	if !failed || refreshInterval <= time.Minute {
		return refreshInterval
	}
	return time.Minute
}

func loadOrCreatePrivateKey(keyFile, inlinePrivateKey string, createKey bool) (ed25519.PrivateKey, error) {
	if strings.TrimSpace(inlinePrivateKey) != "" {
		return parsePrivateKey(inlinePrivateKey)
	}
	keyFile = strings.TrimSpace(keyFile)
	if keyFile == "" {
		return nil, errors.New("relay signing key is required; set -key-file or RELAY_SIGNING_KEY_FILE")
	}
	raw, err := os.ReadFile(keyFile)
	if err == nil {
		return parsePrivateKey(string(raw))
	}
	if !createKey || !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("read key file: %w", err)
	}
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate relay signing key: %w", err)
	}
	encoded := base64.StdEncoding.EncodeToString(privateKey)
	if err := os.WriteFile(keyFile, []byte(encoded+"\n"), 0600); err != nil {
		return nil, fmt.Errorf("write key file: %w", err)
	}
	fmt.Fprintf(os.Stderr, "created relay signing key at %s; keep this file outside git and backed up securely\n", keyFile)
	return privateKey, nil
}

func parsePrivateKey(raw string) (ed25519.PrivateKey, error) {
	raw = strings.TrimSpace(raw)
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, errors.New("relay private key must be base64")
	}
	switch len(decoded) {
	case ed25519.SeedSize:
		return ed25519.NewKeyFromSeed(decoded), nil
	case ed25519.PrivateKeySize:
		return ed25519.PrivateKey(decoded), nil
	default:
		return nil, errors.New("relay private key must be a 32-byte seed or 64-byte Ed25519 private key")
	}
}

func readSecretFile(path string) (string, error) {
	raw, err := os.ReadFile(strings.TrimSpace(path))
	if err != nil {
		return "", fmt.Errorf("read token file: %w", err)
	}
	return strings.TrimSpace(string(raw)), nil
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
		if value == "" {
			continue
		}
		if !allowed[value] {
			return nil, fmt.Errorf("unsupported relay transport %q", value)
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

func normalizeEndpointOrigins(origins []string) ([]string, error) {
	if len(origins) > maxEndpointOrigins {
		return nil, errors.New("too many relay endpoint origins")
	}
	seen := map[string]bool{}
	normalized := make([]string, 0, len(origins))
	for _, raw := range origins {
		origin, err := normalizeEndpointOrigin(raw)
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

func normalizeEndpointOrigin(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("invalid endpoint origin")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "https" && scheme != "http" {
		return "", errors.New("unsupported endpoint origin scheme")
	}
	if parsed.User != nil || parsed.Opaque != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("endpoint origin must not include credentials, query, or fragment")
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return "", errors.New("endpoint origin must not include a path")
	}
	return scheme + "://" + strings.ToLower(parsed.Host), nil
}

func supportsWebsocketEndpoint(transports []string) bool {
	for _, transport := range transports {
		switch transport {
		case "central_ws", "fallback_wss":
			return true
		}
	}
	return false
}

func splitList(raw string) []string {
	parts := strings.FieldsFunc(raw, func(character rune) bool {
		return character == ',' || character == ';' || character == '\n' || character == '\r'
	})
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
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

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envIntOrDefault(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envDurationOrDefault(key string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	if parsed, err := time.ParseDuration(value); err == nil {
		return parsed
	}
	if minutes, err := strconv.Atoi(value); err == nil && minutes > 0 {
		return time.Duration(minutes) * time.Minute
	}
	return fallback
}

func defaultNodeID() string {
	hostname, err := os.Hostname()
	if err != nil || strings.TrimSpace(hostname) == "" {
		return "relay-local"
	}
	return "relay-" + sanitizeRelayToken(hostname, 64)
}
