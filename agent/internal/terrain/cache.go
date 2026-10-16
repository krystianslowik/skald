package terrain

import (
	"container/list"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// tileCache keeps finished tiles under a size bound, least recently used
// out first. With a directory the tiles survive restarts (recency is the
// file's mtime); without one they live in memory only.
type tileCache struct {
	dir string
	max int64

	mu    sync.Mutex
	lru   *list.List // front = most recent; values are *cacheEntry
	items map[string]*list.Element
	total int64
}

type cacheEntry struct {
	key  string
	size int64
	data []byte // memory-only mode
}

// openTileCache indexes what dir already holds; dir "" keeps tiles in memory.
func openTileCache(dir string, max int64) (*tileCache, error) {
	c := &tileCache{dir: dir, max: max, lru: list.New(), items: map[string]*list.Element{}}
	if dir == "" {
		return c, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	// Probe that it is writable: a read-only volume falls back to memory.
	probe := filepath.Join(dir, ".probe")
	if err := os.WriteFile(probe, nil, 0o644); err != nil {
		return nil, err
	}
	_ = os.Remove(probe)
	type found struct {
		key  string
		size int64
		mod  time.Time
	}
	var all []found
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if strings.HasSuffix(p, ".tmp") {
			_ = os.Remove(p)
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return nil
		}
		all = append(all, found{filepath.ToSlash(rel), fi.Size(), fi.ModTime()})
		return nil
	})
	sort.Slice(all, func(i, j int) bool { return all[i].mod.Before(all[j].mod) })
	for _, f := range all {
		c.items[f.key] = c.lru.PushFront(&cacheEntry{key: f.key, size: f.size})
		c.total += f.size
	}
	c.mu.Lock()
	c.evictLocked()
	c.mu.Unlock()
	return c, nil
}

func (c *tileCache) path(key string) string { return filepath.Join(c.dir, filepath.FromSlash(key)) }

func (c *tileCache) get(key string) ([]byte, bool) {
	c.mu.Lock()
	el, ok := c.items[key]
	if !ok {
		c.mu.Unlock()
		return nil, false
	}
	c.lru.MoveToFront(el)
	e := el.Value.(*cacheEntry)
	c.mu.Unlock()
	if c.dir == "" {
		return e.data, true
	}
	b, err := os.ReadFile(c.path(key))
	if err != nil {
		c.remove(key)
		return nil, false
	}
	now := time.Now()
	_ = os.Chtimes(c.path(key), now, now)
	return b, true
}

func (c *tileCache) put(key string, data []byte) error {
	if int64(len(data)) > c.max {
		return errors.New("tile larger than the cache")
	}
	e := &cacheEntry{key: key, size: int64(len(data))}
	if c.dir == "" {
		e.data = data
	} else {
		p := c.path(key)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		tmp := p + ".tmp"
		if err := os.WriteFile(tmp, data, 0o644); err != nil {
			return err
		}
		if err := os.Rename(tmp, p); err != nil {
			_ = os.Remove(tmp)
			return err
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if old, ok := c.items[key]; ok {
		c.total -= old.Value.(*cacheEntry).size
		c.lru.Remove(old)
	}
	c.items[key] = c.lru.PushFront(e)
	c.total += e.size
	c.evictLocked()
	return nil
}

func (c *tileCache) remove(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		c.total -= el.Value.(*cacheEntry).size
		c.lru.Remove(el)
		delete(c.items, key)
	}
}

func (c *tileCache) evictLocked() {
	for c.total > c.max {
		el := c.lru.Back()
		if el == nil {
			return
		}
		e := el.Value.(*cacheEntry)
		c.lru.Remove(el)
		delete(c.items, e.key)
		c.total -= e.size
		if c.dir != "" {
			p := c.path(e.key)
			_ = os.Remove(p)
			// Drop the level and build directories once they are empty.
			for d := filepath.Dir(p); d != c.dir && strings.HasPrefix(d, c.dir); d = filepath.Dir(d) {
				if os.Remove(d) != nil {
					break
				}
			}
		}
	}
}

// size reports the bytes held and the number of tiles.
func (c *tileCache) size() (int64, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.total, len(c.items)
}
