package access

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// Fictional ids only, in the style of the session fixture.
const (
	xboxShort = "X_1234500000000001"
	steamLong = "Steam_76561190000000003"
	steamV    = "V_76561190000000003"
)

func TestValidID(t *testing.T) {
	for _, id := range []string{xboxShort, steamV, "S_42", "N_7", "A_99", "Xbox_2533274900000001", steamLong, "76561190000000003"} {
		if !ValidID(id) {
			t.Errorf("ValidID(%q) = false", id)
		}
	}
	for _, id := range []string{"", "x_123", "X_", "X_12a", "Q_123", "xbox_1", "Steam_", "Steam 1", "X_1\n", "// X_1", "123", "1234567890123456", "../X_1", "X_" + string(make([]byte, 70))} {
		if ValidID(id) {
			t.Errorf("ValidID(%q) = true", id)
		}
	}
}

func TestKeyMatchesFormsOfOneAccount(t *testing.T) {
	if Key(steamV) != Key(steamLong) || Key(steamV) != Key("76561190000000003") {
		t.Fatalf("steam forms differ: %q %q", Key(steamV), Key(steamLong))
	}
	if Key("X_5") != Key("Xbox_5") || Key("X_5") == Key("V_5") {
		t.Fatal("xbox keys wrong")
	}
	if Platform(xboxShort) != "xbox" || Platform(steamV) != "steam" || Platform("S_1") != "playstation" || Platform("A_1") != "unknown" {
		t.Fatal("platforms wrong")
	}
	if got := Mask(xboxShort); got != "X_***0001" {
		t.Fatalf("Mask = %q", got)
	}
}

func TestParseKeepsCommentsAndUnknownLines(t *testing.T) {
	in := "// List admin players ID  ONE per line\n" + xboxShort + "\n\n  " + steamV + "  \nsomething-odd\n"
	lines := Parse([]byte(in))
	if got := IDs(lines); !reflect.DeepEqual(got, []string{xboxShort, steamV, "something-odd"}) {
		t.Fatalf("IDs = %v", got)
	}
	if string(Format(lines, false)) != in {
		t.Fatalf("round trip changed the file:\n%q", Format(lines, false))
	}
}

func TestAddRemove(t *testing.T) {
	lines := Parse([]byte("// header\n" + steamLong + "\nsomething-odd\n"))
	if _, err := Add(lines, steamV); !errors.Is(err, ErrExists) {
		t.Fatalf("adding another form of a listed account: %v", err)
	}
	if _, err := Add(lines, "nope"); !errors.Is(err, ErrBadID) {
		t.Fatalf("bad id: %v", err)
	}
	lines, err := Add(lines, xboxShort)
	if err != nil {
		t.Fatal(err)
	}
	if want := "// header\n" + steamLong + "\nsomething-odd\n" + xboxShort + "\n"; string(Format(lines, false)) != want {
		t.Fatalf("after add: %q", Format(lines, false))
	}
	lines, err = Remove(lines, "something-odd")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Remove(lines, steamV); !errors.Is(err, ErrNotFound) {
		t.Fatalf("remove matches exact entries only: %v", err)
	}
	if want := "// header\n" + steamLong + "\n" + xboxShort + "\n"; string(Format(lines, false)) != want {
		t.Fatalf("after remove: %q", Format(lines, false))
	}
}

func TestStoreWritesAtomicallyAndKeepsLineEndingsAndMode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "adminlist.txt")
	if err := os.WriteFile(path, []byte("// admins\r\n"+steamV+"\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := New(dir)
	if !s.Writable() {
		t.Fatal("temp dir not writable")
	}
	if err := s.Add(Admins, xboxShort); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != "// admins\r\n"+steamV+"\r\n"+xboxShort+"\r\n" {
		t.Fatalf("file = %q", got)
	}
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", fi.Mode().Perm())
	}
	ids, err := s.Read(Admins)
	if err != nil || !reflect.DeepEqual(ids, []string{steamV, xboxShort}) {
		t.Fatalf("Read = %v, %v", ids, err)
	}
	// No temp files left behind.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("dir has %d entries", len(entries))
	}
}

func TestStoreMissingFile(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	if ids, err := s.Read(Bans); err != nil || len(ids) != 0 {
		t.Fatalf("Read = %v, %v", ids, err)
	}
	if err := s.Remove(Bans, steamV); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Remove = %v", err)
	}
	if err := s.Add(Bans, steamV); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "bannedlist.txt"))
	if string(got) != steamV+"\n" {
		t.Fatalf("file = %q", got)
	}
}

func TestStoreReadOnlyDir(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root ignores permissions")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	s := New(dir)
	if s.Writable() {
		t.Fatal("read-only dir reported writable")
	}
	if err := s.Add(Admins, steamV); err == nil {
		t.Fatal("Add succeeded on a read-only dir")
	}
}
