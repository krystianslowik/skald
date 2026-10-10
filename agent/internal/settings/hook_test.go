package settings

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const deployDir = "../../../deploy"

// hookLine is the canonical PRE_SERVER_RUN_HOOK, without its comment header.
func hookLine(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(deployDir, "settings", "pre-server-run-hook.sh"))
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range strings.Split(string(raw), "\n") {
		if l != "" && !strings.HasPrefix(l, "#") {
			return l
		}
	}
	t.Fatal("no hook line")
	return ""
}

// The bash harness evaluates the hook the way the image does and checks that
// nothing in server.env is executed. See deploy/settings/pre-server-run-hook.test.sh.
func TestHookScript(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not installed")
	}
	out, err := exec.Command(bash, filepath.Join(deployDir, "settings", "pre-server-run-hook.test.sh")).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}

// The examples must carry the hook verbatim (Compose with every $ doubled).
func TestHookInExamples(t *testing.T) {
	hook := hookLine(t)
	for file, want := range map[string]string{
		"compose/docker-compose.yaml": strings.ReplaceAll(hook, "$", "$$"),
		"kubernetes/valheim.yaml":     hook,
	} {
		raw, err := os.ReadFile(filepath.Join(deployDir, file))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(raw), want) {
			t.Errorf("%s does not contain the hook from pre-server-run-hook.sh", file)
		}
	}
	// The hook must confirm itself with the line the agent watches for.
	if !strings.Contains(hook, `info "`+HookLine+`"`) {
		t.Errorf("hook does not log %q", HookLine)
	}
}
