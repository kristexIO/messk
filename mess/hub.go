package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// Message РїСЂРµРґСЃС‚Р°РІР»СЏРµС‚ РєРѕРЅРІРµСЂС‚ РґР»СЏ РїРµСЂРµСЃС‹Р»РєРё Р·Р°С€РёС„СЂРѕРІР°РЅРЅРѕРіРѕ СЃРѕРѕР±С‰РµРЅРёСЏ.
type Message struct {
	Type            string
	SenderPubKey    string
	RecipientPubKey string
	Payload         []byte
}

// Hub СѓРїСЂР°РІР»СЏРµС‚ Р°РєС‚РёРІРЅС‹РјРё СЃРѕРµРґРёРЅРµРЅРёСЏРјРё Рё РјР°СЂС€СЂСѓС‚РёР·Р°С†РёРµР№.
type Hub struct {
	clients      map[string]map[*Client]struct{}
	register     chan *Client
	unregister   chan *Client
	routeMessage chan *Message
	redisMessage chan *Message
	instanceID   string

	db    *DB
	cache *Cache
	rdb   *redis.Client

	mu            sync.RWMutex
	sessionTokens sync.Map
	fileTokens    sync.Map
	fileAccess    sync.Map
}

type fileAccessEntry struct {
	Filename       string
	AllowedPubKeys map[string]struct{}
}

type redisRouteEnvelope struct {
	Origin  string  `json:"origin,omitempty"`
	Message Message `json:"message"`
}

type sessionTokenEntry struct {
	PubKey    string
	ExpiresAt time.Time
	CreatedAt time.Time
	LastSeen  time.Time
	UserAgent string
	RemoteIP  string
}

type fileTokenEntry struct {
	Filename  string
	ExpiresAt time.Time
}

func NewHub(db *DB, cache *Cache, rdb *redis.Client) *Hub {
	return &Hub{
		register:     make(chan *Client, 256),
		unregister:   make(chan *Client, 256),
		clients:      make(map[string]map[*Client]struct{}),
		routeMessage: make(chan *Message, 256),
		redisMessage: make(chan *Message, 256),
		instanceID:   newHubInstanceID(),
		db:           db,
		cache:        cache,
		rdb:          rdb,
	}
}

func newHubInstanceID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return time.Now().UTC().Format("20060102150405.000000000")
	}
	return hex.EncodeToString(b[:])
}

