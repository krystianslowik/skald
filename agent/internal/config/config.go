package config

import (
	"errors"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	AgentToken     string
	SyslogAddr     string
	ListenAddr     string
	MetricsAddr    string
	LogLevel       string
	ConfigDir      string
	StatusFile     string
	SupervisorURL  string
	SupervisorUser string
	SupervisorPass string
	WorldName      string
	ServerName     string
	ServerArgs     string
	ServerPublic   string
	// Crossplay is the game's CROSSPLAY (the community image adds
	// -crossplay itself, so it is not in SERVER_ARGS).
	Crossplay bool
	// SettingsDir is where the settings feature writes server.env for the
	// game's pre-run hook; the feature is off when it is missing or read-only.
	SettingsDir string
	// PasswordFile is the game's server password secret, read once to seed
	// the settings before the first save.
	PasswordFile string
	// MapShowNames exports grave and bed owner names, portal tags and pin
	// names in GET /map. Platform ids are never exported either way.
	MapShowNames bool
	// IconsDir is where skald-icons writes map.json and the icon sheet; empty
	// turns the item icon routes off.
	IconsDir string
	// TerrainDir is where the skald-terrain Job writes the world generator's
	// grids; empty turns the terrain image off (its request is still in /state).
	TerrainDir string
	// TerrainCacheDir keeps terrain tiles across restarts; empty keeps them
	// in memory (default: terrain-tiles under SettingsDir).
	TerrainCacheDir string
	// TerrainCacheMB bounds the terrain tile cache; 0 is the default (1024).
	TerrainCacheMB int
	// TerrainBake fills the whole tile pyramid in the background (default on).
	TerrainBake bool
	// BridgeURL is the Skald bridge plugin inside the game process; the
	// agent shares the pod's network namespace, so loopback reaches it.
	BridgeURL string
	// BridgeToken is the game container's SKALD_BRIDGE_TOKEN; empty turns
	// the /bridge routes off.
	BridgeToken string
	// BridgeTestedBuilds are game builds admin commands may run on without
	// an acknowledgement from the panel; "*" allows any.
	BridgeTestedBuilds []string
	// GameMemoryLimit is the game container's memory limit in bytes; 0 when
	// unknown. The agent is a sidecar with its own cgroup, so its
	// /sys/fs/cgroup/memory.max is the agent's limit, not the game's: the
	// value comes in through GAME_MEMORY_LIMIT (the downward API in
	// Kubernetes).
	GameMemoryLimit int64
}

func Load() (Config, error) {
	c := Config{
		AgentToken:         os.Getenv("AGENT_TOKEN"),
		SyslogAddr:         getenv("SYSLOG_ADDR", "127.0.0.1:5140"),
		ListenAddr:         getenv("LISTEN_ADDR", ":8080"),
		MetricsAddr:        getenv("METRICS_ADDR", ":9464"),
		LogLevel:           getenv("LOG_LEVEL", "info"),
		ConfigDir:          getenv("CONFIG_DIR", "/config"),
		StatusFile:         getenv("STATUS_FILE", "/var/run/valheim/valheim-server.status"),
		SupervisorURL:      getenv("SUPERVISOR_URL", "http://127.0.0.1:9001/RPC2"),
		SupervisorUser:     os.Getenv("SUPERVISOR_USER"),
		SupervisorPass:     os.Getenv("SUPERVISOR_PASS"),
		WorldName:          os.Getenv("WORLD_NAME"),
		ServerName:         os.Getenv("SERVER_NAME"),
		ServerArgs:         os.Getenv("SERVER_ARGS"),
		ServerPublic:       os.Getenv("SERVER_PUBLIC"),
		Crossplay:          parseBool(os.Getenv("CROSSPLAY"), false),
		SettingsDir:        getenv("SETTINGS_DIR", "/settings"),
		PasswordFile:       os.Getenv("PASSWORD_FILE"),
		MapShowNames:       parseBool(os.Getenv("MAP_SHOW_NAMES"), true),
		IconsDir:           os.Getenv("ICONS_DIR"),
		TerrainDir:         os.Getenv("TERRAIN_DIR"),
		BridgeURL:          getenv("BRIDGE_URL", "http://127.0.0.1:9010"),
		BridgeToken:        os.Getenv("BRIDGE_TOKEN"),
		BridgeTestedBuilds: splitList(os.Getenv("BRIDGE_TESTED_BUILDS")),
	}
	c.TerrainCacheDir = os.Getenv("TERRAIN_CACHE_DIR")
	if c.TerrainCacheDir == "" && c.SettingsDir != "" {
		c.TerrainCacheDir = filepath.Join(c.SettingsDir, "terrain-tiles")
	}
	if v, err := strconv.Atoi(os.Getenv("TERRAIN_CACHE_MB")); err == nil && v > 0 {
		c.TerrainCacheMB = v
	}
	c.TerrainBake = parseBool(os.Getenv("TERRAIN_BAKE"), true)
	c.GameMemoryLimit = parseBytes(os.Getenv("GAME_MEMORY_LIMIT"))
	if c.AgentToken == "" {
		return c, errors.New("AGENT_TOKEN is required")
	}
	return c, nil
}

// parseBool reads true/false/1/0/yes/no; anything else (or empty) is def.
func parseBool(v string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return def
}

// byteUnits are the Kubernetes quantity suffixes a memory limit may carry.
var byteUnits = []struct {
	suffix string
	mult   int64
}{
	{"Ki", 1 << 10}, {"Mi", 1 << 20}, {"Gi", 1 << 30}, {"Ti", 1 << 40},
	{"k", 1e3}, {"M", 1e6}, {"G", 1e9}, {"T", 1e12},
}

// parseBytes reads a byte count as the downward API writes it (plain bytes)
// or with a Kubernetes suffix ("6Gi", "512Mi", "6G"). Empty, "max", zero,
// negative or unreadable values are 0: no known limit.
func parseBytes(v string) int64 {
	v = strings.TrimSpace(v)
	mult := int64(1)
	for _, u := range byteUnits {
		if n, ok := strings.CutSuffix(v, u.suffix); ok {
			v, mult = n, u.mult
			break
		}
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 || n > math.MaxInt64/mult {
		return 0
	}
	return n * mult
}

// splitList reads a comma- or space-separated list; empty entries are dropped.
func splitList(v string) []string {
	var out []string
	for _, f := range strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == ' ' }) {
		out = append(out, f)
	}
	return out
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
