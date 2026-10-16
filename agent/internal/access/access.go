// Package access reads and edits the game's adminlist.txt and bannedlist.txt
// in CONFIG_DIR. One id per line; lines starting with "//" are comments. The
// files are rewritten through a temp file and a rename, and every line the
// edit does not touch (comments, blanks, ids in formats this package does not
// recognise) is kept as it was, in order.
package access

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/krystianslowik/skald/agent/internal/logparse"
)

// List names, as the API spells them.
const (
	Admins = "admins"
	Bans   = "bans"
)

// Files maps a list to its file under CONFIG_DIR.
var Files = map[string]string{
	Admins: "adminlist.txt",
	Bans:   "bannedlist.txt",
}

// Valheim 1.0 ids are a platform letter and a number, as the in-game F2 panel
// shows them (X_ Xbox, V_ Steam, S_ PlayStation, N_ Nintendo, A_ Apple); the
// game's own log, its world player list and the bridge print the older long
// form (Xbox_..., Steam_...). A bare SteamID64 is what the image's
// ADMINLIST_IDS documents. All three are accepted, case-sensitive, as typed.
var (
	shortID   = regexp.MustCompile(`^[XVSNA]_[0-9]{1,24}$`)
	longID    = regexp.MustCompile(`^(Xbox|Steam|PlayStation|Nintendo)_[0-9]{1,24}$`)
	steamID64 = regexp.MustCompile(`^7656119[0-9]{10}$`)
)

// MaxIDLen caps what Add accepts; the formats above are far shorter.
const MaxIDLen = 64

// ErrBadID is a string that is not a platform id in a known format.
var ErrBadID = errors.New("not a platform id: use the F2 form like X_1234 or V_7656..., or Xbox_/Steam_ followed by digits")

// ErrExists and ErrNotFound are Add's and Remove's no-op cases.
var (
	ErrExists   = errors.New("already on the list")
	ErrNotFound = errors.New("not on the list")
)

// ValidID reports whether s is a platform id in a recognised format.
func ValidID(s string) bool {
	return len(s) <= MaxIDLen && (shortID.MatchString(s) || longID.MatchString(s) || steamID64.MatchString(s))
}

// Key folds the forms of one account into one string (prefixes in any case), for matching list
// entries against ids seen elsewhere: V_n, Steam_n and a bare SteamID64 are
// the same Steam account; X_n and Xbox_n compare by number (console F2
// numbers can be obfuscated, so they may simply not match). Other ids fold to
// lower case.
func Key(id string) string {
	pre, num, ok := strings.Cut(id, "_")
	if !ok {
		if steamID64.MatchString(id) {
			return "steam:" + id
		}
		return strings.ToLower(id)
	}
	switch strings.ToLower(pre) {
	case "v", "steam":
		return "steam:" + num
	case "x", "xbox":
		return "xbox:" + num
	case "s", "playstation":
		return "playstation:" + num
	case "n", "nintendo":
		return "nintendo:" + num
	}
	return strings.ToLower(id)
}

// Platform is the platform type of an id: xbox, steam, playstation,
// nintendo or unknown.
func Platform(id string) string {
	k := Key(id)
	if p, _, ok := strings.Cut(k, ":"); ok {
		return p
	}
	if pre, _, ok := strings.Cut(id, "_"); ok {
		return logparse.PlatformOf(pre)
	}
	return logparse.PlatformUnknown
}

// Mask hides all but the last four digits: "X_***4321". For events, which
// every viewer sees.
func Mask(id string) string {
	pre, num, ok := strings.Cut(id, "_")
	if !ok {
		pre, num = "", id
	} else {
		pre += "_"
	}
	if len(num) > 4 {
		num = num[len(num)-4:]
	}
	return pre + "***" + num
}

// Line is one line of a list file. ID is empty for comments and blanks.
type Line struct {
	Raw string
	ID  string
}

// Parse splits a list file into lines. Every non-blank, non-comment line is
// an entry: the game treats it as an id whatever its format.
func Parse(data []byte) []Line {
	if len(data) == 0 {
		return nil
	}
	text := strings.TrimSuffix(string(data), "\n")
	parts := strings.Split(text, "\n")
	out := make([]Line, 0, len(parts))
	for _, p := range parts {
		raw := strings.TrimSuffix(p, "\r")
		id := strings.TrimSpace(raw)
		if id == "" || strings.HasPrefix(id, "//") {
			id = ""
		}
		out = append(out, Line{Raw: raw, ID: id})
	}
	return out
}

