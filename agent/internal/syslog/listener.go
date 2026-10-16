// Package syslog receives the valheim container's log lines from busybox
// syslogd (`-R 127.0.0.1:5140`) over UDP. One datagram is one line; header
// parsing is internal/logparse's job.
package syslog

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"time"
)

// Read errors back off from minBackoff, doubling up to maxBackoff, so a
// persistent error neither spins a core nor floods the log.
const (
	minBackoff = 50 * time.Millisecond
	maxBackoff = 5 * time.Second
)

// sleep waits d or until ctx is done. A variable so tests can fake time.
var sleep = func(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// Listen binds addr and calls handle for every non-empty line until ctx is
// done. A datagram with embedded newlines is split into lines.
func Listen(ctx context.Context, addr string, logger *slog.Logger, handle func(line string)) error {
	conn, err := net.ListenPacket("udp", addr)
	if err != nil {
		return err
	}
	return serve(ctx, conn, logger, handle)
}

func serve(ctx context.Context, conn net.PacketConn, logger *slog.Logger, handle func(line string)) error {
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
		case <-done:
		}
		conn.Close()
	}()
	buf := make([]byte, 64*1024)
	var backoff time.Duration
	for {
		n, _, err := conn.ReadFrom(buf)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if errors.Is(err, net.ErrClosed) {
				// The socket is gone; no amount of waiting brings it back.
				return fmt.Errorf("syslog read: %w", err)
			}
			if backoff == 0 {
				backoff = minBackoff
			} else {
				backoff = min(backoff*2, maxBackoff)
			}
			// Warn on the way up to the cap, then about once per maxBackoff.
			logger.Warn("syslog read", "err", err, "retryIn", backoff)
			sleep(ctx, backoff)
			continue
		}
		backoff = 0
		for _, line := range strings.Split(string(buf[:n]), "\n") {
			line = strings.TrimRight(line, "\r\x00")
			if strings.TrimSpace(line) != "" {
				handle(line)
			}
		}
	}
}
