package files

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func write(t *testing.T, p string, n int, mtime time.Time) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, make([]byte, n), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(p, mtime, mtime); err != nil {
		t.Fatal(err)
	}
}

func TestWorldSize(t *testing.T) {
	dir := t.TempDir()
	now := time.Now().Truncate(time.Second)
	write(t, filepath.Join(dir, "worlds_local", "Midgard.db"), 100, now)
	write(t, filepath.Join(dir, "worlds_local", "Midgard.fwl"), 10, now)
	write(t, filepath.Join(dir, "worlds_local", "Midgard", "sub", "a"), 5, now)
	write(t, filepath.Join(dir, "worlds_local", "Other.db"), 1000, now)

	size, mt := WorldSize(dir, "Midgard")
	if size != 115 {
		t.Errorf("size = %d", size)
	}
	if mt == nil || !mt.Equal(now) {
		t.Errorf("mtime = %v", mt)
	}
	if size, mt := WorldSize(dir, "Missing"); size != 0 || mt != nil {
		t.Errorf("missing world = %d %v", size, mt)
	}
}

func TestBackups(t *testing.T) {
	dir := t.TempDir()
	old := time.Now().Add(-time.Hour)
	write(t, filepath.Join(dir, "backups", "worlds-20261009-220000.zip"), 7, old)
	write(t, filepath.Join(dir, "backups", "worlds-20261009-230000.zip"), 9, old.Add(30*time.Minute))
	write(t, filepath.Join(dir, "backups", "other.zip"), 1, old)

	bs := Backups(dir)
	if len(bs) != 2 || bs[0].Name != "worlds-20261009-230000.zip" || bs[0].SizeBytes != 9 {
		t.Fatalf("backups = %+v", bs)
	}
	if got := Backups(t.TempDir()); got == nil || len(got) != 0 {
		t.Fatalf("empty = %#v", got)
	}
}
