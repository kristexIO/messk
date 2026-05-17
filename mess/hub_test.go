package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"strings"
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

func setTestClient(hub *Hub, client *Client) {
	if hub.clients[client.PubKey] == nil {
		hub.clients[client.PubKey] = make(map[*Client]struct{})
	}
	hub.clients[client.PubKey][client] = struct{}{}
}

func TestRouteToLocalDeliversMessageToRecipient(t *testing.T) {
	hub := NewHub(nil, nil, nil)
	recipient := newTestClient("recipient")
	senderMirror := newTestClient("sender")

	setTestClient(hub, recipient)
	setTestClient(hub, senderMirror)

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
		t.Fatal("recipient did not receive message")
	}
}

func TestSendServerAckWritesAckEnvelope(t *testing.T) {
	client := newTestClient("sender")
	client.hub = NewHub(nil, nil, nil)

	client.sendServerAck(Envelope{
		Type:  "message",
		MsgID: "ack-1",
	})

	select {
	case got := <-client.send:
		if !strings.Contains(string(got), `"type":"server_ack"`) {
			t.Fatalf("expected server_ack envelope, got %s", string(got))
		}
		if !strings.Contains(string(got), `"msg_id":"ack-1"`) {
			t.Fatalf("expected ack msg_id, got %s", string(got))
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("server ack was not sent")
	}
}

func TestRouteToLocalDoesNotMirrorTypingToSenderSessions(t *testing.T) {
	hub := NewHub(nil, nil, nil)
	recipient := newTestClient("recipient")
	senderMirror := newTestClient("sender")

	setTestClient(hub, recipient)
	setTestClient(hub, senderMirror)

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

func TestDecodeRedisRouteIgnoresSelfPublishedMessages(t *testing.T) {
	hub := NewHub(nil, nil, nil)
	payload, err := json.Marshal(redisRouteEnvelope{
		Origin: hub.instanceID,
		Message: Message{
			Type:            "message",
			SenderPubKey:    "sender",
			RecipientPubKey: "recipient",
			Payload:         []byte(`{"type":"message","msg_id":"self-echo"}`),
		},
	})
	if err != nil {
		t.Fatalf("marshal redis route: %v", err)
	}

	if _, ok := hub.decodeRedisRoute(payload); ok {
		t.Fatal("expected self-published redis route to be ignored")
	}
}

func TestDecodeRedisRouteAcceptsLegacyMessages(t *testing.T) {
	hub := NewHub(nil, nil, nil)
	payload, err := json.Marshal(Message{
		Type:            "message",
		SenderPubKey:    "sender",
		RecipientPubKey: "recipient",
		Payload:         []byte(`{"type":"message","msg_id":"legacy"}`),
	})
	if err != nil {
		t.Fatalf("marshal legacy route: %v", err)
	}

	msg, ok := hub.decodeRedisRoute(payload)
	if !ok {
		t.Fatal("expected legacy redis route to be accepted")
	}
	if string(msg.Payload) != `{"type":"message","msg_id":"legacy"}` {
		t.Fatalf("legacy payload mismatch: %s", string(msg.Payload))
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

func TestRouteToLocalPersistsDirectHistoryForRecovery(t *testing.T) {
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
		Payload:         []byte(`{"type":"message","msg_id":"history-1","sender_pub_key":"sender","recipient_pub_key":"recipient","data":"ciphertext"}`),
	}

	if !hub.routeToLocal(msg, true) {
		t.Fatal("expected direct message to be accepted")
	}
	if !hub.routeToLocal(msg, true) {
		t.Fatal("expected duplicate retry to be accepted")
	}

	records, nextCursor, err := db.ListDirectMessageHistory(ctx, "sender", "recipient", 0, 10)
	if err != nil {
		t.Fatalf("list direct history: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("expected one deduplicated history record, got %d", len(records))
	}
	if nextCursor != records[0].ID {
		t.Fatalf("expected next cursor to match record id, got %d vs %d", nextCursor, records[0].ID)
	}
	if records[0].MsgID != "history-1" || records[0].EnvelopeType != "message" {
		t.Fatalf("unexpected history record: %#v", records[0])
	}
	if records[0].DeliveryState != "waiting_delivery" {
		t.Fatalf("expected waiting_delivery state, got %q", records[0].DeliveryState)
	}
	if string(records[0].CiphertextPayload) != string(msg.Payload) {
		t.Fatalf("history payload mismatch: %s", string(records[0].CiphertextPayload))
	}
	if err := db.MarkMessageHistoryDeliveredByRecipient(ctx, "recipient", "history-1"); err != nil {
		t.Fatalf("mark delivered: %v", err)
	}
	deliveredRecords, _, err := db.ListDirectMessageHistory(ctx, "sender", "recipient", 0, 10)
	if err != nil {
		t.Fatalf("list delivered direct history: %v", err)
	}
	if deliveredRecords[0].DeliveryState != "delivered" {
		t.Fatalf("expected delivered state after ack, got %q", deliveredRecords[0].DeliveryState)
	}

	stats, err := db.Stats(ctx)
	if err != nil {
		t.Fatalf("stats failed: %v", err)
	}
	if stats.MessageHistory != 1 {
		t.Fatalf("expected one history row, got %d", stats.MessageHistory)
	}
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

func TestRouteToLocalStoresAckableSessionResetForOfflineRecipient(t *testing.T) {
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
		Type:            "session_reset",
		SenderPubKey:    "sender",
		RecipientPubKey: "recipient",
		Payload:         []byte(`{"type":"session_reset","msg_id":"reset-1","sender_pub_key":"sender","recipient_pub_key":"recipient"}`),
	}

	if !hub.routeToLocal(msg, true) {
		t.Fatal("expected ackable session reset to be accepted")
	}

	stored, err := db.ListOfflineMessages(ctx, "recipient")
	if err != nil {
		t.Fatalf("list offline messages: %v", err)
	}
	if len(stored) != 1 {
		t.Fatalf("expected one stored session reset, got %d", len(stored))
	}

	deleted, err := db.DeleteOfflineMessage(ctx, "recipient", "reset-1")
	if err != nil {
		t.Fatalf("delete reset failed: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("expected reset to be ack-deletable, got deleted=%d", deleted)
	}
}

func TestRouteToLocalDoesNotStoreLegacySessionResetWithoutMessageID(t *testing.T) {
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
		Type:            "session_reset",
		SenderPubKey:    "sender",
		RecipientPubKey: "recipient",
		Payload:         []byte(`{"type":"session_reset","sender_pub_key":"sender","recipient_pub_key":"recipient"}`),
	}

	if !hub.routeToLocal(msg, true) {
		t.Fatal("expected legacy session reset to be accepted as transient control")
	}

	stored, err := db.ListOfflineMessages(ctx, "recipient")
	if err != nil {
		t.Fatalf("list offline messages: %v", err)
	}
	if len(stored) != 0 {
		t.Fatalf("expected no unackable reset to be stored, got %d", len(stored))
	}
}

func TestRouteToLocalDoesNotStoreOfflineWebRTCEvents(t *testing.T) {
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
		Type:            "call_offer",
		SenderPubKey:    "sender",
		RecipientPubKey: "recipient",
		Payload:         []byte(`{"type":"call_offer"}`),
	}

	hub.routeToLocal(msg, true)
	time.Sleep(150 * time.Millisecond)

	stored, err := db.GetAndDeleteOfflineMessages(ctx, "recipient")
	if err != nil {
		t.Fatalf("read offline messages: %v", err)
	}
	if len(stored) != 0 {
		t.Fatalf("expected no offline entries for WebRTC events, got %d", len(stored))
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

func TestSaveOfflineMessageReplacesPayloadForRetry(t *testing.T) {
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

	firstPayload := []byte(`{"type":"message","msg_id":"retry-1","recipient_pub_key":"recipient","data":"stale"}`)
	secondPayload := []byte(`{"type":"message","msg_id":"retry-1","recipient_pub_key":"recipient","data":"fresh"}`)
	if err := db.SaveOfflineMessage(ctx, "sender", "recipient", firstPayload); err != nil {
		t.Fatalf("first save failed: %v", err)
	}
	if err := db.SaveOfflineMessage(ctx, "sender", "recipient", secondPayload); err != nil {
		t.Fatalf("second save failed: %v", err)
	}

	stored, err := db.ListOfflineMessages(ctx, "recipient")
	if err != nil {
		t.Fatalf("list offline messages: %v", err)
	}
	if len(stored) != 1 {
		t.Fatalf("expected a single offline message, got %d", len(stored))
	}
	if string(stored[0].Payload) != string(secondPayload) {
		t.Fatalf("expected retry payload to replace stale payload, got %s", string(stored[0].Payload))
	}
}

func TestListOfflineMessagesKeepsMessagesUntilAck(t *testing.T) {
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

	payload := []byte(`{"type":"message","msg_id":"ack-1","recipient_pub_key":"recipient"}`)
	if err := db.SaveOfflineMessage(ctx, "sender", "recipient", payload); err != nil {
		t.Fatalf("save failed: %v", err)
	}

	firstList, err := db.ListOfflineMessages(ctx, "recipient")
	if err != nil {
		t.Fatalf("first list failed: %v", err)
	}
	secondList, err := db.ListOfflineMessages(ctx, "recipient")
	if err != nil {
		t.Fatalf("second list failed: %v", err)
	}
	if len(firstList) != 1 || len(secondList) != 1 {
		t.Fatalf("expected message to remain until ack, got first=%d second=%d", len(firstList), len(secondList))
	}

	deleted, err := db.DeleteOfflineMessage(ctx, "recipient", "ack-1")
	if err != nil {
		t.Fatalf("delete acked message failed: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("expected one acked message deleted, got %d", deleted)
	}

	remaining, err := db.ListOfflineMessages(ctx, "recipient")
	if err != nil {
		t.Fatalf("remaining list failed: %v", err)
	}
	if len(remaining) != 0 {
		t.Fatalf("expected no messages after ack, got %d", len(remaining))
	}
}

func TestListOfflineMessagesPrunesUnackableLegacyMessage(t *testing.T) {
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

	if err := db.SaveOfflineMessage(ctx, "sender", "recipient", []byte(`{"type":"message","recipient_pub_key":"recipient","data":"stale"}`)); err != nil {
		t.Fatalf("save legacy message failed: %v", err)
	}

	stored, err := db.ListOfflineMessages(ctx, "recipient")
	if err != nil {
		t.Fatalf("list offline messages: %v", err)
	}
	if len(stored) != 0 {
		t.Fatalf("expected stale legacy message to be pruned, got %d", len(stored))
	}

	var count int
	if err := db.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM offline_messages WHERE recipient_pub_key = ?`, "recipient").Scan(&count); err != nil {
		t.Fatalf("count offline messages: %v", err)
	}
	if count != 0 {
		t.Fatalf("expected legacy message to be deleted, got %d rows", count)
	}
}

func TestListOfflineMessagesPrunesSelfAddressedDirectMessage(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "messenger-test.db")
	db := InitDB(ctx, dbPath)
	defer db.Close()

	if err := db.SaveUserIfNotExists(ctx, "recipient"); err != nil {
		t.Fatalf("save recipient user: %v", err)
	}

	payload := []byte(`{"type":"message","msg_id":"self-direct-1","sender_pub_key":"recipient","recipient_pub_key":"recipient","data":"cipher"}`)
	if err := db.SaveOfflineMessage(ctx, "recipient", "recipient", payload); err != nil {
		t.Fatalf("save self-addressed message failed: %v", err)
	}

	stored, err := db.ListOfflineMessages(ctx, "recipient")
	if err != nil {
		t.Fatalf("list offline messages: %v", err)
	}
	if len(stored) != 0 {
		t.Fatalf("expected self-addressed direct message to be pruned, got %d", len(stored))
	}
}

func TestListOfflineMessagesKeepsSelfSyncMessage(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "messenger-test.db")
	db := InitDB(ctx, dbPath)
	defer db.Close()

	if err := db.SaveUserIfNotExists(ctx, "recipient"); err != nil {
		t.Fatalf("save recipient user: %v", err)
	}

	payload := []byte(`{"type":"self_sync","msg_id":"sync-1:self","sender_pub_key":"recipient","recipient_pub_key":"recipient","data":"cipher"}`)
	if err := db.SaveOfflineMessage(ctx, "recipient", "recipient", payload); err != nil {
		t.Fatalf("save self-sync message failed: %v", err)
	}

	stored, err := db.ListOfflineMessages(ctx, "recipient")
	if err != nil {
		t.Fatalf("list offline messages: %v", err)
	}
	if len(stored) != 1 {
		t.Fatalf("expected self-sync message to remain, got %d", len(stored))
	}
	if string(stored[0].Payload) != string(payload) {
		t.Fatalf("self-sync payload mismatch: %s", string(stored[0].Payload))
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
	setTestClient(hub, client)
	hub.StoreSessionToken(client.Token, client.PubKey, "test-agent", "127.0.0.1")

	hub.dropClient(client, "test")

	if _, ok := hub.ValidateSessionToken(client.Token); ok {
		t.Fatal("expected session token to be removed when client is dropped")
	}
	if sessions, ok := hub.clients["sender"]; ok && len(sessions) > 0 {
		t.Fatal("expected client map entry to be removed after final session drop")
	}
}

func TestRevokeSessionTokenDisconnectsMatchingClient(t *testing.T) {
	hub := NewHub(nil, InitCache(), nil)
	client := newTestClient("sender")
	client.Token = "session-token"
	client.hub = hub
	setTestClient(hub, client)
	hub.StoreSessionToken(client.Token, client.PubKey, "test-agent", "127.0.0.1")

	if !hub.RevokeSessionTokenForUser(client.PubKey, client.Token) {
		t.Fatal("expected session revoke to succeed")
	}

	select {
	case <-client.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("expected revoked client to be disconnected")
	}
}
