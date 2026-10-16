package world

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
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
	// A fresh world: no starting keys, nobody known, no boss down.
	if m.Modifiers == nil || len(m.Modifiers) != 0 || len(m.WorldKeys) != 0 || m.KnownPlayers != 0 {
		t.Errorf("starting keys = %v %v %d", m.Modifiers, m.WorldKeys, m.KnownPlayers)
	}
	if m.GlobalKeys == nil || len(m.GlobalKeys) != 0 || len(m.Bosses) != 7 || m.Bosses[0].Defeated {
		t.Errorf("global keys = %v bosses = %v", m.GlobalKeys, m.Bosses)
	}
	fi, _ := os.Stat(filepath.Join(fixture, "_main.1.db2"))
	if !m.SavedAt.Equal(fi.ModTime().UTC()) {
		t.Errorf("savedAt = %v", m.SavedAt)
	}
}

// progressFixture is written by testdata/gen-world with the layout of a
// played 1.0.17 world: resources much more, portals casual, two bosses down.
const progressFixture = "../../testdata/world-progress"

func TestReadProgressFixture(t *testing.T) {
	m, err := Read(progressFixture)
	if err != nil {
		t.Fatal(err)
	}
	if m.Name != "Midgard" || m.SeedName != "Yggdrasil1" || m.Seed != 123456789 || m.Day != 48 {
		t.Errorf("header = %+v", m)
	}
	if want := map[string]string{"resources": "muchmore", "portals": "casual"}; !reflect.DeepEqual(m.Modifiers, want) {
		t.Errorf("modifiers = %v", m.Modifiers)
	}
	if want := []string{"resourcerate 200", "teleportall"}; !reflect.DeepEqual(m.WorldKeys, want) {
		t.Errorf("world keys = %v", m.WorldKeys)
	}
	if m.KnownPlayers != 2 {
		t.Errorf("known players = %d", m.KnownPlayers)
	}
	if want := []string{"activebosses 0", "defeated_eikthyr", "killedtroll", "defeated_gdking", "killed_surtling"}; !reflect.DeepEqual(m.GlobalKeys, want) {
		t.Errorf("global keys = %v", m.GlobalKeys)
	}
	var down []string
	for _, b := range m.Bosses {
		if b.Defeated {
			down = append(down, b.Key)
		}
	}
	if len(m.Bosses) != len(BossKeys) || !reflect.DeepEqual(down, []string{"defeated_eikthyr", "defeated_gdking"}) {
		t.Errorf("bosses = %v", m.Bosses)
	}
	raw, _ := json.Marshal(m)
	if bytes.Contains(raw, []byte("Xbox_")) || bytes.Contains(raw, []byte("ragnar#")) || bytes.Contains(raw, []byte("AAAA0000")) {
		t.Errorf("player list leaked into JSON: %s", raw)
	}
}

// TestKeysDegrade: a blob or key list that does not match the layout leaves
// the header readable and the key fields null.
func TestKeysDegrade(t *testing.T) {
	fwl, _ := os.ReadFile(filepath.Join(progressFixture, "_main.1.fwl2"))
	db, _ := os.ReadFile(filepath.Join(progressFixture, "_main.1.db2"))
	notGzip := append([]byte{}, db...)
	notGzip[16] = 0
	hugeKeys := append([]byte{}, fwl[:0x2c]...)
	hugeKeys = append(hugeKeys, 0xff, 0xff, 0xff, 0x7f)
	cases := []struct {
		name     string
		fwl, db  []byte
		mods     bool
		keysNull bool
	}{
		{"db2 without blob", fwl, db[:12], true, true},
		{"db2 blob not gzip", fwl, notGzip, true, true},
		{"fwl2 key count absurd", hugeKeys, db, false, false},
		{"fwl2 cut after header", fwl[:0x2b], db, false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			_ = os.WriteFile(filepath.Join(dir, "_main.1.fwl2"), c.fwl, 0o644)
			_ = os.WriteFile(filepath.Join(dir, "_main.1.db2"), c.db, 0o644)
			_ = os.WriteFile(filepath.Join(dir, "_main.1.ok"), nil, 0o644)
			m, err := Read(dir)
			if err != nil {
				t.Fatal(err)
			}
			if m.Name != "Midgard" || m.Day != 48 {
				t.Errorf("header = %+v", m)
			}
			if (m.Modifiers != nil) != c.mods {
				t.Errorf("modifiers = %v", m.Modifiers)
			}
			if (m.GlobalKeys == nil) != c.keysNull || (m.Bosses == nil) != c.keysNull {
				t.Errorf("global keys = %v bosses = %v", m.GlobalKeys, m.Bosses)
			}
		})
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

// TestRealWorld reads a played world when SKALD_REAL_WORLD points at its
// directory. Real saves hold private player data and never enter the repo.
func TestRealWorld(t *testing.T) {
	dir := os.Getenv("SKALD_REAL_WORLD")
	if dir == "" {
		t.Skip("SKALD_REAL_WORLD not set")
	}
	m, err := Read(dir)
	if err != nil {
		t.Fatal(err)
	}
	if m.Modifiers == nil || m.GlobalKeys == nil || m.Bosses == nil {
		t.Fatalf("keys not decoded: %+v", m)
	}
	t.Logf("day %d, modifiers %v, world keys %v, known players %d, global keys %v, bosses %v",
		m.Day, m.Modifiers, m.WorldKeys, m.KnownPlayers, m.GlobalKeys, m.Bosses)
}

func TestKnownPlayers(t *testing.T) {
	got, err := KnownPlayers(progressFixture)
	if err != nil {
		t.Fatal(err)
	}
	want := []KnownPlayer{{ID: "Xbox_2533274900000001", Name: "ragnar#1111"}, {ID: "Steam_76561190000000003", Name: "bjornthebold"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("KnownPlayers = %+v", got)
	}
	if _, err := KnownPlayers(t.TempDir()); err == nil {
		t.Fatal("no save should be an error")
	}
}
