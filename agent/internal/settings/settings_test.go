package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func ptr(s string) *string { return &s }

func base() Settings {
	return Settings{Name: "Midgard Hall", Password: "ognisko", Public: true, Preset: "normal", Modifiers: map[string]string{}}
}

func input(s Settings) Input {
	return Input{Name: s.Name, Public: s.Public, Preset: s.Preset, Modifiers: s.Modifiers, Keys: s.Keys, SaveInterval: s.SaveInterval}
}

func TestValidateName(t *testing.T) {
	for _, tc := range []struct {
		name, want string
	}{
		{"Midgard", ""},
		{"Łódź Długa Noc", ""},
		{"Ragnar's Hall!", ""},
		{"a-b_c.d", ""},
		{"abc", ""},
		{strings.Repeat("x", 40), ""},
		{"ab", "length"},
		{strings.Repeat("x", 41), "length"},
		{strings.Repeat("ż", 40), ""}, // runes, not bytes
		{"Hall $(id)", "chars"},
		{"Hall `id`", "chars"},
		{"Hall; rm", "chars"},
		{"tab\there", "chars"},
		{"new\nline", "chars"},
		{"a=b c", "chars"},
	} {
		if got := ValidateName(tc.name); got != tc.want {
			t.Errorf("ValidateName(%q) = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestValidatePassword(t *testing.T) {
	for _, tc := range []struct {
		pw, name, want string
	}{
		{"ognisko", "Midgard", ""},
		{"a$b`c;d=e'f\"", "Midgard", ""},
		{"abcd", "Midgard", "length"},
		{strings.Repeat("x", 32), "Midgard", ""},
		{strings.Repeat("x", 33), "Midgard", "length"},
		{"has space", "Midgard", "chars"},
		{"zażółć", "Midgard", "chars"},
		{"tab\tx1", "Midgard", "chars"},
		{"midga", "Midgard", "inName"},
		{"HALL1", "The hall1 of fire", "inName"},
	} {
		if got := ValidatePassword(tc.pw, tc.name); got != tc.want {
			t.Errorf("ValidatePassword(%q, %q) = %q, want %q", tc.pw, tc.name, got, tc.want)
		}
	}
}

func TestApply(t *testing.T) {
	prev := base()
	for _, tc := range []struct {
		desc string
		edit func(*Input)
		errs map[string]string
	}{
		{"unchanged", func(*Input) {}, nil},
		{"trimmed name", func(in *Input) { in.Name = "  Midgard Hall  " }, nil},
		{"bad name", func(in *Input) { in.Name = "x" }, map[string]string{"name": "length"}},
		{"short password", func(in *Input) { in.Password = ptr("abc") }, map[string]string{"password": "length"}},
		{"name swallows password", func(in *Input) { in.Name = "Ognisko Hall" }, map[string]string{"password": "inName"}},
		{"preset", func(in *Input) { in.Preset = "Hardcore" }, nil},
		{"unknown preset", func(in *Input) { in.Preset = "nightmare" }, map[string]string{"preset": "value"}},
		{"modifier", func(in *Input) { in.Modifiers = map[string]string{"raids": "none", "Combat": "VeryHard"} }, nil},
		{"normal modifier is no modifier", func(in *Input) { in.Modifiers = map[string]string{"raids": "normal"} }, nil},
		{"modifier value", func(in *Input) { in.Modifiers = map[string]string{"raids": "most"} }, map[string]string{"modifier.raids": "value"}},
		{"modifier name", func(in *Input) { in.Modifiers = map[string]string{"weather": "none"} }, map[string]string{"modifier.weather": "unknown"}},
		{"injection in value", func(in *Input) { in.Modifiers = map[string]string{"raids": "none;id"} }, map[string]string{"modifier.raids": "value"}},
		{"keys", func(in *Input) { in.Keys = []string{"nomap", "nobuildcost"} }, nil},
		{"bad key", func(in *Input) { in.Keys = []string{"godmode"} }, map[string]string{"keys": "value"}},
		{"save interval", func(in *Input) { in.SaveInterval = 600 }, nil},
		{"save interval low", func(in *Input) { in.SaveInterval = 59 }, map[string]string{"saveInterval": "range"}},
		{"save interval high", func(in *Input) { in.SaveInterval = 7201 }, map[string]string{"saveInterval": "range"}},
	} {
		in := input(prev)
		tc.edit(&in)
		got, err := Apply(prev, in)
		if tc.errs == nil {
			if err != nil {
				t.Errorf("%s: %v", tc.desc, err)
			}
			continue
		}
		e, ok := err.(Errors)
		if !ok || !reflect.DeepEqual(map[string]string(e), tc.errs) {
			t.Errorf("%s: err = %v, want %v", tc.desc, err, tc.errs)
		}
		if !reflect.DeepEqual(got, prev) {
			t.Errorf("%s: invalid input changed settings: %+v", tc.desc, got)
		}
	}
}

func TestApplyNormalises(t *testing.T) {
	in := input(base())
	in.Preset = "HARD"
	in.Modifiers = map[string]string{"Raids": "None", "portals": "normal"}
	in.Keys = []string{"nomap", "nobuildcost", "nomap"}
	in.SaveInterval = 1800
	got, err := Apply(base(), in)
	if err != nil {
		t.Fatal(err)
	}
	if got.Preset != "hard" || !reflect.DeepEqual(got.Modifiers, map[string]string{"raids": "none"}) ||
		!reflect.DeepEqual(got.Keys, []string{"nobuildcost", "nomap"}) || got.SaveInterval != 0 {
		t.Errorf("got %+v", got)
	}
}

// Values seeded from the environment may predate the rules; carried over
// unchanged they must not block a save.
func TestApplyGrandfathersUnchanged(t *testing.T) {
	prev := Settings{Name: "Viking & Co", Password: "pw 1", Public: true, Preset: "normal", Modifiers: map[string]string{}}
	in := input(prev)
	in.Public = false
	if _, err := Apply(prev, in); err != nil {
		t.Errorf("unchanged legacy values rejected: %v", err)
	}
	in.Name = "Viking & Sons"
	if _, err := Apply(prev, in); err == nil {
		t.Error("changed name must meet the rules")
	}
	// No known password: a save must set one.
	prev.Password = ""
	in = input(prev)
	if _, err := Apply(prev, in); err == nil || err.(Errors)["password"] != "required" {
		t.Errorf("err = %v, want password required", err)
	}
}

func TestParseArgs(t *testing.T) {
	for _, tc := range []struct {
		args string
		want Settings
	}{
		{"", Settings{Preset: "normal", Modifiers: map[string]string{}}},
		{"-crossplay -modifier raids less -modifier deathpenalty casual", Settings{
			Preset: "normal", Modifiers: map[string]string{"raids": "less", "deathpenalty": "casual"}, Unmanaged: []string{"-crossplay"}}},
		{"-Preset Hard -Modifier DeathPenalty Hardcore -setkey NoMap -saveinterval 600 -backups 4", Settings{
			Preset: "hard", Modifiers: map[string]string{"deathpenalty": "hardcore"}, Keys: []string{"nomap"}, SaveInterval: 600,
			Unmanaged: []string{"-backups", "4"}}},
		// A preset overwrites earlier modifiers, as in the game.
		{"-modifier raids none -preset casual -modifier combat easy", Settings{
			Preset: "casual", Modifiers: map[string]string{"combat": "easy"}}},
		// Known options with unknown values stay verbatim.
		{"-modifier raids sometimes -setkey godmode -saveinterval 5 -preset", Settings{
			Preset: "normal", Modifiers: map[string]string{}, Unmanaged: []string{"-modifier", "raids", "sometimes", "-setkey", "godmode", "-saveinterval", "5", "-preset"}}},
		{"-saveinterval 1800", Settings{Preset: "normal", Modifiers: map[string]string{}}},
	} {
		got := ParseArgs(tc.args)
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("ParseArgs(%q) = %+v, want %+v", tc.args, got, tc.want)
		}
	}
}

func TestArgsRoundTrip(t *testing.T) {
	for _, args := range []string{
		"",
		"-preset hard",
		"-preset hammer -modifier combat veryeasy -modifier raids none -setkey nobuildcost -setkey nomap -saveinterval 900",
		"-modifier portals casual -crossplay -instanceid 2",
	} {
		if got := ParseArgs(args).Args(); got != args {
			t.Errorf("round trip %q -> %q", args, got)
		}
	}
	// Managed options are emitted first, unmanaged tokens after, in order.
	if got := ParseArgs("-crossplay -backups 4 -modifier raids less").Args(); got != "-modifier raids less -crossplay -backups 4" {
		t.Errorf("order = %q", got)
	}
}

func TestArgsTokensAreShellSafe(t *testing.T) {
	s := Settings{Preset: "immersive", Modifiers: map[string]string{}}
	for _, m := range Modifiers {
		s.Modifiers[m.Name] = m.Values[len(m.Values)-1]
	}
	s.Keys = Keys
	s.SaveInterval = 7200
	for _, tok := range strings.Fields(s.Args()) {
		if strings.ContainsAny(tok, "*?[]$`'\"\\;&|<>(){}~") {
			t.Errorf("token %q has shell-special characters", tok)
		}
	}
}

func TestEnvFile(t *testing.T) {
	s := base()
	s.Name = "Ragnar's Hall"
	s.Password = "a=b$c"
	s.Public = false
	s.Modifiers = map[string]string{"raids": "none"}
	s.Unmanaged = []string{"-crossplay"}
	want := "SERVER_NAME=Ragnar's Hall\nSERVER_PASS=a=b$c\nSERVER_PUBLIC=0\nSERVER_ARGS=-modifier raids none -crossplay\n"
	if got := string(s.EnvFile()); got != want {
		t.Errorf("env file:\n%s\nwant:\n%s", got, want)
	}
}

func TestChanged(t *testing.T) {
	a := base()
	b := base()
	b.Name = "Other"
	b.Password = "secret-1"
	b.Modifiers = map[string]string{"raids": "none"}
	b.Keys = []string{"nomap"}
	b.SaveInterval = 600
	want := []string{"name", "password", "modifier.raids", "key.nomap", "saveInterval"}
	if got := Changed(a, b); !reflect.DeepEqual(got, want) {
		t.Errorf("Changed = %v, want %v", got, want)
	}
	if got := Changed(a, a); len(got) != 0 {
		t.Errorf("Changed(a, a) = %v", got)
	}
}

// ---- store ---------------------------------------------------------------

type clock struct{ t time.Time }

func (c *clock) now() time.Time      { return c.t }
func (c *clock) add(d time.Duration) { c.t = c.t.Add(d) }
func at(s string) *time.Time {
	t, _ := time.Parse(time.RFC3339, s)
	return &t
}

func openStore(t *testing.T, seed Seed) (*Store, string, *clock) {
	t.Helper()
	dir := t.TempDir()
	c := &clock{t: *at("2026-10-10T18:00:00Z")}
	s, err := Open(dir, seed, c.now)
	if err != nil {
		t.Fatal(err)
	}
	return s, dir, c
}

func TestOpenDisabled(t *testing.T) {
	if _, err := Open(filepath.Join(t.TempDir(), "missing"), Seed{}, nil); err != ErrDisabled {
		t.Errorf("missing dir: err = %v", err)
	}
	if _, err := Open("", Seed{}, nil); err != ErrDisabled {
		t.Errorf("empty dir: err = %v", err)
	}
	f := filepath.Join(t.TempDir(), "file")
	os.WriteFile(f, nil, 0o644)
	if _, err := Open(f, Seed{}, nil); err != ErrDisabled {
		t.Errorf("file: err = %v", err)
	}
	if os.Geteuid() != 0 {
		ro := t.TempDir()
		os.Chmod(ro, 0o555)
		t.Cleanup(func() { os.Chmod(ro, 0o755) })
		if _, err := Open(ro, Seed{}, nil); err != ErrDisabled {
			t.Errorf("read-only dir: err = %v", err)
		}
	}
}

func TestSeedFromEnvironment(t *testing.T) {
	pwFile := filepath.Join(t.TempDir(), "server-pass")
	os.WriteFile(pwFile, []byte("ognisko\n"), 0o400)
	s, dir, _ := openStore(t, Seed{Name: " My Valheim ", Public: false, Args: "-crossplay  -modifier raids less -backups 4", PasswordFile: pwFile})
	v := s.View(at("2026-10-10T17:00:00Z"))
	if v.Current.Name != "My Valheim" || v.Current.Public || v.Current.Modifiers["raids"] != "less" ||
		!reflect.DeepEqual(v.Current.Unmanaged, []string{"-crossplay", "-backups", "4"}) || v.Current.SaveInterval != 1800 {
		t.Errorf("current = %+v", v.Current)
	}
	if !v.Password.Set || v.Pending || v.UpdatedAt != nil || v.Hook != "unknown" {
		t.Errorf("view = %+v", v)
	}
	if v.Effective != (Effective{Name: "My Valheim", Public: false, Args: "-crossplay -modifier raids less -backups 4"}) {
		t.Errorf("effective = %+v", v.Effective)
	}
	if pw, ok := s.Password(); !ok || pw != "ognisko" {
		t.Errorf("password = %q %v", pw, ok)
	}
	// Seeding writes nothing: the hook keeps using the environment.
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("seeding wrote %d files", len(entries))
	}
	// No password file: unknown, and a save has to set one.
	s2, _, _ := openStore(t, Seed{Name: "X Hall"})
	if _, ok := s2.Password(); ok {
		t.Error("password known without a file")
	}
	if s2.View(nil).Current.Name != "X Hall" {
		t.Error("seed name lost")
	}
}

func TestUpdateWritesAtomicallyAndPreservesUnmanaged(t *testing.T) {
	s, dir, c := openStore(t, Seed{Name: "My Valheim", Public: true, Args: "-crossplay -instanceid 2", PasswordFile: ""})
	start := at("2026-10-10T17:00:00Z")
	in := Input{Name: "Ragnar's Hall", Password: ptr("ognisko-7"), Public: false, Preset: "hard", Modifiers: map[string]string{"raids": "none"}, Keys: []string{"nomap"}, SaveInterval: 900}
	changed, err := s.Update(in)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"name", "password", "public", "preset", "modifier.raids", "key.nomap", "saveInterval"}
	if !reflect.DeepEqual(changed, want) {
		t.Errorf("changed = %v", changed)
	}
	env, err := os.ReadFile(filepath.Join(dir, "server.env"))
	if err != nil {
		t.Fatal(err)
	}
	wantEnv := "SERVER_NAME=Ragnar's Hall\nSERVER_PASS=ognisko-7\nSERVER_PUBLIC=0\nSERVER_ARGS=-preset hard -modifier raids none -setkey nomap -saveinterval 900 -crossplay -instanceid 2\n"
	if string(env) != wantEnv {
		t.Errorf("server.env = %q", env)
	}
	for _, name := range []string{"server.env", "server.json"} {
		fi, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0o640 {
			t.Errorf("%s mode = %v", name, fi.Mode().Perm())
		}
	}
	// No temp files left behind.
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			t.Errorf("leftover %s", e.Name())
		}
	}
	var st fileState
	raw, _ := os.ReadFile(filepath.Join(dir, "server.json"))
	if err := json.Unmarshal(raw, &st); err != nil || st.Settings.Name != "Ragnar's Hall" || st.UpdatedAt == nil {
		t.Errorf("server.json = %s (%v)", raw, err)
	}

	v := s.View(start)
	if !v.Pending || v.Effective.Name != "My Valheim" {
		t.Errorf("after write: pending=%v effective=%+v", v.Pending, v.Effective)
	}
	// A reopened store (agent restart) keeps everything, including unmanaged
	// tokens, and ignores the environment from now on.
	s2, err := Open(dir, Seed{Name: "Env Name", Args: "-backups 9"}, c.now)
	if err != nil {
		t.Fatal(err)
	}
	v2 := s2.View(start)
	if v2.Current.Name != "Ragnar's Hall" || !reflect.DeepEqual(v2.Current.Unmanaged, []string{"-crossplay", "-instanceid", "2"}) || !v2.Pending {
		t.Errorf("reopened = %+v", v2)
	}

	// Same input again: nothing changed, nothing written.
	before, _ := os.Stat(filepath.Join(dir, "server.json"))
	c.add(time.Minute)
	in.Password = nil
	if changed, err := s.Update(in); err != nil || len(changed) != 0 {
		t.Errorf("no-op update = %v, %v", changed, err)
	}
	after, _ := os.Stat(filepath.Join(dir, "server.json"))
	if !after.ModTime().Equal(before.ModTime()) {
		t.Error("no-op update rewrote server.json")
	}
}

