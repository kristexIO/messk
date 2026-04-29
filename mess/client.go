package main

import (
	"bytes"
	"context"
	crypto_rand "crypto/rand"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/nacl/box"
)

const (
	writeWait       = 10 * time.Second
	pongWait        = 60 * time.Second
	pingPeriod      = (pongWait * 9) / 10
	maxMessageSize  = 128 * 1024 // 128 KB
	maxPreKeyUpload = 100
)

var (
	newline = []byte{'\n'}
	space   = []byte{' '}
)

// sync.Pool Р Т‘Р В»РЎРЏ Р С—Р ВµРЎР‚Р ВµР С‘РЎРѓР С—Р С•Р В»РЎРЉР В·Р С•Р Р†Р В°Р Р…Р С‘РЎРЏ Р В±РЎС“РЎвЂћР ВµРЎР‚Р С•Р Р† (Р СР С‘Р Р…Р С‘Р СР С‘Р В·Р В°РЎвЂ Р С‘РЎРЏ Р В°Р В»Р В»Р С•Р С”Р В°РЎвЂ Р С‘Р в„– Р С—Р В°Р СРЎРЏРЎвЂљР С‘)
var bufferPool = sync.Pool{
	New: func() interface{} {
		return new(bytes.Buffer)
	},
}

var routedEnvelopeTypes = map[string]bool{
	"message":          true,
	"self_sync":        true,
	"group_message":    true,
	"group_edit":       true,
	"group_delete":     true,
	"group_reaction":   true,
	"group_sender_key": true,
	"channel_message":  true,
	"channel_edit":     true,
	"channel_delete":   true,
	"channel_reaction": true,
	"channel_pin":      true,
	"typing":           true,
	"delivery_receipt": true,
	"read_receipt":     true,
	"edit":             true,
	"delete":           true,
	"reaction":         true,
	"call_offer":       true,
	"call_answer":      true,
	"call_reject":      true,
	"call_end":         true,
	"ice_candidate":    true,
	"wipe_all":         true,
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     checkWebSocketOrigin,
}

type Client struct {
	hub                   *Hub
	conn                  *websocket.Conn
	PubKey                string
	Token                 string
	send                  chan []byte
	ctx                   context.Context
	cancel                context.CancelFunc
	antiFloodMu           sync.Mutex
	antiFloodWindows      map[string]floodWindow
	antiFloodBlockedUntil time.Time
	antiFloodViolations   int
	typingLastSentAt      time.Time
}

type floodWindow struct {
	start time.Time
	count int
}

func checkWebSocketOrigin(r *http.Request) bool {
	return isAllowedWebSocketOrigin(r.Header.Get("Origin"))
}

func isAllowedWebSocketOrigin(origin string) bool {
	if origin == "" {
		return true
	}

	for _, allowedOrigin := range getAllowedOrigins() {
		if origin == allowedOrigin {
			return true
		}
	}
	return false
}