func (h *Hub) addClientSession(client *Client) bool {
	if client == nil || client.PubKey == "" {
		return false
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	sessions := h.clients[client.PubKey]
	if sessions == nil {
		sessions = make(map[*Client]struct{})
		h.clients[client.PubKey] = sessions
	}
	wasOffline := len(sessions) == 0
	sessions[client] = struct{}{}
	return wasOffline
}

func (h *Hub) removeClientSession(client *Client) bool {
	if client == nil || client.PubKey == "" {
		return false
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	sessions, ok := h.clients[client.PubKey]
	if !ok {
		return false
	}
	delete(sessions, client)
	if len(sessions) == 0 {
		delete(h.clients, client.PubKey)
		return true
	}
	return false
}

func (h *Hub) deliverToPubKey(pubKey string, payload []byte, slowReason string) bool {
	h.mu.RLock()
	sessions, ok := h.clients[pubKey]
	if !ok || len(sessions) == 0 {
		h.mu.RUnlock()
		return false
	}
	targets := make([]*Client, 0, len(sessions))
	for client := range sessions {
		targets = append(targets, client)
	}
	h.mu.RUnlock()

	delivered := false
	for _, client := range targets {
		select {
		case client.send <- payload:
			delivered = true
		default:
			h.dropClient(client, slowReason)
		}
	}
	return delivered
}

func (h *Hub) Run() {
	cleanupTicker := time.NewTicker(time.Minute)
	defer cleanupTicker.Stop()

	// РџРѕРґРїРёСЃРєР° РЅР° Redis РєР°РЅР°Р» (Point 29)
	if h.rdb != nil {
		pubsub := h.rdb.Subscribe(context.Background(), "messenger_routing")
		go func() {
			for msg := range pubsub.Channel() {
				m, ok := h.decodeRedisRoute([]byte(msg.Payload))
				if ok {
					h.redisMessage <- &m
				}
			}
		}()
	}

	for {
		select {
		case client := <-h.register:
			firstSession := h.addClientSession(client)
			log.Printf("Client registered: %s", client.PubKey)

			go func(c *Client) {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()

				if h.db != nil {
					if err := h.db.SaveUserIfNotExists(ctx, c.PubKey); err != nil {
						log.Printf("DB error saving user %s: %v", c.PubKey, err)
					}
				}

				if firstSession && h.cache != nil {
					if err := h.cache.SetOnlineStatus(ctx, c.PubKey, true); err != nil {
						log.Printf("Cache error setting online %s: %v", c.PubKey, err)
					}
				}

				if h.db == nil {
					return
				}

				offlineMsgs, err := h.db.GetAndDeleteOfflineMessages(ctx, c.PubKey)
				if err != nil {
					log.Printf("Failed to get offline messages for %s: %v", c.PubKey, err)
					return
				}
				if len(offlineMsgs) > 0 {
					for _, msg := range offlineMsgs {
						select {
						case <-c.ctx.Done():
							return
						case c.send <- msg.Payload:
						}
					}
					log.Printf("Sent %d offline messages to %s", len(offlineMsgs), c.PubKey)
				}
			}(client)

		case client := <-h.unregister:
			h.dropClient(client, "unregistered")

		case msg := <-h.routeMessage:
			h.routeToLocal(msg, true) // true means republish to Redis if not found locally
		case msg := <-h.redisMessage:
			h.routeToLocal(msg, false) // false means do not republish to Redis
		case now := <-cleanupTicker.C:
			h.cleanupExpiredTokens(now)
		}
	}
}

func (h *Hub) decodeRedisRoute(payload []byte) (Message, bool) {
	var routed redisRouteEnvelope
	if err := json.Unmarshal(payload, &routed); err == nil && len(routed.Message.Payload) > 0 {
		if routed.Origin == h.instanceID {
			return Message{}, false
		}
		return routed.Message, true
	}

	var legacy Message
	if err := json.Unmarshal(payload, &legacy); err != nil {
		return Message{}, false
	}
	return legacy, true
}

func (h *Hub) publishRoute(msg *Message) {
	if h.rdb == nil || msg == nil {
		return
	}
	payload, err := json.Marshal(redisRouteEnvelope{
		Origin:  h.instanceID,
		Message: *msg,
	})
	if err != nil {
		log.Printf("Failed to encode redis route: %v", err)
		return
	}
	if err := h.rdb.Publish(context.Background(), "messenger_routing", payload).Err(); err != nil {
		log.Printf("Failed to publish redis route: %v", err)
	}
}

func (h *Hub) routeToLocal(msg *Message, allowPublish bool) {
	if msg == nil {
		return
	}
	if isGroupRoutedType(msg.Type) {
		h.routeGroupMessage(msg, allowPublish)
		return
	}
	if isChannelRoutedType(msg.Type) {
		h.routeChannelMessage(msg, allowPublish)
		return
	}

	if allowPublish && h.rdb != nil {
		h.publishRoute(msg)
	}

	delivered := h.deliverToPubKey(msg.RecipientPubKey, msg.Payload, "slow recipient")
	if !delivered && allowPublish && shouldPersistOffline(msg.Type) {
		h.saveOfflineMessage(msg)
	}
}

func (h *Hub) routeChannelMessage(msg *Message, allowPublish bool) {
	if h.db == nil {
		return
	}

	var env Envelope
	if err := json.Unmarshal(msg.Payload, &env); err != nil {
		log.Printf("Failed to decode channel message envelope: %v", err)
		return
	}
	if env.GroupID == "" {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	subscriberPubKeys, err := h.db.ListChannelSubscriberPubKeys(ctx, env.GroupID)
	if err != nil {
		log.Printf("Failed to load channel subscribers for %s: %v", env.GroupID, err)
		return
	}

	if allowPublish && h.rdb != nil {
		h.publishRoute(msg)
	}

	for _, subscriberPubKey := range subscriberPubKeys {
		if subscriberPubKey == "" {
			continue
		}
		if h.deliverToPubKey(subscriberPubKey, msg.Payload, "slow channel subscriber") {
			continue
		}

		if allowPublish && subscriberPubKey != msg.SenderPubKey && shouldPersistOffline(msg.Type) {
			h.saveOfflineMessage(&Message{
				Type:            msg.Type,
				SenderPubKey:    msg.SenderPubKey,
				RecipientPubKey: subscriberPubKey,
				Payload:         msg.Payload,
			})
		}
	}
}

func (h *Hub) NotifyUser(msg *Message) {
	if msg == nil || msg.RecipientPubKey == "" || len(msg.Payload) == 0 {
		return
	}
	h.routeToLocal(msg, true)
}

func shouldPersistOffline(messageType string) bool {
	switch messageType {
	case "typing", "delivery_receipt", "read_receipt", "call_offer", "call_answer", "call_reject", "call_end", "ice_candidate":
		return false
	default:
		return true
	}
}

func (h *Hub) routeGroupMessage(msg *Message, allowPublish bool) {
	if h.db == nil {
		return
	}

	var env Envelope
	if err := json.Unmarshal(msg.Payload, &env); err != nil {
		log.Printf("Failed to decode group message envelope: %v", err)
		return
	}
	if env.GroupID == "" {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	memberPubKeys, err := h.db.ListGroupMemberPubKeys(ctx, env.GroupID)
	if err != nil {
		log.Printf("Failed to load group members for %s: %v", env.GroupID, err)
		return
	}

	if allowPublish && h.rdb != nil {
		h.publishRoute(msg)
	}

	for _, memberPubKey := range memberPubKeys {
		if memberPubKey == "" {
			continue
		}
		if h.deliverToPubKey(memberPubKey, msg.Payload, "slow group recipient") {
			continue
		}

		if allowPublish && memberPubKey != msg.SenderPubKey && shouldPersistOffline(msg.Type) {
			h.saveOfflineMessage(&Message{
				Type:            msg.Type,
				SenderPubKey:    msg.SenderPubKey,
				RecipientPubKey: memberPubKey,
				Payload:         msg.Payload,
			})
		}
	}
}

func (h *Hub) saveOfflineMessage(msg *Message) {
	if h.db == nil || msg == nil || msg.RecipientPubKey == "" {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := h.db.SaveOfflineMessage(ctx, msg.SenderPubKey, msg.RecipientPubKey, msg.Payload); err != nil {
			log.Printf("Failed to save offline message for %s: %v", msg.RecipientPubKey, err)
		} else {
			log.Printf("Offline message saved for %s", msg.RecipientPubKey)
		}
	}()
}

func (h *Hub) dropClient(client *Client, reason string) {
	if client == nil {
		return
	}

	lastSessionGone := h.removeClientSession(client)
	log.Printf("Client dropped: %s (%s)", client.PubKey, reason)
	if client.Token != "" {
		h.DeleteSessionToken(client.Token)
	}
	if lastSessionGone && h.cache != nil {
		go func(pubKey string) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := h.cache.SetOnlineStatus(ctx, pubKey, false); err != nil {
				log.Printf("Cache error setting offline %s: %v", pubKey, err)
			}
		}(client.PubKey)
	}
	if client.conn != nil {
		client.conn.Close()
	}
	client.cancel()
}

func (h *Hub) disconnectSessionClients(pubKey, token string) {
	if token == "" {
		return
	}

	h.mu.RLock()
	sessions := h.clients[pubKey]
	if len(sessions) == 0 {
		h.mu.RUnlock()
		return
	}
	targets := make([]*Client, 0, len(sessions))
	for client := range sessions {
		if client != nil && client.Token == token {
			targets = append(targets, client)
		}
	}
	h.mu.RUnlock()

	for _, client := range targets {
		client.requestDrop("session revoked")
	}
}

func (h *Hub) disconnectAllOtherSessionClients(pubKey, exceptToken string) int {
	if pubKey == "" {
		return 0
	}

	h.mu.RLock()
	sessions := h.clients[pubKey]
	if len(sessions) == 0 {
		h.mu.RUnlock()
		return 0
	}
	targets := make([]*Client, 0, len(sessions))
	for client := range sessions {
		if client != nil && client.Token != "" && client.Token != exceptToken {
			targets = append(targets, client)
		}
	}
	h.mu.RUnlock()

	for _, client := range targets {
		client.requestDrop("all other sessions revoked")
	}
	return len(targets)
}

func (h *Hub) StoreSessionToken(token, pubKey, userAgent, remoteIP string) {
	if token == "" || pubKey == "" {
		return
	}
	now := time.Now()
	entry := sessionTokenEntry{
		PubKey:    pubKey,
		ExpiresAt: now.Add(getSessionTokenTTL()),
		CreatedAt: now,
		LastSeen:  now,
		UserAgent: userAgent,
		RemoteIP:  remoteIP,
	}
	h.sessionTokens.Store(token, entry)
	if h.db != nil {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := h.db.SaveSessionToken(ctx, SessionTokenRecord{
				Token:     token,
				PubKey:    entry.PubKey,
				CreatedAt: entry.CreatedAt,
				LastSeen:  entry.LastSeen,
				ExpiresAt: entry.ExpiresAt,
				UserAgent: entry.UserAgent,
				RemoteIP:  entry.RemoteIP,
			}); err != nil {
				log.Printf("Failed to persist session token for %s: %v", pubKey, err)
			}
		}()
	}
}

func (h *Hub) DeleteSessionToken(token string) {
	if token == "" {
		return
	}
	h.sessionTokens.Delete(token)
	if h.db != nil {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := h.db.DeleteSessionToken(ctx, token); err != nil {
				log.Printf("Failed to delete session token %s: %v", token, err)
			}
		}()
	}
}

func (h *Hub) ValidateSessionToken(token string) (string, bool) {
	if token == "" {
		return "", false
	}
	stored, ok := h.sessionTokens.Load(token)
	if !ok && h.db != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		record, err := h.db.GetSessionToken(ctx, token)
		if err == nil {
			stored = sessionTokenEntry{
				PubKey:    record.PubKey,
				ExpiresAt: record.ExpiresAt,
				CreatedAt: record.CreatedAt,
				LastSeen:  record.LastSeen,
				UserAgent: record.UserAgent,
				RemoteIP:  record.RemoteIP,
			}
			h.sessionTokens.Store(token, stored)
			ok = true
		} else if err != sql.ErrNoRows {
			log.Printf("Failed to load session token %s: %v", token, err)
			return "", false
		}
	}
	if !ok {
		return "", false
	}
	entry, ok := stored.(sessionTokenEntry)
	if !ok || entry.PubKey == "" {
		h.sessionTokens.Delete(token)
		return "", false
	}
	if time.Now().After(entry.ExpiresAt) {
		h.sessionTokens.Delete(token)
		logEvent("session_token_expired", map[string]any{"pub_key": entry.PubKey})
		return "", false
	}
	entry.LastSeen = time.Now()
	h.sessionTokens.Store(token, entry)
	if h.db != nil {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := h.db.TouchSessionToken(ctx, token, entry.LastSeen); err != nil {
				log.Printf("Failed to update session activity for %s: %v", token, err)
			}
		}()
	}
	return entry.PubKey, true
}

