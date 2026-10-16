// Package world reads world metadata from the Valheim 1.0 save files under
// CONFIG_DIR/worlds_local/<world>/: names, seed and the starting keys (world
// modifiers) from .fwl2, netTime and the current global keys (boss progress)
// from .db2. ZDOs live in the chunk files and are never touched. Every
// failure degrades to "no metadata" (or a null field), never to a panic.
//
// Layouts, verified against a fresh 1.0.17 world and a played one (gen 63):
//
//	.fwl2: int32 payloadLen, int32 version (41), string name, string seedName,
//	       int32 seed, int64 uid, int32 worldGenVersion, bool needsDB,
//	       int32 n + n strings (starting keys), int32 m + m x 4 strings
//	       (known players: platform id, name, name, hex id; never exposed)
//	.db2:  int32 version, float64 netTime, int32 gzipLen, gzip blob, trailer.
//	       The blob starts: int32 zoneCount, zoneCount x (int16 x, int16 y),
//	       int32 (32 in both samples), int32 k + k strings (global keys),
//	       bool locationsGenerated, ...
package world

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// DayLengthSec is Valheim's default day length in seconds of netTime.
const DayLengthSec = 1800

// CacheFor bounds how often the save files are re-read.
const CacheFor = 30 * time.Second

// maxString caps a .NET string length prefix so a corrupt file cannot make
// the reader allocate much.
const maxString = 1024

// Meta is GET /state `world.meta`.
type Meta struct {
	Name            string    `json:"name"`
	SeedName        string    `json:"seedName"`
	Seed            int32     `json:"seed"`
	WorldGenVersion int32     `json:"worldGenVersion"`
	NetTime         float64   `json:"netTime"`
	Day             int64     `json:"day"`
	SavedAt         time.Time `json:"savedAt"`
	// Modifiers are the world's non-default modifiers from its starting
	// "preset" key (combat, deathpenalty, resources, raids, portals), e.g.
	// {"resources": "muchmore"}. The key stores values, not a preset name.
	// null when the starting keys could not be read.
	Modifiers map[string]string `json:"modifiers"`
	// WorldKeys are the other starting keys ("teleportall", "resourcerate 200").
	WorldKeys []string `json:"worldKeys"`
	// KnownPlayers counts the world's player list; the list itself holds
	// platform ids and stays private.
	KnownPlayers int `json:"knownPlayers"`
	// GlobalKeys are the current global keys (defeated_eikthyr, killedtroll,
	// ...); null when the .db2 blob did not match the expected layout.
	GlobalKeys []string `json:"globalKeys"`
	// Bosses is the boss path in order; null with GlobalKeys.
	Bosses []Boss `json:"bosses"`
}

// Boss is one step of the boss path.
type Boss struct {
	Key      string `json:"key"`
	Defeated bool   `json:"defeated"`
}

// BossKeys are the vanilla boss global keys in path order: Eikthyr, The
// Elder, Bonemass, Moder, Yagluth, The Queen, Fader. eikthyr and gdking are
// confirmed in a 1.0.17 save; the rest follow the game's key naming.
var BossKeys = []string{
	"defeated_eikthyr",
	"defeated_gdking",
	"defeated_bonemass",
	"defeated_dragon",
	"defeated_goblinking",
	"defeated_queen",
	"defeated_fader",
}

// Caps that keep a corrupt file from making the reader loop or allocate much.
const (
	maxKeys    = 1024
	maxPlayers = 10000
	maxZones   = 1 << 22
	maxFWL2    = 1 << 20
)

// Reader caches Read results for CacheFor.
type Reader struct {
	dir string
	now func() time.Time

	mu   sync.Mutex
	at   time.Time
	meta *Meta
}

// NewReader reads CONFIG_DIR/worlds_local/<world>. An empty world name yields
// a reader that always returns nil.
func NewReader(configDir, world string) *Reader {
	dir := ""
	if world != "" {
		dir = filepath.Join(configDir, "worlds_local", world)
	}
	return &Reader{dir: dir, now: time.Now}
}

