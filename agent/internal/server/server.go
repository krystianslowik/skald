package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/krystianslowik/skald/agent/internal/access"
	"github.com/krystianslowik/skald/agent/internal/bridge"
	"github.com/krystianslowik/skald/agent/internal/compat"
	"github.com/krystianslowik/skald/agent/internal/events"
	"github.com/krystianslowik/skald/agent/internal/icons"
	"github.com/krystianslowik/skald/agent/internal/settings"
	"github.com/krystianslowik/skald/agent/internal/state"
	"github.com/krystianslowik/skald/agent/internal/supervisor"
	"github.com/krystianslowik/skald/agent/internal/terrain"
	"github.com/krystianslowik/skald/agent/internal/world"
	"github.com/krystianslowik/skald/agent/internal/worldmap"
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
	// Map is the world map builder; nil or disabled answers GET /map and
	// GET /pieces and GET /nature with 404.
	Map *worldmap.Builder
	// Icons is ICONS_DIR; nil answers the /icons routes with 404.
	Icons *icons.Dir
	// Terrain is the world generator's terrain from TERRAIN_DIR; nil leaves
	// /state.terrain null and answers /terrain.* with 404.
	Terrain *terrain.Terrain
	// Tiles is the terrain tile pyramid; nil answers /terrain/tile* with 404.
	Tiles *terrain.Tiles
	// Bridge is the admin plugin in the game process; nil (no BRIDGE_TOKEN)
	// leaves the /bridge routes unregistered (404).
	Bridge *bridge.Client
	// Access edits adminlist.txt and bannedlist.txt in ConfigDir; nil leaves
	// the /access routes unregistered (404).
	Access *access.Store
	// Compat is the compatibility check; nil leaves /state.compat null and
	// the /compat routes unregistered (404).
	Compat *compat.Checker
	Logger *slog.Logger
	// PingEvery is the SSE keepalive interval; 15 s when zero.
	PingEvery time.Duration
	// ActionTimeout bounds stop/start during a restart; 5 min when zero.
	ActionTimeout time.Duration
	// Version is the Skald release the agent was built from; "dev" when empty.
	Version string
}

type Server struct {
	opt       Options
	startedAt time.Time
	world     *world.Reader
	// busy serialises actions: TryLock fails with 409 while one is running.
	busy sync.Mutex
	// restarting is set while a stop+start runs: the bridge plugin is down
	// with the game then.
	restarting atomic.Bool
	// restoring is set while a world restore runs (restarting is too).
	restoring atomic.Bool
	// procs is the last supervisor answer, shared by /state and /metrics.
	procMu sync.Mutex
	procs  procSnapshot
	// zeroSince is when the apply-when-empty watcher first saw an empty,
	// running server; zero while players are online. Watcher goroutine only.
	zeroSince time.Time
	clocks    clockTracker
	// legacyStreams counts open /events streams without ?positions=lease:
	// they get positions whenever someone plays, as before the lease.
	legacyStreams atomic.Int64
	// watches maps each positions lease holder (POST /positions/watch) to
	// when its lease runs out.
	watchMu sync.Mutex
	watches map[string]time.Time
	// now is the lease clock; time.Now when nil. Tests set it.
	now func() time.Time
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
	if opt.Version == "" {
		opt.Version = "dev"
	}
	return &Server{opt: opt, startedAt: time.Now().UTC(), world: world.NewReader(opt.ConfigDir, opt.WorldName)}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /state", s.stateHandler)
	mux.HandleFunc("GET /events", s.eventsHandler)
	mux.HandleFunc("POST /positions/watch", s.positionsWatch)
	mux.HandleFunc("DELETE /positions/watch", s.positionsUnwatch)
	mux.HandleFunc("GET /logs", s.logsHandler)
	mux.HandleFunc("GET /backups/{name}", s.backupHandler)
	mux.HandleFunc("POST /action/{name}", s.actionHandler)
	mux.HandleFunc("GET /map", s.mapHandler)
	mux.HandleFunc("GET /pieces", s.piecesHandler)
	mux.HandleFunc("GET /nature", s.natureHandler)
	mux.HandleFunc("GET /icons/map.json", s.iconsMap)
	mux.HandleFunc("GET /icons/sheet.webp", s.iconsSheet)
	mux.HandleFunc("GET /terrain.png", s.terrainPNG)
	mux.HandleFunc("GET /terrain.json", s.terrainJSON)
	mux.HandleFunc("GET /terrain/tiles.json", s.terrainTilesJSON)
	mux.HandleFunc("GET /terrain/tile", s.terrainTile)
	if s.opt.Settings != nil {
		mux.HandleFunc("GET /settings", s.settingsGet)
		mux.HandleFunc("GET /settings/password", s.settingsPassword)
		mux.HandleFunc("PUT /settings", s.settingsPut)
		mux.HandleFunc("POST /settings/apply", s.settingsApply)
		mux.HandleFunc("DELETE /settings/apply", s.settingsCancel)
	}
	if s.opt.Access != nil {
		mux.HandleFunc("GET /access", s.accessGet)
		mux.HandleFunc("POST /access/{list}/{op}", s.accessChange)
	}
	if s.opt.Compat != nil {
		mux.HandleFunc("GET /compat", s.compatGet)
		mux.HandleFunc("POST /compat/run", s.compatRun)
	}
	mux.HandleFunc("GET /restore", s.restoreGet)
	mux.HandleFunc("POST /restore", s.restorePost)
	if s.opt.Bridge != nil {
		mux.HandleFunc("GET /bridge/status", s.bridgeStatus)
		mux.HandleFunc("GET /bridge/players", s.bridgePlayers)
		mux.HandleFunc("GET /bridge/{name}", s.bridgeRead)
		mux.HandleFunc("POST /bridge/{command}", s.bridgeCommand)
	}
	return requireToken(s.opt.Token, mux)
}

// ListenAndServe serves the API on addr until ctx is cancelled, then shuts
// down gracefully so a pod rollout does not wait out the grace period.
func (s *Server) ListenAndServe(ctx context.Context, addr string) error {
	srv := &http.Server{
		Addr:              addr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		// /events clears its own write deadline; everything else is small.
		WriteTimeout: 30 * time.Second,
	}
	return serveUntil(ctx, srv)
}

// MetricsHandler serves GET /metrics without a token. It is meant for a
// separate listener (METRICS_ADDR) that only Prometheus can reach.
func (s *Server) MetricsHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /metrics", s.metricsHandler)
	return mux
}

// ListenAndServeMetrics serves MetricsHandler on addr until ctx is cancelled.
func (s *Server) ListenAndServeMetrics(ctx context.Context, addr string) error {
	srv := &http.Server{
		Addr:              addr,
		Handler:           s.MetricsHandler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
	}
	return serveUntil(ctx, srv)
}

// serveUntil runs srv until ctx is done. Open SSE streams get 5 s to finish.
func serveUntil(ctx context.Context, srv *http.Server) error {
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	_, _ = w.Write([]byte("ok"))
}