// Envelope Р С•Р С—РЎР‚Р ВµР Т‘Р ВµР В»РЎРЏР ВµРЎвЂљ Р В±Р В°Р В·Р С•Р Р†РЎС“РЎР‹ РЎРѓРЎвЂљРЎР‚РЎС“Р С”РЎвЂљРЎС“РЎР‚РЎС“ Р Т‘Р В»РЎРЏ Р СР В°РЎР‚РЎв‚¬РЎР‚РЎС“РЎвЂљР С‘Р В·Р В°РЎвЂ Р С‘Р С‘ РЎРѓР С•Р С•Р В±РЎвЂ°Р ВµР Р…Р С‘Р в„–.
// Р ВРЎРѓР С—Р С•Р В»РЎРЉР В·Р С•Р Р†Р В°Р Р…Р С‘Р Вµ json.RawMessage Р С—Р С•Р В·Р Р†Р С•Р В»РЎРЏР ВµРЎвЂљ РЎРѓР ВµРЎР‚Р Р†Р ВµРЎР‚РЎС“ Р С•РЎРѓРЎвЂљР В°Р Р†Р В°РЎвЂљРЎРЉРЎРѓРЎРЏ "РЎРѓР В»Р ВµР С—РЎвЂ№Р С" Р С” РЎРѓР В°Р СР С‘Р С Р Т‘Р В°Р Р…Р Р…РЎвЂ№Р С.
type Envelope struct {
	Type            string          `json:"type"`             // "message", "upload_prekeys", "get_prekey"
	MsgID           string          `json:"msg_id,omitempty"` // Client-generated message/event id
	TargetMsgID     string          `json:"target_msg_id,omitempty"`
	RecipientPubKey string          `json:"recipient_pub_key"` // PubKey Р С—Р С•Р В»РЎС“РЎвЂЎР В°РЎвЂљР ВµР В»РЎРЏ
	GroupID         string          `json:"group_id,omitempty"`
	SenderPubKey    string          `json:"sender_pub_key"` // PubKey Р С•РЎвЂљР С—РЎР‚Р В°Р Р†Р С‘РЎвЂљР ВµР В»РЎРЏ
	Data            json.RawMessage `json:"data"`           // Р вЂ”Р В°РЎв‚¬Р С‘РЎвЂћРЎР‚Р С•Р Р†Р В°Р Р…Р Р…РЎвЂ№Р в„– payload Р С‘Р В»Р С‘ Р Т‘Р В°Р Р…Р Р…РЎвЂ№Р Вµ Р С”Р В»РЎР‹РЎвЂЎР ВµР в„–
	Reaction        string          `json:"reaction,omitempty"`
	PreKeys         []string        `json:"prekeys,omitempty"` // Р вЂќР В»РЎРЏ upload_prekeys
	PreKey          string          `json:"prekey,omitempty"`  // Р вЂќР В»РЎРЏ Р С•РЎвЂљР Р†Р ВµРЎвЂљР В° Р Р…Р В° get_prekey
	SignedPreKey    string          `json:"signed_prekey,omitempty"`
	SignedPreKeySig string          `json:"signed_prekey_sig,omitempty"`
}

