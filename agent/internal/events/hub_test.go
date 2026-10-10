package events

import "testing"

func TestRingWrapAndReplay(t *testing.T) {
	h := New(3, 2)
	for i := 0; i < 5; i++ {
		h.Publish("log", map[string]any{"line": string(rune('a' + i))})
	}
	replay, ch := h.Subscribe(0)
	defer h.Unsubscribe(ch)
	if len(replay) != 3 || replay[0].Seq != 3 || replay[2].Seq != 5 {
		t.Fatalf("replay = %+v", replay)
	}
	replay2, ch2 := h.Subscribe(4)
	defer h.Unsubscribe(ch2)
	if len(replay2) != 1 || replay2[0].Seq != 5 {
		t.Fatalf("replay since 4 = %+v", replay2)
	}

	h.Publish("join_code", map[string]any{"code": "123456"})
	if ev := <-ch; ev.Seq != 6 || ev.Type != "join_code" {
		t.Fatalf("live = %+v", ev)
	}

	logs := h.Logs(10)
	if len(logs) != 2 || logs[0].Line != "d" || logs[1].Line != "e" {
		t.Fatalf("logs = %+v", logs)
	}
	if got := h.Logs(1); len(got) != 1 || got[0].Line != "e" {
		t.Fatalf("logs(1) = %+v", got)
	}
}

func TestSlowSubscriberDropped(t *testing.T) {
	h := New(10, 10)
	_, ch := h.Subscribe(0)
	for i := 0; i < subscriberBuffer+1; i++ {
		h.Publish("x", nil)
	}
	n := 0
	for range ch {
		n++
	}
	if n != subscriberBuffer {
		t.Fatalf("received %d before close, want %d", n, subscriberBuffer)
	}
	h.Unsubscribe(ch) // must not double-close
}

func TestLogsEmptyNotNil(t *testing.T) {
	if got := New(1, 1).Logs(5); got == nil {
		t.Fatal("Logs returned nil")
	}
}

func TestCount(t *testing.T) {
	h := New(2, 2)
	for i := 0; i < 3; i++ {
		h.Publish("death", nil)
	}
	h.Publish("log", map[string]any{"line": "x"})
	// Counts survive ring wrap-around.
	if h.Count("death") != 3 || h.Count("log") != 1 || h.Count("raid") != 0 {
		t.Errorf("counts = %d %d %d", h.Count("death"), h.Count("log"), h.Count("raid"))
	}
}

func TestPublishVolatile(t *testing.T) {
	h := New(10, 10)
	h.Publish("a", nil)
	if h.Subscribers() != 0 {
		t.Fatal("no subscribers yet")
	}
	_, ch := h.Subscribe(0)
	if h.Subscribers() != 1 {
		t.Fatal("one subscriber")
	}
	h.PublishVolatile("positions", map[string]any{"players": []any{}})
	ev := <-ch
	if ev.Type != "positions" || ev.Seq != 0 {
		t.Fatalf("got %+v", ev)
	}
	replay, ch2 := h.Subscribe(0)
	defer h.Unsubscribe(ch2)
	for _, e := range replay {
		if e.Type == "positions" {
			t.Fatal("volatile event was stored")
		}
	}
	if h.Publish("b", nil).Seq != 2 {
		t.Fatal("volatile event took a seq")
	}
	h.Unsubscribe(ch)
}
