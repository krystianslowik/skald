package config

import "testing"

func TestLoadDefaults(t *testing.T) {
	t.Setenv("AGENT_TOKEN", "t")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.ListenAddr != ":8080" || c.SyslogAddr != "127.0.0.1:5140" || c.ConfigDir != "/config" {
		t.Errorf("unexpected defaults: %+v", c)
	}
	if c.MetricsAddr != ":9464" {
		t.Errorf("MetricsAddr = %q", c.MetricsAddr)
	}
	if c.SupervisorURL != "http://127.0.0.1:9001/RPC2" {
		t.Errorf("SupervisorURL = %q", c.SupervisorURL)
	}
	if !c.MapShowNames {
		t.Error("MapShowNames defaults to true")
	}
	if c.SettingsDir != "/settings" || c.PasswordFile != "" {
		t.Errorf("settings defaults: dir %q, password file %q", c.SettingsDir, c.PasswordFile)
	}
	if c.IconsDir != "" || c.TerrainDir != "" {
		t.Errorf("icons and terrain default to off, got %q, %q", c.IconsDir, c.TerrainDir)
	}
}

func TestLoadRequiresToken(t *testing.T) {
	t.Setenv("AGENT_TOKEN", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected error without AGENT_TOKEN")
	}
}

func TestLoadMapShowNames(t *testing.T) {
	t.Setenv("AGENT_TOKEN", "t")
	for v, want := range map[string]bool{"false": false, "0": false, "no": false, "true": true, "1": true, "nonsense": true} {
		t.Setenv("MAP_SHOW_NAMES", v)
		c, err := Load()
		if err != nil || c.MapShowNames != want {
			t.Errorf("MAP_SHOW_NAMES=%q -> %v (%v)", v, c.MapShowNames, err)
		}
	}
}

func TestLoadBridge(t *testing.T) {
	t.Setenv("AGENT_TOKEN", "t")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.BridgeURL != "http://127.0.0.1:9010" || c.BridgeToken != "" || c.BridgeTestedBuilds != nil {
		t.Errorf("bridge defaults: %+v", c)
	}
	t.Setenv("BRIDGE_TOKEN", "secret")
	t.Setenv("BRIDGE_TESTED_BUILDS", "l-1.0.17, l-1.0.18,,")
	if c, _ = Load(); c.BridgeToken != "secret" || len(c.BridgeTestedBuilds) != 2 || c.BridgeTestedBuilds[1] != "l-1.0.18" {
		t.Errorf("bridge from env: %+v", c)
	}
}
