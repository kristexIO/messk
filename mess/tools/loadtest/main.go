package main

import (
	"context"
	crand "crypto/rand"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	mrand "math/rand"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/nacl/box"
)

// Advanced Load testing tool for E2EE Messenger
// Features: Random messaging, Churn (disconnects), Varying payloads, Database stress.

var (
	targetURL  = flag.String("url", "ws://localhost:8080/ws", "WebSocket URL")
	numClients = flag.Int("clients", 500, "Number of concurrent clients")
	duration   = flag.Duration("duration", 1*time.Minute, "Duration of the test")
	msgRate    = flag.Duration("rate", 2*time.Second, "Average message rate per client")
	churnRate  = flag.Float64("churn", 0.1, "Probability of a client disconnecting/reconnecting per minute")
)

type Stats struct {
	Connected      int64
	AuthSuccess    int64
	MessagesSent   int64
	MessagesRecv   int64
	OfflineRecv    int64
	Errors         int64
	LatencySumMs   int64
	LatencyCount   int64
}

type Registry struct {
	mu   sync.RWMutex
	keys []string
}

func (r *Registry) Add(key string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.keys = append(r.keys, key)
}

func (r *Registry) GetRandom(exclude string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(r.keys) < 2 {
		return exclude
	}
	for {
		k := r.keys[mrand.Intn(len(r.keys))]
		if k != exclude {
			return k
		}
	}
}

func main() {
	flag.Parse()
	mrand.Seed(time.Now().UnixNano())

	stats := &Stats{}
	registry := &Registry{}
	ctx, cancel := context.WithTimeout(context.Background(), *duration)
	defer cancel()

	var wg sync.WaitGroup

	fmt.Printf("Starting ADVANCED load test: %d clients, churn %.1f%%, duration %v\n", *numClients, *churnRate*100, *duration)

	for i := 0; i < *numClients; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			runClientLifeCycle(ctx, id, registry, stats)
		}(i)
		time.Sleep(5 * time.Millisecond) // Staggered start
	}

	// Stats reporter
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				mSent := atomic.LoadInt64(&stats.MessagesSent)
				mRecv := atomic.LoadInt64(&stats.MessagesRecv)
				avgLat := float64(0)
				lCount := atomic.LoadInt64(&stats.LatencyCount)
				if lCount > 0 {
					avgLat = float64(atomic.LoadInt64(&stats.LatencySumMs)) / float64(lCount)
				}

				fmt.Printf("[%v] Clients: %d | Auth: %d | Sent: %d | Recv: %d | Offline: %d | Avg Latency: %.2fms | Errors: %d\n",
					time.Now().Format("15:04:05"),
					atomic.LoadInt64(&stats.Connected),
					atomic.LoadInt64(&stats.AuthSuccess),
					mSent, mRecv,
					atomic.LoadInt64(&stats.OfflineRecv),
					avgLat,
					atomic.LoadInt64(&stats.Errors))
			}
		}
	}()

	wg.Wait()
	fmt.Println("\n--- FINAL TEST RESULTS ---")
	fmt.Printf("Total Authenticated: %d\n", atomic.LoadInt64(&stats.AuthSuccess))
	fmt.Printf("Messages Sent:        %d\n", atomic.LoadInt64(&stats.MessagesSent))
	fmt.Printf("Messages Received:    %d\n", atomic.LoadInt64(&stats.MessagesRecv))
	fmt.Printf("Offline Messages:    %d\n", atomic.LoadInt64(&stats.OfflineRecv))
	fmt.Printf("Errors encountered:  %d\n", atomic.LoadInt64(&stats.Errors))
}

func runClientLifeCycle(ctx context.Context, id int, reg *Registry, stats *Stats) {
	// Generate persistent keys for this client
	pub, priv, _ := box.GenerateKey(crand.Reader)
	pubStr := base64.StdEncoding.EncodeToString(pub[:])
	reg.Add(pubStr)

	for {
		select {
		case <-ctx.Done():
			return
		default:
			simulateSession(ctx, pubStr, pub, priv, reg, stats)
			
			// If churn happens or error occurs, wait a bit and reconnect
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Duration(mrand.Intn(5)+1) * time.Second):
				// Reconnect loop
			}
		}
	}
}

