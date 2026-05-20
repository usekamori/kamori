// go-service — Fraud Detection
//
// ──────────────────────────────────────────────────────────────────────────
// SDK Integration: Go KamoriClient + Scoped()  (github.com/usekamori/kamori-go)
//
// KamoriClient buffers events and flushes them to a Kamori ingest server in
// background goroutines. Scoped() binds default fields to every event.
//
// Integration (4 lines):
//
//	client := kamori.New(kamori.Options{URL: url, Token: token, Service: "my-service"})
//	defer client.Shutdown(context.Background())
//	scoped := client.Scoped(kamori.Event{"sdk": "KamoriClient+Scoped"})
//	scoped.Log(kamori.Event{"level": "info", "event": "fraud_check_passed", ...})
//
// Best for: Go services that want full structured event control.
// ──────────────────────────────────────────────────────────────────────────
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"sync/atomic"

	"github.com/usekamori/kamori-go/kamori"
)

var (
	checkCount atomic.Int64
	kamoriLog   *kamori.ScopedClient
	client     *kamori.Client
)

func main() {
	kamoriURL    := getenv("KAMORI_URL",    "http://localhost:3110")
	ingestToken := getenv("INGEST_TOKEN", "")
	port        := getenv("PORT",         "7000")

	// ── Kamori Go SDK ──────────────────────────────────────────────────────
	// Create client, then scope default fields so every event gets service + sdk.
	client = kamori.New(kamori.Options{
		URL:     kamoriURL,
		Token:   ingestToken,
		Service: "go-service",
	})
	defer client.Shutdown(context.Background())
	kamoriLog = client.Scoped(kamori.Event{"sdk": "KamoriClient+Scoped"})
	// ──────────────────────────────────────────────────────────────────────

	http.HandleFunc("/health",       handleHealth)
	http.HandleFunc("/check-fraud",  handleCheckFraud)

	kamoriLog.Log(kamori.Event{"level": "info", "event": "server_started", "port": port})
	log.Printf("go-service listening on :%s\n", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"ok":      true,
		"service": "go-service",
		"sdk":     "KamoriClient+Scoped",
	})
}

func handleCheckFraud(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	orderId, _ := body["orderId"].(string)
	amount, _  := body["amount"].(float64)
	userId, _  := body["userId"].(string)

	n := checkCount.Add(1)
	w.Header().Set("Content-Type", "application/json")

	// Fault: every 15th check flags the order as a false-positive fraud signal
	if n%15 == 0 {
		kamoriLog.Log(kamori.Event{
			"level":   "warn",
			"event":   "fraud_signal_detected",
			"orderId": orderId,
			"userId":  userId,
			"amount":  amount,
			"reason":  "velocity check: 3 orders in 60s from same IP (false positive simulation)",
		})
		json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "orderId": orderId, "fraud": true, "risk": "high",
		})
		return
	}

	kamoriLog.Log(kamori.Event{
		"level":   "info",
		"event":   "fraud_check_passed",
		"orderId": orderId,
		"userId":  userId,
		"amount":  amount,
	})
	json.NewEncoder(w).Encode(map[string]any{
		"ok": true, "orderId": orderId, "fraud": false, "risk": "low",
	})
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
