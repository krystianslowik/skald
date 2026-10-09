package syslog

import (
	"context"
	"io"
	"log/slog"
	"net"
	"testing"
	"time"
)

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
