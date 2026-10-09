package logparse

import (
	"bufio"
	"os"
	"reflect"
	"testing"
)

func TestStripHeader(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want Line
	}{
		{
			name: "container stdout form",
			raw:  `Oct  9 22:28:39 supervisord: valheim-server 10/09/2026 22:28:39: Session "My Valheim" registered with join code 482915`,
			want: Line{Program: "valheim-server", Text: `10/09/2026 22:28:39: Session "My Valheim" registered with join code 482915`, Msg: `Session "My Valheim" registered with join code 482915`},
		},
		{
			name: "udp with PRI and hostname",
			raw:  `<14>Oct 10 01:02:03 valheim-0 supervisord: valheim-backup INFO - Backing up`,
			want: Line{Program: "valheim-backup", Text: "INFO - Backing up", Msg: "INFO - Backing up"},
		},
		{
			name: "udp with PRI no timestamp",
			raw:  `<30>supervisord: valheim-updater valheim-server: started`,
			want: Line{Program: "valheim-updater", Text: "valheim-server: started", Msg: "valheim-server: started"},
		},
		{
			name: "tag with pid",
			raw:  `<14>Oct  9 22:28:39 supervisord[7]: valheim-server hello`,
			want: Line{Program: "valheim-server", Text: "hello", Msg: "hello"},
		},
		{
			name: "leading spaces kept",
			raw:  `Oct  9 22:27:56 supervisord: valheim-server     "memorysetup-bucket-allocator-granularity=16"`,
			want: Line{Program: "valheim-server", Text: `    "memorysetup-bucket-allocator-granularity=16"`, Msg: `    "memorysetup-bucket-allocator-granularity=16"`},
		},
		{
			name: "program with empty message",
			raw:  `Oct  9 22:27:56 supervisord: valheim-server`,
			want: Line{Program: "valheim-server"},
		},
		{
			name: "untagged supervisord output",
			raw:  `2026-10-09 22:27:55,986 INFO spawned: 'valheim-server' with pid 226`,
			want: Line{Text: `2026-10-09 22:27:55,986 INFO spawned: 'valheim-server' with pid 226`, Msg: `2026-10-09 22:27:55,986 INFO spawned: 'valheim-server' with pid 226`},
		},
		{
			name: "untagged with PRI and timestamp",
			raw:  `<13>Oct  9 22:27:55 something else`,
			want: Line{Text: "something else", Msg: "something else"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := StripHeader(c.raw); got != c.want {
				t.Errorf("got %+v\nwant %+v", got, c.want)
			}
		})
	}
}

func TestMatchMsg(t *testing.T) {
	cases := []struct {
		name string
		msg  string
		want []Match
	}{
		{"version", "Valheim version: l-1.0.17 (network version 40)",
			[]Match{{Kind: KindVersion, Version: "l-1.0.17", NetworkVersion: 40}}},
		{"console version is not the version line", "Console: Valheim l-1.0.17 (network version 40)", nil},
		{"registered", `Session "My Valheim" registered with join code 482915`,
			[]Match{{Kind: KindJoinCode, Code: "482915"}, {Kind: KindPlayfab, State: PlayfabOK}}},
		{"active", `Session "My Valheim" with join code 482915 and IP 203.0.113.10:2456 is active with 3 player(s)`,
			[]Match{{Kind: KindJoinCode, Code: "482915"}, {Kind: KindPlayerCount, Count: 3}}},
		{"new session with empty code", `New session server "My Valheim" that has join code , now 0 player(s)`, nil},
		{"playfab joined", `Joined PlayFab Party network with ID "REDACTED"`,
			[]Match{{Kind: KindPlayfab, State: PlayfabOK}}},
		{"playfab connecting", `Server 'My Valheim' begin PlayFab create and join network for server `,
			[]Match{{Kind: KindPlayfab, State: PlayfabConnecting}}},
		{"playfab reconnect", `PlayFab reconnect attempt 1`, []Match{{Kind: KindPlayfab, State: PlayfabError}}},
		{"connectivity error", `Network error: INTERNET_CONNECTIVITY_ERROR`, []Match{{Kind: KindPlayfab, State: PlayfabError}}},
		{"service unavailable", `PlayFab request failed: ServiceUnavailable`, []Match{{Kind: KindPlayfab, State: PlayfabError}}},
		// Synthetic, unconfirmed for 1.0 crossplay.
		{"zdoid join", `Got character ZDOID from Ragnar : -123456:1`,
			[]Match{{Kind: KindCharacter, Name: "Ragnar"}}},
		{"zdoid name with spaces", `Got character ZDOID from Ole Bjorn : 98765:4`,
			[]Match{{Kind: KindCharacter, Name: "Ole Bjorn"}}},
		{"zdoid death", `Got character ZDOID from Ragnar : 0:0`,
			[]Match{{Kind: KindCharacter, Name: "Ragnar", Death: true}}},
		{"world saved with ms", `World saved ( 123.456ms )`, []Match{{Kind: KindWorldSaved, Ms: 123.456}}},
		{"world saved tight", `World saved (42ms)`, []Match{{Kind: KindWorldSaved, Ms: 42}}},
		{"world saved alone", `World saved`, []Match{{Kind: KindWorldSaved}}},
		{"raid", `Random event set:army_eikthyr`, []Match{{Kind: KindRaid, Name: "army_eikthyr"}}},
		{"raid with space", `Random event set: foresttrolls`, []Match{{Kind: KindRaid, Name: "foresttrolls"}}},
		{"net stats", `Connections 2 ZDOS:130422  sent:41 recv:388`,
			[]Match{{Kind: KindNetStats, Connections: 2, ZDOs: 130422, Sent: 41, Recv: 388}}},
		{"net stats single space", `Connections 0 ZDOS:9 sent:0 recv:0`,
			[]Match{{Kind: KindNetStats, ZDOs: 9}}},
		{"noise", `Update PlayFab entity token`, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := MatchMsg(c.msg); !reflect.DeepEqual(got, c.want) {
				t.Errorf("got %+v\nwant %+v", got, c.want)
			}
		})
	}
}

// TestStartupLog runs the real 1.0.17 startup log through Parse and counts
// what the table extracts.
func TestStartupLog(t *testing.T) {
	f, err := os.Open("../../testdata/startup-1.0.17.log")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	var versions, codes, counts []Match
	var lastPlayfab string
	programs := map[string]int{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		l, ms := Parse(sc.Text())
		programs[l.Program]++
		for _, m := range ms {
			switch m.Kind {
			case KindVersion:
				versions = append(versions, m)
			case KindJoinCode:
				codes = append(codes, m)
			case KindPlayerCount:
				counts = append(counts, m)
			case KindPlayfab:
				lastPlayfab = m.State
			case KindCharacter, KindWorldSaved, KindRaid, KindNetStats:
				t.Errorf("unexpected %s match in startup log", m.Kind)
			}
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	if len(versions) != 1 || versions[0].Version != "l-1.0.17" || versions[0].NetworkVersion != 40 {
		t.Errorf("versions = %+v", versions)
	}
	if len(codes) != 2 || codes[0].Code != "482915" || codes[1].Code != "482915" {
		t.Errorf("join codes = %+v", codes)
	}
	if len(counts) != 1 || counts[0].Count != 0 {
		t.Errorf("player counts = %+v", counts)
	}
	if lastPlayfab != PlayfabOK {
		t.Errorf("last playfab = %q", lastPlayfab)
	}
	if programs["valheim-server"] == 0 || programs["valheim-updater"] == 0 || programs[""] == 0 {
		t.Errorf("programs = %v", programs)
	}
}
