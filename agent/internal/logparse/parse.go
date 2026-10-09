// Package logparse turns raw syslog lines from the valheim container into a
// stripped log line plus zero or more typed matches. It is pure: no state, no
// dedupe. Deciding which matches become events is internal/state's job.
package logparse

import (
	"regexp"
	"strconv"
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
	State          string
	Name           string
	Death          bool
	Ms             float64 // world_saved; 0 when the line had no duration
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
	{regexp.MustCompile(`Joined PlayFab Party network`), func([]string) []Match {
		return []Match{{Kind: KindPlayfab, State: PlayfabOK}}
	}},
	{regexp.MustCompile(`begin PlayFab create and join network`), func([]string) []Match {
		return []Match{{Kind: KindPlayfab, State: PlayfabConnecting}}
	}},
	{regexp.MustCompile(`PlayFab reconnect|INTERNET_CONNECTIVITY_ERROR|ServiceUnavailable`), func([]string) []Match {
		return []Match{{Kind: KindPlayfab, State: PlayfabError}}
	}},

	// Unconfirmed for 1.0 crossplay: pre-1.0 community patterns, kept lenient.
	// Replace with real lines in testdata/ after the first player session.
	{regexp.MustCompile(`Got character ZDOID from (.+) : (-?\d+):(\d+)`), func(s []string) []Match {
		return []Match{{Kind: KindCharacter, Name: s[1], Death: s[2] == "0" && s[3] == "0"}}
	}},
	{regexp.MustCompile(`World saved(?: \( ?([\d.]+) ?ms ?\))?`), func(s []string) []Match {
		ms, _ := strconv.ParseFloat(s[1], 64)
		return []Match{{Kind: KindWorldSaved, Ms: ms}}
	}},
	// Unconfirmed for 1.0: the random-event (raid) start line. Name is the
	// internal event id (army_eikthyr, foresttrolls, ...).
	{regexp.MustCompile(`Random event set:\s*(\S+)`), func(s []string) []Match {
		return []Match{{Kind: KindRaid, Name: s[1]}}
	}},
	// Unconfirmed for 1.0: the periodic network summary.
	{regexp.MustCompile(`Connections (\d+) ZDOS:(\d+)\s+sent:(\d+)\s+recv:(\d+)`), func(s []string) []Match {
		c, _ := strconv.Atoi(s[1])
		z, _ := strconv.Atoi(s[2])
		se, _ := strconv.Atoi(s[3])
		r, _ := strconv.Atoi(s[4])
		return []Match{{Kind: KindNetStats, Connections: c, ZDOs: z, Sent: se, Recv: r}}
	}},
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
