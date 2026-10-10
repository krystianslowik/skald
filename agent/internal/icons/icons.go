// Package icons serves the item icon sheet that skald-icons extracts from
// the operator's own game install into ICONS_DIR: map.json (item prefab ->
// cell) and the sheet it names. The agent only reads; it never touches game
// files. Every failure means "no icons", which the web shows as category
// glyphs.
package icons

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

// MaxMap caps map.json; the real one is ~30 KB for ~1000 items.
const MaxMap = 4 << 20

// sheetName is the only file name map.json may point at.
var sheetName = regexp.MustCompile(`^sheet\.[0-9a-f]{1,64}\.webp$`)

var buildRE = regexp.MustCompile(`^[0-9a-f]{1,64}$`)

// Info is GET /state `icons`.
type Info struct {
	Available bool   `json:"available"`
	Build     string `json:"build,omitempty"`
	Count     int    `json:"count"`
}

// Map is a validated map.json.
type Map struct {
	Build string
	Count int
	// JSON is the file as written by the extractor.
	JSON []byte
	// SheetPath is the absolute path of the sheet it names.
	SheetPath string
}

// Dir reads ICONS_DIR. A nil *Dir or an empty dir is "feature off".
type Dir struct {
	dir string

	mu    sync.Mutex
	mtime time.Time
	size  int64
	cur   *Map
}

// New returns nil for an empty dir.
func New(dir string) *Dir {
	if dir == "" {
		return nil
	}
	return &Dir{dir: dir}
}

// Enabled reports whether ICONS_DIR is set.
func (d *Dir) Enabled() bool { return d != nil }

var errNoIcons = errors.New("no icon sheet yet")

// Load returns the current map, re-reading map.json only when it changed on
// disk. The sheet it names must exist.
func (d *Dir) Load() (*Map, error) {
	if d == nil {
		return nil, errNoIcons
	}
	p := filepath.Join(d.dir, "map.json")
	fi, err := os.Stat(p)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > MaxMap {
		return nil, errNoIcons
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.cur == nil || !fi.ModTime().Equal(d.mtime) || fi.Size() != d.size {
		m, err := parse(d.dir, p)
		if err != nil {
			d.cur = nil
			return nil, err
		}
		d.cur, d.mtime, d.size = m, fi.ModTime(), fi.Size()
	}
	if st, err := os.Stat(d.cur.SheetPath); err != nil || !st.Mode().IsRegular() {
		return nil, errNoIcons
	}
	return d.cur, nil
}

func parse(dir, p string) (*Map, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Version int               `json:"version"`
		Build   string            `json:"build"`
		Sheet   string            `json:"sheet"`
		Items   map[string][2]int `json:"items"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		return nil, err
	}
	if doc.Version != 1 || !buildRE.MatchString(doc.Build) || !sheetName.MatchString(doc.Sheet) {
		return nil, errors.New("map.json: unknown version, build or sheet name")
	}
	return &Map{Build: doc.Build, Count: len(doc.Items), JSON: b, SheetPath: filepath.Join(dir, doc.Sheet)}, nil
}

// Info is the /state summary; nil when the feature is off.
func (d *Dir) Info() *Info {
	if d == nil {
		return nil
	}
	m, err := d.Load()
	if err != nil {
		return &Info{}
	}
	return &Info{Available: true, Build: m.Build, Count: m.Count}
}
