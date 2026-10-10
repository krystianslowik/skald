package server

import (
	"bytes"
	"net/http"
	"os"
	"time"
)

// iconsMap serves GET /icons/map.json: the extractor's item -> cell map,
// revalidated by ETag (the game build it was made from). 404 when ICONS_DIR
// is not set or nothing has been extracted yet.
func (s *Server) iconsMap(w http.ResponseWriter, r *http.Request) {
	m, err := s.opt.Icons.Load()
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "message": "no item icons"})
		return
	}
	h := w.Header()
	h.Set("ETag", `"`+m.Build+`"`)
	h.Set("Cache-Control", "no-cache")
	h.Set("Content-Type", "application/json")
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(m.JSON))
}

// iconsSheet serves GET /icons/sheet.webp: the sheet map.json names. The
// file name carries the build, so the content behind one ETag never changes.
func (s *Server) iconsSheet(w http.ResponseWriter, r *http.Request) {
	m, err := s.opt.Icons.Load()
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "message": "no item icons"})
		return
	}
	f, err := os.Open(m.SheetPath)
	if err != nil {
		// Replaced by a newer build between reading map.json and here.
		w.Header().Set("Retry-After", "5")
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "message": "icon sheet is being replaced"})
		return
	}
	defer f.Close()
	h := w.Header()
	h.Set("ETag", `"`+m.Build+`"`)
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	h.Set("Content-Type", "image/webp")
	http.ServeContent(w, r, "", time.Time{}, f)
}
