package restore

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/krystianslowik/skald/agent/internal/supervisor"
)

// A fictional world; never a real one.
const world = "Testheim"

// fakeSup is an in-memory supervisord: programs with a state, calls in
// order, and failures to inject.
type fakeSup struct {
	mu    sync.Mutex
	state map[string]string
	calls []string
	// failStarts makes the next n starts of the game fail.
	failStarts int
	failStop   error
	// onStart runs as the game starts, to look at the world it would load.
	onStart func()
}

func newFakeSup() *fakeSup {
	return &fakeSup{state: map[string]string{ServerProgram: "RUNNING", UpdaterProgram: "RUNNING", "valheim-backup": "RUNNING"}}
}

func (f *fakeSup) GetAllProcessInfo(context.Context) ([]supervisor.ProcessInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []supervisor.ProcessInfo
	for name, st := range f.state {
		out = append(out, supervisor.ProcessInfo{Name: name, StateName: st})
	}
	return out, nil
}

func (f *fakeSup) StopProcess(_ context.Context, name string, _ bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "stop "+name)
	if name == ServerProgram && f.failStop != nil {
		return f.failStop
	}
	if f.state[name] != "RUNNING" {
		return &supervisor.Fault{Code: supervisor.FaultNotRunning, String: "NOT_RUNNING"}
	}
	f.state[name] = "STOPPED"
	return nil
}

func (f *fakeSup) StartProcess(_ context.Context, name string, _ bool) error {
	f.mu.Lock()
	f.calls = append(f.calls, "start "+name)
	if f.state[name] == "RUNNING" {
		f.mu.Unlock()
		return &supervisor.Fault{Code: supervisor.FaultAlreadyStarted, String: "ALREADY_STARTED"}
	}
	hook := f.onStart
	fail := name == ServerProgram && f.failStarts > 0
	if fail {
		f.failStarts--
		f.state[name] = "FATAL"
	} else {
		f.state[name] = "RUNNING"
	}
	f.mu.Unlock()
	if name == ServerProgram && hook != nil {
		hook()
	}
	if fail {
		return &supervisor.Fault{Code: 50, String: "SPAWN_ERROR"}
	}
	return nil
}

func (f *fakeSup) Calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

// step is one published outcome.
type step struct {
	Name string
	OK   bool
}

type recorder struct {
	mu    sync.Mutex
	steps []step
}

func (r *recorder) publish(name string, err error, _ map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.steps = append(r.steps, step{name, err == nil})
}

