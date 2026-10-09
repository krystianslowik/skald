package supervisor_test

import (
	"context"
	"strings"
	"testing"

	"github.com/krystianslowik/skald/agent/internal/supervisor"
	"github.com/krystianslowik/skald/agent/internal/supervisor/supervisortest"
)

func TestGetAllProcessInfo(t *testing.T) {
	f := supervisortest.New()
	defer f.Close()
	c := supervisor.New(f.URL(), supervisortest.User, supervisortest.Pass)

	ps, err := c.GetAllProcessInfo(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(ps) != 3 {
		t.Fatalf("got %d processes", len(ps))
	}
	if ps[0].Name != "valheim-server" || ps[0].StateName != "RUNNING" || ps[0].Start != 1791584875 {
		t.Errorf("ps[0] = %+v", ps[0])
	}
	if ps[1].Group != "valheim-updater" {
		t.Errorf("untyped value: group = %q", ps[1].Group)
	}
}

func TestCallsAndParams(t *testing.T) {
	f := supervisortest.New()
	defer f.Close()
	c := supervisor.New(f.URL(), supervisortest.User, supervisortest.Pass)
	ctx := context.Background()

	if err := c.SignalProcess(ctx, "valheim-backup", "HUP"); err != nil {
		t.Fatal(err)
	}
	if err := c.StopProcess(ctx, "valheim-server", true); err != nil {
		t.Fatal(err)
	}
	calls := f.Calls()
	if calls[0].Method != "supervisor.signalProcess" ||
		calls[0].Params[0] != "<string>valheim-backup</string>" || calls[0].Params[1] != "<string>HUP</string>" {
		t.Errorf("signal call = %+v", calls[0])
	}
	if calls[1].Method != "supervisor.stopProcess" || calls[1].Params[1] != "<boolean>1</boolean>" {
		t.Errorf("stop call = %+v", calls[1])
	}
}

func TestFault(t *testing.T) {
	f := supervisortest.New()
	defer f.Close()
	f.Fault("supervisor.stopProcess", supervisor.FaultNotRunning, "NOT_RUNNING: valheim-server")
	c := supervisor.New(f.URL(), supervisortest.User, supervisortest.Pass)

	err := c.StopProcess(context.Background(), "valheim-server", true)
	if !supervisor.IsFault(err, supervisor.FaultNotRunning) {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(err.Error(), "NOT_RUNNING") {
		t.Errorf("err text = %v", err)
	}
}

func TestBadAuth(t *testing.T) {
	f := supervisortest.New()
	defer f.Close()
	c := supervisor.New(f.URL(), "admin", "wrong")
	if _, err := c.GetAllProcessInfo(context.Background()); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("err = %v", err)
	}
}
