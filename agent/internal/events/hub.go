// Package events is the agent's event log: sequence-numbered ring buffers
// that /events replays from, plus live fan-out to SSE subscribers. Log lines
// and notable events (joins, deaths, saves, ...) share one seq but live in
// separate rings, so a burst of log lines cannot push notable events out of
// the replay. The log ring also serves /logs.
package events

import (
	"sort"
	"sync"
	"time"
)

const (
	// DefaultRingSize is how many notable (non-log) events are kept for replay.
	DefaultRingSize = 5000
	// DefaultLogSize is how many log lines are kept for replay and /logs.
	DefaultLogSize = 2000
	// subscriberBuffer is how far a subscriber may fall behind before it is
	// dropped. The client reconnects with ?since= and loses nothing that is
	// still in the rings.
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

// ring is a fixed-capacity circular buffer of events, oldest overwritten first.
type ring struct {
	buf     []Event // len == max once full
	next    int
	max     int
	evicted uint64 // seq of the newest event overwritten so far, 0 if none
}

func (r *ring) add(ev Event) {
	if r.max <= 0 {
		r.evicted = ev.Seq
		return
	}
	if len(r.buf) < r.max {
		r.buf = append(r.buf, ev)
		return
	}
	r.evicted = r.buf[r.next].Seq
	r.buf[r.next] = ev
	r.next = (r.next + 1) % r.max
}

// ordered returns the ring oldest first.
func (r *ring) ordered() []Event {
	out := make([]Event, 0, len(r.buf))
	out = append(out, r.buf[r.next:]...)
	return append(out, r.buf[:r.next]...)
}

type Hub struct {
	mu     sync.Mutex
	seq    uint64
	ring   ring // notable events
	logs   ring // `log` events
	subs   map[chan Event]struct{}
	counts map[string]uint64 // events published per type since start
	now    func() time.Time
}

func New(ringSize, logSize int) *Hub {
	return &Hub{
		ring:   ring{max: ringSize},
		logs:   ring{max: logSize},
		subs:   map[chan Event]struct{}{},
		counts: map[string]uint64{},
		now:    time.Now,
	}
}

// Publish assigns the next seq and timestamp, stores the event, and fans it
// out. A `log` event goes to the log ring, everything else to the ring of
// notable events.
func (h *Hub) Publish(typ string, data map[string]any) Event {
	if data == nil {
		data = map[string]any{}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.seq++
	h.counts[typ]++
	ev := Event{Seq: h.seq, TS: h.now().UTC(), Type: typ, Data: data}
	if typ == "log" {
		h.logs.add(ev)
	} else {
		h.ring.add(ev)
	}
	h.fanOut(ev)
	return ev
}

// PublishVolatile fans an event out to the current subscribers only: it gets
// no seq (0) and is neither stored nor replayed. For high-rate state that is
// only worth seeing live (player positions), which would otherwise wash the
// replay ring out within minutes.
func (h *Hub) PublishVolatile(typ string, data map[string]any) {
	if data == nil {
		data = map[string]any{}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.counts[typ]++
	h.fanOut(Event{TS: h.now().UTC(), Type: typ, Data: data})
}

// fanOut sends ev to every subscriber. Caller holds mu.
func (h *Hub) fanOut(ev Event) {
	for ch := range h.subs {
		select {
		case ch <- ev:
		default:
			// Too slow: drop it so it reconnects and resumes via ?since=.
			delete(h.subs, ch)
			close(ch)
		}
	}
}

// Subscribers is the number of live subscribers.
func (h *Hub) Subscribers() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}

// Subscription is what SubscribeFrom returns.
type Subscription struct {
	// Replay holds the stored events with seq > since, in seq order.
	Replay []Event
	// Ch carries everything published after Replay. It is closed when the
	// subscriber is dropped for lagging or after Unsubscribe.
	Ch chan Event
	// Gap is true when a resuming subscriber (since > 0) asks for notable
	// events that were already overwritten, so Replay misses some of them.
	// Lost log lines do not count; a fresh subscriber (since 0) never has one.
	Gap bool
}

// SubscribeFrom atomically returns the stored events with seq > since, a
// channel for everything after them, and whether notable events after since
// have already been lost.
func (h *Hub) SubscribeFrom(since uint64) Subscription {
	h.mu.Lock()
	defer h.mu.Unlock()
	replay := mergeAfter(since, h.ring.ordered(), h.logs.ordered())
	ch := make(chan Event, subscriberBuffer)
	h.subs[ch] = struct{}{}
	return Subscription{Replay: replay, Ch: ch, Gap: since > 0 && h.ring.evicted > since}
}

// mergeAfter merges two seq-ordered slices into one, keeping seq > since.
func mergeAfter(since uint64, a, b []Event) []Event {
	a = a[sort.Search(len(a), func(i int) bool { return a[i].Seq > since }):]
	b = b[sort.Search(len(b), func(i int) bool { return b[i].Seq > since }):]
	if len(a)+len(b) == 0 {
		return nil
	}
	out := make([]Event, 0, len(a)+len(b))
	for len(a) > 0 && len(b) > 0 {
		if a[0].Seq < b[0].Seq {
			out, a = append(out, a[0]), a[1:]
		} else {
			out, b = append(out, b[0]), b[1:]
		}
	}
	out = append(out, a...)
	return append(out, b...)
}

// Subscribe is SubscribeFrom without the gap report.
func (h *Hub) Subscribe(since uint64) ([]Event, chan Event) {
	s := h.SubscribeFrom(since)
	return s.Replay, s.Ch
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
	evs := h.logs.ordered()
	if n >= 0 && n < len(evs) {
		evs = evs[len(evs)-n:]
	}
	out := make([]LogLine, 0, len(evs))
	for _, ev := range evs {
		line, _ := ev.Data["line"].(string)
		out = append(out, LogLine{TS: ev.TS, Line: line})
	}
	return out
}
