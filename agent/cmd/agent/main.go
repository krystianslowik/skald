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

	"github.com/krystianslowik/skald/agent/internal/config"
	"github.com/krystianslowik/skald/agent/internal/events"
	"github.com/krystianslowik/skald/agent/internal/server"
	"github.com/krystianslowik/skald/agent/internal/settings"
	"github.com/krystianslowik/skald/agent/internal/state"
	"github.com/krystianslowik/skald/agent/internal/supervisor"
	"github.com/krystianslowik/skald/agent/internal/syslog"
	"github.com/krystianslowik/skald/agent/internal/world"
	"github.com/krystianslowik/skald/agent/internal/worldmap"
)

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
	handleLine := tracker.HandleLine
	if store != nil {
		handleLine = func(line string) {
			tracker.HandleLine(line)
			store.NoteLine(line)
		}
	}

	go tracker.WatchStatusFile(ctx, cfg.StatusFile, 2*time.Second)
	go func() {
		// A bind failure means the game's logs are lost for the pod's
		// lifetime; exit so the container runtime restarts the sidecar.
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
		Logger:     logger,
	})
	go s.RunSettingsWatcher(ctx)
	go func() {
		if err := s.ListenAndServeMetrics(cfg.MetricsAddr); err != nil {
			fail(fmt.Errorf("metrics listen %s: %w", cfg.MetricsAddr, err))
		}
	}()
	logger.Info("starting skald-agent", "addr", cfg.ListenAddr, "metrics", cfg.MetricsAddr, "syslog", cfg.SyslogAddr)
	if err := s.ListenAndServe(cfg.ListenAddr); err != nil {
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
