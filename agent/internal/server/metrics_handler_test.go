package server

import (
	"bufio"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/krystianslowik/skald/agent/internal/events"
	"github.com/krystianslowik/skald/agent/internal/state"
	"github.com/krystianslowik/skald/agent/internal/supervisor"
	"github.com/krystianslowik/skald/agent/internal/supervisor/supervisortest"
)

var (
	metricName = `[a-zA-Z_:][a-zA-Z0-9_:]*`
	sampleRe   = regexp.MustCompile(`^(` + metricName + `)(\{[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\[\\"n])*"(?:,[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\[\\"n])*")*\})? (-?[0-9]+(?:\.[0-9]+)?|NaN|[+-]Inf)$`)
	helpRe     = regexp.MustCompile(`^# HELP (` + metricName + `) (?:[^\\\n]|\\[\\n])*$`)
	typeRe     = regexp.MustCompile(`^# TYPE (` + metricName + `) (counter|gauge|untyped)$`)
)

// checkExposition validates the text format strictly enough to catch our
// own mistakes: every line parses, each family has exactly one HELP and one
// TYPE before its samples, and families are not interleaved. It returns the
// sample lines.
func checkExposition(t *testing.T, body string) []string {
	t.Helper()
	if !strings.HasSuffix(body, "\n") {
		t.Fatal("body does not end with a newline")
	}
	seen := map[string]bool{}
	current := ""
	var samples []string
	sc := bufio.NewScanner(strings.NewReader(body))
	for sc.Scan() {
		line := sc.Text()
		if m := helpRe.FindStringSubmatch(line); m != nil {
			if seen[m[1]] {
				t.Errorf("family %s repeated", m[1])
			}
			seen[m[1]] = true
			current = m[1]
			continue
		}
		if m := typeRe.FindStringSubmatch(line); m != nil {
			if m[1] != current {
				t.Errorf("TYPE %s not right after its HELP", m[1])
			}
			continue
		}
		m := sampleRe.FindStringSubmatch(line)
		if m == nil {
			t.Errorf("invalid line: %q", line)
			continue
		}
		if m[1] != current {
			t.Errorf("sample %s outside its family (current %s)", m[1], current)
		}
		samples = append(samples, line)
	}
	return samples
}

func scrape(t *testing.T, s *Server) (string, []string) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.MetricsHandler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	if rec.Code != 200 {
		t.Fatalf("metrics = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/plain; version=0.0.4; charset=utf-8" {
		t.Errorf("content-type = %q", ct)
	}
	body := rec.Body.String()
	return body, checkExposition(t, body)
}

func TestMetrics(t *testing.T) {
	h := newHarness(t)
	dst := filepath.Join(h.dir, "worlds_local", "Midgard")
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"_main.1.fwl2", "_main.1.db2", "_main.1.ok"} {
		b, err := os.ReadFile(filepath.Join("../../testdata/world-1.0", f))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dst, f), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h.tr.SetStatus("running")
	for _, l := range []string{
		`supervisord: valheim-server 10/09/2026 22:28:11: Valheim version: l-1.0.17 (network version 40)`,
		`supervisord: valheim-server 10/09/2026 22:28:39: Session "My Valheim" registered with join code 482915`,
		`supervisord: valheim-server 10/09/2026 22:29:00: Got character ZDOID from Ragnar : -123456:1`,
		`supervisord: valheim-server 10/09/2026 22:30:00: Got character ZDOID from Ragnar : 0:0`,
		`supervisord: valheim-server 10/09/2026 22:31:00: World saved ( 12.5ms )`,
		`supervisord: valheim-server 10/09/2026 22:31:30: Session "My Valheim" with join code 482915 and IP 1.2.3.4:2456 is active with 1 player(s)`,
		`supervisord: valheim-server 10/09/2026 23:00:00: Connections 1 ZDOS:4242  sent:3 recv:40`,
	} {
		h.tr.HandleLine(l)
	}
	h.hub.Publish("action", map[string]any{"name": "backup", "ok": true})

	body, samples := scrape(t, h.s)
	want := []string{
		`valheim_server_up 1`,
		`valheim_server_status{status="running"} 1`,
		`valheim_server_started_timestamp_seconds 1791584875`,
		`valheim_supervisor_up 1`,
		`valheim_process_running{process="valheim-server"} 1`,
		`valheim_players_online 1`,
		`valheim_playfab_state{state="ok"} 1`,
		`valheim_info{version="l-1.0.17",network_version="40",world="Midgard",server_name="My Valheim"} 1`,
		`valheim_world_size_bytes `,
		`valheim_world_net_time_seconds 2040`,
		`valheim_world_day 1`,
		`valheim_world_last_save_timestamp_seconds `,
		`valheim_backups_count 1`,
		`valheim_backups_bytes 512`,
		`valheim_last_backup_timestamp_seconds `,
		`valheim_world_zdos 4242`,
		`valheim_connections 1`,
		`valheim_events_total{type="player_join"} 1`,
		`valheim_events_total{type="player_leave"} 0`,
		`valheim_events_total{type="death"} 1`,
		`valheim_events_total{type="world_saved"} 1`,
		`valheim_events_total{type="raid"} 0`,
		`valheim_events_total{type="join_code"} 1`,
		`valheim_events_total{type="action"} 1`,
		`valheim_join_code_changed_timestamp_seconds `,
		`valheim_agent_last_log_timestamp_seconds `,
	}
	for _, w := range want {
		found := false
		for _, s := range samples {
			if strings.HasPrefix(s, w) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("missing sample %q in:\n%s", w, body)
		}
	}
	if !strings.Contains(body, "# TYPE valheim_events_total counter\n") {
		t.Error("valheim_events_total is not a counter")
	}
	if n := strings.Count(body, "valheim_server_status{"); n != 1 {
		t.Errorf("server_status samples = %d, want 1", n)
	}
}

