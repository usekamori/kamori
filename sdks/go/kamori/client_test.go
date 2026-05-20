package kamori_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/usekamori/kamori-go/kamori"
)

func TestLogAndFlush(t *testing.T) {
	var received []map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/ingest" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Errorf("decode: %v", err)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true,"written":1}`))
	}))
	defer srv.Close()

	c := kamori.New(kamori.Options{URL: srv.URL})
	c.Log(kamori.Event{"level": "info", "message": "hello"})
	c.Flush()

	// Give the goroutine time to complete
	time.Sleep(50 * time.Millisecond)

	if len(received) != 1 {
		t.Fatalf("expected 1 event, got %d", len(received))
	}
	if received[0]["message"] != "hello" {
		t.Errorf("unexpected message: %v", received[0]["message"])
	}
}

func TestAutoFlushOnBatchSize(t *testing.T) {
	flushed := make(chan struct{}, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flushed <- struct{}{}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := kamori.New(kamori.Options{URL: srv.URL, BatchSize: 3})
	c.Log(kamori.Event{"n": 1})
	c.Log(kamori.Event{"n": 2})
	c.Log(kamori.Event{"n": 3}) // triggers auto-flush

	select {
	case <-flushed:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("auto-flush did not fire within timeout")
	}
}

func TestDefaultService(t *testing.T) {
	var received []map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&received)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := kamori.New(kamori.Options{URL: srv.URL, Service: "my-svc"})
	c.Log(kamori.Event{"message": "test"})
	c.Flush()
	time.Sleep(50 * time.Millisecond)

	if len(received) == 0 {
		t.Fatal("no events received")
	}
	if received[0]["service"] != "my-svc" {
		t.Errorf("expected service=my-svc, got %v", received[0]["service"])
	}
}

func TestScopedClient(t *testing.T) {
	var received []map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&received)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := kamori.New(kamori.Options{URL: srv.URL})
	scoped := c.Scoped(kamori.Event{"service": "api", "env": "test"})
	scoped.Log(kamori.Event{"message": "scoped event"})
	scoped.Flush()
	time.Sleep(50 * time.Millisecond)

	if len(received) == 0 {
		t.Fatal("no events received")
	}
	if received[0]["service"] != "api" || received[0]["env"] != "test" {
		t.Errorf("defaults not merged: %v", received[0])
	}
}

func TestAuthTokenHeader(t *testing.T) {
	var gotAuth string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := kamori.New(kamori.Options{URL: srv.URL, Token: "my-secret-token"})
	c.Log(kamori.Event{"message": "auth test"})
	c.Flush()
	time.Sleep(50 * time.Millisecond)

	if gotAuth != "Bearer my-secret-token" {
		t.Errorf("expected Authorization=Bearer my-secret-token, got %q", gotAuth)
	}
}

func TestNoTokenHeaderWhenTokenEmpty(t *testing.T) {
	var gotAuth string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := kamori.New(kamori.Options{URL: srv.URL})
	c.Log(kamori.Event{"message": "no auth"})
	c.Flush()
	time.Sleep(50 * time.Millisecond)

	if gotAuth != "" {
		t.Errorf("expected no Authorization header, got %q", gotAuth)
	}
}

func TestIngestURLPath(t *testing.T) {
	var gotPath string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := kamori.New(kamori.Options{URL: srv.URL})
	c.Log(kamori.Event{"message": "path check"})
	c.Flush()
	time.Sleep(50 * time.Millisecond)

	if gotPath != "/v1/ingest" {
		t.Errorf("expected path /v1/ingest, got %q", gotPath)
	}
}

func TestSendsBatchAsJSONArray(t *testing.T) {
	var received []map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&received)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := kamori.New(kamori.Options{URL: srv.URL, BatchSize: 2})
	c.Log(kamori.Event{"n": 1})
	c.Log(kamori.Event{"n": 2}) // triggers auto-flush at batchSize
	time.Sleep(50 * time.Millisecond)

	if len(received) != 2 {
		t.Fatalf("expected 2 events in batch, got %d", len(received))
	}
}