func (h *Hub) ListSessions(pubKey string) []map[string]any {
	out := make([]map[string]any, 0)
	if pubKey == "" {
		return out
	}
	if h.db != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		records, err := h.db.ListSessionTokens(ctx, pubKey)
		if err == nil {
			now := time.Now()
			for _, record := range records {
				if now.After(record.ExpiresAt) {
					continue
				}
				h.sessionTokens.Store(record.Token, sessionTokenEntry{
					PubKey:    record.PubKey,
					CreatedAt: record.CreatedAt,
					LastSeen:  record.LastSeen,
					ExpiresAt: record.ExpiresAt,
					UserAgent: record.UserAgent,
					RemoteIP:  record.RemoteIP,
				})
				out = append(out, map[string]any{
					"token":     record.Token,
					"createdAt": record.CreatedAt.UTC().Format(time.RFC3339),
					"lastSeen":  record.LastSeen.UTC().Format(time.RFC3339),
					"expiresAt": record.ExpiresAt.UTC().Format(time.RFC3339),
					"userAgent": record.UserAgent,
					"remoteIp":  record.RemoteIP,
				})
			}
			return out
		}
		log.Printf("Failed to list persisted sessions for %s: %v", pubKey, err)
	}

	now := time.Now()
	h.sessionTokens.Range(func(key, value any) bool {
		token, ok := key.(string)
		if !ok || token == "" {
			return true
		}
		entry, ok := value.(sessionTokenEntry)
		if !ok || entry.PubKey != pubKey {
			return true
		}
		if now.After(entry.ExpiresAt) {
			h.sessionTokens.Delete(key)
			return true
		}
		out = append(out, map[string]any{
			"token":     token,
			"createdAt": entry.CreatedAt.UTC().Format(time.RFC3339),
			"lastSeen":  entry.LastSeen.UTC().Format(time.RFC3339),
			"expiresAt": entry.ExpiresAt.UTC().Format(time.RFC3339),
			"userAgent": entry.UserAgent,
			"remoteIp":  entry.RemoteIP,
		})
		return true
	})
	return out
}

