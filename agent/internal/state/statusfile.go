package state

import (
	"context"
	"os"
	"strings"
	"time"
)

// ReadStatusFile returns the one-word content of the server status file
// (starting|running|stopping|stopped), or "unknown" if it is missing,
// unreadable, or empty.
func ReadStatusFile(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return StatusUnknown
	}
	s := strings.TrimSpace(string(b))
	if s == "" {
		return StatusUnknown
	}
	return s
}

// WatchStatusFile polls the status file and feeds changes into the tracker
// until ctx is done. The file lives on a shared emptyDir, so polling is
// simpler and more reliable than inotify across containers.
func (t *Tracker) WatchStatusFile(ctx context.Context, path string, every time.Duration) {
	t.SetStatus(ReadStatusFile(path))
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			t.SetStatus(ReadStatusFile(path))
		}
	}
}
