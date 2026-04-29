package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAuthorizeSessionSilentlyWithHeader(t *testing.T) {
	hub := NewHub(nil, nil, nil)
	hub.StoreSessionToken("token-123", "pub-key", "test-agent", "127.0.0.1")

	req := httptest.NewRequest(http.MethodGet, "/upload", nil)
	req.Header.Set("X-Session-Token", "token-123")

	pubKey, ok := authorizeSessionSilently(hub, req)
	if !ok {
		t.Fatalf("expected session token to validate")
	}
	if pubKey != "pub-key" {
		t.Fatalf("unexpected pub key: %s", pubKey)
	}
}

func TestValidateSessionTokenRejectsExpiredToken(t *testing.T) {
	hub := NewHub(nil, nil, nil)
	hub.sessionTokens.Store("expired", sessionTokenEntry{
		PubKey:    "pub-key",
		ExpiresAt: time.Now().Add(-time.Minute),
	})

	if _, ok := hub.ValidateSessionToken("expired"); ok {
		t.Fatal("expected expired session token to be rejected")
	}
	if _, exists := hub.sessionTokens.Load("expired"); exists {
		t.Fatal("expected expired session token to be deleted")
	}
}

func TestAuthorizeDownloadWithFileToken(t *testing.T) {
	hub := NewHub(nil, nil, nil)
	hub.StoreFileToken("file-token", "secret.bin")

	req := httptest.NewRequest(http.MethodGet, "/download/secret.bin?token=file-token", nil)
	rec := httptest.NewRecorder()

	if !authorizeDownload(hub, rec, req, "secret.bin") {
		t.Fatalf("expected file token to authorize download")
	}
}

func TestValidateFileTokenRejectsExpiredToken(t *testing.T) {
	hub := NewHub(nil, nil, nil)
	hub.fileTokens.Store("expired", fileTokenEntry{
		Filename:  "secret.bin",
		ExpiresAt: time.Now().Add(-time.Minute),
	})

	if hub.ValidateFileToken("expired", "secret.bin") {
		t.Fatal("expected expired file token to be rejected")
	}
	if _, exists := hub.fileTokens.Load("expired"); exists {
		t.Fatal("expected expired file token to be deleted")
	}
}

func TestCleanupExpiredTokensRemovesSessionAndFileTokens(t *testing.T) {
	hub := NewHub(nil, nil, nil)
	now := time.Date(2026, 4, 28, 12, 0, 0, 0, time.UTC)
	hub.sessionTokens.Store("expired-session", sessionTokenEntry{
		PubKey:    "alice",
		ExpiresAt: now.Add(-time.Second),
	})
	hub.sessionTokens.Store("fresh-session", sessionTokenEntry{
		PubKey:    "bob",
		ExpiresAt: now.Add(time.Hour),
	})
	hub.fileTokens.Store("expired-file", fileTokenEntry{
		Filename:  "secret.bin",
		ExpiresAt: now.Add(-time.Second),
	})
	hub.fileTokens.Store("fresh-file", fileTokenEntry{
		Filename:  "photo.bin",
		ExpiresAt: now.Add(time.Hour),
	})

	hub.cleanupExpiredTokens(now)

	if _, exists := hub.sessionTokens.Load("expired-session"); exists {
		t.Fatal("expected expired session token to be cleaned")
	}
	if _, exists := hub.fileTokens.Load("expired-file"); exists {
		t.Fatal("expected expired file token to be cleaned")
	}
	if _, exists := hub.sessionTokens.Load("fresh-session"); !exists {
		t.Fatal("expected fresh session token to remain")
	}
	if _, exists := hub.fileTokens.Load("fresh-file"); !exists {
		t.Fatal("expected fresh file token to remain")
	}
}

