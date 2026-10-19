// Package restore puts a world backup back in place of the live world.
//
// The world is CONFIG_DIR/worlds_local/<WORLD>/ (Valheim 1.0, a directory of
// save generations and chunk files) and, for worlds last saved before 1.0,
// the flat <WORLD>.db and <WORLD>.fwl next to it. A restore replaces all
// three as one unit:
//
//  1. check the archive: every entry name is safe (no zip-slip), and it holds
//     files of this world;
//  2. safety copy: zip the live world to CONFIG_DIR/skald-backups/
//     pre-restore-<time>.zip and verify it (sha256 of the file read back,
//     every entry read to the end so the CRCs are checked);
//  3. stop the game through supervisord and wait for its shutdown save;
//  4. extract the world's entries into worlds_local/.skald-restore-<time>/;
//  5. swap by renames: live world to worlds_local/.skald-prev-<time>/, the
//     extracted one into place;
//  6. start the game.
//
// Any failure after the stop puts the previous world back (the renamed
// directory, or the safety copy if that fails too) and starts the game. The
// live world is never written into: it is either the old one or the new one.
package restore

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/krystianslowik/skald/agent/internal/supervisor"
)

// Program names in the community valheim-server image.
const (
	ServerProgram  = "valheim-server"
	UpdaterProgram = "valheim-updater"
)

// Backup sources: the image's own zips, and Skald's own copies (taken before
// a restore, and by a safe restart).
const (
	SourceImage = "image"
	SourceSkald = "skald"
)

// SkaldDir is where Skald's copies go, under CONFIG_DIR. Not the image's
// backups/, whose pruning would count them.
const SkaldDir = "skald-backups"

var (
	imageName = regexp.MustCompile(`^worlds-\d{8}-\d{6}\.zip$`)
	skaldName = regexp.MustCompile(`^pre-(restore|restart)-\d{8}-\d{6}\.zip$`)
)

// Limits on an archive, so a broken or hostile zip cannot fill the volume.
const (
	maxEntries    = 500_000
	maxTotalBytes = 64 << 30
)

// Supervisor is the part of supervisord a restore needs.
type Supervisor interface {
	GetAllProcessInfo(ctx context.Context) ([]supervisor.ProcessInfo, error)
	StopProcess(ctx context.Context, name string, wait bool) error
	StartProcess(ctx context.Context, name string, wait bool) error
}

// Backup is one restorable archive.
type Backup struct {
	Name       string    `json:"name"`
	Source     string    `json:"source"`
	SizeBytes  int64     `json:"sizeBytes"`
	ModifiedAt time.Time `json:"modifiedAt"`
}

// List returns the image's backups and Skald's own copies, newest
// first. Never nil.
func List(configDir string) []Backup {
	out := []Backup{}
	for _, src := range []string{SourceImage, SourceSkald} {
		dir, pattern := sourceDir(configDir, src)
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if !pattern.MatchString(e.Name()) || !e.Type().IsRegular() {
				continue
			}
			fi, err := e.Info()
			if err != nil {
				continue
			}
			out = append(out, Backup{Name: e.Name(), Source: src, SizeBytes: fi.Size(), ModifiedAt: fi.ModTime().UTC()})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].ModifiedAt.Equal(out[j].ModifiedAt) {
			return out[i].ModifiedAt.After(out[j].ModifiedAt)
		}
		return out[i].Name > out[j].Name
	})
	return out
}

func sourceDir(configDir, source string) (string, *regexp.Regexp) {
	if source == SourceSkald {
		return filepath.Join(configDir, SkaldDir), skaldName
	}
	return filepath.Join(configDir, "backups"), imageName
}

// Path resolves a backup name to its file, or an error a caller may show.
func Path(configDir, source, name string) (string, error) {
	if source != SourceImage && source != SourceSkald {
		return "", errors.New("unknown backup source")
	}
	dir, pattern := sourceDir(configDir, source)
	if !pattern.MatchString(name) {
		return "", errors.New("bad backup name")
	}
	p := filepath.Join(dir, name)
	fi, err := os.Lstat(p)
	if err != nil || !fi.Mode().IsRegular() {
		return "", errors.New("no such backup")
	}
	return p, nil
}

