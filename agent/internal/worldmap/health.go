package worldmap

import (
	"strings"
	"time"
)

// Why the last Refresh published nothing new.
const (
	// FailNoSave: the world directory has no finished save generation yet.
	FailNoSave = "no_save"
	// FailIndex: the newest generation's chunk index did not read.
	FailIndex = "index"
)

// Health is how well the save read, for the compatibility check after a game
// update: what failed in the last build and what is unreadable in the whole
// save (chunks keep their parse results across builds).
type Health struct {
	// Generation is the save generation of the last build, Latest the newest
	// finished one on disk (0 and false when none).
	Generation int
	Latest     int
	HasLatest  bool
	// BuiltAt is when the last build finished; zero before one.
	BuiltAt time.Time
	// Failure is set when the last Refresh failed as a whole (FailNoSave,
	// FailIndex); the snapshot before it stays published.
	Failure string
	// Chunks is the chunk index's size, ChunksUnreadable those whose file did
	// not parse.
	Chunks           int
	ChunksUnreadable int
	// ContainersUnreadable is the containers whose inventory did not decode;
	// ContainerReason one of their reasons ("unreadable inventory: version
	// 111"), without paths.
	ContainersUnreadable int
	ContainerReason      string
	// LocationsUnreadable: the .db2 did not read (generated locations are
	// from the build before). MetaUnreadable: the .fwl did not.
	LocationsUnreadable bool
	MetaUnreadable      bool
}

// Built is true once a build has published a snapshot.
func (h Health) Built() bool { return !h.BuiltAt.IsZero() }

// Current is true when the published snapshot is from the newest finished
// save on disk.
func (h Health) Current() bool { return h.Built() && h.HasLatest && h.Generation == h.Latest }

// Health reports the last build and the newest finished save generation.
func (b *Builder) Health() Health {
	if !b.Enabled() {
		return Health{}
	}
	b.mu.RLock()
	h := b.health
	b.mu.RUnlock()
	h.Latest, h.HasLatest = latestOK(b.opt.Dir)
	return h
}

func (b *Builder) setFailure(reason string) {
	b.mu.Lock()
	b.health.Failure = reason
	b.mu.Unlock()
}

// unreadableContainers totals the refused inventories over every chunk of the
// save and picks one reason, the same one on every build.
func unreadableContainers(chunks []*chunkData) (int, string) {
	n, reason := 0, ""
	for _, c := range chunks {
		n += c.badInventory
		if c.badInventoryErr != nil {
			r := strings.TrimPrefix(c.badInventoryErr.Error(), "worldmap: ")
			if reason == "" || r < reason {
				reason = r
			}
		}
	}
	return n, reason
}
