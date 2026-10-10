package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	stateFile     = "server.json"
	envFile       = "server.env"
	effectiveFile = "effective.json"
	// The game container reads server.env as root; the agent writes as 65532.
	fileMode = 0o640
	// HookLine is what the game's PRE_SERVER_RUN_HOOK logs after reading server.env.
	HookLine = "Skald settings applied"
	// hookEcho prefixes the image's own log of the hook command, whose text
	// contains HookLine too; that echo proves nothing ran.
	hookEcho = "Running pre server run hook"
)

// Seed is what the game runs with before Skald ever wrote a file: its own
// environment, mirrored into the agent's.
type Seed struct {
	Name   string
	Public bool
	Args   string
	// PasswordFile is the game's SERVER_PASS_FILE secret, mounted read-only.
	PasswordFile string
}

// Effective is what the running server was started with.
type Effective struct {
	Name   string `json:"name"`
	Public bool   `json:"public"`
	Args   string `json:"args"`
}

type fileState struct {
	Version   int        `json:"version"`
	Settings  Settings   `json:"settings"`
	UpdatedAt *time.Time `json:"updatedAt"`
	// ApplyWhenEmptyAt is set while an apply-when-empty is armed.
	ApplyWhenEmptyAt *time.Time `json:"applyWhenEmptyAt"`
}

// Store holds the settings and their files. Safe for concurrent use.
type Store struct {
	dir       string
	now       func() time.Time
	startedAt time.Time

	mu         sync.Mutex
	st         fileState
	eff        Effective
	hookSeenAt *time.Time
}

// ErrDisabled means SETTINGS_DIR is missing or not writable: the feature is off.
var ErrDisabled = errors.New("settings directory missing or not writable")

// Open loads the store from dir, seeding from the environment when nothing
// was written yet. The directory must exist and be writable.
func Open(dir string, seed Seed, now func() time.Time) (*Store, error) {
	if now == nil {
		now = time.Now
	}
	if dir == "" {
		return nil, ErrDisabled
	}
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() {
		return nil, ErrDisabled
	}
	// Mode bits lie on some volumes; only a real write proves it.
	probe, err := os.CreateTemp(dir, ".probe-*")
	if err != nil {
		return nil, ErrDisabled
	}
	probe.Close()
	os.Remove(probe.Name())

	s := &Store{dir: dir, now: now, startedAt: now().UTC()}
	seedName := strings.TrimSpace(seed.Name)
	if seedName == "" {
		seedName = "My Server" // the image's default
	}
	s.eff = Effective{Name: seedName, Public: seed.Public, Args: strings.Join(strings.Fields(seed.Args), " ")}

	raw, err := os.ReadFile(filepath.Join(dir, stateFile))
	switch {
	case err == nil:
		if err := json.Unmarshal(raw, &s.st); err != nil {
			return nil, fmt.Errorf("%s: %w", stateFile, err)
		}
		if s.st.Settings.Modifiers == nil {
			s.st.Settings.Modifiers = map[string]string{}
		}
	case errors.Is(err, os.ErrNotExist):
		cur := ParseArgs(seed.Args)
		cur.Name = seedName
		cur.Public = seed.Public
		if seed.PasswordFile != "" {
			if b, err := os.ReadFile(seed.PasswordFile); err == nil {
				// $(< file) in the image strips trailing newlines; match it.
				cur.Password = strings.TrimRight(string(b), "\r\n")
			}
		}
		s.st = fileState{Version: 1, Settings: cur}
	default:
		return nil, fmt.Errorf("%s: %w", stateFile, err)
	}
	if raw, err := os.ReadFile(filepath.Join(dir, effectiveFile)); err == nil {
		_ = json.Unmarshal(raw, &s.eff)
	}
	return s, nil
}