func TestFourXXDropsImmediatelyNoRetry(t *testing.T) {
	callCount := 0
	dropped := make(chan []kamori.Event, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		w.WriteHeader(http.StatusUnauthorized) // 401
	}))
	defer srv.Close()

	c := kamori.New(kamori.Options{
		URL: srv.URL,
		OnDrop: func(events []kamori.Event) {
			dropped <- events
		},
	})
	c.Log(kamori.Event{"message": "bad auth"})
	c.Flush()

	select {
	case evts := <-dropped:
		if callCount != 1 {
			t.Errorf("expected exactly 1 HTTP call on 4xx (no retry), got %d", callCount)
		}
		if len(evts) != 1 {
			t.Errorf("expected 1 dropped event, got %d", len(evts))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("drop handler never called on 4xx")
	}
}

func TestFiveXXRetriesThreeTimesThenDrops(t *testing.T) {
	callCount := 0
	dropped := make(chan []kamori.Event, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		w.WriteHeader(http.StatusServiceUnavailable) // 503
	}))
	defer srv.Close()

	c := kamori.New(kamori.Options{
		URL: srv.URL,
		OnDrop: func(events []kamori.Event) {
			dropped <- events
		},
	})
	c.Log(kamori.Event{"message": "server down"})
	c.Flush()

	select {
	case evts := <-dropped:
		// 1 initial + 3 retries = 4 total
		if callCount != 4 {
			t.Errorf("expected 4 HTTP calls (1 + 3 retries), got %d", callCount)
		}
		if len(evts) != 1 {
			t.Errorf("expected 1 dropped event, got %d", len(evts))
		}
	case <-time.After(15 * time.Second):
		t.Fatal("drop handler never called after 5xx retries")
	}
}

func TestFiveXXSucceedsOnRetry(t *testing.T) {
	callCount := 0

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		if callCount == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	dropped := false
	c := kamori.New(kamori.Options{
		URL: srv.URL,
		OnDrop: func(events []kamori.Event) {
			dropped = true
		},
	})
	c.Log(kamori.Event{"message": "transient error"})
	c.Flush()

	// Wait long enough for the 250ms retry to fire
	time.Sleep(500 * time.Millisecond)

	if dropped {
		t.Error("on_drop must not be called when a retry succeeds")
	}
	if callCount < 2 {
		t.Errorf("expected at least 2 HTTP calls (fail + retry success), got %d", callCount)
	}
}

func TestFlushOnEmptyBufferIsNoop(t *testing.T) {
	called := false

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := kamori.New(kamori.Options{URL: srv.URL})
	c.Flush() // buffer is empty — must not call server
	time.Sleep(50 * time.Millisecond)

	if called {
		t.Error("Flush() on empty buffer must not make any HTTP calls")
	}
}