// Format joins lines back, with the file's original line ending.
func Format(lines []Line, crlf bool) []byte {
	if len(lines) == 0 {
		return nil
	}
	nl := "\n"
	if crlf {
		nl = "\r\n"
	}
	var b bytes.Buffer
	for _, l := range lines {
		b.WriteString(l.Raw)
		b.WriteString(nl)
	}
	return b.Bytes()
}

// IDs are the entries of lines, in file order.
func IDs(lines []Line) []string {
	out := []string{}
	for _, l := range lines {
		if l.ID != "" {
			out = append(out, l.ID)
		}
	}
	return out
}

// Add appends id unless the list already holds it (in any form of the same
// account). The id must be valid.
func Add(lines []Line, id string) ([]Line, error) {
	if !ValidID(id) {
		return nil, ErrBadID
	}
	k := Key(id)
	for _, l := range lines {
		if l.ID != "" && Key(l.ID) == k {
			return nil, ErrExists
		}
	}
	return append(append([]Line(nil), lines...), Line{Raw: id, ID: id}), nil
}

// Remove drops every line whose entry is exactly id. Unknown formats can be
// removed too: the id only has to be on the list.
func Remove(lines []Line, id string) ([]Line, error) {
	id = strings.TrimSpace(id)
	out := make([]Line, 0, len(lines))
	found := false
	for _, l := range lines {
		if id != "" && l.ID == id {
			found = true
			continue
		}
		out = append(out, l)
	}
	if !found {
		return nil, ErrNotFound
	}
	return out, nil
}

// Store edits the list files in one directory. Edits are serialised.
type Store struct {
	dir string
	mu  sync.Mutex
}

// New returns a store for CONFIG_DIR.
func New(dir string) *Store { return &Store{dir: dir} }

// Read returns the entries of list; a missing file is an empty list.
func (s *Store) Read(list string) ([]string, error) {
	name, ok := Files[list]
	if !ok {
		return nil, fmt.Errorf("unknown list %q", list)
	}
	data, err := os.ReadFile(filepath.Join(s.dir, name))
	if errors.Is(err, fs.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	return IDs(Parse(data)), nil
}

// Writable reports whether the agent may write the list files: the
// directory takes a new file, and the files that exist can be replaced.
func (s *Store) Writable() bool {
	f, err := os.CreateTemp(s.dir, ".skald-probe-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	return os.Remove(name) == nil
}

// Add puts id on list.
func (s *Store) Add(list, id string) error {
	return s.edit(list, func(lines []Line) ([]Line, error) { return Add(lines, id) })
}

// Remove takes id off list.
func (s *Store) Remove(list, id string) error {
	return s.edit(list, func(lines []Line) ([]Line, error) { return Remove(lines, id) })
}

func (s *Store) edit(list string, change func([]Line) ([]Line, error)) error {
	name, ok := Files[list]
	if !ok {
		return fmt.Errorf("unknown list %q", list)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	path := filepath.Join(s.dir, name)
	mode := fs.FileMode(0o644)
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		if fi, err := os.Stat(path); err == nil {
			mode = fi.Mode().Perm()
		}
	case errors.Is(err, fs.ErrNotExist):
		data = nil
	default:
		return err
	}
	lines, err := change(Parse(data))
	if err != nil {
		return err
	}
	return WriteAtomic(path, Format(lines, bytes.Contains(data, []byte("\r\n"))), mode)
}

// WriteAtomic writes data to path through a temp file in the same directory,
// synced, then renamed over path: a reader (the game) sees the old file or
// the new one, never half of either.
func WriteAtomic(path string, data []byte, mode fs.FileMode) error {
	dir, name := filepath.Split(path)
	f, err := os.CreateTemp(dir, "."+name+".tmp-*")
	if err != nil {
		return fmt.Errorf("write %s: %w", name, err)
	}
	tmp := f.Name()
	defer os.Remove(tmp) // no-op after the rename
	_, err = f.Write(data)
	if err == nil {
		err = f.Chmod(mode)
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		return fmt.Errorf("write %s: %w", name, err)
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}
