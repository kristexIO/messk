package main

import (
	"context"
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
	clients      map[string]map[*Client]bool // РўРµРїРµСЂСЊ РѕРґРёРЅ РєР»СЋС‡ РјРѕР¶РµС‚ РёРјРµС‚СЊ РЅРµСЃРєРѕР»СЊРєРѕ СЃРµСЃСЃРёР№
	register     chan *Client
	unregister   chan *Client
	routeMessage chan *Message

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
		register:     make(chan *Client),
		unregister:   make(chan *Client),
		clients:      make(map[string]map[*Client]bool),
		routeMessage: make(chan *Message, 256),
		db:           db,
		cache:        cache,
		rdb:          rdb,
	}
}

func (h *Hub) Run() {
	// РџРѕРґРїРёСЃРєР° РЅР° Redis РєР°РЅР°Р» (Point 29)
	if h.rdb != nil {
		pubsub := h.rdb.Subscribe(context.Background(), "messenger_routing")
		go func() {
			for msg := range pubsub.Channel() {
				var m Message
				if err := json.Unmarshal([]byte(msg.Payload), &m); err == nil {
					h.routeToLocal(&m, false) // false means don't republish to Redis
				}
			}
		}()
	}

	for {
		select {
		case client := <-h.register:
			if h.clients[client.PubKey] == nil {
				h.clients[client.PubKey] = make(map[*Client]bool)
			}
			h.clients[client.PubKey][client] = true
			log.Printf("Client registered: %s (Total sessions: %d)", client.PubKey, len(h.clients[client.PubKey]))

			isFirstConnection := len(h.clients[client.PubKey]) == 1

			// Р’С‹РїРѕР»РЅСЏРµРј Р·Р°РїСЂРѕСЃС‹ Рє Р‘Р” РЅРµ Р±Р»РѕРєРёСЂСѓСЏ РіР»Р°РІРЅС‹Р№ С†РёРєР» С…Р°Р±Р°
			go func(c *Client, isFirst bool) {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()

				if err := h.db.SaveUserIfNotExists(ctx, c.PubKey); err != nil {
					log.Printf("DB error saving user %s: %v", c.PubKey, err)
				}

				if isFirst {
					if err := h.cache.SetOnlineStatus(ctx, c.PubKey, true); err != nil {
						log.Printf("Cache error setting online %s: %v", c.PubKey, err)
					}
				}

				// РџРѕР»СѓС‡Р°РµРј Рё СѓРґР°Р»СЏРµРј РѕС„С„Р»Р°Р№РЅ СЃРѕРѕР±С‰РµРЅРёСЏ РёР· Р±Р°Р·С‹
				offlineMsgs, err := h.db.GetAndDeleteOfflineMessages(ctx, c.PubKey)
				if err != nil {
					log.Printf("Error getting offline messages for %s: %v", c.PubKey, err)
				} else if len(offlineMsgs) > 0 {
					for _, msg := range offlineMsgs {
						select {
						case <-c.ctx.Done():
							return
						case c.send <- msg.Payload:
						}
					}
					log.Printf("Sent %d offline messages to %s", len(offlineMsgs), c.PubKey)
				}
			}(client, isFirstConnection)

		case client := <-h.unregister:
			h.dropClient(client, "unregistered")

		case msg := <-h.routeMessage:
			h.routeToLocal(msg, true) // true means republish to Redis if not found locally
		}
	}
}

func (h *Hub) routeToLocal(msg *Message, allowPublish bool) {
	if isGroupRoutedType(msg.Type) {
		h.routeGroupMessage(msg)
		return
	}
	if isChannelRoutedType(msg.Type) {
		h.routeChannelMessage(msg)
		return
	}

	// РћС‚РїСЂР°РІР»СЏРµРј РїРѕР»СѓС‡Р°С‚РµР»СЋ
	recipientConnections, recipientOnline := h.clients[msg.RecipientPubKey]
	foundLocally := false

	if recipientOnline && len(recipientConnections) > 0 {
		foundLocally = true
		for client := range recipientConnections {
			select {
			case client.send <- msg.Payload:
			default:
				h.dropClient(client, "slow recipient")
			}
		}
		if len(recipientConnections) == 0 {
			delete(h.clients, msg.RecipientPubKey)
			if msg.Type == "message" {
				h.saveOfflineMessage(msg)
			}
		}
	}

	// Р•СЃР»Рё РЅРµ РЅР°С€Р»Рё Р»РѕРєР°Р»СЊРЅРѕ, РЅРѕ СЂР°Р·СЂРµС€РµРЅРѕ РїСѓР±Р»РёРєРѕРІР°С‚СЊ РІ Redis
	if !foundLocally && allowPublish && h.rdb != nil {
		payload, _ := json.Marshal(msg)
		h.rdb.Publish(context.Background(), "messenger_routing", payload)

		if shouldPersistOffline(msg.Type) {
			h.saveOfflineMessage(msg)
		}
	} else if !foundLocally && allowPublish {
		if shouldPersistOffline(msg.Type) {
			h.saveOfflineMessage(msg)
		}
	}

	// РЎРёРЅС…СЂРѕРЅРёР·Р°С†РёСЏ РјРµР¶РґСѓ СѓСЃС‚СЂРѕР№СЃС‚РІР°РјРё (РћС‚РїСЂР°РІРёС‚РµР»СЋ)
	if msg.Type == "message" && msg.SenderPubKey != msg.RecipientPubKey {
		if senderConnections, ok := h.clients[msg.SenderPubKey]; ok && len(senderConnections) > 0 {
			for client := range senderConnections {
				select {
				case client.send <- msg.Payload:
				default:
					h.dropClient(client, "slow sender mirror")
				}
			}
		}
	}
}

func (h *Hub) routeChannelMessage(msg *Message) {
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

	for _, subscriberPubKey := range subscriberPubKeys {
		if subscriberPubKey == "" {
			continue
		}
		if subscriberConnections, ok := h.clients[subscriberPubKey]; ok && len(subscriberConnections) > 0 {
			for client := range subscriberConnections {
				select {
				case client.send <- msg.Payload:
				default:
					h.dropClient(client, "slow channel recipient")
				}
			}
			continue
		}

		if subscriberPubKey != msg.SenderPubKey {
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
	case "typing", "delivery_receipt", "read_receipt":
		return false
	default:
		return true
	}
}

func (h *Hub) routeGroupMessage(msg *Message) {
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

	for _, memberPubKey := range memberPubKeys {
		if memberPubKey == "" {
			continue
		}
		if memberConnections, ok := h.clients[memberPubKey]; ok && len(memberConnections) > 0 {
			for client := range memberConnections {
				select {
				case client.send <- msg.Payload:
				default:
					h.dropClient(client, "slow group recipient")
				}
			}
			continue
		}

		if memberPubKey != msg.SenderPubKey {
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
	connections, ok := h.clients[client.PubKey]
	if !ok {
		return
	}
	if _, exists := connections[client]; !exists {
		return
	}

	delete(connections, client)
	h.DeleteSessionToken(client.Token)
	client.cancel()
	log.Printf("Client dropped: %s (%s, remaining sessions: %d)", client.PubKey, reason, len(connections))

	if len(connections) == 0 {
		delete(h.clients, client.PubKey)
		log.Printf("All sessions closed for %s. Marking offline.", client.PubKey)
		if h.cache != nil {
			go func(pubKey string) {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if err := h.cache.SetOnlineStatus(ctx, pubKey, false); err != nil {
					log.Printf("Cache error setting offline %s: %v", pubKey, err)
				}
			}(client.PubKey)
		}
	}
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
