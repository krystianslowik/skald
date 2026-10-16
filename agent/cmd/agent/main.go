package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/krystianslowik/skald/agent/internal/access"
	"github.com/krystianslowik/skald/agent/internal/bridge"
	"github.com/krystianslowik/skald/agent/internal/config"
	"github.com/krystianslowik/skald/agent/internal/events"
	"github.com/krystianslowik/skald/agent/internal/icons"
	"github.com/krystianslowik/skald/agent/internal/server"
	"github.com/krystianslowik/skald/agent/internal/settings"
	"github.com/krystianslowik/skald/agent/internal/state"
	"github.com/krystianslowik/skald/agent/internal/supervisor"
	"github.com/krystianslowik/skald/agent/internal/syslog"
	"github.com/krystianslowik/skald/agent/internal/terrain"
	"github.com/krystianslowik/skald/agent/internal/world"
	"github.com/krystianslowik/skald/agent/internal/worldmap"
)

// version is the release this binary was built from, set at build time with
// -ldflags "-X main.version=2026.10.0". Local builds report "dev".
var version = "dev"

func main() {
	cfg, err := config.Load()
	if err != nil {
		fail(err)
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: parseLevel(cfg.LogLevel)}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	hub := events.New(events.DefaultRingSize, events.DefaultLogSize)
	tracker := state.New(hub)

	seed := settings.Seed{
		Name:         cfg.ServerName,
		Public:       settings.ParsePublic(cfg.ServerPublic),
		Args:         cfg.ServerArgs,
		PasswordFile: cfg.PasswordFile,
	}
	if m := world.NewReader(cfg.ConfigDir, cfg.WorldName).Meta(); m != nil {
		seed.WorldModifiers = m.Modifiers
	}
	store, err := settings.Open(cfg.SettingsDir, seed, nil)
	if err != nil {
		logger.Info("server settings disabled", "dir", cfg.SettingsDir, "reason", err.Error())
		store = nil
	}
	// The admin plugin in the game process; nil without BRIDGE_TOKEN.
	var ackPath string
	if store != nil {
		ackPath = filepath.Join(cfg.SettingsDir, "bridge.json")
	}
	br := bridge.New(bridge.Options{
		URL:          cfg.BridgeURL,
		Token:        cfg.BridgeToken,
		TestedBuilds: cfg.BridgeTestedBuilds,
		AckPath:      ackPath,
		Hub:          hub,
		Logger:       logger,
	})
	if br == nil {
		logger.Info("bridge disabled", "reason", "BRIDGE_TOKEN not set")
	}

	handleLine := func(line string) {
		tracker.HandleLine(line)
		if store != nil {
			store.NoteLine(line)
		}
		if br != nil {
			br.NoteLine(line)
		}
	}

	go tracker.WatchStatusFile(ctx, cfg.StatusFile, 2*time.Second)
	go func() {
		// A bind failure or a socket closed under us means the game's logs
		// are lost for the pod's lifetime; exit so the container runtime
		// restarts the sidecar.
		if err := syslog.Listen(ctx, cfg.SyslogAddr, logger, handleLine); err != nil {
			fail(fmt.Errorf("syslog listen %s: %w", cfg.SyslogAddr, err))
		}
	}()

	var worldDir string
	if cfg.WorldName != "" {
		worldDir = filepath.Join(cfg.ConfigDir, "worlds_local", cfg.WorldName)
	}
	worldMap := worldmap.New(worldmap.Options{Dir: worldDir, ShowNames: cfg.MapShowNames, Logger: logger})
	go worldMap.Run(ctx, worldmap.RebuildEvery)

	terr := terrain.New(terrain.Options{
		Dir:         cfg.TerrainDir,
		Meta:        world.NewReader(cfg.ConfigDir, cfg.WorldName).Meta,
		GameVersion: func() string { return tracker.Snapshot().Version },
		Logger:      logger,
	})
	go terr.Run(ctx, terrain.RefreshEvery)
	// Tiles from the running server through the bridge, the Job's grid for
	// the low levels when it is current. A nil *bridge.Client must not
	// become a non-nil interface.
	var tileSource terrain.Source
	if br != nil {
		tileSource = br
	}
	tiles := terrain.NewTiles(terr, terrain.TileOptions{
		Source:     tileSource,
		CacheDir:   cfg.TerrainCacheDir,
		CacheBytes: int64(cfg.TerrainCacheMB) << 20,
		Bake:       cfg.TerrainBake,
		PlayersOnline: func() bool {
			snap := tracker.Snapshot()
			return snap.PlayersReported > 0 || len(snap.Players) > 0
		},
		Logger: logger,
	})
	go tiles.Run(ctx)

	s := server.New(server.Options{
		Token:      cfg.AgentToken,
		ConfigDir:  cfg.ConfigDir,
		WorldName:  cfg.WorldName,
		ServerName: cfg.ServerName,
		ServerArgs: cfg.ServerArgs,
		Hub:        hub,
		Tracker:    tracker,
		Supervisor: supervisor.New(cfg.SupervisorURL, cfg.SupervisorUser, cfg.SupervisorPass),
		Settings:   store,
		Map:        worldMap,
		Icons:      icons.New(cfg.IconsDir),
		Terrain:    terr,
		Tiles:      tiles,
		Bridge:     br,
		Access:     access.New(cfg.ConfigDir),
		Logger:     logger,
		Version:    version,
	})
	go s.RunSettingsWatcher(ctx)
	if br != nil {
		// Live positions only while someone watches and someone plays.
		go br.RunPositions(ctx, 2*time.Second, func() bool {
			snap := tracker.Snapshot()
			return hub.Subscribers() > 0 && (snap.PlayersReported > 0 || len(snap.Players) > 0) && !s.Restarting()
		})
	}
	go func() {
		if err := s.ListenAndServeMetrics(ctx, cfg.MetricsAddr); err != nil {
			fail(fmt.Errorf("metrics listen %s: %w", cfg.MetricsAddr, err))
		}
	}()
	logger.Info("starting skald-agent", "version", version, "addr", cfg.ListenAddr, "metrics", cfg.MetricsAddr, "syslog", cfg.SyslogAddr)
	if err := s.ListenAndServe(ctx, cfg.ListenAddr); err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

func parseLevel(s string) slog.Level {
	switch s {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