func (c *Client) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
		c.cancel()
	}()
	c.conn.SetReadLimit(maxMessageSize)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error { _ = c.conn.SetReadDeadline(time.Now().Add(pongWait)); return nil })

	for {
		select {
		case <-c.ctx.Done():
			return
		default:
			_, message, err := c.conn.ReadMessage()
			if err != nil {
				if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
					log.Printf("readPump error (%s): %v", c.PubKey, err)
				}
				return
			}

			// Р СљР С‘Р Р…Р С‘Р СР С‘Р В·Р В°РЎвЂ Р С‘РЎРЏ Р В°Р В»Р В»Р С•Р С”Р В°РЎвЂ Р С‘Р в„– (РЎвЂ¦Р С•РЎвЂљРЎРЏ bytes.TrimSpace/ReplaceAll Р В°Р В»Р В»Р С•РЎвЂ Р С‘РЎР‚РЎС“РЎР‹РЎвЂљ, Р С‘РЎРѓР С—Р С•Р В»РЎРЉР В·РЎС“Р ВµР С Р С•Р С—РЎвЂљР С‘Р СР С‘Р В·Р С‘РЎР‚Р С•Р Р†Р В°Р Р…Р Р…РЎвЂ№Р в„– Р С—Р С•Р Т‘РЎвЂ¦Р С•Р Т‘)
			message = bytes.TrimSpace(bytes.ReplaceAll(message, newline, space))

			var env Envelope
			if err := json.Unmarshal(message, &env); err != nil {
				log.Printf("Invalid message from %s: %v", c.PubKey, err)
				continue
			}

			if isGroupRoutedType(env.Type) && env.GroupID != "" {
				if allowed, retryAfter := c.allowInboundEvent(env.Type); !allowed {
					c.sendRateLimitNotice(env.Type, retryAfter)
					continue
				}
				if !isValidMessageID(env.MsgID) || len(env.Data) > maxMessageSize {
					logEvent("ws_invalid_group_envelope", map[string]any{
						"pub_key":  c.PubKey,
						"group_id": env.GroupID,
						"type":     env.Type,
					})
					continue
				}
				if _, err := c.hub.db.GetGroupMemberRole(context.Background(), env.GroupID, c.PubKey); err != nil {
					logEvent("ws_group_forbidden", map[string]any{
						"pub_key":  c.PubKey,
						"group_id": env.GroupID,
					})
					continue
				}
				normalizedMessage, ok := normalizeRoutedEnvelope(env, c.PubKey)
				if !ok {
					logEvent("ws_invalid_group_envelope", map[string]any{
						"pub_key":  c.PubKey,
						"group_id": env.GroupID,
						"type":     env.Type,
					})
					continue
				}
				c.hub.routeMessage <- &Message{
					Type:         env.Type,
					SenderPubKey: c.PubKey,
					Payload:      normalizedMessage,
				}
			} else if isChannelRoutedType(env.Type) && env.GroupID != "" {
				if allowed, retryAfter := c.allowInboundEvent(env.Type); !allowed {
					c.sendRateLimitNotice(env.Type, retryAfter)
					continue
				}
				if !isValidMessageID(env.MsgID) || len(env.Data) > maxMessageSize {
					logEvent("ws_invalid_channel_envelope", map[string]any{
						"pub_key":    c.PubKey,
						"channel_id": env.GroupID,
						"type":       env.Type,
					})
					continue
				}
				channelRole, err := c.hub.db.GetChannelSubscriberRole(context.Background(), env.GroupID, c.PubKey)
				if err != nil {
					logEvent("ws_channel_forbidden", map[string]any{
						"pub_key":    c.PubKey,
						"channel_id": env.GroupID,
					})
					continue
				}
				if !canPublishToChannel(channelRole, env.Type) {
					logEvent("ws_channel_post_forbidden", map[string]any{
						"pub_key":    c.PubKey,
						"channel_id": env.GroupID,
						"type":       env.Type,
						"role":       channelRole,
					})
					continue
				}
				normalizedMessage, ok := normalizeRoutedEnvelope(env, c.PubKey)
				if !ok {
					logEvent("ws_invalid_channel_envelope", map[string]any{
						"pub_key":    c.PubKey,
						"channel_id": env.GroupID,
						"type":       env.Type,
					})
					continue
				}
				c.hub.routeMessage <- &Message{
					Type:         env.Type,
					SenderPubKey: c.PubKey,
					Payload:      normalizedMessage,
				}
			} else if routedEnvelopeTypes[env.Type] && env.RecipientPubKey != "" {
				if allowed, retryAfter := c.allowInboundEvent(env.Type); !allowed {
					c.sendRateLimitNotice(env.Type, retryAfter)
					continue
				}
				normalizedMessage, ok := normalizeRoutedEnvelope(env, c.PubKey)
				if !ok {
					logEvent("ws_invalid_envelope", map[string]any{
						"pub_key": c.PubKey,
						"type":    env.Type,
					})
					continue
				}
				c.hub.routeMessage <- &Message{
					Type:            env.Type,
					SenderPubKey:    c.PubKey,
					RecipientPubKey: env.RecipientPubKey,
					Payload:         normalizedMessage,
				}
				c.sendServerAck(env)
			} else if env.Type == "upload_prekeys" {
				if len(env.PreKeys) > 0 {
					if !areValidPreKeys(env.PreKeys) {
						logEvent("ws_invalid_prekeys", map[string]any{
							"pub_key": c.PubKey,
							"count":   len(env.PreKeys),
						})
						continue
					}
				}
				go func() {
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					if len(env.PreKeys) > 0 {
						if err := c.hub.db.SavePreKeys(ctx, c.PubKey, env.PreKeys); err != nil {
							log.Printf("Error saving prekeys for %s: %v", c.PubKey, err)
						}
					}
					if env.SignedPreKey != "" && env.SignedPreKeySig != "" {
						if err := c.hub.db.SaveSignedPreKey(ctx, c.PubKey, env.SignedPreKey, env.SignedPreKeySig); err != nil {
							log.Printf("Error saving signed prekey for %s: %v", c.PubKey, err)
						}
					}
				}()
			} else if env.Type == "get_prekey" && env.RecipientPubKey != "" {
				if !isValidPublicKey(env.RecipientPubKey) {
					logEvent("ws_invalid_get_prekey", map[string]any{
						"pub_key":   c.PubKey,
						"recipient": env.RecipientPubKey,
					})
					continue
				}
				go func() {
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					preKey, err := c.hub.db.ConsumePreKey(ctx, env.RecipientPubKey)
					if err != nil {
						log.Printf("Error getting prekey for %s: %v", env.RecipientPubKey, err)
					}
					signedPreKey, signedPreKeySig, err := c.hub.db.GetSignedPreKey(ctx, env.RecipientPubKey)
					if err != nil {
						log.Printf("Error getting signed prekey for %s: %v", env.RecipientPubKey, err)
					}

					res := Envelope{
						Type:            "prekey_bundle",
						RecipientPubKey: env.RecipientPubKey,
						PreKey:          preKey,
						SignedPreKey:    signedPreKey,
						SignedPreKeySig: signedPreKeySig,
					}
					resJSON, _ := json.Marshal(res)
					select {
					case <-c.ctx.Done():
					case c.send <- resJSON:
					}
				}()
			}
		}
	}
}

