package server

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/krystianslowik/skald/agent/internal/bridge"
)

// The agent owns the admin command allow-list: bridge.Commands plus
// "ack-build", which bridgeCommand handles itself. The dashboard
// (server/src/types.ts ADMIN_COMMANDS, which the web imports) and the plugin's
// router (bridge/plugin/Commands.cs) keep their own copies. The dashboard
// list must equal the agent's; the plugin must route every path the agent
// calls (it may serve more, such as tombstones and terrain). Adding a command
// means adding it to ADMIN_COMMANDS and a route to the plugin too.

func repoFile(t *testing.T, rel string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", filepath.FromSlash(rel)))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// tsList reads the names of `export const <name> = [...] as const` in server/src/types.ts.
func tsList(t *testing.T, name string) []string {
	t.Helper()
	src := repoFile(t, "server/src/types.ts")
	_, rest, ok := strings.Cut(src, "export const "+name+" = [")
	if !ok {
		t.Fatalf("%s not found in server/src/types.ts", name)
	}
	list, _, ok := strings.Cut(rest, "] as const")
	if !ok {
		t.Fatalf("%s is not closed by `] as const`", name)
	}
	var got []string
	for _, line := range strings.Split(list, "\n") {
		line, _, _ = strings.Cut(line, "//")
		for _, m := range regexp.MustCompile(`["']([^"']+)["']`).FindAllStringSubmatch(line, -1) {
			got = append(got, m[1])
		}
	}
	slices.Sort(got)
	for i := 1; i < len(got); i++ {
		if got[i] == got[i-1] {
			t.Errorf("%s lists %q twice", name, got[i])
		}
	}
	return slices.Compact(got)
}

func TestAdminCommandsMatchDashboard(t *testing.T) {
	got := tsList(t, "ADMIN_COMMANDS")
	want := append(bridge.CommandNames(), "ack-build")
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Errorf("server/src/types.ts ADMIN_COMMANDS = %v\nagent allow-list = %v", got, want)
	}
}

// The reads the dashboard may ask for: bridge.Reads plus "bans", which
// bridgeRead serves from the client's own ban list call.
func TestAdminReadsMatchDashboard(t *testing.T) {
	got := tsList(t, "ADMIN_READS")
	want := []string{"bans"}
	for name := range bridge.Reads {
		want = append(want, name)
	}
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Errorf("server/src/types.ts ADMIN_READS = %v\nagent reads = %v", got, want)
	}
}

func TestAdminCommandsMatchPluginRoutes(t *testing.T) {
	src := repoFile(t, "bridge/plugin/Commands.cs")
	routes := map[string]bool{}
	for _, m := range regexp.MustCompile(`R\("(GET|POST)", "([^"]+)"`).FindAllStringSubmatch(src, -1) {
		routes[m[1]+" "+m[2]] = true
	}
	for name, c := range bridge.Commands {
		if !routes["POST "+c.Path] {
			t.Errorf("command %q: the plugin has no route POST %s", name, c.Path)
		}
	}
	for name, path := range bridge.Reads {
		if !routes["GET "+path] {
			t.Errorf("read %q: the plugin has no route GET %s", name, path)
		}
	}
	// The fixed reads the bridge client calls directly.
	for _, path := range []string{"/v1/health", "/v1/players", "/v1/bans"} {
		if !routes["GET "+path] {
			t.Errorf("the plugin has no route GET %s", path)
		}
	}
}