// Meta returns the cached metadata, re-reading the files at most every
// CacheFor. nil when the save is missing or unreadable.
func (r *Reader) Meta() *Meta {
	if r.dir == "" {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	if !r.at.IsZero() && now.Sub(r.at) < CacheFor {
		return r.meta
	}
	r.at = now
	m, err := Read(r.dir)
	if err != nil {
		r.meta = nil
	} else {
		r.meta = m
	}
	return r.meta
}

// Read decodes the latest save generation in dir.
func Read(dir string) (*Meta, error) {
	n, ok := latestGeneration(dir)
	if !ok {
		return nil, errors.New("no save generation")
	}
	base := filepath.Join(dir, "_main."+strconv.Itoa(n))

	fwl, err := readHead(base+".fwl2", maxFWL2)
	if err != nil {
		return nil, err
	}
	m, err := parseFWL2(fwl)
	if err != nil {
		return nil, err
	}

	db, err := os.Open(base + ".db2")
	if err != nil {
		return nil, err
	}
	defer db.Close()
	fi, err := db.Stat()
	if err != nil {
		return nil, err
	}
	head := make([]byte, 16)
	got, err := io.ReadFull(db, head)
	if got < 12 {
		if err == nil {
			err = errShort
		}
		return nil, err
	}
	netTime, err := parseDB2Head(head[:12])
	if err != nil {
		return nil, err
	}
	m.NetTime = netTime
	// Checked against a live 1.0.17 world: the game logged "day:48" at
	// netTime 87897, and floor(87897 / 1800) = 48.
	m.Day = int64(math.Floor(netTime / DayLengthSec))
	if got == 16 {
		gzLen := int64(binary.LittleEndian.Uint32(head[12:16]))
		if keys, err := readGlobalKeys(io.LimitReader(db, gzLen)); err == nil {
			m.GlobalKeys = keys
			m.Bosses = bosses(keys)
		}
	}
	m.SavedAt = fi.ModTime().UTC()
	return m, nil
}

// latestGeneration picks the highest N with an `_main.N.ok` marker (a save
// the game finished writing), falling back to the highest N with a .fwl2.
func latestGeneration(dir string) (int, bool) {
	if n, ok := maxGen(dir, ".ok"); ok {
		return n, true
	}
	return maxGen(dir, ".fwl2")
}

func maxGen(dir, ext string) (int, bool) {
	matches, _ := filepath.Glob(filepath.Join(dir, "_main.*"+ext))
	best, found := 0, false
	for _, p := range matches {
		mid := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(p), "_main."), ext)
		n, err := strconv.Atoi(mid)
		if err != nil || n < 0 {
			continue
		}
		if !found || n > best {
			best, found = n, true
		}
	}
	return best, found
}

func readHead(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, limit))
}

var errShort = errors.New("truncated save header")

// parseFWL2 decodes the .fwl2 layout in the package comment. Strings are
// .NET BinaryWriter strings (7-bit-encoded length, UTF-8).
func parseFWL2(b []byte) (*Meta, error) {
	rd := bytes.NewReader(b)
	var hdr [2]int32
	if err := binary.Read(rd, binary.LittleEndian, &hdr); err != nil {
		return nil, errShort
	}
	name, err := readString(rd)
	if err != nil {
		return nil, err
	}
	seedName, err := readString(rd)
	if err != nil {
		return nil, err
	}
	var tail struct {
		Seed            int32
		UID             int64
		WorldGenVersion int32
	}
	if err := binary.Read(rd, binary.LittleEndian, &tail); err != nil {
		return nil, errShort
	}
	m := &Meta{Name: name, SeedName: seedName, Seed: tail.Seed, WorldGenVersion: tail.WorldGenVersion}
	// The rest is optional: a world whose starting keys do not decode still
	// has a name, seed and day.
	if keys, players, err := parseFWL2Keys(rd); err == nil {
		m.Modifiers, m.WorldKeys = splitStartingKeys(keys)
		m.KnownPlayers = len(players)
	}
	return m, nil
}

// KnownPlayer is one entry of the world's player list. The id is private:
// only the agent's admin-list routes use it, to put names on list entries.
type KnownPlayer struct {
	ID   string
	Name string
}

// KnownPlayers reads the player list of the latest save generation in dir.
func KnownPlayers(dir string) ([]KnownPlayer, error) {
	n, ok := latestGeneration(dir)
	if !ok {
		return nil, errors.New("no save generation")
	}
	b, err := readHead(filepath.Join(dir, "_main."+strconv.Itoa(n)+".fwl2"), maxFWL2)
	if err != nil {
		return nil, err
	}
	rd := bytes.NewReader(b)
	if _, err := rd.Seek(8, io.SeekStart); err != nil {
		return nil, errShort
	}
	for range 2 { // name, seedName
		if _, err := readString(rd); err != nil {
			return nil, err
		}
	}
	if _, err := rd.Seek(16, io.SeekCurrent); err != nil { // seed, uid, worldGenVersion
		return nil, errShort
	}
	_, players, err := parseFWL2Keys(rd)
	return players, err
}

