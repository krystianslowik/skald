package worldmap

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHealthCountsTheWholeSave(t *testing.T) {
	dir := copyDir(t, fixture)
	b := build(t, dir, true)
	h := b.Health()
	// The fixture's reinforced chest has an unreadable inventory.
	if !h.Current() || h.Generation != 3 || h.ContainersUnreadable != 1 || !strings.Contains(h.ContainerReason, "unreadable inventory") ||
		h.ChunksUnreadable != 0 || h.Chunks != 4 || h.Failure != "" || h.LocationsUnreadable || h.MetaUnreadable {
		t.Fatalf("health = %+v", h)
	}
	if h.ContainerWhy.Code == "" || h.ContainerWhy.Code == ReasonOther {
		t.Errorf("reason code = %+v for %q", h.ContainerWhy, h.ContainerReason)
	}
	if strings.Contains(h.ContainerReason, "worldmap:") || strings.Contains(h.ContainerReason, dir) {
		t.Errorf("reason carries a prefix or a path: %q", h.ContainerReason)
	}
	if n := b.Current().Snapshot.Stats.ContainersUnreadable; n != 1 {
		t.Errorf("stats containers unreadable = %d", n)
	}

	// A save that rewrote another chunk parses only that one; the chest is
	// still counted from the cache.
	writeGeneration(t, dir, 4, "00_01__0_", nil)
	if _, err := b.Refresh(); err != nil {
		t.Fatal(err)
	}
	s := b.Current().Snapshot
	if h := b.Health(); s.Stats.ChunksParsed != 1 || h.ContainersUnreadable != 1 || s.Stats.ContainersUnreadable != 1 || h.Generation != 4 {
		t.Errorf("after an incremental build: parsed %d, health %+v, stats %d", s.Stats.ChunksParsed, h, s.Stats.ContainersUnreadable)
	}

	// A chunk that stops parsing stays counted until a save fixes it.
	island, err := os.ReadFile(filepath.Join(dir, "20_20__1_4.chunk"))
	if err != nil {
		t.Fatal(err)
	}
	writeGeneration(t, dir, 5, "20_20__1_", island[:len(island)/2])
	if _, err := b.Refresh(); err != nil {
		t.Fatal(err)
	}
	if h := b.Health(); h.ChunksUnreadable != 1 || h.Generation != 5 {
		t.Errorf("corrupt chunk: %+v", h)
	}

	// A save the agent has not built yet: not current.
	if err := os.WriteFile(filepath.Join(dir, "_main.9.ok"), []byte{41, 0, 0, 0}, 0o644); err != nil {
		t.Fatal(err)
	}
	if h := b.Health(); h.Current() || h.Latest != 9 {
		t.Errorf("unbuilt save: %+v", h)
	}
	// It has no chunk index: the build fails and says why.
	if _, err := b.Refresh(); err == nil {
		t.Fatal("generation without an index built")
	}
	if h := b.Health(); h.Failure != FailIndex || !h.Built() {
		t.Errorf("failed build: %+v", h)
	}
	// The marker goes away again: the failure is over, the last build stands.
	if err := os.Remove(filepath.Join(dir, "_main.9.ok")); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Refresh(); err != nil {
		t.Fatal(err)
	}
	if h := b.Health(); h.Failure != "" || !h.Current() || h.Generation != 5 {
		t.Errorf("after the failure: %+v", h)
	}
}

func TestHealthWithoutASave(t *testing.T) {
	b := New(Options{Dir: t.TempDir(), Logger: quiet})
	if _, err := b.Refresh(); err == nil {
		t.Fatal("built without a save")
	}
	if h := b.Health(); h.Built() || h.Current() || h.Failure != FailNoSave || h.HasLatest {
		t.Errorf("health = %+v", h)
	}
	if h := New(Options{}).Health(); h != (Health{}) {
		t.Errorf("disabled = %+v", h)
	}
}
