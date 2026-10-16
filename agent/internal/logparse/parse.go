// Package logparse turns raw syslog lines from the valheim container into a
// stripped log line plus zero or more typed matches. It is pure: no state, no
// dedupe. Deciding which matches become events is internal/state's job.
package logparse

import (
	"regexp"
	"strconv"
	"strings"
)

// Line is one syslog datagram with the transport header removed.
type Line struct {
	// Program is the supervisord program name (valheim-server,
	// valheim-updater, ...) or "" when the line carried no supervisord tag.
	Program string
	// Text is everything after the syslog header and program name. This is
	// what goes into the `log` event.
	Text string
	// Msg is Text with Valheim's own "MM/DD/YYYY HH:MM:SS: " prefix removed;
	// the match table runs against it.
	Msg string
}

// Match kinds produced by the table.
const (
	KindVersion     = "version"
	KindJoinCode    = "join_code"
	KindPlayerCount = "player_count"
	KindPlayfab     = "playfab"
	KindCharacter   = "character"
	KindWorldSaved  = "world_saved"
	KindRaid        = "raid"
	KindNetStats    = "net_stats"
	KindWorldBackup = "world_backup"
	// KindPlatform is "PlayFab socket ... received local Platform ID X_id":
	// a connecting client's platform, before its character is known.
	KindPlatform = "platform"
	// KindAbandoned is "Destroying abandoned non persistent zdo U:N owner U":
	// the owner's peer is gone. Logged once per object, in bursts.
	KindAbandoned = "abandoned"
)

// Platform types. The raw platform user ID is never kept.
const (
	PlatformXbox        = "xbox"
	PlatformSteam       = "steam"
	PlatformPlayStation = "playstation"
	PlatformNintendo    = "nintendo"
	PlatformUnknown     = "unknown"
)

// Playfab states.
const (
	PlayfabOK         = "ok"
	PlayfabConnecting = "connecting"
	PlayfabError      = "error"
)

// Match is one fact extracted from a line. Only the fields relevant to Kind
// are set.
type Match struct {
	Kind           string
	Version        string
	NetworkVersion int
	Code           string
	Count          int
	// Lost is set on a player_count from a "Player connection lost" line.
	Lost  bool
	State string
	Name  string
	Death bool
	// UID is the peer id part of a character ZDOID (character) or the owner
	// of an abandoned object (abandoned).
	UID      string
	Platform string  // platform: one of the Platform* constants
	Ms       float64 // world_saved; 0 when the line had no duration
	// net_stats
	Connections int
	ZDOs        int
	Sent        int
	Recv        int
}

// syslogHeader accepts, in order and each optional: "<PRI>", an RFC3164
// timestamp ("Oct  9 22:28:39", day space-padded), a hostname, then the
// "supervisord:" tag (optionally with [pid]), then the program name. Without
// the tag the line falls through to bareHeader.
var syslogHeader = regexp.MustCompile(
	`^(?:<\d+>)?(?:[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} )?(?:\S+ )?supervisord(?:\[\d+\])?: (\S+)(?: (.*))?$`)

// bareHeader strips only PRI and timestamp from untagged lines (supervisord's
// own output, entrypoint DEBUG lines).
var bareHeader = regexp.MustCompile(`^(?:<\d+>)?(?:[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} )?(.*)$`)

var valheimStamp = regexp.MustCompile(`^\d{2}/\d{2}/\d{4} \d{2}:\d{2}:\d{2}: `)

// StripHeader removes the syslog header and Valheim's timestamp prefix.
func StripHeader(raw string) Line {
	if m := syslogHeader.FindStringSubmatch(raw); m != nil {
		l := Line{Program: m[1], Text: m[2]}
		l.Msg = valheimStamp.ReplaceAllString(l.Text, "")
		return l
	}
	m := bareHeader.FindStringSubmatch(raw)
	l := Line{Text: m[1]}
	l.Msg = valheimStamp.ReplaceAllString(l.Text, "")
	return l
}

type rule struct {
	re *regexp.Regexp
	fn func(sub []string) []Match
}

