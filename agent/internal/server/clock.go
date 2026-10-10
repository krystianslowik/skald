package server

import (
	"math"
	"sync"
	"time"

	"github.com/krystianslowik/skald/agent/internal/state"
	"github.com/krystianslowik/skald/agent/internal/world"
)

// worldClock is GET /state `world.clock`: where the world's day stands now.
//
// netTime only reaches disk with a save, so between saves the clock is
// extrapolated: a dedicated server advances world time only while someone
// is connected, so the estimate adds the wall time since the later of the
// last save and the moment the current players started arriving, and adds
// nothing while the server is empty. Rate, once two saves were seen, is the
// netTime gained per wall second between them (about 1 with players on,
// 0 when the world slept through the interval); it corroborates `advancing`
// but does not drive it.
type worldClock struct {
	NetTime float64 `json:"netTime"`
	Day     int64   `json:"day"`
	// DayFraction is the time of day, 0..1, as netTime mod the 1800 s day.
	DayFraction float64 `json:"dayFraction"`
	// Daylight is an approximation: the middle half of the day (fraction
	// 0.25..0.75) counts as day. The game's exact dawn and dusk are not
	// verified against a source.
	Daylight  bool     `json:"daylight"`
	Advancing bool     `json:"advancing"`
	Rate      *float64 `json:"rate"`
}

// maxExtrapolate caps the estimate in case saves stop (save interval off).
const maxExtrapolate = 2 * time.Hour

type savePoint struct {
	at      time.Time
	netTime float64
}

type clockTracker struct {
	mu         sync.Mutex
	prev, last savePoint
}

// observe records a save the first time its timestamp is seen.
func (c *clockTracker) observe(m *world.Meta) {
	if m == nil || m.SavedAt.IsZero() {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if m.SavedAt.Equal(c.last.at) {
		return
	}
	c.prev, c.last = c.last, savePoint{at: m.SavedAt, netTime: m.NetTime}
}

func (c *clockTracker) rate() *float64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.prev.at.IsZero() {
		return nil
	}
	wall := c.last.at.Sub(c.prev.at).Seconds()
	if wall <= 0 {
		return nil
	}
	r := math.Round((c.last.netTime-c.prev.netTime)/wall*1000) / 1000
	return &r
}

func (s *Server) clock(m *world.Meta, players []state.Player, now time.Time) *worldClock {
	if m == nil {
		return nil
	}
	s.clocks.observe(m)
	c := &worldClock{NetTime: m.NetTime, Advancing: len(players) > 0, Rate: s.clocks.rate()}
	if c.Advancing {
		from := m.SavedAt
		if earliest := earliestSince(players); !earliest.IsZero() && earliest.After(from) {
			from = earliest
		}
		if d := now.Sub(from); d > 0 {
			c.NetTime += math.Min(d.Seconds(), maxExtrapolate.Seconds())
		}
	}
	c.Day = int64(math.Floor(c.NetTime / world.DayLengthSec))
	c.DayFraction = math.Round(math.Mod(c.NetTime, world.DayLengthSec)/world.DayLengthSec*1000) / 1000
	c.Daylight = c.DayFraction >= 0.25 && c.DayFraction < 0.75
	return c
}

// earliestSince is when the current group of players started arriving.
func earliestSince(players []state.Player) time.Time {
	var t time.Time
	for _, p := range players {
		if !p.Since.IsZero() && (t.IsZero() || p.Since.Before(t)) {
			t = p.Since
		}
	}
	return t
}