func TestAuthorizeDownloadWithSessionRequiresACL(t *testing.T) {
	hub := NewHub(nil, nil, nil)
	hub.StoreSessionToken("session-123", "alice", "test-agent", "127.0.0.1")
	hub.StoreFileAccess("secret.bin", "alice", "bob")

	req := httptest.NewRequest(http.MethodGet, "/download/secret.bin", nil)
	req.Header.Set("X-Session-Token", "session-123")
	rec := httptest.NewRecorder()

	if !authorizeDownload(hub, rec, req, "secret.bin") {
		t.Fatalf("expected ACL-authorized session to download file")
	}
}

func TestStoreFileAccessSupportsGroupACLs(t *testing.T) {
	hub := NewHub(nil, nil, nil)
	hub.StoreFileAccess("group.bin", "alice", "bob", "carol")

	if !hub.ValidateFileAccess("group.bin", "carol") {
		t.Fatal("expected group member to have download access")
	}
	if hub.ValidateFileAccess("group.bin", "mallory") {
		t.Fatal("expected non-member to be rejected")
	}
}

func TestAuthorizeDownloadRejectsSessionOutsideACL(t *testing.T) {
	hub := NewHub(nil, nil, nil)
	hub.StoreSessionToken("session-123", "mallory", "test-agent", "127.0.0.1")
	hub.StoreFileAccess("secret.bin", "alice", "bob")

	req := httptest.NewRequest(http.MethodGet, "/download/secret.bin", nil)
	req.Header.Set("X-Session-Token", "session-123")
	rec := httptest.NewRecorder()

	if authorizeDownload(hub, rec, req, "secret.bin") {
		t.Fatalf("expected session outside ACL to be rejected")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestAuthorizeDownloadRejectsInvalidToken(t *testing.T) {
	hub := NewHub(nil, nil, nil)
	req := httptest.NewRequest(http.MethodGet, "/download/secret.bin?token=bad-token", nil)
	rec := httptest.NewRecorder()

	if authorizeDownload(hub, rec, req, "secret.bin") {
		t.Fatalf("expected invalid token to be rejected")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestAllowedUploadContentTypes(t *testing.T) {
	t.Setenv("ALLOWED_UPLOAD_MIME_TYPES", "application/octet-stream,image/png")

	if !isAllowedUploadContentType("application/octet-stream") {
		t.Fatal("expected encrypted upload content type to be allowed")
	}
	if !isAllowedUploadContentType("image/png; charset=binary") {
		t.Fatal("expected configured image/png content type to be allowed")
	}
	if isAllowedUploadContentType("text/html") {
		t.Fatal("expected text/html to be rejected")
	}
}

func TestNewUploadFilenameDoesNotLeakOriginalName(t *testing.T) {
	filename, err := newUploadFilename("../../private Vacation Photo.PNG")
	if err != nil {
		t.Fatalf("failed to create upload filename: %v", err)
	}

	if strings.Contains(strings.ToLower(filename), "vacation") || strings.Contains(filename, "..") {
		t.Fatalf("filename leaked original metadata: %s", filename)
	}
	if !strings.HasSuffix(filename, ".png") {
		t.Fatalf("expected safe lowercase extension, got %s", filename)
	}
}

func TestNewUploadFilenameFallsBackForUnsafeExtension(t *testing.T) {
	filename, err := newUploadFilename("payload.bad-ext!")
	if err != nil {
		t.Fatalf("failed to create upload filename: %v", err)
	}

	if !strings.HasSuffix(filename, ".bin") {
		t.Fatalf("expected unsafe extension fallback, got %s", filename)
	}
}

func TestNewUploadFilenameFallsBackForExecutableExtension(t *testing.T) {
	filename, err := newUploadFilename("invoice.exe")
	if err != nil {
		t.Fatalf("failed to create upload filename: %v", err)
	}

	if !strings.HasSuffix(filename, ".bin") {
		t.Fatalf("expected executable extension fallback, got %s", filename)
	}
}

func TestProxyAddressPolicyBlocksPrivateAndAllowsPublic(t *testing.T) {
	privateAddr := netip.MustParseAddr("127.0.0.1")
	publicAddr := netip.MustParseAddr("8.8.8.8")

	if !isForbiddenProxyAddr(privateAddr) {
		t.Fatal("expected private loopback address to be forbidden")
	}
	if isForbiddenProxyAddr(publicAddr) {
		t.Fatal("expected public global address to be allowed")
	}
}

func TestProxyRedirectPolicyBlocksLoopbackRedirect(t *testing.T) {
	client := newSafeProxyClient(time.Second)
	redirectReq := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/internal", nil)
	firstReq := httptest.NewRequest(http.MethodGet, "https://example.com/start", nil)

	err := client.CheckRedirect(redirectReq, []*http.Request{firstReq})
	if !errors.Is(err, errForbiddenProxyTarget) {
		t.Fatalf("expected loopback redirect to be blocked, got %v", err)
	}
}

func TestSanitizeMemberPubKeysDeduplicatesOwnerAndMembers(t *testing.T) {
	owner := base64.StdEncoding.EncodeToString([]byte("12345678901234567890123456789012"))
	member := base64.StdEncoding.EncodeToString([]byte("abcdefghijklmnopqrstuvwxyz123456"))

	members, err := sanitizeMemberPubKeys([]string{member, owner, member, ""}, owner)
	if err != nil {
		t.Fatalf("sanitize failed: %v", err)
	}
	if len(members) != 1 || members[0] != member {
		t.Fatalf("expected one unique non-owner member, got %#v", members)
	}
}

func TestSanitizeMemberPubKeysRejectsInvalidKeys(t *testing.T) {
	owner := base64.StdEncoding.EncodeToString([]byte("12345678901234567890123456789012"))

	if _, err := sanitizeMemberPubKeys([]string{"not-a-valid-key"}, owner); err == nil {
		t.Fatal("expected invalid member key to be rejected")
	}
}

func TestWebSocketOriginUsesAllowedOrigins(t *testing.T) {
	t.Setenv("ALLOWED_ORIGINS", "https://app.example.com,https://admin.example.com")

	if !isAllowedWebSocketOrigin("https://app.example.com") {
		t.Fatal("expected configured websocket origin to be allowed")
	}
	if isAllowedWebSocketOrigin("https://evil.example.com") {
		t.Fatal("expected unconfigured websocket origin to be rejected")
	}
}

func TestWebSocketOriginAllowsNonBrowserClients(t *testing.T) {
	if !isAllowedWebSocketOrigin("") {
		t.Fatal("expected empty origin to be allowed for non-browser clients")
	}
}

func TestServeWsRejectsInvalidPublicKeyBeforeUpgrade(t *testing.T) {
	hub := NewHub(nil, nil, nil)
	req := httptest.NewRequest(http.MethodGet, "/ws?pub=not-base64", nil)
	rec := httptest.NewRecorder()

	serveWs(hub, rec, req, context.Background())

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestNormalizeRoutedEnvelopeOverwritesSender(t *testing.T) {
	sender := base64.StdEncoding.EncodeToString([]byte("12345678901234567890123456789012"))
	recipient := base64.StdEncoding.EncodeToString([]byte("abcdefghijklmnopqrstuvwxyz123456"))

	payload, ok := normalizeRoutedEnvelope(Envelope{
		Type:            "message",
		MsgID:           "msg-1",
		SenderPubKey:    "spoofed",
		RecipientPubKey: recipient,
		Data:            json.RawMessage(`"ciphertext"`),
	}, sender)

	if !ok {
		t.Fatal("expected valid envelope")
	}

	var normalized Envelope
	if err := json.Unmarshal(payload, &normalized); err != nil {
		t.Fatalf("failed to decode normalized envelope: %v", err)
	}
	if normalized.SenderPubKey != sender {
		t.Fatalf("expected sender to be overwritten, got %q", normalized.SenderPubKey)
	}
}

func TestNormalizeRoutedEnvelopePreservesReaction(t *testing.T) {
	sender := base64.StdEncoding.EncodeToString([]byte("12345678901234567890123456789012"))
	recipient := base64.StdEncoding.EncodeToString([]byte("abcdefghijklmnopqrstuvwxyz123456"))

	payload, ok := normalizeRoutedEnvelope(Envelope{
		Type:            "reaction",
		MsgID:           "msg-1",
		RecipientPubKey: recipient,
		Reaction:        "👍",
	}, sender)

	if !ok {
		t.Fatal("expected valid reaction envelope")
	}

	var normalized Envelope
	if err := json.Unmarshal(payload, &normalized); err != nil {
		t.Fatalf("failed to decode normalized reaction envelope: %v", err)
	}
	if normalized.Reaction != "👍" {
		t.Fatalf("expected reaction to be preserved, got %q", normalized.Reaction)
	}
	if normalized.SenderPubKey != sender {
		t.Fatalf("expected sender to be overwritten, got %q", normalized.SenderPubKey)
	}
}

func TestNormalizeRoutedEnvelopeAllowsGroupEvents(t *testing.T) {
	sender := base64.StdEncoding.EncodeToString([]byte("12345678901234567890123456789012"))

	payload, ok := normalizeRoutedEnvelope(Envelope{
		Type:        "group_reaction",
		MsgID:       "evt-1",
		TargetMsgID: "msg-1",
		GroupID:     "grp_test",
		Data:        json.RawMessage(`"ciphertext"`),
	}, sender)

	if !ok {
		t.Fatal("expected valid group envelope")
	}

	var normalized Envelope
	if err := json.Unmarshal(payload, &normalized); err != nil {
		t.Fatalf("failed to decode normalized group envelope: %v", err)
	}
	if normalized.GroupID != "grp_test" {
		t.Fatalf("expected group id to be preserved, got %q", normalized.GroupID)
	}
	if normalized.TargetMsgID != "msg-1" {
		t.Fatalf("expected target msg id to be preserved, got %q", normalized.TargetMsgID)
	}
	if normalized.SenderPubKey != sender {
		t.Fatalf("expected sender to be overwritten, got %q", normalized.SenderPubKey)
	}
}

func TestNormalizeRoutedEnvelopeRequiresMessageID(t *testing.T) {
	sender := base64.StdEncoding.EncodeToString([]byte("12345678901234567890123456789012"))
	recipient := base64.StdEncoding.EncodeToString([]byte("abcdefghijklmnopqrstuvwxyz123456"))

	if _, ok := normalizeRoutedEnvelope(Envelope{
		Type:            "message",
		RecipientPubKey: recipient,
		Data:            json.RawMessage(`"ciphertext"`),
	}, sender); ok {
		t.Fatal("expected message without msg_id to be rejected")
	}

	if _, ok := normalizeRoutedEnvelope(Envelope{
		Type:            "typing",
		RecipientPubKey: recipient,
	}, sender); !ok {
		t.Fatal("expected typing without msg_id to be allowed")
	}
}

func TestNormalizeRoutedEnvelopeRejectsInvalidRecipient(t *testing.T) {
	sender := base64.StdEncoding.EncodeToString([]byte("12345678901234567890123456789012"))

	if _, ok := normalizeRoutedEnvelope(Envelope{
		Type:            "message",
		RecipientPubKey: "bad-recipient",
		Data:            json.RawMessage(`"ciphertext"`),
	}, sender); ok {
		t.Fatal("expected invalid recipient to be rejected")
	}
}

func TestPreKeyValidation(t *testing.T) {
	first := base64.StdEncoding.EncodeToString([]byte("12345678901234567890123456789012"))
	second := base64.StdEncoding.EncodeToString([]byte("abcdefghijklmnopqrstuvwxyz123456"))

	if !areValidPreKeys([]string{first, second}) {
		t.Fatal("expected valid prekeys")
	}
	if areValidPreKeys([]string{first, first}) {
		t.Fatal("expected duplicate prekeys to be rejected")
	}
	if areValidPreKeys([]string{"bad-key"}) {
		t.Fatal("expected malformed prekey to be rejected")
	}
}

func TestStatusRecorderCapturesHTTPStatus(t *testing.T) {
	rec := httptest.NewRecorder()
	statusRec := &statusRecorder{
		ResponseWriter: rec,
		statusCode:     http.StatusOK,
	}

	statusRec.WriteHeader(http.StatusTeapot)

	if statusRec.statusCode != http.StatusTeapot {
		t.Fatalf("expected recorded status %d, got %d", http.StatusTeapot, statusRec.statusCode)
	}
	if rec.Code != http.StatusTeapot {
		t.Fatalf("expected response status %d, got %d", http.StatusTeapot, rec.Code)
	}
}

func TestIPRateLimiterUsesHostWithoutPort(t *testing.T) {
	now := time.Date(2026, 4, 24, 12, 0, 0, 0, time.UTC)
	limiter := newIPRateLimiter(func() int { return 1 }, time.Minute)
	limiter.now = func() time.Time { return now }

	if ok, _ := limiter.allow("192.0.2.10:1000"); !ok {
		t.Fatal("expected first request to be allowed")
	}
	if ok, retryAfter := limiter.allow("192.0.2.10:2000"); ok || retryAfter <= 0 {
		t.Fatalf("expected second request from same IP to be limited, ok=%v retryAfter=%v", ok, retryAfter)
	}
}

func TestIPRateLimiterCleansExpiredBuckets(t *testing.T) {
	now := time.Date(2026, 4, 24, 12, 0, 0, 0, time.UTC)
	limiter := newIPRateLimiter(func() int { return 1 }, time.Minute)
	limiter.now = func() time.Time { return now }

	limiter.allow("192.0.2.10:1000")
	now = now.Add(2 * time.Minute)

	if ok, _ := limiter.allow("192.0.2.10:1000"); !ok {
		t.Fatal("expected request after reset window to be allowed")
	}
	if len(limiter.clients) != 1 {
		t.Fatalf("expected expired buckets to be cleaned, got %d", len(limiter.clients))
	}
}

func TestRateLimitMiddlewareReturnsRetryAfter(t *testing.T) {
	originalLimiter := defaultRateLimiter
	t.Cleanup(func() {
		defaultRateLimiter = originalLimiter
	})

	now := time.Date(2026, 4, 24, 12, 0, 0, 0, time.UTC)
	defaultRateLimiter = newIPRateLimiter(func() int { return 0 }, time.Minute)
	defaultRateLimiter.now = func() time.Time { return now }

	req := httptest.NewRequest(http.MethodGet, "/limited", nil)
	req.RemoteAddr = "192.0.2.10:1000"
	rec := httptest.NewRecorder()

	rateLimit(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("expected Retry-After header")
	}
}

func TestHealthEndpointReportsServiceStatus(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "health.db")
	db := InitDB(ctx, dbPath)
	defer db.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		healthCtx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()

		dbStatus := "ok"
		if err := db.Ping(healthCtx); err != nil {
			dbStatus = "error"
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "ok",
			"services": map[string]string{
				"database": dbStatus,
				"cache":    "ok",
				"redis":    "disabled",
			},
		})
	})

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var body struct {
		Status   string            `json:"status"`
		Services map[string]string `json:"services"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to decode body: %v", err)
	}
	if body.Status != "ok" {
		t.Fatalf("unexpected status: %s", body.Status)
	}
	if body.Services["database"] != "ok" {
		t.Fatalf("unexpected database status: %s", body.Services["database"])
	}
}

func TestSecurityHeadersMiddleware(t *testing.T) {
	handler := securityHeadersMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	expected := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "no-referrer",
		"Permissions-Policy":     "camera=(self), microphone=(self), geolocation=()",
	}

	for header, want := range expected {
		if got := rec.Header().Get(header); got != want {
			t.Fatalf("expected %s=%q, got %q", header, want, got)
		}
	}
	if got := rec.Header().Get("Strict-Transport-Security"); got != "" {
		t.Fatalf("expected HSTS to be omitted for HTTP, got %q", got)
	}
}

func TestSecurityHeadersMiddlewareSetsHSTSForTLS(t *testing.T) {
	handler := securityHeadersMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "https://example.com/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Strict-Transport-Security"); got != "max-age=31536000; includeSubDomains" {
		t.Fatalf("unexpected HSTS header: %q", got)
	}
}

func TestVersionHandler(t *testing.T) {
	originalVersion := appVersion
	originalCommit := commitSHA
	originalBuildTime := buildTime
	t.Cleanup(func() {
		appVersion = originalVersion
		commitSHA = originalCommit
		buildTime = originalBuildTime
	})

	appVersion = "1.2.3"
	commitSHA = "abc123"
	buildTime = "2026-04-24T12:00:00Z"

	req := httptest.NewRequest(http.MethodGet, "/version", nil)
	rec := httptest.NewRecorder()
	versionHandler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if body["version"] != appVersion || body["commit"] != commitSHA || body["builtAt"] != buildTime {
		t.Fatalf("unexpected version payload: %#v", body)
	}
}

func TestVersionHandlerRejectsNonGet(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/version", nil)
	rec := httptest.NewRecorder()
	versionHandler(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

func TestGroupLifecycle(t *testing.T) {
	ctx := context.Background()
	db := InitDB(ctx, filepath.Join(t.TempDir(), "groups.db"))
	defer db.Close()

	owner := base64.StdEncoding.EncodeToString([]byte("12345678901234567890123456789012"))
	member := base64.StdEncoding.EncodeToString([]byte("abcdefghijklmnopqrstuvwxyz123456"))

	if err := db.SaveUserIfNotExists(ctx, owner); err != nil {
		t.Fatalf("failed to save owner: %v", err)
	}
	if err := db.SaveUserIfNotExists(ctx, member); err != nil {
		t.Fatalf("failed to save member: %v", err)
	}
	if err := db.CreateGroup(ctx, "grp_test", "Release Squad", "", owner, []string{member}); err != nil {
		t.Fatalf("failed to create group: %v", err)
	}

	memberGroups, err := db.ListGroupsForUser(ctx, member)
	if err != nil {
		t.Fatalf("failed to list member groups: %v", err)
	}
	if len(memberGroups) != 1 || memberGroups[0].ID != "grp_test" {
		t.Fatalf("expected member to see created group, got %#v", memberGroups)
	}

	groupMembers, err := db.ListGroupMembers(ctx, "grp_test")
	if err != nil {
		t.Fatalf("failed to list group members: %v", err)
	}
	if len(groupMembers) != 2 {
		t.Fatalf("expected 2 group members, got %d", len(groupMembers))
	}
}

func TestCreateGroupCreatesMissingUsersForMembers(t *testing.T) {
	ctx := context.Background()
	db := InitDB(ctx, filepath.Join(t.TempDir(), "groups_missing_users.db"))
	defer db.Close()

	owner := base64.StdEncoding.EncodeToString([]byte("12345678901234567890123456789012"))
	member := base64.StdEncoding.EncodeToString([]byte("abcdefghijklmnopqrstuvwxyz123456"))

	if err := db.CreateGroup(ctx, "grp_missing_users", "Zero Setup", "", owner, []string{member}); err != nil {
		t.Fatalf("failed to create group with missing users: %v", err)
	}

	memberGroups, err := db.ListGroupsForUser(ctx, member)
	if err != nil {
		t.Fatalf("failed to list member groups: %v", err)
	}
	if len(memberGroups) != 1 || memberGroups[0].ID != "grp_missing_users" {
		t.Fatalf("expected member to see group created without preexisting user row, got %#v", memberGroups)
	}
}

func TestDispatchGroupInvitesQueuesOfflineInvite(t *testing.T) {
	ctx := context.Background()
	db := InitDB(ctx, filepath.Join(t.TempDir(), "group_invites.db"))
	defer db.Close()

	owner := base64.StdEncoding.EncodeToString([]byte("12345678901234567890123456789012"))
	member := base64.StdEncoding.EncodeToString([]byte("abcdefghijklmnopqrstuvwxyz123456"))

	if err := db.SaveUserIfNotExists(ctx, owner); err != nil {
		t.Fatalf("failed to save owner: %v", err)
	}
	if err := db.SaveUserIfNotExists(ctx, member); err != nil {
		t.Fatalf("failed to save member: %v", err)
	}
	if err := db.CreateGroup(ctx, "grp_test", "Release Squad", "", owner, []string{member}); err != nil {
		t.Fatalf("failed to create group: %v", err)
	}

	hub := NewHub(db, nil, nil)
	if err := dispatchGroupInvites(ctx, hub, db, "grp_test", owner, []string{member}); err != nil {
		t.Fatalf("failed to dispatch group invite: %v", err)
	}

	var offlineMessages []*Message
	var err error
	for attempt := 0; attempt < 20; attempt++ {
		offlineMessages, err = db.GetAndDeleteOfflineMessages(ctx, member)
		if err != nil {
			t.Fatalf("failed to fetch offline messages: %v", err)
		}
		if len(offlineMessages) == 1 {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if len(offlineMessages) != 1 {
		t.Fatalf("expected 1 offline invite, got %d", len(offlineMessages))
	}

	var envelope Envelope
	if err := json.Unmarshal(offlineMessages[0].Payload, &envelope); err != nil {
		t.Fatalf("failed to decode invite envelope: %v", err)
	}
	if envelope.Type != "group_invite" {
		t.Fatalf("expected group_invite, got %s", envelope.Type)
	}
	if envelope.GroupID != "grp_test" {
		t.Fatalf("expected group id grp_test, got %s", envelope.GroupID)
	}
}

func TestChannelLifecycle(t *testing.T) {
	ctx := context.Background()
	db := InitDB(ctx, filepath.Join(t.TempDir(), "channels.db"))
	defer db.Close()

	owner := base64.StdEncoding.EncodeToString([]byte("12345678901234567890123456789012"))
	subscriber := base64.StdEncoding.EncodeToString([]byte("abcdefghijklmnopqrstuvwxyz123456"))

	if err := db.SaveUserIfNotExists(ctx, owner); err != nil {
		t.Fatalf("failed to save owner: %v", err)
	}
	if err := db.SaveUserIfNotExists(ctx, subscriber); err != nil {
		t.Fatalf("failed to save subscriber: %v", err)
	}
	if err := db.CreateChannel(ctx, "chn_test", "Announcements", "", owner); err != nil {
		t.Fatalf("failed to create channel: %v", err)
	}
	if err := db.AddChannelSubscriber(ctx, "chn_test", subscriber); err != nil {
		t.Fatalf("failed to add subscriber: %v", err)
	}

	subscriberChannels, err := db.ListChannelsForUser(ctx, subscriber)
	if err != nil {
		t.Fatalf("failed to list subscriber channels: %v", err)
	}
	if len(subscriberChannels) != 1 || subscriberChannels[0].ID != "chn_test" {
		t.Fatalf("expected subscriber to see created channel, got %#v", subscriberChannels)
	}

	channelSubscribers, err := db.ListChannelSubscribers(ctx, "chn_test")
	if err != nil {
		t.Fatalf("failed to list channel subscribers: %v", err)
	}
	if len(channelSubscribers) != 2 {
		t.Fatalf("expected 2 channel subscribers, got %d", len(channelSubscribers))
	}
}

func TestSplitScopedPath(t *testing.T) {
	id, tail, ok := splitScopedPath("/groups/grp_123/members", "/groups/")
	if !ok {
		t.Fatal("expected path to split")
	}
	if id != "grp_123" || tail != "members" {
		t.Fatalf("unexpected split result: %s %s", id, tail)
	}
}