func (c *Client) allowInboundEvent(eventType string) (bool, int) {
	now := time.Now()
	c.antiFloodMu.Lock()
	defer c.antiFloodMu.Unlock()
	if !c.antiFloodBlockedUntil.IsZero() && now.Before(c.antiFloodBlockedUntil) {
		retry := int(c.antiFloodBlockedUntil.Sub(now).Seconds())
		if retry < 1 {
			retry = 1
		}
		return false, retry
	}

	if eventType == "typing" {
		if !c.typingLastSentAt.IsZero() && now.Sub(c.typingLastSentAt) < 900*time.Millisecond {
			return false, 1
		}
		c.typingLastSentAt = now
		return true, 0
	}

	category, limit, window := floodPolicyForEvent(eventType)
	if c.antiFloodWindows == nil {
		c.antiFloodWindows = make(map[string]floodWindow)
	}
	bucket := c.antiFloodWindows[category]
	if bucket.start.IsZero() || now.Sub(bucket.start) > window {
		bucket = floodWindow{start: now, count: 0}
	}
	bucket.count++
	c.antiFloodWindows[category] = bucket
	if bucket.count <= limit {
		return true, 0
	}
	c.antiFloodViolations++
	retry := int(window.Seconds())
	if retry < 1 {
		retry = 1
	}
	if c.antiFloodViolations >= 3 {
		c.antiFloodBlockedUntil = now.Add(30 * time.Second)
		c.antiFloodViolations = 0
		return false, 30
	}
	return false, retry
}

func floodPolicyForEvent(eventType string) (category string, limit int, window time.Duration) {
	switch eventType {
	case "call_offer", "call_answer", "call_reject", "call_end", "ice_candidate":
		return "call", 36, 10 * time.Second
	case "message", "group_message", "channel_message":
		return "message", 80, 10 * time.Second
	case "edit", "delete", "reaction", "group_edit", "group_delete", "group_reaction", "channel_edit", "channel_delete", "channel_reaction", "channel_pin":
		return "interaction", 60, 10 * time.Second
	default:
		return "default", 50, 10 * time.Second
	}
}

func (c *Client) sendRateLimitNotice(eventType string, retryAfterSec int) {
	if c == nil {
		return
	}
	message := "Too many actions. Slow down."
	if retryAfterSec > 1 {
		message = "Too many actions. Try again shortly."
	}
	if retryAfterSec < 1 {
		retryAfterSec = 1
	}
	payload, err := json.Marshal(map[string]any{
		"type":            "rate_limited",
		"event":           eventType,
		"message":         message,
		"retry_after_sec": retryAfterSec,
	})
	if err != nil {
		return
	}
	select {
	case <-c.ctx.Done():
	case c.send <- payload:
	default:
	}
}