func (h *Hub) RevokeSessionTokenForUser(pubKey, token string) bool {
	if pubKey == "" || token == "" {
		return false
	}
	stored, ok := h.sessionTokens.Load(token)
	if !ok && h.db != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		record, err := h.db.GetSessionToken(ctx, token)
		if err == nil {
			stored = sessionTokenEntry{
				PubKey:    record.PubKey,
				ExpiresAt: record.ExpiresAt,
				CreatedAt: record.CreatedAt,
				LastSeen:  record.LastSeen,
				UserAgent: record.UserAgent,
				RemoteIP:  record.RemoteIP,
			}
			h.sessionTokens.Store(token, stored)
			ok = true
		}
	}
	if !ok {
		return false
	}
	entry, ok := stored.(sessionTokenEntry)
	if !ok || entry.PubKey != pubKey {
		return false
	}
	h.sessionTokens.Delete(token)
	if h.db != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := h.db.DeleteSessionToken(ctx, token); err != nil {
			log.Printf("Failed to revoke session token %s: %v", token, err)
			return false
		}
	}
	h.disconnectSessionClients(pubKey, token)
	return true
}

func (h *Hub) RevokeAllSessionTokensForUser(pubKey, exceptToken string) int {
	if pubKey == "" {
		return 0
	}
	revoked := 0
	h.sessionTokens.Range(func(key, value any) bool {
		token, ok := key.(string)
		if !ok || token == "" || token == exceptToken {
			return true
		}
		entry, ok := value.(sessionTokenEntry)
		if !ok || entry.PubKey != pubKey {
			return true
		}
		h.sessionTokens.Delete(token)
		revoked++
		return true
	})
	if h.db != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if deleted, err := h.db.DeleteAllSessionTokensForUser(ctx, pubKey, exceptToken); err != nil {
			log.Printf("Failed to revoke persisted sessions for %s: %v", pubKey, err)
		} else if int(deleted) > revoked {
			revoked = int(deleted)
		}
	}
	disconnected := h.disconnectAllOtherSessionClients(pubKey, exceptToken)
	if disconnected > revoked {
		revoked = disconnected
	}
	return revoked
}