func TestPendingEffectiveAndHook(t *testing.T) {
	s, dir, c := openStore(t, Seed{Name: "My Valheim", Public: true, Args: "-crossplay"})
	oldStart := at("2026-10-10T17:00:00Z")
	if _, err := s.Update(Input{Name: "New Hall", Password: ptr("ognisko"), Public: true, Preset: "normal"}); err != nil {
		t.Fatal(err)
	}
	if !s.Pending(oldStart) || !s.Pending(nil) {
		t.Error("want pending before a restart")
	}
	if s.View(oldStart).Hook != "unknown" {
		t.Error("hook known before a restart")
	}

	// The server restarts a minute later; the hook confirms.
	c.add(time.Minute)
	newStart := c.t
	c.add(2 * time.Second)
	s.NoteLine("supervisord: valheim-server 10/10/2026 18:01:02: INFO - " + HookLine)
	v := s.View(&newStart)
	if v.Pending || v.Effective != (Effective{Name: "New Hall", Public: true, Args: "-crossplay"}) || v.Hook != "ok" {
		t.Errorf("after restart = %+v", v)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "effective.json"))
	if err != nil || !strings.Contains(string(raw), "New Hall") {
		t.Errorf("effective.json = %s (%v)", raw, err)
	}

	// Another save and a restart without the hook line: missing, once the
	// grace period is over.
	c.add(time.Minute)
	s.Update(Input{Name: "Third Hall", Public: true, Preset: "normal"})
	c.add(time.Minute)
	start3 := c.t
	c.add(5 * time.Second)
	if h := s.View(&start3).Hook; h != "unknown" {
		t.Errorf("hook during grace = %s", h)
	}
	c.add(time.Minute)
	if h := s.View(&start3).Hook; h != "missing" {
		t.Errorf("hook = %s, want missing", h)
	}
}

