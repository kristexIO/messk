package main

import (
	"context"
	"crypto/rand"
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
	clients      map[string]*Client // Возвращаем мапу один-к-одному
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
}

type fileTokenEntry struct {
	Filename  string
	ExpiresAt time.Time
}

func NewHub(db *DB, cache *Cache, rdb *redis.Client) *Hub {
	return &Hub{
		register:     make(chan *Client, 256),
		unregister:   make(chan *Client, 256),
		clients:      make(map[string]*Client),
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
			if oldClient, ok := h.clients[client.PubKey]; ok {
				oldClient.cancel()
			}
			h.clients[client.PubKey] = client
			log.Printf("Client registered: %s", client.PubKey)

			go func(c *Client) {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()

				if h.db != nil {
					if err := h.db.SaveUserIfNotExists(ctx, c.PubKey); err != nil {
						log.Printf("DB error saving user %s: %v", c.PubKey, err)
					}
				}

				if h.cache != nil {
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
	if isGroupRoutedType(msg.Type) {
		h.routeGroupMessage(msg, allowPublish)
		return
	}
	if isChannelRoutedType(msg.Type) {
		h.routeChannelMessage(msg, allowPublish)
		return
	}

	// РћС‚РїСЂР°РІР»СЏРµРј РїРѕР»СѓС‡Р°С‚РµР»СЋ
	client, foundLocally := h.clients[msg.RecipientPubKey]

	if foundLocally {
		select {
		case client.send <- msg.Payload:
		default:
			h.dropClient(client, "slow recipient")
			foundLocally = false
		}
	}

	// Р•СЃР»Рё РЅРµ РЅР°С€Р»Рё Р»РѕРєР°Р»СЊРЅРѕ, РЅРѕ СЂР°Р·СЂРµС€РµРЅРѕ РїСѓР±Р»РёРєРѕРІР°С‚СЊ РІ Redis
	if !foundLocally && allowPublish && h.rdb != nil {
		h.publishRoute(msg)

		if shouldPersistOffline(msg.Type) {
			h.saveOfflineMessage(msg)
		}
	} else if !foundLocally && allowPublish {
		if shouldPersistOffline(msg.Type) {
			h.saveOfflineMessage(msg)
		}
	}

	// РЎРёРЅС…СЂРѕРЅРёР·Р°С†РёСЏ РјРµР¶РґСѓ СѓСЃС‚СЂРѕР№СЃС‚РІР°РјРё (РћС‚РїСЂР°РІРёС‚РµР»СЋ) - удалено так как больше нет мульти-сессий
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
		if client, ok := h.clients[subscriberPubKey]; ok {
			select {
			case client.send <- msg.Payload:
			default:
				h.dropClient(client, "slow channel subscriber")
			}
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
		if client, ok := h.clients[memberPubKey]; ok {
			select {
			case client.send <- msg.Payload:
			default:
				h.dropClient(client, "slow group recipient")
			}
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

	if currentClient, ok := h.clients[client.PubKey]; ok && currentClient == client {
		delete(h.clients, client.PubKey)
		log.Printf("Client dropped: %s (%s)", client.PubKey, reason)
		if h.cache != nil {
			go func(pubKey string) {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if err := h.cache.SetOnlineStatus(ctx, pubKey, false); err != nil {
					log.Printf("Cache error setting offline %s: %v", pubKey, err)
				}
			}(client.PubKey)
		}
		if client.Token != "" {
			h.DeleteSessionToken(client.Token)
		}
	}
	if client.conn != nil {
		client.conn.Close()
	}
	client.cancel()
}

func (h *Hub) StoreSessionToken(token, pubKey string) {
	if token == "" || pubKey == "" {
		return
	}
	h.sessionTokens.Store(token, sessionTokenEntry{
		PubKey:    pubKey,
		ExpiresAt: time.Now().Add(getSessionTokenTTL()),
	})
}

func (h *Hub) DeleteSessionToken(token string) {
	if token == "" {
		return
	}
	h.sessionTokens.Delete(token)
}

func (h *Hub) ValidateSessionToken(token string) (string, bool) {
	if token == "" {
		return "", false
	}
	pubKey, ok := h.sessionTokens.Load(token)
	if !ok {
		return "", false
	}
	entry, ok := pubKey.(sessionTokenEntry)
	if !ok || entry.PubKey == "" {
		h.sessionTokens.Delete(token)
		return "", false
	}
	if time.Now().After(entry.ExpiresAt) {
		h.sessionTokens.Delete(token)
		logEvent("session_token_expired", map[string]any{"pub_key": entry.PubKey})
		return "", false
	}
	return entry.PubKey, true
}

func (h *Hub) StoreFileToken(token, filename string) {
	if token == "" || filename == "" {
		return
	}
	h.fileTokens.Store(token, fileTokenEntry{
		Filename:  filename,
		ExpiresAt: time.Now().Add(getFileTokenTTL()),
	})
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
}

func (h *Hub) ValidateFileAccess(filename, pubKey string) bool {
	if filename == "" || pubKey == "" {
		return false
	}

	storedEntry, ok := h.fileAccess.Load(filename)
	if !ok {
		return false
	}

	entry, ok := storedEntry.(fileAccessEntry)
	if !ok {
		return false
	}

	_, allowed := entry.AllowedPubKeys[pubKey]
	return allowed
}

func (h *Hub) ValidateFileToken(token, filename string) bool {
	if token == "" || filename == "" {
		return false
	}
	storedFilename, ok := h.fileTokens.Load(token)
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
}
