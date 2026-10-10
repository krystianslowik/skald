package server

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/krystianslowik/skald/agent/internal/events"
	"github.com/krystianslowik/skald/agent/internal/settings"
	"github.com/krystianslowik/skald/agent/internal/state"
	"github.com/krystianslowik/skald/agent/internal/supervisor"
	"github.com/krystianslowik/skald/agent/internal/world"
)

// Supervisor is the subset of the supervisord XML-RPC API the server calls.
// Implemented by internal/supervisor.Client.
type Supervisor interface {
	GetAllProcessInfo(ctx context.Context) ([]supervisor.ProcessInfo, error)
	SignalProcess(ctx context.Context, name, signal string) error
	StopProcess(ctx context.Context, name string, wait bool) error
	StartProcess(ctx context.Context, name string, wait bool) error
}

type Options struct {
	Token      string
	ConfigDir  string
	WorldName  string
	ServerName string
	ServerArgs string
	Hub        *events.Hub
	Tracker    *state.Tracker
	Supervisor Supervisor
	// Settings is nil when SETTINGS_DIR is missing or read-only: the
	// /settings routes are then not registered at all (404).
	Settings *settings.Store
	Logger   *slog.Logger
	// PingEvery is the SSE keepalive interval; 15 s when zero.
	PingEvery time.Duration
	// ActionTimeout bounds stop/start during a restart; 5 min when zero.
	ActionTimeout time.Duration
}

type Server struct {
	opt       Options
	startedAt time.Time
	world     *world.Reader
	// busy serialises actions: TryLock fails with 409 while one is running.
	busy sync.Mutex
	// procs is the last supervisor answer, shared by /state and /metrics.
	procMu sync.Mutex
	procs  procSnapshot
	// zeroSince is when the apply-when-empty watcher first saw an empty,
	// running server; zero while players are online. Watcher goroutine only.
	zeroSince time.Time
}

func New(opt Options) *Server {
	if opt.PingEvery == 0 {
		opt.PingEvery = 15 * time.Second
	}
	if opt.ActionTimeout == 0 {
		opt.ActionTimeout = 5 * time.Minute
	}
	if opt.Logger == nil {
		opt.Logger = slog.Default()
	}
	return &Server{opt: opt, startedAt: time.Now().UTC(), world: world.NewReader(opt.ConfigDir, opt.WorldName)}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /state", s.stateHandler)
	mux.HandleFunc("GET /events", s.eventsHandler)
	mux.HandleFunc("GET /logs", s.logsHandler)
	mux.HandleFunc("GET /backups/{name}", s.backupHandler)
	mux.HandleFunc("POST /action/{name}", s.actionHandler)
	if s.opt.Settings != nil {
		mux.HandleFunc("GET /settings", s.settingsGet)
		mux.HandleFunc("GET /settings/password", s.settingsPassword)
		mux.HandleFunc("PUT /settings", s.settingsPut)
		mux.HandleFunc("POST /settings/apply", s.settingsApply)
		mux.HandleFunc("DELETE /settings/apply", s.settingsCancel)
	}
	return requireToken(s.opt.Token, mux)
}

func (s *Server) ListenAndServe(addr string) error {
	srv := &http.Server{
		Addr:              addr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		// /events clears its own write deadline; everything else is small.
		WriteTimeout: 30 * time.Second,
	}
	return srv.ListenAndServe()
}

// MetricsHandler serves GET /metrics without a token. It is meant for a
// separate listener (METRICS_ADDR) that only Prometheus can reach.
func (s *Server) MetricsHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /metrics", s.metricsHandler)
	return mux
}

// ListenAndServeMetrics serves MetricsHandler on addr.
func (s *Server) ListenAndServeMetrics(addr string) error {
	srv := &http.Server{
		Addr:              addr,
		Handler:           s.MetricsHandler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
	}
	return srv.ListenAndServe()
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	_, _ = w.Write([]byte("ok"))
}