func (h *Hub) StoreFileToken(token, filename string) {
	if token == "" || filename == "" {
		return
	}
	entry := fileTokenEntry{
		Filename:  filename,
		ExpiresAt: time.Now().Add(getFileTokenTTL()),
	}
	h.fileTokens.Store(token, entry)
	if h.db != nil {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := h.db.SaveFileToken(ctx, token, filename, entry.ExpiresAt); err != nil {
				log.Printf("Failed to persist file token for %s: %v", filename, err)
			}
		}()
	}
}

func (h *Hub) StoreFileAccess(filename string, allowedPubKeys ...string) {
	if filename == "" {
		return
	}

	allowed := make(map[string]struct{}, len(allowedPubKeys))
	for _, pubKey := range allowedPubKeys {
		if pubKey == "" {
			continue
		}
		allowed[pubKey] = struct{}{}
	}

	h.fileAccess.Store(filename, fileAccessEntry{
		Filename:       filename,
		AllowedPubKeys: allowed,
	})
	if h.db != nil {
		allowedPubKeysCopy := append([]string(nil), allowedPubKeys...)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := h.db.ReplaceFileAccess(ctx, filename, allowedPubKeysCopy); err != nil {
				log.Printf("Failed to persist file access for %s: %v", filename, err)
			}
		}()
	}
}