// table is the single regex table. A line is tested against every rule, so
// one line can produce several matches (the "registered with join code" line
// yields both join_code and playfab ok).
var table = []rule{
	// Confirmed against 1.0.17 (testdata/startup-1.0.17.log).
	{regexp.MustCompile(`Valheim version: (\S+) \(network version (\d+)\)`), func(s []string) []Match {
		n, _ := strconv.Atoi(s[2])
		return []Match{{Kind: KindVersion, Version: s[1], NetworkVersion: n}}
	}},
	{regexp.MustCompile(`Session ".*" registered with join code (\d{6})`), func(s []string) []Match {
		return []Match{{Kind: KindJoinCode, Code: s[1]}, {Kind: KindPlayfab, State: PlayfabOK}}
	}},
	{regexp.MustCompile(`Session ".*" with join code (\d{6}) and IP \S+ is active with (\d+) player`), func(s []string) []Match {
		n, _ := strconv.Atoi(s[2])
		return []Match{{Kind: KindJoinCode, Code: s[1]}, {Kind: KindPlayerCount, Count: n}}
	}},
	// Confirmed against a 1.0.17 crossplay session (testdata/session-1.0.17.log)
	// from here to the network summary.
	//
	// "New session", "Player joined" and "Player connection lost" lines all
	// end in the server's count. The first one has an empty join code. The
	// "connection lost" count can lag by one while the socket is kept for a
	// reconnect, so names come from ZDOIDs, not from this number, and Lost
	// marks it so the tracker never lets it raise the count.
	{regexp.MustCompile(`(connection lost )?server ".*" that has join code \d*, now (\d+) player`), func(s []string) []Match {
		n, _ := strconv.Atoi(s[2])
		return []Match{{Kind: KindPlayerCount, Count: n, Lost: s[1] != ""}}
	}},
	{regexp.MustCompile(`received local Platform ID ([A-Za-z]+)_`), func(s []string) []Match {
		return []Match{{Kind: KindPlatform, Platform: PlatformOf(s[1])}}
	}},
	// A death: the character ZDOID is reset to 0:0 while the player is dead.
	// The respawn about 8 s later is a new ZDOID with the same peer id.
	{regexp.MustCompile(`Got character ZDOID from (.+) : 0:0\s*$`), func(s []string) []Match {
		return []Match{{Kind: KindCharacter, Name: s[1], Death: true}}
	}},
	// A spawned character: UID is the peer's session id, new on every connect.
	{regexp.MustCompile(`Got character ZDOID from (.+) : (-?\d+):(\d+)`), func(s []string) []Match {
		if s[2] == "0" && s[3] == "0" {
			return nil // the death form below
		}
		return []Match{{Kind: KindCharacter, Name: s[1], UID: s[2]}}
	}},
	{regexp.MustCompile(`Destroying abandoned non persistent zdo -?\d+:\d+ owner (-?\d+)`), func(s []string) []Match {
		return []Match{{Kind: KindAbandoned, UID: s[1]}}
	}},
	// The regular save, every -saveinterval seconds and on shutdown.
	{regexp.MustCompile(`World save \(\d+/\d+\) done\. Total time \[([\d.]+)ms\]`), func(s []string) []Match {
		ms, _ := strconv.ParseFloat(s[1], 64)
		return []Match{{Kind: KindWorldSaved, Ms: ms}}
	}},
	// The game's own autobackup, a step inside some saves (it is considered
	// on every save but only taken every couple of hours of world time).
	{regexp.MustCompile(`World auto backup saved \[([\d.]+)ms\]`), func(s []string) []Match {
		ms, _ := strconv.ParseFloat(s[1], 64)
		return []Match{{Kind: KindWorldBackup, Ms: ms}}
	}},
	// Confirmed against 1.0.17 (testdata/session-1.0.17.log): the periodic
	// network summary, every 10 minutes, with a leading space.
	{regexp.MustCompile(`Connections (\d+) ZDOS:(\d+)\s+sent:(\d+)\s+recv:(\d+)`), func(s []string) []Match {
		c, _ := strconv.Atoi(s[1])
		z, _ := strconv.Atoi(s[2])
		se, _ := strconv.Atoi(s[3])
		r, _ := strconv.Atoi(s[4])
		return []Match{{Kind: KindNetStats, Connections: c, ZDOs: z, Sent: se, Recv: r}}
	}},
	{regexp.MustCompile(`Joined PlayFab Party network`), func([]string) []Match {
		return []Match{{Kind: KindPlayfab, State: PlayfabOK}}
	}},
	{regexp.MustCompile(`begin PlayFab create and join network`), func([]string) []Match {
		return []Match{{Kind: KindPlayfab, State: PlayfabConnecting}}
	}},
	{regexp.MustCompile(`PlayFab reconnect|INTERNET_CONNECTIVITY_ERROR|ServiceUnavailable`), func([]string) []Match {
		return []Match{{Kind: KindPlayfab, State: PlayfabError}}
	}},

	// Pre-1.0 save line, kept for older servers.
	{regexp.MustCompile(`World saved(?: \( ?([\d.]+) ?ms ?\))?`), func(s []string) []Match {
		ms, _ := strconv.ParseFloat(s[1], 64)
		return []Match{{Kind: KindWorldSaved, Ms: ms}}
	}},
	// The random-event (raid) start line, confirmed on 1.0.17 ("Random event
	// set:army_bonemass", no space after the colon). Name is the
	// internal event id (army_eikthyr, foresttrolls, ...).
	{regexp.MustCompile(`Random event set:\s*(\S+)`), func(s []string) []Match {
		return []Match{{Kind: KindRaid, Name: s[1]}}
	}},
}

