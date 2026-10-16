package server

import (
	"net/http"
	"testing"
	"time"
)

// waitWanted polls PositionsWanted until it equals want; streams register
// asynchronously with the request.
func waitWanted(t *testing.T, s *Server, want bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if s.PositionsWanted() == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("PositionsWanted() = %v, want %v", !want, want)
}

func TestPositionsWantedNobody(t *testing.T) {
	h := newHarness(t)
	if h.s.PositionsWanted() {
		t.Error("wanted with no stream at all")
	}
}

// A stream from an older skald-web never asks for positions: it keeps
// getting them as long as it is connected, as before.
func TestPositionsWantedLegacyStream(t *testing.T) {
	h := newHarness(t)
	r := h.do(t, "GET", "/events", token)
	readEvents(t, r.Body, 0, true)
	waitWanted(t, h.s, true)
	r.Body.Close()
	waitWanted(t, h.s, false)
}

// A stream that opts in to the lease is not by itself a reason to poll.
func TestPositionsWantedLease(t *testing.T) {
	h := newHarness(t)
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	h.s.now = func() time.Time { return now }

	r := h.do(t, "GET", "/events?positions=lease", token)
	defer r.Body.Close()
	readEvents(t, r.Body, 0, true)
	if h.s.PositionsWanted() {
		t.Fatal("a lease stream alone wants positions")
	}

	if w := h.do(t, "POST", "/positions/watch", token); w.StatusCode != http.StatusNoContent {
		t.Fatalf("POST /positions/watch = %d", w.StatusCode)
	}
	if !h.s.PositionsWanted() {
		t.Fatal("not wanted after a watch")
	}
	now = now.Add(positionsLease - time.Second)
	if !h.s.PositionsWanted() {
		t.Error("lease ended early")
	}
	now = now.Add(2 * time.Second)
	if h.s.PositionsWanted() {
		t.Error("lease outlived its term without a renewal")
	}

	// Two web tiers on one agent: one ending its lease leaves the other's.
	h.do(t, "POST", "/positions/watch?holder=a", token)
	h.do(t, "POST", "/positions/watch?holder=b", token)
	if w := h.do(t, "DELETE", "/positions/watch?holder=a", token); w.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /positions/watch = %d", w.StatusCode)
	}
	if !h.s.PositionsWanted() {
		t.Error("one holder ended another's lease")
	}
	h.do(t, "DELETE", "/positions/watch?holder=b", token)
	if h.s.PositionsWanted() {
		t.Error("still wanted after every watch ended")
	}
	if w := h.do(t, "POST", "/positions/watch", ""); w.StatusCode != http.StatusUnauthorized {
		t.Errorf("watch without a token = %d", w.StatusCode)
	}
}
