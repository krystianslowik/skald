// Package files reads world and backup facts from the read-only /config
// mount. It never writes.
package files

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"
)

type Backup struct {
	Name       string    `json:"name"`
	SizeBytes  int64     `json:"sizeBytes"`
	ModifiedAt time.Time `json:"modifiedAt"`
}

// WorldSize sums CONFIG_DIR/worlds_local/<world> recursively (if it is a
// directory) plus the flat <world>.db and <world>.fwl files next to it. The
// second return is the .db mtime, used as a lastSaveAt fallback before the
// agent has seen a "World saved" line; nil if there is no .db.
func WorldSize(configDir, world string) (int64, *time.Time) {
	if world == "" {
		return 0, nil
	}
	base := filepath.Join(configDir, "worlds_local")
	var total int64
	_ = filepath.WalkDir(filepath.Join(base, world), func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.Type().IsRegular() {
			if fi, err := d.Info(); err == nil {
				total += fi.Size()
			}
		}
		return nil
	})
	var dbMtime *time.Time
	for _, ext := range []string{".db", ".fwl"} {
		fi, err := os.Stat(filepath.Join(base, world+ext))
		if err != nil || !fi.Mode().IsRegular() {
			continue
		}
		total += fi.Size()
		if ext == ".db" {
			m := fi.ModTime().UTC()
			dbMtime = &m
		}
	}
	return total, dbMtime
}

// Backups lists CONFIG_DIR/backups/worlds-*.zip, newest first. Never nil.
func Backups(configDir string) []Backup {
	matches, _ := filepath.Glob(filepath.Join(configDir, "backups", "worlds-*.zip"))
	out := make([]Backup, 0, len(matches))
	for _, p := range matches {
		fi, err := os.Stat(p)
		if err != nil || !fi.Mode().IsRegular() {
			continue
		}
		out = append(out, Backup{Name: fi.Name(), SizeBytes: fi.Size(), ModifiedAt: fi.ModTime().UTC()})
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].ModifiedAt.Equal(out[j].ModifiedAt) {
			return out[i].ModifiedAt.After(out[j].ModifiedAt)
		}
		return out[i].Name > out[j].Name
	})
	return out
}
