package server

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

var backupName = regexp.MustCompile(`^worlds-\d{8}-\d{6}\.zip$`)

// backupDownloadTimeout replaces the server-wide WriteTimeout for one
// download: backup zips can be far larger than a /state response.
const backupDownloadTimeout = 30 * time.Minute

// backupHandler streams one CONFIG_DIR/backups/<name> zip. The name is
// pattern-checked, then opened through an os.Root so nothing outside the
// backups directory is reachable, and symlinks are refused outright.
func (s *Server) backupHandler(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !backupName.MatchString(name) {
		http.Error(w, "bad backup name", http.StatusBadRequest)
		return
	}
	root, err := os.OpenRoot(filepath.Join(s.opt.ConfigDir, "backups"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer root.Close()

	lfi, err := root.Lstat(name)
	if err != nil || !lfi.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	f, err := root.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	// SameFile guards against the entry being swapped between Lstat and Open.
	if err != nil || !fi.Mode().IsRegular() || !os.SameFile(lfi, fi) {
		http.NotFound(w, r)
		return
	}

	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(backupDownloadTimeout))
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	// ServeContent sets Content-Length and handles Range/If-Modified-Since.
	http.ServeContent(w, r, name, fi.ModTime(), f)
}
