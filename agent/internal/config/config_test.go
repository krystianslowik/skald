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
}

func TestLoadRequiresToken(t *testing.T) {
	t.Setenv("AGENT_TOKEN", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected error without AGENT_TOKEN")
	}
}
