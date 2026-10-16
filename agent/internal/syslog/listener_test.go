package syslog

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"slices"
	"testing"
	"time"
)

// flakyConn is a PacketConn whose ReadFrom fails `fails` times, then returns
// one line, then fails forever. Only ReadFrom and Close are used by serve.
type flakyConn struct {
	net.PacketConn
	fails  int
	reads  int
	closed chan struct{}
}

func (c *flakyConn) ReadFrom(b []byte) (int, net.Addr, error) {
	c.reads++
	if c.reads == c.fails+1 {
		return copy(b, "hello\n"), nil, nil
	}
	return 0, nil, errors.New("recvfrom: no buffer space available")
}

func (c *flakyConn) Close() error { close(c.closed); return nil }

// A persistent read error must back off exponentially up to a cap instead of
// spinning, and a successful read must reset the backoff.
func TestServeBacksOffOnReadErrors(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var waits []time.Duration
	orig := sleep
	sleep = func(_ context.Context, d time.Duration) {
		waits = append(waits, d)
		if len(waits) == 15 {
			cancel()
		}
	}
	defer func() { sleep = orig }()

	conn := &flakyConn{fails: 9, closed: make(chan struct{})}
	var lines []string
	err := serve(ctx, conn, slog.New(slog.NewTextHandler(io.Discard, nil)), func(l string) { lines = append(lines, l) })
	if err != nil {
		t.Fatal(err)
	}
	ms := time.Millisecond
	want := []time.Duration{
		50 * ms, 100 * ms, 200 * ms, 400 * ms, 800 * ms, 1600 * ms, 3200 * ms, 5000 * ms, 5000 * ms,
		// The good read resets the backoff.
		50 * ms, 100 * ms, 200 * ms, 400 * ms, 800 * ms, 1600 * ms,
	}
	if !slices.Equal(waits, want) {
		t.Errorf("waits = %v\nwant    %v", waits, want)
	}
	if len(lines) != 1 || lines[0] != "hello" {
		t.Errorf("lines = %q", lines)
	}
	// One read per wait, the good one, and the last failed read after cancel.
	if conn.reads != 17 {
		t.Errorf("reads = %d, want 17", conn.reads)
	}
}

// A socket closed while ctx is still live cannot recover: serve must return
// an error rather than loop.
func TestServeReturnsOnClosedSocket(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	pc.Close()
	done := make(chan error, 1)
	go func() {
		done <- serve(context.Background(), pc, slog.New(slog.NewTextHandler(io.Discard, nil)), func(string) {})
	}()
	select {
	case err := <-done:
		if !errors.Is(err, net.ErrClosed) {
			t.Fatalf("err = %v, want net.ErrClosed", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("serve kept looping on a closed socket")
	}
}

func TestListen(t *testing.T) {
	// Grab a free UDP port.
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := pc.LocalAddr().String()
	pc.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	got := make(chan string, 4)
	done := make(chan error, 1)
	go func() {
		done <- Listen(ctx, addr, slog.New(slog.NewTextHandler(io.Discard, nil)), func(l string) { got <- l })
	}()

	var conn net.Conn
	for i := 0; i < 50; i++ {
		if conn, err = net.Dial("udp", addr); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	defer conn.Close()

	want := `<14>Oct  9 22:28:39 supervisord: valheim-server hello`
	deadline := time.After(2 * time.Second)
	for {
		conn.Write([]byte(want + "\n"))
		select {
		case l := <-got:
			if l != want {
				t.Fatalf("got %q", l)
			}
			cancel()
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			return
		case <-time.After(20 * time.Millisecond):
		case <-deadline:
			t.Fatal("no line received")
		}
	}
}
