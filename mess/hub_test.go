package main

import (
	"context"
	"encoding/base64"
	"path/filepath"
	"testing"
	"time"
)

func newTestClient(pubKey string) *Client {
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{
		PubKey: pubKey,
		send:   make(chan []byte, 4),
		ctx:    ctx,
		cancel: cancel,
	}
}

func TestRouteToLocalDeliversMessageToRecipientAndSenderSessions(t *testing.T) {
	hub := NewHub(nil, nil, nil)
	recipient := newTestClient("recipient")
	senderMirror := newTestClient("sender")

	hub.clients["recipient"] = map[*Client]bool{recipient: true}
	hub.clients["sender"] = map[*Client]bool{senderMirror: true}

	msg := &Message{
		Type:            "message",
		SenderPubKey:    "sender",
		RecipientPubKey: "recipient",
		Payload:         []byte(`{"type":"message","msg_id":"1"}`),
	}

	hub.routeToLocal(msg, true)

	select {
	case got := <-recipient.send:
		if string(got) != string(msg.Payload) {
			t.Fatalf("recipient payload mismatch: %s", string(got))
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("recipient did not receive routed message")
	}

	select {
	case got := <-senderMirror.send:
		if string(got) != string(msg.Payload) {
			t.Fatalf("sender mirror payload mismatch: %s", string(got))
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("sender mirror did not receive sync copy")
	}
}

func TestRouteToLocalDoesNotMirrorTypingToSenderSessions(t *testing.T) {
	hub := NewHub(nil, nil, nil)
	recipient := newTestClient("recipient")
	senderMirror := newTestClient("sender")

	hub.clients["recipient"] = map[*Client]bool{recipient: true}
	hub.clients["sender"] = map[*Client]bool{senderMirror: true}

	msg := &Message{
		Type:            "typing",
		SenderPubKey:    "sender",
		RecipientPubKey: "recipient",
		Payload:         []byte(`{"type":"typing"}`),
	}

	hub.routeToLocal(msg, true)

	select {
	case <-recipient.send:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("recipient did not receive typing event")
	}

	select {
	case <-senderMirror.send:
		t.Fatal("typing event should not be mirrored to sender sessions")
	case <-time.After(200 * time.Millisecond):
	}
}

func TestRouteToLocalStoresOfflineMessageForUndeliveredRecipient(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "messenger-test.db")
	db := InitDB(ctx, dbPath)
	defer db.Close()

	if err := db.SaveUserIfNotExists(ctx, "sender"); err != nil {
		t.Fatalf("save sender user: %v", err)
	}
	if err := db.SaveUserIfNotExists(ctx, "recipient"); err != nil {
		t.Fatalf("save recipient user: %v", err)
	}

	hub := NewHub(db, InitCache(), nil)
	msg := &Message{
		Type:            "message",
		SenderPubKey:    "sender",
		RecipientPubKey: "recipient",
		Payload:         []byte(`{"type":"message","msg_id":"offline-1"}`),
	}

	hub.routeToLocal(msg, true)

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		stored, err := db.GetAndDeleteOfflineMessages(ctx, "recipient")
		if err != nil {
			t.Fatalf("read offline messages: %v", err)
		}
		if len(stored) > 0 {
			if string(stored[0].Payload) != string(msg.Payload) {
				t.Fatalf("offline payload mismatch: %s", string(stored[0].Payload))
			}
			return
		}
		time.Sleep(25 * time.Millisecond)
	}

	t.Fatal("expected offline message to be stored")
}

func TestRouteToLocalDoesNotStoreOfflineTypingEvents(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "messenger-test.db")
	db := InitDB(ctx, dbPath)
	defer db.Close()

	if err := db.SaveUserIfNotExists(ctx, "sender"); err != nil {
		t.Fatalf("save sender user: %v", err)
	}
	if err := db.SaveUserIfNotExists(ctx, "recipient"); err != nil {
		t.Fatalf("save recipient user: %v", err)
	}

	hub := NewHub(db, InitCache(), nil)
	msg := &Message{
		Type:            "typing",
		SenderPubKey:    "sender",
		RecipientPubKey: "recipient",
		Payload:         []byte(`{"type":"typing"}`),
	}

	hub.routeToLocal(msg, true)
	time.Sleep(150 * time.Millisecond)

	stored, err := db.GetAndDeleteOfflineMessages(ctx, "recipient")
	if err != nil {
		t.Fatalf("read offline messages: %v", err)
	}
	if len(stored) != 0 {
		t.Fatalf("expected no offline entries for typing events, got %d", len(stored))
	}
}

func TestSaveOfflineMessageDeduplicatesByMessageID(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "messenger-test.db")
	db := InitDB(ctx, dbPath)
	defer db.Close()

	if err := db.SaveUserIfNotExists(ctx, "sender"); err != nil {
		t.Fatalf("save sender user: %v", err)
	}
	if err := db.SaveUserIfNotExists(ctx, "recipient"); err != nil {
		t.Fatalf("save recipient user: %v", err)
	}

	payload := []byte(`{"type":"message","msg_id":"dupe-1","recipient_pub_key":"recipient"}`)
	if err := db.SaveOfflineMessage(ctx, "sender", "recipient", payload); err != nil {
		t.Fatalf("first save failed: %v", err)
	}
	if err := db.SaveOfflineMessage(ctx, "sender", "recipient", payload); err != nil {
		t.Fatalf("second save failed: %v", err)
	}

	stored, err := db.GetAndDeleteOfflineMessages(ctx, "recipient")
	if err != nil {
		t.Fatalf("read offline messages: %v", err)
	}
	if len(stored) != 1 {
		t.Fatalf("expected a single deduplicated offline message, got %d", len(stored))
	}
}

func TestSavePreKeysDeduplicatesAndPrunes(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "messenger-test.db")
	db := InitDB(ctx, dbPath)
	defer db.Close()

	if err := db.SaveUserIfNotExists(ctx, "sender"); err != nil {
		t.Fatalf("save user: %v", err)
	}

	preKeys := make([]string, 0, 511)
	for i := 0; i < 510; i++ {
		key := make([]byte, 32)
		key[0] = byte(i)
		key[1] = byte(i >> 8)
		preKeys = append(preKeys, base64.StdEncoding.EncodeToString(key))
	}
	preKeys = append(preKeys, preKeys[0])

	if err := db.SavePreKeys(ctx, "sender", preKeys); err != nil {
		t.Fatalf("save prekeys: %v", err)
	}

	var count int
	if err := db.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM prekeys WHERE user_pub_key = ?`, "sender").Scan(&count); err != nil {
		t.Fatalf("count prekeys: %v", err)
	}
	if count != 500 {
		t.Fatalf("expected 500 retained prekeys, got %d", count)
	}
}

func TestDropClientRemovesSessionToken(t *testing.T) {
	hub := NewHub(nil, InitCache(), nil)
	client := newTestClient("sender")
	client.Token = "session-token"
	hub.clients["sender"] = map[*Client]bool{client: true}
	hub.StoreSessionToken(client.Token, client.PubKey)

	hub.dropClient(client, "test")

	if _, ok := hub.ValidateSessionToken(client.Token); ok {
		t.Fatal("expected session token to be removed when client is dropped")
	}
	if _, ok := hub.clients["sender"]; ok {
		t.Fatal("expected client map entry to be removed after final session drop")
	}
}
