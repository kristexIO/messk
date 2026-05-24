package main

import "sync"

var operationalEventNames = map[string]string{
	"rate_limit_exceeded":             "rateLimitExceeded",
	"session_auth_failed":             "sessionAuthFailed",
	"download_auth_failed":            "downloadAuthFailed",
	"ws_auth_failed":                  "wsAuthFailed",
	"ws_stale_client_rejected":        "staleClientRejected",
	"ws_origin_rejected":              "wsOriginRejected",
	"ws_disconnected":                 "wsDisconnected",
	"upload_rejected":                 "uploadRejected",
	"upload_store_failed":             "uploadStoreFailed",
	"upload_succeeded":                "uploadSucceeded",
	"relay_announce_auth_failed":      "relayAnnounceAuthFailed",
	"relay_announce_signature_failed": "relayAnnounceSignatureFailed",
}

type operationalEventCounter struct {
	mu     sync.RWMutex
	counts map[string]uint64
}

var defaultOperationalEventCounter = newOperationalEventCounter()

func newOperationalEventCounter() *operationalEventCounter {
	return &operationalEventCounter{counts: make(map[string]uint64)}
}

func (c *operationalEventCounter) Record(event string) {
	name, ok := operationalEventNames[event]
	if !ok {
		return
	}
	c.mu.Lock()
	c.counts[name]++
	c.mu.Unlock()
}

func (c *operationalEventCounter) Snapshot() map[string]uint64 {
	c.mu.RLock()
	defer c.mu.RUnlock()
	snapshot := make(map[string]uint64, len(operationalEventNames))
	for _, name := range operationalEventNames {
		snapshot[name] = c.counts[name]
	}
	return snapshot
}