func TestDropHandlerOnPermanentFailure(t *testing.T) {
	dropped := make(chan []kamori.Event, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := kamori.New(kamori.Options{
		URL: srv.URL,
		OnDrop: func(events []kamori.Event) {
			dropped <- events
		},
	})
	c.Log(kamori.Event{"message": "will fail"})
	c.Flush()

	select {
	case evts := <-dropped:
		if len(evts) != 1 {
			t.Errorf("expected 1 dropped event, got %d", len(evts))
		}
	case <-time.After(15 * time.Second):
		t.Fatal("drop handler never called")
	}
}

func TestFlushInterval(t *testing.T) {
	flushed := make(chan struct{}, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flushed <- struct{}{}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := kamori.New(kamori.Options{
		URL:           srv.URL,
		FlushInterval: 100 * time.Millisecond,
	})
	c.Log(kamori.Event{"message": "interval test"})
	// Do NOT call Flush() — the timer should fire on its own.

	select {
	case <-flushed:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("auto-flush via FlushInterval did not fire within timeout")
	}
}

func TestScopedClientEventFieldsOverrideDefaults(t *testing.T) {
	var received []map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&received)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := kamori.New(kamori.Options{URL: srv.URL})
	sc := c.Scoped(kamori.Event{"service": "default-svc", "env": "production"})
	// "service" in the event should override the scoped default.
	sc.Log(kamori.Event{"service": "override-svc", "message": "hello"})
	sc.Flush()
	time.Sleep(50 * time.Millisecond)

	if len(received) != 1 {
		t.Fatalf("expected 1 event, got %d", len(received))
	}
	if received[0]["service"] != "override-svc" {
		t.Errorf("event field should override scoped default; got service=%v", received[0]["service"])
	}
	if received[0]["env"] != "production" {
		t.Errorf("scoped default not merged; got env=%v", received[0]["env"])
	}
}

func TestMaxConcurrentDropsWhenAtCapacity(t *testing.T) {
	// Block the first request long enough for the second Flush() to find the
	// semaphore full, which should trigger an immediate drop via OnDrop.
	unblock := make(chan struct{})
	dropped := make(chan []kamori.Event, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-unblock // hold the goroutine until we signal it
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := kamori.New(kamori.Options{
		URL:           srv.URL,
		MaxConcurrent: 1,
		OnDrop: func(events []kamori.Event) {
			dropped <- events
		},
	})

	// First batch — occupies the single semaphore slot.
	c.Log(kamori.Event{"batch": 1})
	c.Flush()

	// Give the goroutine a moment to acquire the semaphore.
	time.Sleep(20 * time.Millisecond)

	// Second batch — semaphore is full, should be dropped immediately.
	c.Log(kamori.Event{"batch": 2})
	c.Flush()

	select {
	case evts := <-dropped:
		if len(evts) != 1 {
			t.Errorf("expected 1 dropped event, got %d", len(evts))
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("OnDrop was not called when MaxConcurrent was exceeded")
	}

	close(unblock) // let the first goroutine finish
	time.Sleep(50 * time.Millisecond)
}

func TestMaxBufferDropsWhenFull(t *testing.T) {
	dropped := make(chan []kamori.Event, 10)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Block indefinitely so the buffer is never drained by sends.
		time.Sleep(10 * time.Second)
	}))
	defer srv.Close()

	c := kamori.New(kamori.Options{
		URL:       srv.URL,
		BatchSize: 100,
		MaxBuffer: 2,
		OnDrop: func(events []kamori.Event) {
			dropped <- events
		},
	})

	c.Log(kamori.Event{"n": 1}) // buffer: 1
	c.Log(kamori.Event{"n": 2}) // buffer: 2 — full
	c.Log(kamori.Event{"n": 3}) // over MaxBuffer → OnDrop

	select {
	case evts := <-dropped:
		if len(evts) != 1 {
			t.Errorf("expected 1 dropped event, got %d", len(evts))
		}
		if evts[0]["n"] != 3 {
			t.Errorf("expected dropped event n=3, got %v", evts[0]["n"])
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("OnDrop was not called when MaxBuffer was exceeded")
	}
}

func TestShutdownContextDeadline(t *testing.T) {
	// The server blocks indefinitely — Shutdown should return ctx.Err() before completing.
	unblock := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-unblock
	}))
	defer func() {
		close(unblock)
		srv.Close()
	}()

	c := kamori.New(kamori.Options{URL: srv.URL, BatchSize: 1})
	c.Log(kamori.Event{"message": "will block"})
	// Flush triggers the HTTP goroutine which blocks on the server.
	c.Flush()
	time.Sleep(20 * time.Millisecond) // let goroutine start

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	err := c.Shutdown(ctx)
	if err == nil {
		t.Error("expected Shutdown to return an error when context deadline exceeded")
	}
}

func TestConcurrentLogIsSafe(t *testing.T) {
	// Run with -race to detect data races.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := kamori.New(kamori.Options{URL: srv.URL, BatchSize: 10})

	done := make(chan struct{})
	for i := 0; i < 5; i++ {
		go func(n int) {
			for j := 0; j < 20; j++ {
				c.Log(kamori.Event{"goroutine": n, "seq": j})
			}
			done <- struct{}{}
		}(i)
	}
	for i := 0; i < 5; i++ {
		<-done
	}
	c.Flush()
	time.Sleep(100 * time.Millisecond)
}
