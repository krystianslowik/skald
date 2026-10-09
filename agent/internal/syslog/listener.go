// Package syslog receives the valheim container's log lines from busybox
// syslogd (`-R 127.0.0.1:5140`) over UDP. One datagram is one line; header
// parsing is internal/logparse's job.
package syslog

import (
	"context"
	"log/slog"
	"net"
	"strings"
)

// Listen binds addr and calls handle for every non-empty line until ctx is
// done. A datagram with embedded newlines is split into lines.
func Listen(ctx context.Context, addr string, logger *slog.Logger, handle func(line string)) error {
	conn, err := net.ListenPacket("udp", addr)
	if err != nil {
		return err
	}
	go func() {
		<-ctx.Done()
		conn.Close()
	}()
	buf := make([]byte, 64*1024)
	for {
		n, _, err := conn.ReadFrom(buf)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			logger.Warn("syslog read", "err", err)
			continue
		}
		for _, line := range strings.Split(string(buf[:n]), "\n") {
			line = strings.TrimRight(line, "\r\x00")
			if strings.TrimSpace(line) != "" {
				handle(line)
			}
		}
	}
}
