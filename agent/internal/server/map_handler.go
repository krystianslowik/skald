package server

import (
	"net/http"
	"strconv"
	"strings"
)

// mapHandler serves GET /map: the last built world map, gzip when the client
// takes it, with an ETag so an unchanged map costs a 304. 404 when no world
// is configured, 503 until the first build is done.
func (s *Server) mapHandler(w http.ResponseWriter, r *http.Request) {
	if !s.opt.Map.Enabled() {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "message": "world map off: WORLD_NAME is not set"})
		return
	}
	enc := s.opt.Map.Current()
	if enc == nil {
		w.Header().Set("Retry-After", "30")
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "message": "world map not built yet"})
		return
	}
	h := w.Header()
	h.Set("ETag", enc.ETag)
	h.Set("Cache-Control", "no-cache")
	h.Set("Vary", "Accept-Encoding")
	if etagMatch(r.Header.Get("If-None-Match"), enc.ETag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	h.Set("Content-Type", "application/json")
	body := enc.JSON
	if acceptsGzip(r.Header.Get("Accept-Encoding")) {
		h.Set("Content-Encoding", "gzip")
		body = enc.Gzip
	}
	_, _ = w.Write(body)
}

func etagMatch(header, etag string) bool {
	for _, t := range strings.Split(header, ",") {
		t = strings.TrimPrefix(strings.TrimSpace(t), "W/")
		if t == etag || t == "*" {
			return true
		}
	}
	return false
}

func acceptsGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(name), "gzip") {
			continue
		}
		for _, p := range strings.Split(params, ";") {
			k, v, _ := strings.Cut(strings.TrimSpace(p), "=")
			if strings.TrimSpace(k) == "q" {
				q, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
				return err == nil && q > 0
			}
		}
		return true
	}
	return false
}