func simulateSession(ctx context.Context, pubStr string, pub, priv *[32]byte, reg *Registry, stats *Stats) {
	u, _ := url.Parse(*targetURL)
	q := u.Query()
	q.Set("pub", pubStr)
	u.RawQuery = q.Encode()

	dialer := websocket.DefaultDialer
	header := make(http.Header)
	header.Set("Origin", "http://localhost:5173")
	
	conn, _, err := dialer.Dial(u.String(), header)
	if err != nil {
		atomic.AddInt64(&stats.Errors, 1)
		return
	}
	defer conn.Close()
	atomic.AddInt64(&stats.Connected, 1)
	defer atomic.AddInt64(&stats.Connected, -1)

	if err := handleAuth(conn, pub, priv); err != nil {
		atomic.AddInt64(&stats.Errors, 1)
		return
	}
	atomic.AddInt64(&stats.AuthSuccess, 1)

	// Receiver loop
	go func() {
		for {
			_, p, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var env struct {
				Type string `json:"type"`
				Data string `json:"data"`
			}
			if err := json.Unmarshal(p, &env); err == nil {
				if env.Type == "message" {
					atomic.AddInt64(&stats.MessagesRecv, 1)
					// Calculate latency if timestamp is present
					var data struct {
						Ts int64 `json:"ts"`
					}
					if json.Unmarshal([]byte(env.Data), &data) == nil && data.Ts > 0 {
						lat := time.Since(time.Unix(0, data.Ts)).Milliseconds()
						atomic.AddInt64(&stats.LatencySumMs, lat)
						atomic.AddInt64(&stats.LatencyCount, 1)
					}
				} else if env.Type == "offline_message" {
					atomic.AddInt64(&stats.OfflineRecv, 1)
					atomic.AddInt64(&stats.MessagesRecv, 1)
				}
			}
		}
	}()

	// Sender loop
	ticker := time.NewTicker(time.Duration(float64(*msgRate) * (0.5 + mrand.Float64())))
	defer ticker.Stop()

	churnTicker := time.NewTicker(10 * time.Second)
	defer churnTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-churnTicker.C:
			if mrand.Float64() < (*churnRate / 6.0) {
				return // Trigger reconnect
			}
		case <-ticker.C:
			target := reg.GetRandom(pubStr)
			if target == pubStr {
				continue
			}

			// Simulate different message types
			payloadSize := 32
			if mrand.Float64() < 0.1 { // 10% are "heavy" (voice/files)
				payloadSize = 1024 * 10 // 10KB
			}
			
			dummyData := make([]byte, payloadSize)
			crand.Read(dummyData)
			
			dataMap := map[string]interface{}{
				"ts":      time.Now().UnixNano(),
				"payload": base64.StdEncoding.EncodeToString(dummyData),
			}
			dataJSON, _ := json.Marshal(dataMap)

			msg := map[string]interface{}{
				"type":              "message",
				"recipient_pub_key": target,
				"sender_pub_key":    pubStr,
				"data":              string(dataJSON),
			}
			
			if err := conn.WriteJSON(msg); err != nil {
				atomic.AddInt64(&stats.Errors, 1)
				return
			}
			atomic.AddInt64(&stats.MessagesSent, 1)
		}
	}
}

func handleAuth(conn *websocket.Conn, pub, priv *[32]byte) error {
	var challenge map[string]string
	if err := conn.ReadJSON(&challenge); err != nil {
		return err
	}
	ephemeralBytes, _ := base64.StdEncoding.DecodeString(challenge["ephemeral"])
	var ephemeral [32]byte
	copy(ephemeral[:], ephemeralBytes)
	encryptedChallenge, _ := base64.StdEncoding.DecodeString(challenge["challenge"])
	var nonce [24]byte
	copy(nonce[:], encryptedChallenge[:24])
	decrypted, ok := box.Open(nil, encryptedChallenge[24:], &nonce, &ephemeral, priv)
	if !ok {
		return fmt.Errorf("auth fail")
	}
	res := map[string]string{"type": "auth_response", "challenge": string(decrypted)}
	if err := conn.WriteJSON(res); err != nil {
		return err
	}
	var success map[string]string
	if err := conn.ReadJSON(&success); err != nil {
		return err
	}
	return nil
}