func (h *Hub) ValidateFileAccess(filename, pubKey string) bool {
	if filename == "" || pubKey == "" {
		return false
	}

	storedEntry, ok := h.fileAccess.Load(filename)
	if ok {
		entry, ok := storedEntry.(fileAccessEntry)
		if ok {
			if _, allowed := entry.AllowedPubKeys[pubKey]; allowed {
				return true
			}
		}
	}
	if h.db == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	allowed, err := h.db.HasFileAccess(ctx, filename, pubKey)
	if err != nil {
		log.Printf("Failed to validate persisted file access for %s/%s: %v", filename, pubKey, err)
		return false
	}
	if allowed {
		allowedPubKeys := map[string]struct{}{pubKey: {}}
		if ok {
			if entry, entryOK := storedEntry.(fileAccessEntry); entryOK {
				for allowedPubKey := range entry.AllowedPubKeys {
					allowedPubKeys[allowedPubKey] = struct{}{}
				}
			}
		}
		h.fileAccess.Store(filename, fileAccessEntry{
			Filename:       filename,
			AllowedPubKeys: allowedPubKeys,
		})
	}
	return allowed
}

func (h *Hub) ValidateFileToken(token, filename string) bool {
	if token == "" || filename == "" {
		return false
	}
	storedFilename, ok := h.fileTokens.Load(token)
	if !ok && h.db != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		record, err := h.db.GetFileToken(ctx, token)
		if err == nil {
			storedFilename = fileTokenEntry{
				Filename:  record.Filename,
				ExpiresAt: record.ExpiresAt,
			}
			h.fileTokens.Store(token, storedFilename)
			ok = true
		} else if err != sql.ErrNoRows {
			log.Printf("Failed to load file token %s: %v", token, err)
		}
	}
	if !ok {
		return false
	}
	entry, ok := storedFilename.(fileTokenEntry)
	if !ok || entry.Filename == "" {
		h.fileTokens.Delete(token)
		return false
	}
	if time.Now().After(entry.ExpiresAt) {
		h.fileTokens.Delete(token)
		logEvent("file_token_expired", map[string]any{"filename": entry.Filename})
		if h.db != nil {
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = h.db.DeleteFileToken(ctx, token)
			}()
		}
		return false
	}
	return entry.Filename == filename
}

func (h *Hub) cleanupExpiredTokens(now time.Time) {
	h.sessionTokens.Range(func(key, value any) bool {
		entry, ok := value.(sessionTokenEntry)
		if !ok || entry.PubKey == "" || now.After(entry.ExpiresAt) {
			h.sessionTokens.Delete(key)
		}
		return true
	})

	h.fileTokens.Range(func(key, value any) bool {
		entry, ok := value.(fileTokenEntry)
		if !ok || entry.Filename == "" || now.After(entry.ExpiresAt) {
			h.fileTokens.Delete(key)
		}
		return true
	})
	if h.db != nil {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := h.db.CleanupExpiredSessionTokens(ctx, now); err != nil {
				log.Printf("Failed to cleanup persisted session tokens: %v", err)
			}
			if err := h.db.CleanupExpiredFileTokens(ctx, now); err != nil {
				log.Printf("Failed to cleanup persisted file tokens: %v", err)
			}
		}()
	}
}