// Writable reports why a restore cannot write, or "" when it can: the
// agent must be able to create files in CONFIG_DIR (the safety copies) and
// in worlds_local (the staging directory and the swap).
func Writable(configDir string) string {
	for _, dir := range []string{configDir, filepath.Join(configDir, "worlds_local")} {
		f, err := os.CreateTemp(dir, ".skald-probe-*")
		if err != nil {
			return "read-only"
		}
		name := f.Name()
		f.Close()
		if os.Remove(name) != nil {
			return "read-only"
		}
	}
	return ""
}

// ---- archive checks ---------------------------------------------------------

// SafeName cleans a zip entry name, or refuses it: absolute paths, drive
// letters, backslashes, NUL and any ".." component are zip-slip attempts or
// archives from somewhere else, and either way not the image's backup.
func SafeName(name string) (string, error) {
	if name == "" || strings.ContainsAny(name, "\\\x00") || strings.HasPrefix(name, "/") || (len(name) > 1 && name[1] == ':') {
		return "", fmt.Errorf("unsafe entry name %q", name)
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." {
			return "", fmt.Errorf("unsafe entry name %q", name)
		}
	}
	clean := path.Clean(name)
	if clean == "." || !filepath.IsLocal(filepath.FromSlash(clean)) {
		return "", fmt.Errorf("unsafe entry name %q", name)
	}
	return clean, nil
}

// worldItems are the names a world occupies in worlds_local.
func worldItems(world string) []string {
	return []string{world, world + ".db", world + ".fwl"}
}

// WorldPath maps a clean entry name to its path relative to worlds_local, if
// it belongs to world. The image zips "worlds_local/" from /config, so names
// start with worlds_local/ (or worlds/ for pre-1.0 layouts); anything before
// that prefix is ignored, and an archive of the world folder alone works too.
func WorldPath(clean, world string) (string, bool) {
	parts := strings.Split(clean, "/")
	for i := len(parts) - 1; i >= 0; i-- {
		if parts[i] == "worlds_local" || parts[i] == "worlds" {
			parts = parts[i+1:]
			break
		}
	}
	if len(parts) == 0 {
		return "", false
	}
	if parts[0] == world && len(parts) > 1 {
		return strings.Join(parts, "/"), true
	}
	if len(parts) == 1 && (parts[0] == world+".db" || parts[0] == world+".fwl") {
		return parts[0], true
	}
	return "", false
}

// entry is one archive member to extract.
type entry struct {
	f   *zip.File
	rel string
}

// scan checks every entry name of r and picks the world's regular files.
func scan(r *zip.Reader, world string) ([]entry, error) {
	if len(r.File) > maxEntries {
		return nil, fmt.Errorf("archive has %d entries, more than %d", len(r.File), maxEntries)
	}
	var out []entry
	var total uint64
	for _, f := range r.File {
		clean, err := SafeName(f.Name)
		if err != nil {
			return nil, err
		}
		rel, ok := WorldPath(clean, world)
		if !ok {
			continue
		}
		mode := f.Mode()
		if mode.IsDir() || strings.HasSuffix(f.Name, "/") {
			continue
		}
		if !mode.IsRegular() {
			return nil, fmt.Errorf("entry %q is not a regular file", f.Name)
		}
		total += f.UncompressedSize64
		if total > maxTotalBytes {
			return nil, errors.New("archive unpacks to more than 64 GiB")
		}
		out = append(out, entry{f: f, rel: rel})
	}
	if len(out) == 0 {
		return nil, errors.New("no files of this world in the archive")
	}
	return out, nil
}

// Check opens an archive and checks it before anything is stopped.
func Check(archive, world string) (int, error) {
	r, err := zip.OpenReader(archive)
	if err != nil {
		return 0, fmt.Errorf("open archive: %w", err)
	}
	defer r.Close()
	entries, err := scan(&r.Reader, world)
	return len(entries), err
}

// Extract writes the world's entries of archive into dir, which must be
// empty, through an os.Root: even a name that got past SafeName cannot
// leave dir. Sizes and CRCs are checked as the files are written.
func Extract(archive, world, dir string) (int, error) {
	r, err := zip.OpenReader(archive)
	if err != nil {
		return 0, fmt.Errorf("open archive: %w", err)
	}
	defer r.Close()
	entries, err := scan(&r.Reader, world)
	if err != nil {
		return 0, err
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return 0, err
	}
	defer root.Close()
	for _, e := range entries {
		if err := extractOne(root, e); err != nil {
			return 0, fmt.Errorf("extract %s: %w", e.rel, err)
		}
	}
	return len(entries), nil
}

