package world

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

const fixture = "../../testdata/world-1.0"

func copyFixture(t *testing.T, dst string, gen int, files ...string) {
	t.Helper()
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, ext := range files {
		b, err := os.ReadFile(filepath.Join(fixture, "_main.1"+ext))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dst, "_main."+strconv.Itoa(gen)+ext), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestReadFixture(t *testing.T) {
	m, err := Read(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if m.Name != "Midgard" || m.SeedName != "ZbzIWkK5KK" || m.Seed != 353373721 || m.WorldGenVersion != 2 {
		t.Errorf("fwl2 = %+v", m)
	}
	if m.NetTime != 2040 || m.Day != 1 {
		t.Errorf("netTime = %v day = %d", m.NetTime, m.Day)
	}
	fi, _ := os.Stat(filepath.Join(fixture, "_main.1.db2"))
	if !m.SavedAt.Equal(fi.ModTime().UTC()) {
		t.Errorf("savedAt = %v", m.SavedAt)
	}
}

// TestDB2Layout guards the header assumptions: version 41, then netTime,
// then a gzip length whose blob plus a short trailer fills the file.
func TestDB2Layout(t *testing.T) {
	b, err := os.ReadFile(filepath.Join(fixture, "_main.1.db2"))
	if err != nil {
		t.Fatal(err)
	}
	if v := binary.LittleEndian.Uint32(b); v != 41 {
		t.Errorf("version = %d", v)
	}
	gz := int(binary.LittleEndian.Uint32(b[12:]))
	if b[16] != 0x1f || b[17] != 0x8b {
		t.Errorf("no gzip magic at 16")
	}
	if trailer := len(b) - 16 - gz; trailer != 40 {
		t.Errorf("trailer = %d bytes", trailer)
	}
}

func TestGenerationPick(t *testing.T) {
	all := []string{".fwl2", ".db2", ".ok"}
	cases := []struct {
		name  string
		setup func(dir string)
		want  int
		ok    bool
	}{
		{"empty dir", func(string) {}, 0, false},
		{"single", func(d string) { copyFixture(t, d, 1, all...) }, 1, true},
		{"newer without ok is ignored", func(d string) {
			copyFixture(t, d, 1, all...)
			copyFixture(t, d, 2, ".fwl2", ".db2")
		}, 1, true},
		{"newer with ok wins", func(d string) {
			copyFixture(t, d, 1, all...)
			copyFixture(t, d, 2, all...)
		}, 2, true},
		{"no ok at all falls back to highest fwl2", func(d string) {
			copyFixture(t, d, 1, ".fwl2", ".db2")
			copyFixture(t, d, 3, ".fwl2", ".db2")
		}, 3, true},
		{"non-numeric generation skipped", func(d string) {
			copyFixture(t, d, 1, all...)
			_ = os.WriteFile(filepath.Join(d, "_main.x.ok"), nil, 0o644)
		}, 1, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "w")
			_ = os.MkdirAll(dir, 0o755)
			c.setup(dir)
			n, ok := latestGeneration(dir)
			if n != c.want || ok != c.ok {
				t.Errorf("got %d %v, want %d %v", n, ok, c.want, c.ok)
			}
		})
	}
}

func TestMalformed(t *testing.T) {
	fwl, _ := os.ReadFile(filepath.Join(fixture, "_main.1.fwl2"))
	db, _ := os.ReadFile(filepath.Join(fixture, "_main.1.db2"))
	bigLen := append([]byte{}, fwl[:8]...)
	bigLen = append(bigLen, 0xff, 0xff, 0xff, 0xff, 0x0f)
	cases := []struct {
		name    string
		fwl, db []byte
	}{
		{"empty fwl2", nil, db},
		{"truncated fwl2 in name", fwl[:12], db},
		{"truncated fwl2 in tail", fwl[:35], db},
		{"huge string length", bigLen, db},
		{"empty db2", fwl, nil},
		{"short db2", fwl, db[:7]},
		{"NaN netTime", fwl, append([]byte{41, 0, 0, 0}, 0, 0, 0, 0, 0, 0, 0xf8, 0x7f)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			_ = os.WriteFile(filepath.Join(dir, "_main.1.fwl2"), c.fwl, 0o644)
			_ = os.WriteFile(filepath.Join(dir, "_main.1.db2"), c.db, 0o644)
			_ = os.WriteFile(filepath.Join(dir, "_main.1.ok"), nil, 0o644)
			if m, err := Read(dir); err == nil {
				t.Errorf("want error, got %+v", m)
			}
		})
	}
	if m, err := Read(filepath.Join(t.TempDir(), "missing")); err == nil || m != nil {
		t.Errorf("missing dir: %+v %v", m, err)
	}
}

func TestReaderCache(t *testing.T) {
	cfg := t.TempDir()
	dir := filepath.Join(cfg, "worlds_local", "Midgard")
	r := NewReader(cfg, "Midgard")
	now := time.Date(2026, 10, 9, 23, 0, 0, 0, time.UTC)
	r.now = func() time.Time { return now }

	if r.Meta() != nil {
		t.Fatal("meta before any save")
	}
	copyFixture(t, dir, 1, ".fwl2", ".db2", ".ok")
	if r.Meta() != nil {
		t.Fatal("cache not honoured")
	}
	now = now.Add(CacheFor)
	if m := r.Meta(); m == nil || m.Name != "Midgard" {
		t.Fatalf("after cache expiry: %+v", m)
	}
	if NewReader(cfg, "").Meta() != nil {
		t.Error("empty world name should yield nil")
	}
}
