package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRelayAnnounceStoresSignedCapability(t *testing.T) {
	t.Setenv("RELAY_ANNOUNCE_TOKEN", "relay-token")
	hub := NewHub(nil, nil, nil)
	mux := http.NewServeMux()
	registerRelayRoutes(mux, hub)

	capability := signedRelayCapability(t, "relay-1", 0)
	body := relayAnnounceRequest{
		Capability: capability,
		Credential: RelayCredential{
			Scope:           "relay:announce",
			RevocationEpoch: 0,
			ExpiresAt:       time.Now().UTC().Add(time.Hour),
		},
	}
	rawBody, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/relay/announce", bytes.NewReader(rawBody))
	req.Header.Set("X-Relay-Token", "relay-token")
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", rec.Code, rec.Body.String())
	}
	peers := hub.ListRelayCapabilities(time.Now().UTC())
	if len(peers) != 1 {
		t.Fatalf("expected one relay, got %d", len(peers))
	}
	if peers[0].NodeID != "relay-1" {
		t.Fatalf("unexpected relay node id: %s", peers[0].NodeID)
	}
	if peers[0].Transports[0] != "central_ws" || peers[0].Transports[1] != "mesh_relay" {
		t.Fatalf("unexpected normalized transports: %#v", peers[0].Transports)
	}
	if len(peers[0].EndpointOrigins) != 1 || peers[0].EndpointOrigins[0] != "https://relay.example" {
		t.Fatalf("unexpected endpoint origins: %#v", peers[0].EndpointOrigins)
	}
}

func TestRelayAnnounceRejectsBadSignature(t *testing.T) {
	t.Setenv("RELAY_ANNOUNCE_TOKEN", "relay-token")
	hub := NewHub(nil, nil, nil)
	mux := http.NewServeMux()
	registerRelayRoutes(mux, hub)

	capability := signedRelayCapability(t, "relay-1", 0)
	capability.CapacityClass = "large"
	body := relayAnnounceRequest{
		Capability: capability,
		Credential: RelayCredential{
			Scope:           "relay:announce",
			RevocationEpoch: 0,
		},
	}
	rawBody, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/relay/announce", bytes.NewReader(rawBody))
	req.Header.Set("X-Relay-Token", "relay-token")
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", rec.Code, rec.Body.String())
	}
	if len(hub.ListRelayCapabilities(time.Now().UTC())) != 0 {
		t.Fatal("bad relay signature should not be stored")
	}
}

func TestRelayAnnounceRequiresOperatorTokenOutsideLoopback(t *testing.T) {
	hub := NewHub(nil, nil, nil)
	mux := http.NewServeMux()
	registerRelayRoutes(mux, hub)

	body := relayAnnounceRequest{
		Capability: signedRelayCapability(t, "relay-1", 0),
		Credential: RelayCredential{Scope: "relay:announce"},
	}
	rawBody, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/relay/announce", bytes.NewReader(rawBody))
	req.RemoteAddr = "198.51.100.10:4444"
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestRelayAnnounceRejectsRevokedNode(t *testing.T) {
	t.Setenv("RELAY_ANNOUNCE_TOKEN", "relay-token")
	t.Setenv("RELAY_REVOKED_NODES", "relay-1,relay-2")
	hub := NewHub(nil, nil, nil)
	mux := http.NewServeMux()
	registerRelayRoutes(mux, hub)

	body := relayAnnounceRequest{
		Capability: signedRelayCapability(t, "relay-1", 0),
		Credential: RelayCredential{
			Scope:           "relay:announce",
			RevocationEpoch: 0,
		},
	}
	rawBody, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/relay/announce", bytes.NewReader(rawBody))
	req.Header.Set("X-Relay-Token", "relay-token")
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", rec.Code, rec.Body.String())
	}
	if len(hub.ListRelayCapabilities(time.Now().UTC())) != 0 {
		t.Fatal("revoked relay should not be stored")
	}
}

func TestRelayAnnounceRejectsOldRevocationEpoch(t *testing.T) {
	t.Setenv("RELAY_ANNOUNCE_TOKEN", "relay-token")
	t.Setenv("RELAY_MIN_REVOCATION_EPOCH", "3")
	hub := NewHub(nil, nil, nil)
	mux := http.NewServeMux()
	registerRelayRoutes(mux, hub)

	body := relayAnnounceRequest{
		Capability: signedRelayCapability(t, "relay-1", 2),
		Credential: RelayCredential{
			Scope:           "relay:announce",
			RevocationEpoch: 2,
		},
	}
	rawBody, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/relay/announce", bytes.NewReader(rawBody))
	req.Header.Set("X-Relay-Token", "relay-token")
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", rec.Code, rec.Body.String())
	}
	if len(hub.ListRelayCapabilities(time.Now().UTC())) != 0 {
		t.Fatal("old revocation epoch should not be stored")
	}
}