func TestMetricsPlayersOnlineAfterLaggingLeave(t *testing.T) {
	h := newHarness(t)
	h.tr.SetStatus("running")
	for _, l := range lastLeaveLines {
		h.tr.HandleLine(l)
	}
	if body, _ := scrape(t, h.s); !strings.Contains(body, "\nvalheim_players_online 0\n") {
		t.Errorf("players_online not 0:\n%s", body)
	}
}

func TestMetricsColdAndSupervisorDown(t *testing.T) {
	h := newHarness(t)
	h.fake.Close()
	// Remove the flat .db so no save timestamp can be derived.
	if err := os.Remove(filepath.Join(h.dir, "worlds_local", "Midgard.db")); err != nil {
		t.Fatal(err)
	}
	body, _ := scrape(t, h.s)
	for _, w := range []string{
		"valheim_server_up 0\n",
		`valheim_server_status{status="unknown"} 1` + "\n",
		"valheim_supervisor_up 0\n",
		`valheim_playfab_state{state="unknown"} 1` + "\n",
		`valheim_info{version="",network_version="0",world="Midgard",server_name="My Valheim"} 1` + "\n",
		`valheim_events_total{type="raid"} 0` + "\n",
	} {
		if !strings.Contains(body, w) {
			t.Errorf("missing %q in:\n%s", w, body)
		}
	}
	for _, absent := range []string{
		"valheim_server_started_timestamp_seconds",
		"valheim_process_running",
		"valheim_join_code_changed_timestamp_seconds",
		"valheim_world_net_time_seconds",
		"valheim_world_day",
		"valheim_world_last_save_timestamp_seconds",
		"valheim_world_zdos",
		"valheim_connections",
		"valheim_agent_last_log_timestamp_seconds",
	} {
		if strings.Contains(body, absent) {
			t.Errorf("%s should be omitted:\n%s", absent, body)
		}
	}
}

func TestMetricsUsesCachedSupervisorState(t *testing.T) {
	h := newHarness(t)
	h.do(t, "GET", "/state", token)
	before := len(h.fake.Calls())
	scrape(t, h.s)
	scrape(t, h.s)
	if after := len(h.fake.Calls()); after != before {
		t.Errorf("scrapes made %d supervisor calls, want 0 (cache fresh)", after-before)
	}
}

func TestMetricsNoToken(t *testing.T) {
	h := newHarness(t)
	srv := httptest.NewServer(h.s.MetricsHandler())
	defer srv.Close()
	resp, err := srv.Client().Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("metrics without token = %d", resp.StatusCode)
	}
	// The main listener does not serve /metrics.
	if r := h.do(t, "GET", "/metrics", token); r.StatusCode != 404 {
		t.Errorf("main /metrics = %d, want 404", r.StatusCode)
	}
}

func TestMetricsLabelEscaping(t *testing.T) {
	fake := supervisortest.New()
	defer fake.Close()
	hub := events.New(10, 10)
	s := New(Options{
		ConfigDir:  t.TempDir(),
		WorldName:  `W"o\rld`,
		ServerName: "Northern \"Valheim\" \\ line1\nline2",
		Hub:        hub,
		Tracker:    state.New(hub),
		Supervisor: supervisor.New(fake.URL(), supervisortest.User, supervisortest.Pass),
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	body, _ := scrape(t, s)
	want := `valheim_info{version="",network_version="0",world="W\"o\\rld",server_name="Northern \"Valheim\" \\ line1\nline2"} 1`
	if !strings.Contains(body, want+"\n") {
		t.Errorf("missing %s in:\n%s", want, body)
	}
}

func TestPromWriterEscapingAndFloats(t *testing.T) {
	var p promWriter
	p.family("x_total", "counter", "a \\ b\nc")
	p.sample("x_total", 1.5, "l", "q\"\\\n")
	p.sample("x_total", 1791584875.123)
	got := p.b.String()
	want := "# HELP x_total a \\\\ b\\nc\n# TYPE x_total counter\nx_total{l=\"q\\\"\\\\\\n\"} 1.5\nx_total 1791584875.123\n"
	if got != want {
		t.Errorf("got\n%q\nwant\n%q", got, want)
	}
	checkExposition(t, got)
	for v, s := range map[float64]string{0: "0", 1e21: "1000000000000000000000", -2: "-2"} {
		if f := formatFloat(v); f != s {
			t.Errorf("formatFloat(%v) = %q, want %q", v, f, s)
		}
	}
}
