package logparse

import (
	"bufio"
	"os"
	"reflect"
	"regexp"
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
		{"new session with empty code", `New session server "My Valheim" that has join code , now 0 player(s)`,
			[]Match{{Kind: KindPlayerCount}}},
		{"player joined", `Player joined server "My Valheim" that has join code 482915, now 2 player(s)`,
			[]Match{{Kind: KindPlayerCount, Count: 2}}},
		{"connection lost", `Player connection lost server "My Valheim" that has join code 482915, now 1 player(s)`,
			[]Match{{Kind: KindPlayerCount, Count: 1, Lost: true}}},
		{"platform xbox", `PlayFab socket with remote ID playfab/0A1B2C3D4E5F6071 received local Platform ID Xbox_2533274900000001`,
			[]Match{{Kind: KindPlatform, Remote: "0A1B2C3D4E5F6071", Platform: PlatformXbox}}},
		{"platform steam", `PlayFab socket with remote ID playfab/1B2C3D4E5F607182 received local Platform ID Steam_76561190000000003`,
			[]Match{{Kind: KindPlatform, Remote: "1B2C3D4E5F607182", Platform: PlatformSteam}}},
		{"platform other", `PlayFab socket with remote ID playfab/1 received local Platform ID Stadia_1`,
			[]Match{{Kind: KindPlatform, Remote: "1", Platform: PlatformUnknown}}},
		{"platform without remote id", `received local Platform ID Xbox_2533274900000001`,
			[]Match{{Kind: KindPlatform, Platform: PlatformXbox}}},
		{"socket kept", `Keep socket for playfab/0A1B2C3D4E5F6071, try to reconnect before timeout`,
			[]Match{{Kind: KindSocketLost, Remote: "0A1B2C3D4E5F6071"}}},
		{"abandoned", `Destroying abandoned non persistent zdo 111111111:65 owner 111111111`,
			[]Match{{Kind: KindAbandoned, UID: "111111111"}}},
		{"abandoned negative", `Destroying abandoned non persistent zdo -22222222:50 owner -22222222`,
			[]Match{{Kind: KindAbandoned, UID: "-22222222"}}},
		{"world save done", `World save (5/5) done. Total time [488ms]`, []Match{{Kind: KindWorldSaved, Ms: 488}}},
		{"world save step", `World save (2/5) Chunks writing done [422ms]`, nil},
		{"world auto backup", `World auto backup saved [41ms]`, []Match{{Kind: KindWorldBackup, Ms: 41}}},
		{"net stats 1.0 spacing", ` Connections 2 ZDOS:374624  sent:46 recv:76`,
			[]Match{{Kind: KindNetStats, Connections: 2, ZDOs: 374624, Sent: 46, Recv: 76}}},
		{"playfab joined", `Joined PlayFab Party network with ID "REDACTED"`,
			[]Match{{Kind: KindPlayfab, State: PlayfabOK}}},
		{"playfab connecting", `Server 'My Valheim' begin PlayFab create and join network for server `,
			[]Match{{Kind: KindPlayfab, State: PlayfabConnecting}}},
		{"playfab reconnect", `PlayFab reconnect attempt 1`, []Match{{Kind: KindPlayfab, State: PlayfabError}}},
		{"connectivity error", `Network error: INTERNET_CONNECTIVITY_ERROR`, []Match{{Kind: KindPlayfab, State: PlayfabError}}},
		{"service unavailable", `PlayFab request failed: ServiceUnavailable`, []Match{{Kind: KindPlayfab, State: PlayfabError}}},
		{"zdoid join", `Got character ZDOID from Ragnar : -123456:1`,
			[]Match{{Kind: KindCharacter, Name: "Ragnar", UID: "-123456"}}},
		{"zdoid name with spaces", `Got character ZDOID from Ole Bjorn : 98765:4`,
			[]Match{{Kind: KindCharacter, Name: "Ole Bjorn", UID: "98765"}}},
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
			case KindCharacter, KindWorldSaved, KindWorldBackup, KindRaid, KindNetStats, KindPlatform, KindSocketLost, KindAbandoned:
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
	if len(counts) != 2 || counts[0].Count != 0 || counts[1].Count != 0 {
		t.Errorf("player counts = %+v", counts)
	}
	if lastPlayfab != PlayfabOK {
		t.Errorf("last playfab = %q", lastPlayfab)
	}
	if programs["valheim-server"] == 0 || programs["valheim-updater"] == 0 || programs[""] == 0 {
		t.Errorf("programs = %v", programs)
	}
}