// writeWorld lays out a 1.0 world directory whose files all say tag.
func writeWorld(t *testing.T, worlds, name, tag string) {
	t.Helper()
	dir := filepath.Join(worlds, name)
	if err := os.MkdirAll(filepath.Join(dir, "cache"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"_main.1.fwl2", "_main.1.db2", "_main.1.ok", "00_00__0_1.chunk", "cache/c1"} {
		if err := os.WriteFile(filepath.Join(dir, f), []byte(tag+":"+f), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// worldTag reads the world back: the one tag every file carries, or "mixed".
func worldTag(t *testing.T, worlds string) string {
	t.Helper()
	tag := ""
	err := filepath.WalkDir(filepath.Join(worlds, world), func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		got, _, _ := strings.Cut(string(b), ":")
		switch tag {
		case "":
			tag = got
		case got:
		default:
			tag = "mixed"
		}
		return nil
	})
	if err != nil {
		return "missing"
	}
	return tag
}

type zipEntry struct {
	name, body string
	mode       os.FileMode
}

func writeZip(t *testing.T, p string, entries []zipEntry) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		h := &zip.FileHeader{Name: e.name, Method: zip.Store}
		if e.mode != 0 {
			h.SetMode(e.mode)
		}
		w, err := zw.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(w, e.body)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

// imageZip is the image's layout: all of worlds_local, other worlds included.
func imageZip(tag string) []zipEntry {
	var out []zipEntry
	for _, f := range []string{"_main.1.fwl2", "_main.1.db2", "_main.1.ok", "00_00__0_1.chunk", "cache/c1"} {
		out = append(out, zipEntry{name: "worlds_local/" + world + "/" + f, body: tag + ":" + f})
	}
	out = append(out,
		zipEntry{name: "worlds_local/" + world + "/", body: "", mode: os.ModeDir | 0o755},
		zipEntry{name: "worlds_local/Otherland/_main.1.db2", body: "other"},
		zipEntry{name: "worlds_local/Otherland.db", body: "other"},
	)
	return out
}

type fixture struct {
	config, worlds, archive string
	sup                     *fakeSup
	rec                     *recorder
	opt                     Options
}

func setup(t *testing.T) *fixture {
	t.Helper()
	config := t.TempDir()
	worlds := filepath.Join(config, "worlds_local")
	writeWorld(t, worlds, world, "old")
	writeWorld(t, worlds, "Otherland", "untouched")
	archive := filepath.Join(config, "backups", "worlds-20261001-120000.zip")
	writeZip(t, archive, imageZip("new"))
	f := &fixture{config: config, worlds: worlds, archive: archive, sup: newFakeSup(), rec: &recorder{}}
	f.opt = Options{
		ConfigDir:     config,
		World:         world,
		Supervisor:    f.sup,
		Publish:       f.rec.publish,
		PlayersOnline: func() bool { return false },
		Timeout:       5 * time.Second,
		Now:           func() time.Time { return time.Date(2026, 10, 16, 20, 0, 0, 0, time.UTC) },
		Logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	return f
}

// leftovers lists Skald's working directories still in worlds_local.
func leftovers(t *testing.T, worlds string) []string {
	t.Helper()
	entries, _ := os.ReadDir(worlds)
	var out []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".skald-") {
			out = append(out, e.Name())
		}
	}
	return out
}

func TestSafeName(t *testing.T) {
	ok := map[string]string{
		"worlds_local/W/_main.1.db2": "worlds_local/W/_main.1.db2",
		"worlds_local/W/./cache/c":   "worlds_local/W/cache/c",
		"worlds_local/W/":            "worlds_local/W",
	}
	for in, want := range ok {
		if got, err := SafeName(in); err != nil || got != want {
			t.Errorf("SafeName(%q) = %q, %v", in, got, err)
		}
	}
	for _, in := range []string{
		"", "../evil", "worlds_local/../../etc/passwd", "worlds_local/W/../../x", "/etc/passwd",
		"C:/windows/x", "c:evil", `worlds_local\W\..\..\x`, "worlds_local/W/a\x00b", ".", "..",
	} {
		if got, err := SafeName(in); err == nil {
			t.Errorf("SafeName(%q) = %q, want an error", in, got)
		}
	}
}

func TestWorldPath(t *testing.T) {
	cases := map[string]string{
		"worlds_local/Testheim/_main.1.db2":        "Testheim/_main.1.db2",
		"config/worlds_local/Testheim/cache/c":     "Testheim/cache/c",
		"Testheim/_main.1.db2":                     "Testheim/_main.1.db2",
		"worlds/Testheim.db":                       "Testheim.db",
		"worlds_local/Testheim.fwl":                "Testheim.fwl",
		"worlds_local/Otherland/_main.1.db2":       "",
		"worlds_local/Testheim_backup_auto-1/x.db": "",
		"worlds_local/Testheim":                    "",
		"worlds_local/Testheim.db.old":             "",
		"worlds_local/TestheimX/_main.1.db2":       "",
	}
	for in, want := range cases {
		got, ok := WorldPath(in, world)
		if ok != (want != "") || got != want {
			t.Errorf("WorldPath(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
}

func TestCheckRefusesUnsafeArchives(t *testing.T) {
	dir := t.TempDir()
	good := imageZip("new")
	cases := map[string][]zipEntry{
		"zip-slip":            append(append([]zipEntry{}, good...), zipEntry{name: "worlds_local/" + world + "/../../../evil", body: "x"}),
		"absolute":            append(append([]zipEntry{}, good...), zipEntry{name: "/tmp/evil", body: "x"}),
		"backslash traversal": append(append([]zipEntry{}, good...), zipEntry{name: `..\..\evil`, body: "x"}),
		"symlink":             append(append([]zipEntry{}, good...), zipEntry{name: "worlds_local/" + world + "/link", body: "/etc/passwd", mode: os.ModeSymlink | 0o777}),
		"no world":            {{name: "worlds_local/Otherland/_main.1.db2", body: "x"}},
	}
	for name, entries := range cases {
		p := filepath.Join(dir, strings.ReplaceAll(name, " ", "-")+".zip")
		writeZip(t, p, entries)
		if _, err := Check(p, world); err == nil {
			t.Errorf("%s: Check passed", name)
		}
		stage := t.TempDir()
		if _, err := Extract(p, world, stage); err == nil {
			t.Errorf("%s: Extract passed", name)
		}
		if entries, _ := os.ReadDir(stage); len(entries) != 0 {
			t.Errorf("%s: Extract wrote %d entries", name, len(entries))
		}
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dir), "evil")); err == nil {
		t.Fatal("an entry escaped the staging directory")
	}
}

func TestExtractOnlyThisWorld(t *testing.T) {
	f := setup(t)
	stage := t.TempDir()
	n, err := Extract(f.archive, world, stage)
	if err != nil || n != 5 {
		t.Fatalf("Extract = %d, %v", n, err)
	}
	entries, _ := os.ReadDir(stage)
	if len(entries) != 1 || entries[0].Name() != world {
		t.Fatalf("staged %v", entries)
	}
	if b, _ := os.ReadFile(filepath.Join(stage, world, "cache", "c1")); string(b) != "new:cache/c1" {
		t.Fatalf("cache/c1 = %q", b)
	}
}

func TestSafetyCopyVerifiesAndRoundTrips(t *testing.T) {
	f := setup(t)
	dir := filepath.Join(f.config, SkaldDir)
	p, digest, err := SafetyCopy(f.config, world, dir, f.opt.Now())
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(p) != "pre-restore-20261016-200000.zip" {
		t.Fatalf("name = %s", filepath.Base(p))
	}
	side, _ := os.ReadFile(p + ".sha256")
	if !strings.HasPrefix(string(side), digest+"  ") {
		t.Fatalf("sidecar = %q", side)
	}
	stage := t.TempDir()
	if n, err := Extract(p, world, stage); err != nil || n != 5 {
		t.Fatalf("Extract safety copy = %d, %v", n, err)
	}
	if got := worldTag(t, stage); got != "old" {
		t.Fatalf("safety copy holds %q", got)
	}
	if list := List(f.config); len(list) != 2 || list[0].Source != SourceSkald || list[1].Source != SourceImage {
		t.Fatalf("List = %+v", list)
	}
}

func TestRunRestores(t *testing.T) {
	f := setup(t)
	f.sup.onStart = func() {
		if got := worldTag(t, f.worlds); got != "new" {
			t.Errorf("the game started on a %q world", got)
		}
	}
	if err := Run(context.Background(), f.opt, f.archive); err != nil {
		t.Fatal(err)
	}
	if got := worldTag(t, f.worlds); got != "new" {
		t.Fatalf("world = %q", got)
	}
	if b, _ := os.ReadFile(filepath.Join(f.worlds, "Otherland", "_main.1.db2")); string(b) != "untouched:_main.1.db2" {
		t.Fatal("another world was touched")
	}
	if _, err := os.Stat(filepath.Join(f.worlds, "Otherland.db")); err == nil {
		t.Fatal("another world's file was extracted")
	}
	want := []string{"stop " + UpdaterProgram, "stop " + ServerProgram, "start " + ServerProgram, "start " + UpdaterProgram}
	if got := f.sup.Calls(); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls = %v", got)
	}
	wantSteps := []step{{StepBegin, true}, {StepSafety, true}, {StepStop, true}, {StepExtract, true}, {StepStart, true}, {StepDone, true}}
	if !reflect.DeepEqual(f.rec.steps, wantSteps) {
		t.Fatalf("steps = %v", f.rec.steps)
	}
	if l := leftovers(t, f.worlds); len(l) != 0 {
		t.Fatalf("left behind: %v", l)
	}
	if list := List(f.config); len(list) != 2 {
		t.Fatalf("no safety copy listed: %+v", list)
	}
}

func TestRunRollsBackWhenExtractFails(t *testing.T) {
	f := setup(t)
	f.opt.afterExtract = func() error { return errors.New("disk full") }
	err := Run(context.Background(), f.opt, f.archive)
	if err == nil || !strings.Contains(err.Error(), "previous world put back") {
		t.Fatalf("Run = %v", err)
	}
	if got := worldTag(t, f.worlds); got != "old" {
		t.Fatalf("world = %q", got)
	}
	if st, _ := serverState(context.Background(), f.sup); st != "RUNNING" {
		t.Fatalf("game left %s", st)
	}
	wantSteps := []step{{StepBegin, true}, {StepSafety, true}, {StepStop, true}, {StepExtract, false}, {StepRollback, true}, {StepStart, true}}
	if !reflect.DeepEqual(f.rec.steps, wantSteps) {
		t.Fatalf("steps = %v", f.rec.steps)
	}
	if l := leftovers(t, f.worlds); len(l) != 0 {
		t.Fatalf("left behind: %v", l)
	}
}

func TestRunRollsBackWhenTheArchiveIsCorrupt(t *testing.T) {
	f := setup(t)
	// Flip a stored byte: the names check out, the CRC does not.
	b, _ := os.ReadFile(f.archive)
	i := bytes.Index(b, []byte("new:_main.1.db2"))
	b[i] = 'N'
	if err := os.WriteFile(f.archive, b, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Validate(Options{ConfigDir: f.config, World: world}, Request{Source: SourceImage, Backup: filepath.Base(f.archive), Confirm: world}); err != nil {
		t.Fatalf("Validate = %v", err)
	}
	if err := Run(context.Background(), f.opt, f.archive); err == nil {
		t.Fatal("Run succeeded on a corrupt archive")
	}
	if got := worldTag(t, f.worlds); got != "old" {
		t.Fatalf("world = %q", got)
	}
	if st, _ := serverState(context.Background(), f.sup); st != "RUNNING" {
		t.Fatalf("game left %s", st)
	}
}

func TestRunRollsBackWhenTheGameDoesNotStart(t *testing.T) {
	f := setup(t)
	f.sup.failStarts = 1
	var seen []string
	f.sup.onStart = func() { seen = append(seen, worldTag(t, f.worlds)) }
	err := Run(context.Background(), f.opt, f.archive)
	if err == nil || !strings.Contains(err.Error(), "previous world put back") {
		t.Fatalf("Run = %v", err)
	}
	if !reflect.DeepEqual(seen, []string{"new", "old"}) {
		t.Fatalf("worlds at start = %v", seen)
	}
	if got := worldTag(t, f.worlds); got != "old" {
		t.Fatalf("world = %q", got)
	}
	if st, _ := serverState(context.Background(), f.sup); st != "RUNNING" {
		t.Fatalf("game left %s", st)
	}
	wantSteps := []step{{StepBegin, true}, {StepSafety, true}, {StepStop, true}, {StepExtract, true}, {StepStart, false}, {StepRollback, true}, {StepStart, true}}
	if !reflect.DeepEqual(f.rec.steps, wantSteps) {
		t.Fatalf("steps = %v", f.rec.steps)
	}
	if l := leftovers(t, f.worlds); len(l) != 0 {
		t.Fatalf("left behind: %v", l)
	}
}

func TestRunRollbackFallsBackToTheSafetyCopy(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root ignores permissions")
	}
	f := setup(t)
	f.sup.failStarts = 1
	// The game fails to start on the new world, and the renamed previous
	// world cannot be moved back (its directory turned read-only): the
	// rollback must restore the verified safety copy instead.
	var prev string
	f.sup.onStart = func() {
		f.sup.onStart = nil
		entries, _ := os.ReadDir(f.worlds)
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".skald-prev-") {
				prev = filepath.Join(f.worlds, e.Name())
				_ = os.Chmod(prev, 0o500)
			}
		}
	}
	t.Cleanup(func() {
		if prev != "" {
			_ = os.Chmod(prev, 0o755)
		}
	})
	err := Run(context.Background(), f.opt, f.archive)
	if err == nil || !strings.Contains(err.Error(), "previous world put back") {
		t.Fatalf("Run = %v", err)
	}
	if prev == "" {
		t.Fatal("no previous-world directory was made")
	}
	if got := worldTag(t, f.worlds); got != "old" {
		t.Fatalf("world = %q", got)
	}
	if st, _ := serverState(context.Background(), f.sup); st != "RUNNING" {
		t.Fatalf("game left %s", st)
	}
}