// PlatformOf maps the prefix of a platform user ID to a platform type. Only
// Xbox_ and Steam_ are confirmed on 1.0.17; the console prefixes are guesses.
func PlatformOf(prefix string) string {
	switch strings.ToLower(prefix) {
	case "xbox":
		return PlatformXbox
	case "steam":
		return PlatformSteam
	case "playstation", "psn", "ps", "ps5", "sony":
		return PlatformPlayStation
	case "nintendo", "switch", "nx":
		return PlatformNintendo
	}
	return PlatformUnknown
}

// redactions hide player identifiers in log text served to the UI: platform
// user IDs (Xbox_2533..., Steam_7656...; the platform type stays readable)
// and PlayFab remote player IDs.
var redactions = []struct {
	re   *regexp.Regexp
	with string
}{
	{regexp.MustCompile(`(Platform ID [A-Za-z]+_)\S+`), "${1}***"},
	// "Player history entry with index 0:  gamertag (Xbox_2533..., 0123ABCD...)"
	{regexp.MustCompile(`\(([A-Za-z]+)_[^,\s)]+, [0-9A-Fa-f]+\)`), "(${1}_***, ***)"},
	{regexp.MustCompile(`\b([A-Za-z]+)_\d{6,}\b`), "${1}_***"},
	{regexp.MustCompile(`playfab/[0-9A-Za-z]+`), "playfab/***"},
	{regexp.MustCompile(`(remote player) [0-9A-Fa-f]+`), "$1 ***"},
	// Skald bridge audit lines: a player argument can be a peer uid or a
	// platform id, and ban results carry the whole ban list.
	{regexp.MustCompile(`"(player|toPlayer|banned|unbanned)":"([^"]*_[^"]*|-?\d{6,})"`), `"$1":"***"`},
	{regexp.MustCompile(`"banList":\[[^\]]*\]`), `"banList":["***"]`},
}

// Redact removes player identifiers from a log line.
func Redact(text string) string {
	for _, r := range redactions {
		text = r.re.ReplaceAllString(text, r.with)
	}
	return text
}

// MatchMsg runs the table against a stripped message.
func MatchMsg(msg string) []Match {
	var out []Match
	for _, r := range table {
		if sub := r.re.FindStringSubmatch(msg); sub != nil {
			out = append(out, r.fn(sub)...)
		}
	}
	return out
}

// Parse is StripHeader followed by MatchMsg.
func Parse(raw string) (Line, []Match) {
	l := StripHeader(raw)
	return l, MatchMsg(l.Msg)
}