// CurrentView is Settings without the password, for the API.
type CurrentView struct {
	Name         string            `json:"name"`
	Public       bool              `json:"public"`
	Preset       string            `json:"preset"`
	Modifiers    map[string]string `json:"modifiers"`
	Keys         []string          `json:"keys"`
	SaveInterval int               `json:"saveInterval"`
	Unmanaged    []string          `json:"unmanaged"`
}

// View is the body of GET /settings.
type View struct {
	Current   CurrentView `json:"current"`
	Pending   bool        `json:"pending"`
	Effective Effective   `json:"effective"`
	Password  struct {
		Set bool `json:"set"`
	} `json:"password"`
	Apply struct {
		Armed bool       `json:"armed"`
		Since *time.Time `json:"since"`
	} `json:"apply"`
	// Hook is "ok" when the game logged reading server.env at its last start,
	// "missing" when it started without doing so, "unknown" otherwise.
	Hook      string     `json:"hook"`
	UpdatedAt *time.Time `json:"updatedAt"`
}

// Summary is the small part of the view that /state carries.
type Summary struct {
	Enabled     bool `json:"enabled"`
	Pending     bool `json:"pending"`
	Armed       bool `json:"armed"`
	PasswordSet bool `json:"passwordSet"`
}

// View reports the settings given the server process start time (nil when
// it is not running). It also records the effective settings once a start
// newer than the last write is seen.
func (s *Store) View(serverStart *time.Time) View {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.observe(serverStart)
	cur := s.st.Settings
	v := View{
		Current: CurrentView{
			Name:         cur.Name,
			Public:       cur.Public,
			Preset:       cur.Preset,
			Modifiers:    cur.Modifiers,
			Keys:         cur.Keys,
			SaveInterval: cur.SaveInterval,
			Unmanaged:    cur.Unmanaged,
		},
		Pending:   s.pending(serverStart),
		Effective: s.eff,
		Hook:      s.hook(serverStart),
		UpdatedAt: s.st.UpdatedAt,
	}
	if v.Current.Preset == "" {
		v.Current.Preset = "normal"
	}
	if v.Current.Modifiers == nil {
		v.Current.Modifiers = map[string]string{}
	}
	if v.Current.Keys == nil {
		v.Current.Keys = []string{}
	}
	if v.Current.Unmanaged == nil {
		v.Current.Unmanaged = []string{}
	}
	if v.Current.SaveInterval == 0 {
		v.Current.SaveInterval = SaveIntervalDefault
	}
	v.Password.Set = cur.Password != ""
	v.Apply.Armed = s.st.ApplyWhenEmptyAt != nil
	v.Apply.Since = s.st.ApplyWhenEmptyAt
	return v
}

// Summary is View reduced to what the dashboard header needs.
func (s *Store) Summary(serverStart *time.Time) Summary {
	v := s.View(serverStart)
	return Summary{Enabled: true, Pending: v.Pending, Armed: v.Apply.Armed, PasswordSet: v.Password.Set}
}

// EffectiveSettings returns what the running server was started with.
func (s *Store) EffectiveSettings(serverStart *time.Time) Effective {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.observe(serverStart)
	return s.eff
}

// Pending reports whether the files changed after the server process started.
func (s *Store) Pending(serverStart *time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pending(serverStart)
}

// Password returns the stored server password, if known.
func (s *Store) Password() (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.st.Settings.Password, s.st.Settings.Password != ""
}

// Update validates in, writes server.json and server.env, and returns what
// changed. Nothing is written when nothing changed.
func (s *Store) Update(in Input) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next, err := Apply(s.st.Settings, in)
	if err != nil {
		return nil, err
	}
	changed := Changed(s.st.Settings, next)
	if len(changed) == 0 {
		return nil, nil
	}
	now := s.now().UTC()
	st := s.st
	st.Version = 1
	st.Settings = next
	st.UpdatedAt = &now
	if err := s.write(st, true); err != nil {
		return nil, err
	}
	s.st = st
	return changed, nil
}

