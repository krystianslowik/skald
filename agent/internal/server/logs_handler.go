package server

import (
	"net/http"
	"strconv"

	"github.com/krystianslowik/skald/agent/internal/events"
)

const defaultLogLimit = 500

func (s *Server) logsHandler(w http.ResponseWriter, r *http.Request) {
	limit := defaultLogLimit
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			http.Error(w, "bad limit", http.StatusBadRequest)
			return
		}
		limit = n
	}
	writeJSON(w, http.StatusOK, struct {
		Lines []events.LogLine `json:"lines"`
	}{s.opt.Hub.Logs(limit)})
}
