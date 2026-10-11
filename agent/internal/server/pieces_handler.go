package server

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"hash/fnv"
	"math"
	"net/http"
	"strconv"

	"github.com/krystianslowik/skald/agent/internal/worldmap"
)

// maxPiecesSide bounds each side of a /pieces or /nature box: floor plans
// and nature are for close zoom, not for the whole world.
const maxPiecesSide = 1024

// piecesHandler serves GET /pieces?x0=&z0=&x1=&z1=: the pieces players built
// whose position lies inside the world-space box, as a floor plan (see
// worldmap.Pieces.AppendJSON). Same gates as /map; 400 on a missing, inverted
// or too large box. The ETag is the index's plus the box, so an unchanged
// base costs a 304.
func (s *Server) piecesHandler(w http.ResponseWriter, r *http.Request) {
	enc, box, ok := s.mapBox(w, r)
	if !ok {
		return
	}
	if notModified(w, r, enc.Pieces.ETag, box, "") {
		return
	}
	q := enc.Pieces.Query(box[0], box[1], box[2], box[3], worldmap.MaxPieces)
	writeBoxJSON(w, r, enc.Pieces.AppendJSON(nil, q, enc.Generation))
}

// mapBox answers the map gates (404 without a world, 503 before the first
// build) and reads the x0, z0, x1, z1 box (400 when missing, inverted or
// longer than maxPiecesSide a side). ok is false when it has answered.
func (s *Server) mapBox(w http.ResponseWriter, r *http.Request) (enc *worldmap.Encoded, box [4]float64, ok bool) {
	if !s.opt.Map.Enabled() {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "message": "world map off: WORLD_NAME is not set"})
		return nil, box, false
	}
	enc = s.opt.Map.Current()
	if enc == nil {
		w.Header().Set("Retry-After", "30")
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "message": "world map not built yet"})
		return nil, box, false
	}
	for i, k := range []string{"x0", "z0", "x1", "z1"} {
		v, err := strconv.ParseFloat(r.URL.Query().Get(k), 64)
		if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "x0, z0, x1 and z1 must be numbers"})
			return nil, box, false
		}
		box[i] = v
	}
	if box[2] < box[0] || box[3] < box[1] {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "the box needs x0 <= x1 and z0 <= z1"})
		return nil, box, false
	}
	if box[2]-box[0] > maxPiecesSide || box[3]-box[1] > maxPiecesSide {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": fmt.Sprintf("the box is limited to %d m a side", maxPiecesSide)})
		return nil, box, false
	}
	return enc, box, true
}

// notModified sets the ETag (the index's tag plus a hash of the box and
// extra) and the caching headers, and answers 304 when the client has it.
func notModified(w http.ResponseWriter, r *http.Request, index string, box [4]float64, extra string) bool {
	h := fnv.New64a()
	fmt.Fprintf(h, "%g,%g,%g,%g%s", box[0], box[1], box[2], box[3], extra)
	etag := fmt.Sprintf(`"%s-%016x"`, index, h.Sum64())
	hdr := w.Header()
	hdr.Set("ETag", etag)
	hdr.Set("Cache-Control", "no-cache")
	hdr.Set("Vary", "Accept-Encoding")
	if etagMatch(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return true
	}
	return false
}

// writeBoxJSON writes a JSON answer, gzipped when the client takes it.
func writeBoxJSON(w http.ResponseWriter, r *http.Request, body []byte) {
	hdr := w.Header()
	hdr.Set("Content-Type", "application/json")
	if acceptsGzip(r.Header.Get("Accept-Encoding")) {
		var gz bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&gz, gzip.BestSpeed)
		_, _ = zw.Write(body)
		_ = zw.Close()
		hdr.Set("Content-Encoding", "gzip")
		body = gz.Bytes()
	}
	_, _ = w.Write(body)
}