// Arm records an apply-when-empty request.
func (s *Store) Arm() (time.Time, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.st.ApplyWhenEmptyAt != nil {
		return *s.st.ApplyWhenEmptyAt, nil
	}
	now := s.now().UTC()
	st := s.st
	st.ApplyWhenEmptyAt = &now
	if err := s.write(st, false); err != nil {
		return time.Time{}, err
	}
	s.st = st
	return now, nil
}

// Disarm clears an armed apply; false when none was armed.
func (s *Store) Disarm() (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.st.ApplyWhenEmptyAt == nil {
		return false, nil
	}
	st := s.st
	st.ApplyWhenEmptyAt = nil
	if err := s.write(st, false); err != nil {
		return false, err
	}
	s.st = st
	return true, nil
}

// Armed reports whether an apply-when-empty is waiting.
func (s *Store) Armed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.st.ApplyWhenEmptyAt != nil
}

// NoteLine watches the game's log for the hook's confirmation line.
func (s *Store) NoteLine(line string) {
	if !strings.Contains(line, HookLine) || strings.Contains(line, hookEcho) {
		return
	}
	now := s.now().UTC()
	s.mu.Lock()
	s.hookSeenAt = &now
	s.mu.Unlock()
}

// pending: written, and not yet picked up by a server start. Caller holds mu.
func (s *Store) pending(start *time.Time) bool {
	if s.st.UpdatedAt == nil {
		return false
	}
	return start == nil || s.st.UpdatedAt.After(*start)
}

// observe records the current settings as effective once a server start
// after the last write is seen. Caller holds mu.
func (s *Store) observe(start *time.Time) {
	if s.st.UpdatedAt == nil || start == nil || s.pending(start) {
		return
	}
	cur := s.st.Settings
	eff := Effective{Name: cur.Name, Public: cur.Public, Args: cur.Args()}
	if eff == s.eff {
		return
	}
	s.eff = eff
	if b, err := json.Marshal(eff); err == nil {
		// Best effort: on failure it is recomputed on the next observe.
		_ = writeAtomic(s.dir, effectiveFile, b)
	}
}

// hook classifies the last start; see View.Hook. Caller holds mu.
func (s *Store) hook(start *time.Time) string {
	if s.st.UpdatedAt == nil || start == nil || s.pending(start) || start.Before(s.startedAt) {
		// Never written, not running, not restarted yet, or started before
		// this agent could listen.
		return "unknown"
	}
	if s.hookSeenAt != nil && !s.hookSeenAt.Before(*start) {
		return "ok"
	}
	// The line arrives a moment after the process starts; give it time.
	if s.now().Sub(*start) < 30*time.Second {
		return "unknown"
	}
	return "missing"
}

// write persists st as server.json and, with env, server.env. Caller holds mu.
func (s *Store) write(st fileState, env bool) error {
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	if err := writeAtomic(s.dir, stateFile, append(b, '\n')); err != nil {
		return err
	}
	if env {
		return writeAtomic(s.dir, envFile, st.Settings.EnvFile())
	}
	return nil
}

// writeAtomic writes data to dir/name through a temp file and a rename, so a
// reader sees either the old file or the new one, never half of it.
func writeAtomic(dir, name string, data []byte) error {
	f, err := os.CreateTemp(dir, "."+name+".tmp-*")
	if err != nil {
		return fmt.Errorf("write %s: %w", name, err)
	}
	tmp := f.Name()
	defer os.Remove(tmp) // no-op after a successful rename
	if _, err := f.Write(data); err != nil {
		f.Close()
		return fmt.Errorf("write %s: %w", name, err)
	}
	if err := f.Chmod(fileMode); err != nil {
		f.Close()
		return fmt.Errorf("write %s: %w", name, err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return fmt.Errorf("write %s: %w", name, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("write %s: %w", name, err)
	}
	if err := os.Rename(tmp, filepath.Join(dir, name)); err != nil {
		return fmt.Errorf("write %s: %w", name, err)
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}