func TestRelayAnnounceRejectsEndpointOriginWithPath(t *testing.T) {
	t.Setenv("RELAY_ANNOUNCE_TOKEN", "relay-token")
	hub := NewHub(nil, nil, nil)
	mux := http.NewServeMux()
	registerRelayRoutes(mux, hub)

	capability := signedRelayCapability(t, "relay-1", 0)
	capability.EndpointOrigins = []string{"https://relay.example/base"}
	body := relayAnnounceRequest{
		Capability: capability,
		Credential: RelayCredential{
			Scope:           "relay:announce",
			RevocationEpoch: 0,
		},
	}
	rawBody, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/relay/announce", bytes.NewReader(rawBody))
	req.Header.Set("X-Relay-Token", "relay-token")
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestRelayAnnounceAcceptsLegacySignatureWithoutEndpoints(t *testing.T) {
	t.Setenv("RELAY_ANNOUNCE_TOKEN", "relay-token")
	hub := NewHub(nil, nil, nil)
	mux := http.NewServeMux()
	registerRelayRoutes(mux, hub)

	capability := legacySignedRelayCapability(t, "relay-legacy", 0)
	body := relayAnnounceRequest{
		Capability: capability,
		Credential: RelayCredential{
			Scope:           "relay:announce",
			RevocationEpoch: 0,
		},
	}
	rawBody, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/relay/announce", bytes.NewReader(rawBody))
	req.Header.Set("X-Relay-Token", "relay-token")
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", rec.Code, rec.Body.String())
	}
	peers := hub.ListRelayCapabilities(time.Now().UTC())
	if len(peers) != 1 || peers[0].NodeID != "relay-legacy" {
		t.Fatalf("legacy relay should be stored, got %#v", peers)
	}
}

func TestRelayPeersPrunesExpiredEntries(t *testing.T) {
	hub := NewHub(nil, nil, nil)
	expired := signedRelayCapability(t, "relay-expired", 0)
	expired.ExpiresAt = time.Now().UTC().Add(-time.Minute)
	hub.relays[expired.NodeID] = RelayRecord{Capability: expired}

	peers := hub.ListRelayCapabilities(time.Now().UTC())
	if len(peers) != 0 {
		t.Fatalf("expected expired relay to be pruned, got %d", len(peers))
	}
}

func TestRelayHealthEndpointReportsBootstrapMode(t *testing.T) {
	hub := NewHub(nil, nil, nil)
	mux := http.NewServeMux()
	registerRelayRoutes(mux, hub)

	req := httptest.NewRequest(http.MethodGet, "/relay/health", nil)
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var response map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	if response["mode"] != "bootstrap" {
		t.Fatalf("unexpected relay mode: %#v", response["mode"])
	}
	revocation, ok := response["revocation"].(map[string]any)
	if !ok {
		t.Fatal("relay health should include revocation status")
	}
	if revocation["minEpoch"] == nil {
		t.Fatalf("relay revocation status missing minEpoch: %#v", revocation)
	}
}

func signedRelayCapability(t *testing.T, nodeID string, revocationEpoch int) RelayCapability {
	t.Helper()
	capability, privateKey := unsignedRelayCapability(t, nodeID)
	capability.EndpointOrigins = []string{"https://relay.example"}
	capability.Signature = base64.StdEncoding.EncodeToString(
		ed25519.Sign(privateKey, canonicalRelayAnnouncement(capability, revocationEpoch)),
	)
	return capability
}

func legacySignedRelayCapability(t *testing.T, nodeID string, revocationEpoch int) RelayCapability {
	t.Helper()
	capability, privateKey := unsignedRelayCapability(t, nodeID)
	capability.Signature = base64.StdEncoding.EncodeToString(
		ed25519.Sign(privateKey, canonicalRelayAnnouncementV1(capability, revocationEpoch)),
	)
	return capability
}

func unsignedRelayCapability(t *testing.T, nodeID string) (RelayCapability, ed25519.PrivateKey) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate relay key: %v", err)
	}
	capability := RelayCapability{
		NodeID:        nodeID,
		PublicKey:     base64.StdEncoding.EncodeToString(publicKey),
		Transports:    []string{"central_ws", "mesh_relay"},
		RegionHint:    "eu",
		CapacityClass: "small",
		ExpiresAt:     time.Now().UTC().Add(time.Hour).Truncate(time.Second),
	}
	return capability, privateKey
}
