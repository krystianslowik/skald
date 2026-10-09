// Package events is the agent's event log: a sequence-numbered ring buffer
// that /events replays from, plus live fan-out to SSE subscribers, plus a
// separate ring of log lines for /logs.
package events

import (
	"sync"
	"time"
)

const (
	DefaultRingSize = 5000
	DefaultLogSize  = 2000
	// subscriberBuffer is how far a subscriber may fall behind before it is
	// dropped. The client reconnects with ?since= and loses nothing that is
	// still in the ring.
	subscriberBuffer = 512
)

// Event is the wire shape of one SSE `data:` frame.
type Event struct {
	Seq  uint64         `json:"seq"`
	TS   time.Time      `json:"ts"`
	Type string         `json:"type"`
	Data map[string]any `json:"data"`
}

// LogLine is one entry of GET /logs.
type LogLine struct {
	TS   time.Time `json:"ts"`
	Line string    `json:"line"`
}

type Hub struct {
	mu      sync.Mutex
	seq     uint64
	ring    []Event // circular, len == cap once full
	next    int
	logs    []LogLine
	logNext int
	subs    map[chan Event]struct{}
	counts  map[string]uint64 // events published per type since start
	now     func() time.Time
	ringCap int
	logCap  int
}

func New(ringSize, logSize int) *Hub {
	return &Hub{
		subs:    map[chan Event]struct{}{},
		counts:  map[string]uint64{},
		now:     time.Now,
		ringCap: ringSize,
		logCap:  logSize,
	}
}

// Publish assigns the next seq and timestamp, stores the event, and fans it
// out. A `log` event with a "line" string is also stored in the log ring.
func (h *Hub) Publish(typ string, data map[string]any) Event {
	if data == nil {
		data = map[string]any{}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.seq++
	h.counts[typ]++
	ev := Event{Seq: h.seq, TS: h.now().UTC(), Type: typ, Data: data}

	if len(h.ring) < h.ringCap {
		h.ring = append(h.ring, ev)
	} else {
		h.ring[h.next] = ev
		h.next = (h.next + 1) % h.ringCap
	}
	if typ == "log" {
		line, _ := data["line"].(string)
		ll := LogLine{TS: ev.TS, Line: line}
		if len(h.logs) < h.logCap {
			h.logs = append(h.logs, ll)
		} else {
			h.logs[h.logNext] = ll
			h.logNext = (h.logNext + 1) % h.logCap
		}
	}

	for ch := range h.subs {
		select {
		case ch <- ev:
		default:
			// Too slow: drop it so it reconnects and resumes via ?since=.
			delete(h.subs, ch)
			close(ch)
		}
	}
	return ev
}

// Subscribe atomically returns the buffered events with seq > since and a
// channel for everything after them. The channel is closed when the
// subscriber is dropped for lagging or after Unsubscribe.
func (h *Hub) Subscribe(since uint64) ([]Event, chan Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	var replay []Event
	for _, ev := range h.ordered() {
		if ev.Seq > since {
			replay = append(replay, ev)
		}
	}
	ch := make(chan Event, subscriberBuffer)
	h.subs[ch] = struct{}{}
	return replay, ch
}

func (h *Hub) Unsubscribe(ch chan Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.subs[ch]; ok {
		delete(h.subs, ch)
		close(ch)
	}
}

// Count returns how many events of type typ were published since start.
func (h *Hub) Count(typ string) uint64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.counts[typ]
}

// Logs returns the last n log lines, oldest first. Never nil.
func (h *Hub) Logs(n int) []LogLine {
	h.mu.Lock()
	defer h.mu.Unlock()
	all := make([]LogLine, 0, len(h.logs))
	all = append(all, h.logs[h.logNext:]...)
	all = append(all, h.logs[:h.logNext]...)
	if n >= 0 && n < len(all) {
		all = all[len(all)-n:]
	}
	return all
}

// ordered returns the ring oldest first. Caller holds mu.
func (h *Hub) ordered() []Event {
	out := make([]Event, 0, len(h.ring))
	out = append(out, h.ring[h.next:]...)
	return append(out, h.ring[:h.next]...)
}
