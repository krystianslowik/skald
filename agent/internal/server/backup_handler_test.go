package server

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func TestBackupDownload(t *testing.T) {
	h := newHarness(t)
	name := "worlds-20261009-230500.zip"
	content := []byte("PK\x03\x04 fake zip body")
	if err := os.WriteFile(filepath.Join(h.dir, "backups", name), content, 0o644); err != nil {
		t.Fatal(err)
	}

	if r := h.do(t, "GET", "/backups/"+name, ""); r.StatusCode != 401 {
		t.Errorf("without token = %d, want 401", r.StatusCode)
	}

	r := h.do(t, "GET", "/backups/"+name, token)
	defer r.Body.Close()
	if r.StatusCode != 200 {
		t.Fatalf("status = %d", r.StatusCode)
	}
	body, _ := io.ReadAll(r.Body)
	if string(body) != string(content) {
		t.Errorf("body = %q", body)
	}
	if ct := r.Header.Get("Content-Type"); ct != "application/zip" {
		t.Errorf("content-type = %q", ct)
	}
	if cl := r.Header.Get("Content-Length"); cl != strconv.Itoa(len(content)) {
		t.Errorf("content-length = %q", cl)
	}
	if cd := r.Header.Get("Content-Disposition"); cd != `attachment; filename="`+name+`"` {
		t.Errorf("content-disposition = %q", cd)
	}
}

func TestBackupDownloadRejects(t *testing.T) {
	h := newHarness(t)
	backups := filepath.Join(h.dir, "backups")

	// A secret next to the backups dir, plus symlinks that try to reach it.
	secret := filepath.Join(h.dir, "secret.zip")
	if err := os.WriteFile(secret, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(backups, "worlds-20260101-000000.zip")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../secret.zip", filepath.Join(backups, "worlds-20260101-000001.zip")); err != nil {
		t.Fatal(err)
	}
	// A symlink to a real backup inside the dir is still refused: only
	// regular files are served.
	if err := os.Symlink("worlds-20261009-230500.zip", filepath.Join(backups, "worlds-20260101-000002.zip")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(backups, "worlds-20260101-000003.zip"), 0o755); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		path string
		want int
	}{
		{"/backups/worlds-20991231-235959.zip", 404},     // missing
		{"/backups/worlds-20260101-000000.zip", 404},     // absolute symlink out
		{"/backups/worlds-20260101-000001.zip", 404},     // relative symlink out
		{"/backups/worlds-20260101-000002.zip", 404},     // symlink inside
		{"/backups/worlds-20260101-000003.zip", 404},     // directory
		{"/backups/secret.zip", 400},                     // bad name
		{"/backups/worlds-2026100-230500.zip", 400},      // short date
		{"/backups/worlds-20261009-230500.zip.bak", 400}, // suffix
		{"/backups/xworlds-20261009-230500.zip", 400},    // prefix
		{"/backups/..%2Fsecret.zip", 400},                // encoded traversal
		{"/backups/..%2F..%2Fetc%2Fpasswd", 400},         // encoded traversal
		{"/backups/worlds-20261009-230500.zip%00", 400},  // NUL
		{"/backups/%2E%2E%2Fworlds-20261009-230500.zip", 400},
	}
	for _, c := range cases {
		r := h.do(t, "GET", c.path, token)
		body, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if r.StatusCode != c.want {
			t.Errorf("%s = %d, want %d (body %q)", c.path, r.StatusCode, c.want, body)
		}
		if string(body) == "secret" {
			t.Errorf("%s leaked the secret", c.path)
		}
	}

	// Literal ../ is cleaned by ServeMux into a redirect that never reaches
	// the handler with a traversing name; following it must not serve the
	// secret either.
	req, _ := http.NewRequest("GET", h.srv.URL+"/backups/../secret.zip", nil)
	req.Header.Set("X-Agent-Token", token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode == 200 || string(body) == "secret" {
		t.Errorf("literal traversal = %d %q", resp.StatusCode, body)
	}
}

func TestBackupDownloadNoBackupsDir(t *testing.T) {
	h := newHarness(t)
	if err := os.RemoveAll(filepath.Join(h.dir, "backups")); err != nil {
		t.Fatal(err)
	}
	if r := h.do(t, "GET", "/backups/worlds-20261009-230500.zip", token); r.StatusCode != 404 {
		t.Errorf("no backups dir = %d, want 404", r.StatusCode)
	}
}