func extractOne(root *os.Root, e entry) error {
	if d := path.Dir(e.rel); d != "." {
		if err := root.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	src, err := e.f.Open()
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := root.OpenFile(e.rel, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	// One byte over the declared size means the header lied.
	n, err := io.Copy(dst, io.LimitReader(src, int64(e.f.UncompressedSize64)+1))
	if err == nil && uint64(n) != e.f.UncompressedSize64 {
		err = errors.New("size does not match the archive header")
	}
	if err == nil {
		err = dst.Sync()
	}
	if cerr := dst.Close(); err == nil {
		err = cerr
	}
	if err == nil && !e.f.Modified.IsZero() {
		_ = root.Chtimes(e.rel, e.f.Modified, e.f.Modified)
	}
	return err
}

// ---- safety copy --------------------------------------------------------------

// SafetyCopy zips the live world into dir/pre-restore-<time>.zip, with the
// image's layout (worlds_local/<WORLD>/...), and verifies it. It returns the
// archive's path and sha256; a .sha256 file goes next to it. A world with no
// files yields an archive with no entries.
func SafetyCopy(configDir, world, dir string, now time.Time) (string, string, error) {
	return Archive(configDir, world, dir, "pre-restore", now)
}

// Archive is SafetyCopy with another name prefix: dir/<prefix>-<time>.zip.
func Archive(configDir, world, dir, prefix string, now time.Time) (string, string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", err
	}
	name := prefix + "-" + now.UTC().Format("20060102-150405") + ".zip"
	final := filepath.Join(dir, name)
	if _, err := os.Lstat(final); err == nil {
		return "", "", errors.New("a copy with this time already exists")
	}
	tmp, err := os.CreateTemp(dir, "."+prefix+"-*.tmp")
	if err != nil {
		return "", "", err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after the rename

	sum := sha256.New()
	zw := zip.NewWriter(io.MultiWriter(tmp, sum))
	worlds := filepath.Join(configDir, "worlds_local")
	files, size, err := addWorld(zw, worlds, world)
	if err == nil {
		err = zw.Close()
	}
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", "", fmt.Errorf("write safety copy: %w", err)
	}
	digest := hex.EncodeToString(sum.Sum(nil))
	if err := verify(tmpName, digest, files, size); err != nil {
		return "", "", fmt.Errorf("verify safety copy: %w", err)
	}
	if err := os.Rename(tmpName, final); err != nil {
		return "", "", err
	}
	_ = os.WriteFile(final+".sha256", []byte(digest+"  "+name+"\n"), 0o644)
	syncDir(dir)
	return final, digest, nil
}

// addWorld writes the world's files into zw under worlds_local/.
func addWorld(zw *zip.Writer, worlds, world string) (int, int64, error) {
	var files int
	var size int64
	for _, item := range worldItems(world) {
		base := filepath.Join(worlds, item)
		if _, err := os.Lstat(base); errors.Is(err, fs.ErrNotExist) {
			continue
		} else if err != nil {
			return 0, 0, err
		}
		err := filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
			if errors.Is(err, fs.ErrNotExist) {
				return nil // the running game dropped an old generation
			}
			if err != nil {
				return err
			}
			if !d.Type().IsRegular() {
				return nil // directories are implied; links are not the game's
			}
			rel, err := filepath.Rel(worlds, p)
			if err != nil {
				return err
			}
			// Open first: a generation the running game drops meanwhile is skipped.
			f, err := os.Open(p)
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			if err != nil {
				return err
			}
			defer f.Close()
			info, err := f.Stat()
			if err != nil {
				return err
			}
			h, err := zip.FileInfoHeader(info)
			if err != nil {
				return err
			}
			h.Name = "worlds_local/" + filepath.ToSlash(rel)
			h.Method = zip.Deflate
			w, err := zw.CreateHeader(h)
			if err != nil {
				return err
			}
			n, err := io.Copy(w, f)
			if err != nil {
				return err
			}
			files++
			size += n
			return nil
		})
		if err != nil {
			return 0, 0, err
		}
	}
	return files, size, nil
}

