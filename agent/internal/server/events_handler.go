package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/krystianslowik/skald/agent/internal/events"
)

// eventsHandler streams events as SSE. It first replays buffered events with
// seq > since (from ?since=, or the Last-Event-ID header on an EventSource
// auto-reconnect), then streams live ones. A subscriber that falls too far
// behind is dropped by the hub; the stream ends and the client resumes.
func (s *Server) eventsHandler(w http.ResponseWriter, r *http.Request) {
	sinceStr := r.URL.Query().Get("since")
	if sinceStr == "" {
		sinceStr = r.Header.Get("Last-Event-ID")
	}
	var since uint64
	if sinceStr != "" {
		v, err := strconv.ParseUint(sinceStr, 10, 64)
		if err != nil {
			http.Error(w, "bad since", http.StatusBadRequest)
			return
		}
		since = v
	}

	rc := http.NewResponseController(w)
	// The server-wide WriteTimeout would cut the stream; disable it here.
	_ = rc.SetWriteDeadline(time.Time{})

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	sub := s.opt.Hub.SubscribeFrom(since)
	ch := sub.Ch
	defer s.opt.Hub.Unsubscribe(ch)

	if sub.Gap {
		// Notable events after since were already overwritten: the client
		// fell behind further than the ring reaches. Say so rather than
		// replay silently with a hole in it.
		s.opt.Logger.Warn("events: since is older than the replay ring, some events were lost", "since", since)
		if _, err := fmt.Fprintf(w, ": gap since=%d\n\n", since); err != nil {
			return
		}
	}
	for _, ev := range sub.Replay {
		if writeEvent(w, ev) != nil {
			return
		}
	}
	if rc.Flush() != nil {
		return
	}

	ping := time.NewTicker(s.opt.PingEvery)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			if writeEvent(w, ev) != nil || rc.Flush() != nil {
				return
			}
		case <-ping.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil || rc.Flush() != nil {
				return
			}
		}
	}
}

func writeEvent(w http.ResponseWriter, ev events.Event) error {
	b, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	if ev.Seq == 0 {
		// Volatile: not replayable, so it must not move Last-Event-ID.
		_, err = fmt.Fprintf(w, "data: %s\n\n", b)
		return err
	}
	_, err = fmt.Fprintf(w, "id: %d\ndata: %s\n\n", ev.Seq, b)
	return err
}