func TestRedact(t *testing.T) {
	cases := []struct{ in, want string }{
		{`PlayFab socket with remote ID playfab/0A1B2C3D4E5F6071 received local Platform ID Xbox_2533274900000001`,
			`PlayFab socket with remote ID playfab/*** received local Platform ID Xbox_***`},
		{`Got handshake from client playfab/0A1B2C3D4E5F6071`, `Got handshake from client playfab/***`},
		{`PlayFab listen socket child connected to remote player 0A1B2C3D4E5F6071`, `PlayFab listen socket child connected to remote player ***`},
		{`Muted PlayFab remote player 1B2C3D4E5F607182`, `Muted PlayFab remote player ***`},
		{`Keep socket for playfab/0A1B2C3D4E5F6071, try to reconnect before timeout`, `Keep socket for playfab/***, try to reconnect before timeout`},
		{`Player history entry with index 2:  bjornthebold (Steam_76561190000000003, AAAA000000000003)`,
			`Player history entry with index 2:  bjornthebold (Steam_***, ***)`},
		{`PlayFab socket with remote ID playfab/X received local Platform ID Nintendo_ABCDEF01`,
			`PlayFab socket with remote ID playfab/*** received local Platform ID Nintendo_***`},
		{`Player history entry with index 3:  someone (PSN_ab-cd.ef, 0123ABCD)`,
			`Player history entry with index 3:  someone (PSN_***, ***)`},
		{`Backup created in Midgard_backup_auto-20261010-114246 [16.184ms]`, `Backup created in Midgard_backup_auto-20261010-114246 [16.184ms]`},
		{`Using steam APPID:892970`, `Using steam APPID:892970`},
	}
	for _, c := range cases {
		if got := Redact(c.in); got != c.want {
			t.Errorf("Redact(%q)\n got %q\nwant %q", c.in, got, c.want)
		}
	}
}

// TestSessionLog runs a redacted 1.0.17 crossplay session (three players,
// one reconnect with another character, one death and respawn) through Parse.
func TestSessionLog(t *testing.T) {
	f, err := os.Open("../../testdata/session-1.0.17.log")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	kinds := map[string]int{}
	var chars, platforms []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		l, ms := Parse(sc.Text())
		if r := Redact(l.Text); regexp.MustCompile(`_\d{6,}|playfab/[0-9A-F]{6,}|Platform ID \w+_[^*]|\(\w+_[^*]`).MatchString(r) {
			t.Errorf("unredacted: %q", r)
		}
		for _, m := range ms {
			kinds[m.Kind]++
			switch m.Kind {
			case KindCharacter:
				chars = append(chars, m.Name+"@"+m.UID)
			case KindPlatform:
				platforms = append(platforms, m.Platform)
			}
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	if want := []string{"Ragnar@111111111", "Freya@-22222222", "Bjorn@333333333", "Freya@", "Freya@-22222222"}; !reflect.DeepEqual(chars, want) {
		t.Errorf("characters = %v, want %v", chars, want)
	}
	if want := []string{"xbox", "xbox", "steam"}; !reflect.DeepEqual(platforms, want) {
		t.Errorf("platforms = %v, want %v", platforms, want)
	}
	want := map[string]int{KindAbandoned: 37, KindNetStats: 4, KindWorldSaved: 1, KindWorldBackup: 1, KindVersion: 1}
	for k, v := range want {
		if kinds[k] != v {
			t.Errorf("%s = %d, want %d (all %v)", k, kinds[k], v, kinds)
		}
	}
}

func TestAdminAudit(t *testing.T) {
	args := `Oct 10 18:01:02 supervisord: valheim-server [Info   :Skald Bridge] [SkaldBridge] audit actor=admin-1a2b cmd=POST /v1/spawn args={"item":"Wood","amount":20,"player":"123456789"}`
	_, m := Parse(args)
	want := []Match{{Kind: KindAdmin, Actor: "admin-1a2b", Cmd: "POST /v1/spawn", Args: `{"item":"Wood","amount":20,"player":"123456789"}`}}
	if !reflect.DeepEqual(m, want) {
		t.Fatalf("args line: got %+v", m)
	}
	res := `Oct 10 18:01:02 supervisord: valheim-server [Info   :Skald Bridge] [SkaldBridge] audit actor=admin-1a2b cmd=POST /v1/spawn result=ok {"ok":true,"data":{"near":"Ragnar"}}`
	_, m = Parse(res)
	if len(m) != 1 || m[0].Result != "ok" || m[0].Detail != `{"ok":true,"data":{"near":"Ragnar"}}` || m[0].Args != "" {
		t.Fatalf("result line: got %+v", m)
	}
	_, m = Parse(`[Warning:Skald Bridge] [SkaldBridge] audit actor=x cmd=POST /v1/save result=timeout`)
	if len(m) != 1 || m[0].Result != "timeout" || m[0].Detail != "" {
		t.Fatalf("timeout line: got %+v", m)
	}
}

func TestRedactAudit(t *testing.T) {
	in := `[SkaldBridge] audit actor=a cmd=POST /v1/ban result=ok {"ok":true,"data":{"banned":"Xbox_2533274800000000","name":"Ragnar","banList":["Xbox_2533274800000000","Steam_76561190000000000"]}}`
	got := Redact(in)
	for _, leak := range []string{"2533274800000000", "76561190000000000"} {
		if regexp.MustCompile(leak).MatchString(got) {
			t.Fatalf("leaked %s: %s", leak, got)
		}
	}
	if !regexp.MustCompile(`"name":"Ragnar"`).MatchString(got) {
		t.Fatalf("name lost: %s", got)
	}
	got = Redact(`audit actor=a cmd=POST /v1/kick args={"player":"-4611686018427387904"}`)
	if got != `audit actor=a cmd=POST /v1/kick args={"player":"***"}` {
		t.Fatalf("uid kept: %s", got)
	}
}
