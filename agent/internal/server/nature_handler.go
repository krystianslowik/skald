package server

import (
	"net/http"
	"strconv"

	"github.com/krystianslowik/skald/agent/internal/worldmap"
)

// natureHandler serves GET /nature?x0=&z0=&x1=&z1=[&spoilers=true]: the trees,
// stumps, logs, rocks, bushes, ore deposits and pickables the world generated
// inside the box (see worldmap.Nature.AppendJSON). Same gates and box rules
// as /pieces. Without spoilers=true only objects on found spots are sent
// (explored, or within 64 m of a built piece, as for locations), so ore in
// land nobody has seen never leaves the agent; the web passes its
// MAP_SPOILERS. The ETag is the index's plus the box and the flag.
func (s *Server) natureHandler(w http.ResponseWriter, r *http.Request) {
	enc, box, ok := s.mapBox(w, r)
	if !ok {
		return
	}
	spoilers := false
	if v := r.URL.Query().Get("spoilers"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "spoilers must be true or false"})
			return
		}
		spoilers = b
	}
	if notModified(w, r, enc.Nature.ETag, box, ","+strconv.FormatBool(spoilers)) {
		return
	}
	q := enc.Nature.Query(box[0], box[1], box[2], box[3], spoilers, worldmap.MaxNature)
	writeBoxJSON(w, r, enc.Nature.AppendJSON(nil, q, enc.Generation))
}
