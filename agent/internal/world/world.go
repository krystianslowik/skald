// Package world reads world metadata from the Valheim 1.0 save files under
// CONFIG_DIR/worlds_local/<world>/. It decodes only the small fixed headers
// (.fwl2 names + seed, .db2 netTime); the gzip ZDO blob is never touched.
// Every failure degrades to "no metadata", never to a panic.
package world

import (
	"bytes"
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
}

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

	fwl, err := readHead(base+".fwl2", 4096)
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
	head := make([]byte, 12)
	if _, err := io.ReadFull(db, head); err != nil {
		return nil, err
	}
	netTime, err := parseDB2Head(head)
	if err != nil {
		return nil, err
	}
	m.NetTime = netTime
	// Day mapping is unverified against the in-game day counter: Valheim
	// shows day N starting from 1 and may offset netTime; treat this as an
	// approximation until checked against a live world.
	m.Day = int64(math.Floor(netTime / DayLengthSec))
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

// parseFWL2 decodes: int32 payloadLen, int32 version, string worldName,
// string seedName, int32 seed, int64 uid, int32 worldGenVersion. Strings are
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
	return &Meta{Name: name, SeedName: seedName, Seed: tail.Seed, WorldGenVersion: tail.WorldGenVersion}, nil
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