func TestRunStopFailureLeavesTheWorldAlone(t *testing.T) {
	f := setup(t)
	f.sup.failStop = errors.New("timeout")
	if err := Run(context.Background(), f.opt, f.archive); err == nil {
		t.Fatal("Run succeeded")
	}
	if got := worldTag(t, f.worlds); got != "old" {
		t.Fatalf("world = %q", got)
	}
	calls := f.sup.Calls()
	if calls[len(calls)-1] != "start "+UpdaterProgram {
		t.Fatalf("updater not started again: %v", calls)
	}
}

func TestRunRefusesWhenPlayersJoinBeforeTheStop(t *testing.T) {
	f := setup(t)
	n := 0
	f.opt.PlayersOnline = func() bool { n++; return n > 0 }
	if err := Run(context.Background(), f.opt, f.archive); !errors.Is(err, ErrPlayersOnline) {
		t.Fatalf("Run = %v", err)
	}
	for _, c := range f.sup.Calls() {
		if strings.HasPrefix(c, "stop") {
			t.Fatalf("stopped with players online: %v", f.sup.Calls())
		}
	}
	if got := worldTag(t, f.worlds); got != "old" {
		t.Fatalf("world = %q", got)
	}
}

func TestRunFromStoppedGame(t *testing.T) {
	f := setup(t)
	f.sup.state[ServerProgram] = "EXITED"
	if err := Run(context.Background(), f.opt, f.archive); err != nil {
		t.Fatal(err)
	}
	if got := worldTag(t, f.worlds); got != "new" {
		t.Fatalf("world = %q", got)
	}
	if got := f.sup.Calls(); !reflect.DeepEqual(got, []string{"start " + ServerProgram}) {
		t.Fatalf("calls = %v", got)
	}
}