// parseFWL2Keys reads bool needsDB, the starting keys and the player list
// (platform id, name, name, hex id each).
func parseFWL2Keys(rd *bytes.Reader) ([]string, []KnownPlayer, error) {
	if _, err := rd.ReadByte(); err != nil {
		return nil, nil, errShort
	}
	keys, err := readStrings(rd, maxKeys)
	if err != nil {
		return nil, nil, err
	}
	var count int32
	if err := binary.Read(rd, binary.LittleEndian, &count); err != nil {
		return nil, nil, errShort
	}
	if count < 0 || count > maxPlayers {
		return nil, nil, errors.New("bad player count")
	}
	players := make([]KnownPlayer, 0, count)
	for range count {
		var f [4]string
		for j := range f {
			if f[j], err = readString(rd); err != nil {
				return nil, nil, err
			}
		}
		players = append(players, KnownPlayer{ID: f[0], Name: f[1]})
	}
	return keys, players, nil
}

// splitStartingKeys turns "preset combat_default:resources_muchmore:..."
// into {"resources": "muchmore"} and returns every other key as is.
func splitStartingKeys(keys []string) (map[string]string, []string) {
	mods := map[string]string{}
	other := []string{}
	for _, k := range keys {
		name, val, _ := strings.Cut(k, " ")
		if strings.ToLower(name) != "preset" {
			other = append(other, k)
			continue
		}
		for _, part := range strings.Split(val, ":") {
			mod, v, ok := strings.Cut(strings.ToLower(part), "_")
			if !ok || mod == "" || v == "" || v == "default" {
				continue
			}
			mods[mod] = v
		}
	}
	return mods, other
}

// readGlobalKeys walks the start of the .db2 gzip blob to its global-key
// list. Any mismatch with the layout in the package comment is an error.
func readGlobalKeys(gz io.Reader) ([]string, error) {
	zr, err := gzip.NewReader(gz)
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	br := bufio.NewReader(zr)
	var zones int32
	if err := binary.Read(br, binary.LittleEndian, &zones); err != nil {
		return nil, errShort
	}
	if zones < 0 || zones > maxZones {
		return nil, errors.New("bad zone count")
	}
	if _, err := io.CopyN(io.Discard, br, int64(zones)*4); err != nil {
		return nil, errShort
	}
	var version int32
	if err := binary.Read(br, binary.LittleEndian, &version); err != nil {
		return nil, errShort
	}
	// The next 1024+ bytes are the keys and the start of the location list;
	// that is enough for any sane key list.
	rest := make([]byte, 64*1024)
	n, _ := io.ReadFull(br, rest)
	rd := bytes.NewReader(rest[:n])
	keys, err := readStrings(rd, maxKeys)
	if err != nil {
		return nil, err
	}
	// locationsGenerated is a bool: anything else means we are misaligned.
	if b, err := rd.ReadByte(); err != nil || b > 1 {
		return nil, errors.New("global keys not followed by a bool")
	}
	return keys, nil
}

func bosses(keys []string) []Boss {
	have := map[string]bool{}
	for _, k := range keys {
		name, _, _ := strings.Cut(k, " ")
		have[strings.ToLower(name)] = true
	}
	out := make([]Boss, len(BossKeys))
	for i, k := range BossKeys {
		out[i] = Boss{Key: k, Defeated: have[k]}
	}
	return out
}

// readStrings reads an int32 count and that many strings.
func readStrings(rd *bytes.Reader, max int32) ([]string, error) {
	var n int32
	if err := binary.Read(rd, binary.LittleEndian, &n); err != nil {
		return nil, errShort
	}
	if n < 0 || n > max {
		return nil, errors.New("bad string count")
	}
	out := make([]string, 0, n)
	for i := int32(0); i < n; i++ {
		s, err := readString(rd)
		if err != nil {
			return nil, err
		}
		if !utf8.ValidString(s) {
			return nil, errors.New("bad string")
		}
		out = append(out, s)
	}
	return out, nil
}

// parseDB2Head decodes int32 version + float64 netTime.
func parseDB2Head(b []byte) (float64, error) {
	if len(b) < 12 {
		return 0, errShort
	}
	t := math.Float64frombits(binary.LittleEndian.Uint64(b[4:12]))
	if math.IsNaN(t) || math.IsInf(t, 0) || t < 0 {
		return 0, errors.New("bad netTime")
	}
	return t, nil
}

func readString(rd *bytes.Reader) (string, error) {
	var n uint32
	for shift := 0; ; shift += 7 {
		if shift >= 35 {
			return "", errors.New("bad string length")
		}
		c, err := rd.ReadByte()
		if err != nil {
			return "", errShort
		}
		n |= uint32(c&0x7f) << shift
		if c&0x80 == 0 {
			break
		}
	}
	if n > maxString || int64(n) > int64(rd.Len()) {
		return "", errors.New("bad string length")
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(rd, buf); err != nil {
		return "", errShort
	}
	return string(buf), nil
}