func (c *Client) sendServerAck(env Envelope) {
	if env.MsgID == "" {
		return
	}
	ack, err := json.Marshal(map[string]string{
		"type":        "server_ack",
		"msg_id":      env.MsgID,
		"ack_type":    env.Type,
		"server_time": time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err != nil {
		return
	}
	select {
	case <-c.ctx.Done():
	case c.send <- ack:
	default:
		c.requestDrop("slow server ack")
	}
}

func (c *Client) requestDrop(reason string) {
	if c == nil {
		return
	}
	logEvent("client_drop_requested", map[string]any{
		"pub_key": c.PubKey,
		"reason":  reason,
	})
	c.cancel()
	if c.hub == nil {
		return
	}
	select {
	case c.hub.unregister <- c:
	default:
		go func() {
			select {
			case c.hub.unregister <- c:
			case <-time.After(time.Second):
			}
		}()
	}
}

func normalizeRoutedEnvelope(env Envelope, authenticatedPubKey string) ([]byte, bool) {
	if !routedEnvelopeTypes[env.Type] || !isValidPublicKey(authenticatedPubKey) {
		return nil, false
	}
	if isGroupRoutedType(env.Type) {
		if env.GroupID == "" {
			return nil, false
		}
	} else if isChannelRoutedType(env.Type) {
		if env.GroupID == "" {
			return nil, false
		}
	} else if !isValidPublicKey(env.RecipientPubKey) {
		return nil, false
	}
	if requiresMessageID(env.Type) && !isValidMessageID(env.MsgID) {
		return nil, false
	}
	if len(env.Data) > maxMessageSize {
		return nil, false
	}

	env.SenderPubKey = authenticatedPubKey
	normalized, err := json.Marshal(env)
	if err != nil {
		return nil, false
	}
	return normalized, true
}

func requiresMessageID(messageType string) bool {
	switch messageType {
	case "message", "group_message", "group_edit", "group_delete", "group_reaction", "group_sender_key", "channel_message", "channel_edit", "channel_delete", "channel_reaction", "channel_pin", "delivery_receipt", "read_receipt", "edit", "delete", "reaction":
		return true
	default:
		return false
	}
}

func isGroupRoutedType(messageType string) bool {
	switch messageType {
	case "group_message", "group_edit", "group_delete", "group_reaction":
		return true
	default:
		return false
	}
}

func isChannelRoutedType(messageType string) bool {
	switch messageType {
	case "channel_message", "channel_edit", "channel_delete", "channel_reaction", "channel_pin":
		return true
	default:
		return false
	}
}

func canPublishToChannel(role, messageType string) bool {
	switch messageType {
	case "channel_reaction":
		return role == "owner" || role == "admin" || role == "poster" || role == "subscriber"
	case "channel_pin":
		return role == "owner" || role == "admin"
	case "channel_message", "channel_edit", "channel_delete":
		return role == "owner" || role == "admin" || role == "poster"
	default:
		return false
	}
}

func isValidMessageID(msgID string) bool {
	if msgID == "" || len(msgID) > 128 {
		return false
	}
	for _, char := range msgID {
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

func areValidPreKeys(preKeys []string) bool {
	if len(preKeys) == 0 || len(preKeys) > maxPreKeyUpload {
		return false
	}

	seen := make(map[string]struct{}, len(preKeys))
	for _, preKey := range preKeys {
		if !isValidPublicKey(preKey) {
			return false
		}
		if _, exists := seen[preKey]; exists {
			return false
		}
		seen[preKey] = struct{}{}
	}
	return true
}

func isValidPublicKey(value string) bool {
	decoded, err := base64.StdEncoding.DecodeString(value)
	return err == nil && len(decoded) == 32
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case <-c.ctx.Done():
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
			return
		case message, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)

			if err := w.Close(); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func serveWs(hub *Hub, w http.ResponseWriter, r *http.Request, globalCtx context.Context) {
	if !isAllowedWebSocketOrigin(r.Header.Get("Origin")) {
		logEvent("ws_origin_rejected", map[string]any{
			"origin": r.Header.Get("Origin"),
			"remote": r.RemoteAddr,
		})
		http.Error(w, "Forbidden origin", http.StatusForbidden)
		return
	}

	// Р вЂќР В»РЎРЏ Web3/Auth Р СРЎвЂ№ Р С•Р В¶Р С‘Р Т‘Р В°Р ВµР С Р С—РЎС“Р В±Р В»Р С‘РЎвЂЎР Р…РЎвЂ№Р в„– Р С”Р В»РЎР‹РЎвЂЎ.
	pubKey := r.URL.Query().Get("pub")
	if pubKey == "" {
		logEvent("ws_missing_pubkey", map[string]any{"remote": r.RemoteAddr})
		http.Error(w, "Missing public key", http.StatusUnauthorized)
		return
	}

	if !isValidPublicKey(pubKey) {
		logEvent("ws_invalid_pubkey", map[string]any{"remote": r.RemoteAddr})
		http.Error(w, "Invalid public key", http.StatusUnauthorized)
		return
	}
	clientPubKeyBytes, _ := base64.StdEncoding.DecodeString(pubKey)
	var clientPubKey [32]byte
	copy(clientPubKey[:], clientPubKeyBytes)

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Upgrade error: %v", err)
		return
	}

	// 2. Р вЂњР ВµР Р…Р ВµРЎР‚Р С‘РЎР‚РЎС“Р ВµР С РЎРЊРЎвЂћР ВµР СР ВµРЎР‚Р Р…РЎС“РЎР‹ Р С—Р В°РЎР‚РЎС“ Р С”Р В»РЎР‹РЎвЂЎР ВµР в„– Р Т‘Р В»РЎРЏ РЎРѓР ВµРЎР‚Р Р†Р ВµРЎР‚Р В°
	ephemeralPubKey, ephemeralPrivKey, err := box.GenerateKey(crypto_rand.Reader)
	if err != nil {
		conn.Close()
		return
	}

	// 3. Р вЂњР ВµР Р…Р ВµРЎР‚Р С‘РЎР‚РЎС“Р ВµР С challenge
	challengeBytes := make([]byte, 32)
	if _, err := crypto_rand.Read(challengeBytes); err != nil {
		conn.Close()
		return
	}
	challengeStr := base64.StdEncoding.EncodeToString(challengeBytes)

	// 4. Р РЃР С‘РЎвЂћРЎР‚РЎС“Р ВµР С challenge
	var nonce [24]byte
	if _, err := crypto_rand.Read(nonce[:]); err != nil {
		conn.Close()
		return
	}
	encryptedChallenge := box.Seal(nonce[:], []byte(challengeStr), &nonce, &clientPubKey, ephemeralPrivKey)

	// 5. Р С›РЎвЂљР С—РЎР‚Р В°Р Р†Р В»РЎРЏР ВµР С Р В·Р В°Р С—РЎР‚Р С•РЎРѓ
	authReq := map[string]interface{}{
		"type":      "auth_challenge",
		"ephemeral": base64.StdEncoding.EncodeToString(ephemeralPubKey[:]),
		"challenge": base64.StdEncoding.EncodeToString(encryptedChallenge),
	}
	if err := conn.WriteJSON(authReq); err != nil {
		conn.Close()
		return
	}

	// 6. Р вЂ“Р Т‘Р ВµР С Р С•РЎвЂљР Р†Р ВµРЎвЂљ
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var authRes map[string]string
	if err := conn.ReadJSON(&authRes); err != nil {
		conn.Close()
		return
	}
	conn.SetReadDeadline(time.Time{}) // Р РЋР В±РЎР‚Р С•РЎРѓ РЎвЂљР В°Р в„–Р СР В°РЎС“РЎвЂљР В°

	// 7. Р СџРЎР‚Р С•Р Р†Р ВµРЎР‚РЎРЏР ВµР С Р С•РЎвЂљР Р†Р ВµРЎвЂљ
	if authRes["type"] != "auth_response" || authRes["challenge"] != challengeStr {
		logEvent("ws_auth_failed", map[string]any{"pub_key": pubKey})
		conn.WriteJSON(map[string]string{"type": "auth_error"})
		conn.Close()
		return
	}

	// 8. Р С’Р Р†РЎвЂљР С•РЎР‚Р С‘Р В·Р В°РЎвЂ Р С‘РЎРЏ РЎС“РЎРѓР С—Р ВµРЎв‚¬Р Р…Р В°
	sessionTokenBytes := make([]byte, 32)
	if _, err := crypto_rand.Read(sessionTokenBytes); err != nil {
		conn.Close()
		return
	}
	sessionToken := base64.StdEncoding.EncodeToString(sessionTokenBytes)
	hub.StoreSessionToken(sessionToken, pubKey, r.UserAgent(), r.RemoteAddr)

	if err := conn.WriteJSON(map[string]string{
		"type":          "auth_success",
		"session_token": sessionToken,
	}); err != nil {
		hub.DeleteSessionToken(sessionToken)
		conn.Close()
		return
	}

	ctx, cancel := context.WithCancel(globalCtx)
	client := &Client{
		hub:    hub,
		conn:   conn,
		PubKey: pubKey,
		Token:  sessionToken,
		send:   make(chan []byte, 256),
		ctx:    ctx,
		cancel: cancel,
	}
	client.hub.register <- client

	go client.writePump()
	go client.readPump()
}