// verify reads the archive back: its sha256 must match what was written,
// and every entry must read to the end (archive/zip checks each CRC there),
// with the expected count and total size.
func verify(p, digest string, files int, size int64) error {
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	sum := sha256.New()
	_, err = io.Copy(sum, f)
	f.Close()
	if err != nil {
		return err
	}
	if hex.EncodeToString(sum.Sum(nil)) != digest {
		return errors.New("checksum mismatch")
	}
	r, err := zip.OpenReader(p)
	if err != nil {
		return err
	}
	defer r.Close()
	var n int
	var total int64
	for _, zf := range r.File {
		rc, err := zf.Open()
		if err != nil {
			return err
		}
		c, err := io.Copy(io.Discard, rc)
		rc.Close()
		if err != nil {
			return err
		}
		n++
		total += c
	}
	if n != files || total != size {
		return fmt.Errorf("archive holds %d files / %d bytes, wrote %d / %d", n, total, files, size)
	}
	return nil
}

func syncDir(dir string) {
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
}

// ---- swap -----------------------------------------------------------------------

// move is one rename done by a swap, so it can be undone.
type move struct{ from, to string }

// swap moves the live world's items into prev and the staged items into
// worlds. On error it undoes what it did and the live world is as before.
func swap(worlds, staging, prev, world string) ([]move, error) {
	var done []move
	mv := func(from, to string) error {
		if err := os.Rename(from, to); err != nil {
			return err
		}
		done = append(done, move{from, to})
		return nil
	}
	for _, item := range worldItems(world) {
		if _, err := os.Lstat(filepath.Join(worlds, item)); err == nil {
			if err := mv(filepath.Join(worlds, item), filepath.Join(prev, item)); err != nil {
				return nil, errors.Join(err, undo(done))
			}
		}
	}
	for _, item := range worldItems(world) {
		if _, err := os.Lstat(filepath.Join(staging, item)); err == nil {
			if err := mv(filepath.Join(staging, item), filepath.Join(worlds, item)); err != nil {
				return nil, errors.Join(err, undo(done))
			}
		}
	}
	return done, nil
}

