package server

import (
	"net/http"
	"time"
)

// positionsLease is how long one POST /positions/watch keeps the poll on.
// skald-web renews it every 10 s while a browser has the map or a player
// list open, so a web tier that dies stops the poll within this.
const positionsLease = 30 * time.Second

// maxLeaseHolders bounds the lease table; one web tier holds one lease.
const maxLeaseHolders = 64

// PositionsWanted reports whether anyone wants live positions: an SSE
// stream that did not opt in to the lease (a skald-web older than the
// lease, or curl), or a lease that has not run out.
func (s *Server) PositionsWanted() bool {
	if s.legacyStreams.Load() > 0 {
		return true
	}
	s.watchMu.Lock()
	defer s.watchMu.Unlock()
	now := s.leaseNow()
	for _, until := range s.watches {
		if now.Before(until) {
			return true
		}
	}
	return false
}

// positionsWatch starts or renews the lease of ?holder= (one per web tier,
// so one ending its lease does not end another's).
func (s *Server) positionsWatch(w http.ResponseWriter, r *http.Request) {
	holder := r.URL.Query().Get("holder")
	if len(holder) > 64 {
		http.Error(w, "bad holder", http.StatusBadRequest)
		return
	}
	s.watchMu.Lock()
	now := s.leaseNow()
	if s.watches == nil {
		s.watches = map[string]time.Time{}
	}
	for h, until := range s.watches {
		if !now.Before(until) {
			delete(s.watches, h)
		}
	}
	if _, ok := s.watches[holder]; ok || len(s.watches) < maxLeaseHolders {
		s.watches[holder] = now.Add(positionsLease)
	}
	s.watchMu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

// positionsUnwatch ends the lease of ?holder= at once: its last map closed.
func (s *Server) positionsUnwatch(w http.ResponseWriter, r *http.Request) {
	s.watchMu.Lock()
	delete(s.watches, r.URL.Query().Get("holder"))
	s.watchMu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) leaseNow() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}
