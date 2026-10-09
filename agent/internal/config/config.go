package config

import (
	"errors"
	"os"
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
}

func Load() (Config, error) {
	c := Config{
		AgentToken:     os.Getenv("AGENT_TOKEN"),
		SyslogAddr:     getenv("SYSLOG_ADDR", "127.0.0.1:5140"),
		ListenAddr:     getenv("LISTEN_ADDR", ":8080"),
		MetricsAddr:    getenv("METRICS_ADDR", ":9464"),
		LogLevel:       getenv("LOG_LEVEL", "info"),
		ConfigDir:      getenv("CONFIG_DIR", "/config"),
		StatusFile:     getenv("STATUS_FILE", "/var/run/valheim/valheim-server.status"),
		SupervisorURL:  getenv("SUPERVISOR_URL", "http://127.0.0.1:9001/RPC2"),
		SupervisorUser: os.Getenv("SUPERVISOR_USER"),
		SupervisorPass: os.Getenv("SUPERVISOR_PASS"),
		WorldName:      os.Getenv("WORLD_NAME"),
		ServerName:     os.Getenv("SERVER_NAME"),
		ServerArgs:     os.Getenv("SERVER_ARGS"),
	}
	if c.AgentToken == "" {
		return c, errors.New("AGENT_TOKEN is required")
	}
	return c, nil
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