// undo reverses moves, newest first.
func undo(done []move) error {
	var errs []error
	for i := len(done) - 1; i >= 0; i-- {
		if err := os.Rename(done[i].to, done[i].from); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// ---- the run ----------------------------------------------------------------------

// Steps, as the `step` of the `admin` events a run publishes (command
// "restore"). Each is published once with result ok or error.
const (
	StepBegin    = "begin"
	StepSafety   = "safety"
	StepStop     = "stop"
	StepExtract  = "extract"
	StepStart    = "start"
	StepDone     = "done"
	StepRollback = "rollback"
)

// Options configure one restore run.
type Options struct {
	ConfigDir  string
	World      string
	Supervisor Supervisor
	// Publish reports one step's outcome; err is nil on success. extra holds
	// no ids or paths beyond backup and archive names.
	Publish func(step string, err error, extra map[string]any)
	// PlayersOnline is asked before the safety copy and again before the stop.
	PlayersOnline func() bool
	// Timeout bounds the stop and the start; 5 min when zero.
	Timeout time.Duration
	Now     func() time.Time
	Logger  *slog.Logger

	// afterExtract runs between extraction and swap (tests).
	afterExtract func() error
}

// Request is what an admin asked for.
type Request struct {
	Source string
	Backup string
	// Confirm must be the world name, typed.
	Confirm string
}

// ErrPlayersOnline refuses a restore while someone plays.
var ErrPlayersOnline = errors.New("players are online")

// Validate checks a request against the world before a run starts, so the
// panel gets a plain answer and nothing is touched.
func Validate(opt Options, req Request) (string, error) {
	if opt.World == "" {
		return "", errors.New("WORLD_NAME is not set")
	}
	if req.Confirm != opt.World {
		return "", errors.New("type the world name to confirm")
	}
	archive, err := Path(opt.ConfigDir, req.Source, req.Backup)
	if err != nil {
		return "", err
	}
	if reason := Writable(opt.ConfigDir); reason != "" {
		return "", errors.New("the agent cannot write the config volume")
	}
	if opt.PlayersOnline != nil && opt.PlayersOnline() {
		return "", ErrPlayersOnline
	}
	if _, err := Check(archive, opt.World); err != nil {
		return "", err
	}
	return archive, nil
}

// Run carries out a validated restore of archive. It returns nil when the
// backup is in place and the game was started; on an error the previous
// world is back (unless the error says it could not be put back).
func Run(ctx context.Context, opt Options, archive string) error {
	if opt.Timeout == 0 {
		opt.Timeout = 5 * time.Minute
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.Logger == nil {
		opt.Logger = slog.Default()
	}
	publish := func(step string, err error, extra map[string]any) {
		if opt.Publish != nil {
			opt.Publish(step, err, extra)
		}
	}
	backupName := filepath.Base(archive)
	publish(StepBegin, nil, map[string]any{"backup": backupName})

	// The game must be up or down, not on its way between.
	state, err := serverState(ctx, opt.Supervisor)
	if err != nil {
		publish(StepBegin, err, nil)
		return err
	}
	running := state == "RUNNING"
	if !running && state != "STOPPED" && state != "EXITED" && state != "FATAL" {
		err := fmt.Errorf("the game is %s; try again when it is running or stopped", strings.ToLower(state))
		publish(StepBegin, err, nil)
		return err
	}

	// 2. Safety copy, while the game still runs: a failure here costs nothing.
	stamp := opt.Now().UTC()
	safety, _, err := SafetyCopy(opt.ConfigDir, opt.World, filepath.Join(opt.ConfigDir, SkaldDir), stamp)
	if err != nil {
		publish(StepSafety, err, nil)
		return err
	}
	publish(StepSafety, nil, map[string]any{"archive": filepath.Base(safety)})

	if opt.PlayersOnline != nil && opt.PlayersOnline() {
		publish(StepStop, ErrPlayersOnline, nil)
		return ErrPlayersOnline
	}

	// 3. Stop. The updater is paused too: it may start the server on its own.
	updater := false
	if running {
		updater = processRunning(ctx, opt.Supervisor, UpdaterProgram)
		if updater {
			if err := stop(ctx, opt, UpdaterProgram); err != nil {
				publish(StepStop, err, nil)
				return err
			}
		}
		if err := stop(ctx, opt, ServerProgram); err != nil {
			err = fmt.Errorf("stop: %w", err)
			publish(StepStop, err, nil)
			// The game may still run; make sure it does, and the updater too.
			startAll(ctx, opt, updater)
			return err
		}
	}
	publish(StepStop, nil, nil)

	// From here on, a failure puts the previous world back and starts the game.
	worlds := filepath.Join(opt.ConfigDir, "worlds_local")
	tag := stamp.Format("20060102-150405")
	staging := filepath.Join(worlds, ".skald-restore-"+tag)
	prev := filepath.Join(worlds, ".skald-prev-"+tag)
	defer os.RemoveAll(staging)

	fail := func(step string, cause error) error {
		publish(step, cause, nil)
		rbErr := rollback(opt, worlds, prev, safety)
		publish(StepRollback, rbErr, map[string]any{"archive": filepath.Base(safety)})
		if rbErr != nil {
			// Neither world is known to be whole: leave the game stopped.
			opt.Logger.Error("restore rollback failed; the game stays stopped", "err", rbErr)
			return fmt.Errorf("%s failed (%v) and the rollback failed too (%v): the game stays stopped, restore %s by hand", step, cause, rbErr, filepath.Base(safety))
		}
		if err := startAll(ctx, opt, updater); err != nil {
			publish(StepStart, err, nil)
			return fmt.Errorf("%s failed (%v); previous world back, but the game did not start: %w", step, cause, err)
		}
		publish(StepStart, nil, nil)
		_ = os.RemoveAll(prev)
		return fmt.Errorf("%s failed, previous world put back: %w", step, cause)
	}

	// 4. Extract into a staging directory beside the world.
	for _, d := range []string{staging, prev} {
		if err := os.Mkdir(d, 0o755); err != nil {
			return fail(StepExtract, err)
		}
	}
	files, err := Extract(archive, opt.World, staging)
	if err == nil && opt.afterExtract != nil {
		err = opt.afterExtract()
	}
	if err != nil {
		return fail(StepExtract, err)
	}

	// 5. Swap.
	if _, err := swap(worlds, staging, prev, opt.World); err != nil {
		return fail(StepExtract, fmt.Errorf("swap: %w", err))
	}
	publish(StepExtract, nil, map[string]any{"files": files})

	// 6. Start.
	if err := startAll(ctx, opt, updater); err != nil {
		return fail(StepStart, err)
	}
	publish(StepStart, nil, nil)
	if err := os.RemoveAll(prev); err != nil {
		opt.Logger.Warn("restore: previous world left behind", "dir", filepath.Base(prev), "err", err)
	}
	publish(StepDone, nil, map[string]any{"backup": backupName, "archive": filepath.Base(safety)})
	return nil
}

// rollback stops the game if it came up, then puts the previous world back:
// the items in prev if the swap moved them there, otherwise (or if that
// fails) the safety copy.
func rollback(opt Options, worlds, prev, safety string) error {
	ctx, cancel := context.WithTimeout(context.Background(), opt.Timeout)
	defer cancel()
	if err := opt.Supervisor.StopProcess(ctx, ServerProgram, true); err != nil && !supervisor.IsFault(err, supervisor.FaultNotRunning) {
		return fmt.Errorf("stop: %w", err)
	}
	inPrev := false
	for _, item := range worldItems(opt.World) {
		if _, err := os.Lstat(filepath.Join(prev, item)); err == nil {
			inPrev = true
		}
	}
	if !inPrev {
		// The swap never ran (or undid itself): the live world is the old one.
		return nil
	}
	err := putBack(worlds, prev, opt.World)
	if err == nil {
		return nil
	}
	opt.Logger.Warn("restore: renaming the previous world back failed; using the safety copy", "err", err)
	stage, err := os.MkdirTemp(worlds, ".skald-rollback-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if _, err := Extract(safety, opt.World, stage); err != nil {
		return fmt.Errorf("extract safety copy: %w", err)
	}
	discard, err := os.MkdirTemp(worlds, ".skald-failed-*")
	if err != nil {
		return err
	}
	if _, err := swap(worlds, stage, discard, opt.World); err != nil {
		return err
	}
	_ = os.RemoveAll(discard)
	return nil
}

// putBack replaces whatever is live with the items in prev.
func putBack(worlds, prev, world string) error {
	discard, err := os.MkdirTemp(worlds, ".skald-failed-*")
	if err != nil {
		return err
	}
	if _, err := swap(worlds, prev, discard, world); err != nil {
		return err
	}
	_ = os.RemoveAll(discard)
	return nil
}

func serverState(ctx context.Context, sup Supervisor) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	infos, err := sup.GetAllProcessInfo(ctx)
	if err != nil {
		return "", fmt.Errorf("supervisor: %w", err)
	}
	for _, p := range infos {
		if p.Name == ServerProgram {
			return p.StateName, nil
		}
	}
	return "", errors.New("supervisor has no " + ServerProgram)
}

func processRunning(ctx context.Context, sup Supervisor, name string) bool {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	infos, err := sup.GetAllProcessInfo(ctx)
	if err != nil {
		return false
	}
	for _, p := range infos {
		if p.Name == name {
			return p.StateName == "RUNNING"
		}
	}
	return false
}

// stop stops one program and waits; with wait, supervisord answers once the
// process has exited, which for the game is after its shutdown save.
func stop(ctx context.Context, opt Options, name string) error {
	ctx, cancel := context.WithTimeout(ctx, opt.Timeout)
	defer cancel()
	err := opt.Supervisor.StopProcess(ctx, name, true)
	if err != nil && !supervisor.IsFault(err, supervisor.FaultNotRunning) {
		return err
	}
	return nil
}

// startAll starts the game, then the updater if it was paused.
func startAll(ctx context.Context, opt Options, updater bool) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), opt.Timeout)
	defer cancel()
	err := opt.Supervisor.StartProcess(ctx, ServerProgram, true)
	if err != nil && !supervisor.IsFault(err, supervisor.FaultAlreadyStarted) {
		return err
	}
	if updater {
		if err := opt.Supervisor.StartProcess(ctx, UpdaterProgram, false); err != nil && !supervisor.IsFault(err, supervisor.FaultAlreadyStarted) {
			opt.Logger.Warn("restore: updater did not start again", "err", err)
		}
	}
	return nil
}
