package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"testing"
	"time"
)

func TestBuildRelayAnnouncementSignsCanonicalCapability(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = byte(index + 1)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	request, err := buildRelayAnnouncement(
		privateKey,
		"relay-test",
		"fallback_wss,central_ws,central_ws",
		"https://b.example/;https://a.example",
		"EU-West!!",
		"small",
		time.Hour,
		2,
		false,
		time.Date(2026, 5, 18, 12, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatalf("build relay announcement: %v", err)
	}

	capability := request.Capability
	if got := capability.Transports; len(got) != 2 || got[0] != "central_ws" || got[1] != "fallback_wss" {
		t.Fatalf("unexpected transports: %#v", got)
	}
	if got := capability.EndpointOrigins; len(got) != 2 || got[0] != "https://a.example" || got[1] != "https://b.example" {
		t.Fatalf("unexpected endpoint origins: %#v", got)
	}
	if capability.RegionHint != "eu-west" {
		t.Fatalf("unexpected region hint: %q", capability.RegionHint)
	}
	signature, err := base64.StdEncoding.DecodeString(capability.Signature)
	if err != nil {
		t.Fatalf("decode signature: %v", err)
	}
	if !ed25519.Verify(privateKey.Public().(ed25519.PublicKey), canonicalRelayAnnouncement(capability, 2), signature) {
		t.Fatal("signature should verify against canonical relay announcement")
	}
}

func TestBuildRelayAnnouncementRequiresEndpointOriginsForWebTransports(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	_, err = buildRelayAnnouncement(
		privateKey,
		"relay-test",
		"fallback_wss",
		"",
		"",
		"small",
		time.Hour,
		0,
		false,
		time.Now(),
	)
	if err == nil {
		t.Fatal("expected missing endpoint origins to fail for fallback_wss")
	}
}

func TestNormalizeEndpointOriginsRejectsNonOrigins(t *testing.T) {
	origins, err := normalizeEndpointOrigins([]string{
		"https://Relay.Example/",
		"https://relay.example",
		"http://127.0.0.1:8080/",
	})
	if err != nil {
		t.Fatalf("normalize endpoints: %v", err)
	}
	if len(origins) != 2 || origins[0] != "http://127.0.0.1:8080" || origins[1] != "https://relay.example" {
		t.Fatalf("unexpected origins: %#v", origins)
	}
	if _, err := normalizeEndpointOrigins([]string{"https://relay.example/path"}); err == nil {
		t.Fatal("expected pathful endpoint origin to fail")
	}
	if _, err := normalizeEndpointOrigins([]string{"wss://relay.example"}); err == nil {
		t.Fatal("expected wss endpoint origin to fail")
	}
}

func TestParsePrivateKeyAcceptsSeedAndFullPrivateKey(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = byte(index)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	fromSeed, err := parsePrivateKey(base64.StdEncoding.EncodeToString(seed))
	if err != nil {
		t.Fatalf("parse seed: %v", err)
	}
	fromPrivate, err := parsePrivateKey(base64.StdEncoding.EncodeToString(privateKey))
	if err != nil {
		t.Fatalf("parse private key: %v", err)
	}
	if base64.StdEncoding.EncodeToString(fromSeed) != base64.StdEncoding.EncodeToString(fromPrivate) {
		t.Fatal("seed and private key should produce the same private key")
	}
}

func TestValidateRefreshIntervalKeepsCapabilityFresh(t *testing.T) {
	if err := validateRefreshInterval(12*time.Hour, 6*time.Hour); err != nil {
		t.Fatalf("expected valid refresh interval: %v", err)
	}
	if err := validateRefreshInterval(12*time.Hour, 0); err != nil {
		t.Fatalf("one-shot mode should be valid: %v", err)
	}
	if err := validateRefreshInterval(12*time.Hour, 12*time.Hour); err == nil {
		t.Fatal("expected refresh interval equal to ttl to fail")
	}
	if err := validateRefreshInterval(12*time.Hour, -time.Second); err == nil {
		t.Fatal("expected negative refresh interval to fail")
	}
}

func TestNextRefreshDelayRetriesFailuresSooner(t *testing.T) {
	if delay := nextRefreshDelay(6*time.Hour, false); delay != 6*time.Hour {
		t.Fatalf("unexpected success delay: %s", delay)
	}
	if delay := nextRefreshDelay(6*time.Hour, true); delay != time.Minute {
		t.Fatalf("unexpected failed delay: %s", delay)
	}
	if delay := nextRefreshDelay(30*time.Second, true); delay != 30*time.Second {
		t.Fatalf("unexpected short failed delay: %s", delay)
	}
}