func TestArmDisarmPersists(t *testing.T) {
	s, dir, c := openStore(t, Seed{Name: "My Valheim"})
	if s.Armed() {
		t.Fatal("armed at start")
	}
	since, err := s.Arm()
	if err != nil || !since.Equal(c.t) {
		t.Fatalf("arm = %v %v", since, err)
	}
	s2, _ := Open(dir, Seed{}, c.now)
	if !s2.Armed() {
		t.Error("armed state not persisted")
	}
	if was, _ := s.Disarm(); !was {
		t.Error("disarm reported nothing armed")
	}
	if was, _ := s.Disarm(); was {
		t.Error("double disarm")
	}
}

// The password lives only in server.json and server.env.
func TestPasswordNotInViews(t *testing.T) {
	s, _, _ := openStore(t, Seed{Name: "My Valheim"})
	s.Update(Input{Name: "My Valheim", Password: ptr("hunter-2x"), Public: true, Preset: "normal"})
	for _, v := range []any{s.View(nil), s.Summary(nil), s.EffectiveSettings(nil)} {
		b, _ := json.Marshal(v)
		if strings.Contains(string(b), "hunter-2x") {
			t.Errorf("password in %s", b)
		}
	}
	if err := (Errors{"password": "length"}).Error(); strings.Contains(err, "hunter") {
		t.Error("password in error")
	}
}