func TestRunRefusesAGameInTransition(t *testing.T) {
	f := setup(t)
	f.sup.state[ServerProgram] = "STARTING"
	if err := Run(context.Background(), f.opt, f.archive); err == nil {
		t.Fatal("Run succeeded while the game was starting")
	}
	if len(f.sup.Calls()) != 0 {
		t.Fatalf("calls = %v", f.sup.Calls())
	}
}

func TestRestoreOfALegacyWorld(t *testing.T) {
	f := setup(t)
	writeZip(t, f.archive, []zipEntry{{name: "worlds_local/" + world + ".db", body: "legacy db"}, {name: "worlds_local/" + world + ".fwl", body: "legacy fwl"}})
	if err := Run(context.Background(), f.opt, f.archive); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(f.worlds, world)); err == nil {
		t.Fatal("the 1.0 directory is still in place next to the restored pre-1.0 world")
	}
	if b, _ := os.ReadFile(filepath.Join(f.worlds, world+".db")); string(b) != "legacy db" {
		t.Fatalf(".db = %q", b)
	}
}

func TestValidate(t *testing.T) {
	f := setup(t)
	req := Request{Source: SourceImage, Backup: filepath.Base(f.archive), Confirm: world}
	if _, err := Validate(f.opt, req); err != nil {
		t.Fatal(err)
	}
	bad := map[string]Request{
		"confirm":              {Source: SourceImage, Backup: req.Backup, Confirm: strings.ToLower(world)},
		"source":               {Source: "elsewhere", Backup: req.Backup, Confirm: world},
		"traversal name":       {Source: SourceImage, Backup: "../worlds-20261001-120000.zip", Confirm: world},
		"missing":              {Source: SourceImage, Backup: "worlds-20200101-000000.zip", Confirm: world},
		"skald from image dir": {Source: SourceSkald, Backup: req.Backup, Confirm: world},
	}
	for name, r := range bad {
		if _, err := Validate(f.opt, r); err == nil {
			t.Errorf("%s: Validate passed", name)
		}
	}
	f.opt.PlayersOnline = func() bool { return true }
	if _, err := Validate(f.opt, req); !errors.Is(err, ErrPlayersOnline) {
		t.Fatalf("players online: %v", err)
	}
}
