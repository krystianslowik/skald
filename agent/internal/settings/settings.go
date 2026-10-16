// Package settings owns the server settings Skald can change: name,
// password, public listing and the vanilla world modifiers. It validates
// structured input against an allow-list, turns it into launch arguments and
// writes the files the game's pre-run hook reads (see store.go).
//
// The allow-list follows Iron Gate's dedicated server guide,
// https://valheimgame.com/support/a-guide-to-dedicated-servers/ (section
// "List of console commands": -preset, -modifier, -setkey, -saveinterval).
// Nothing outside it ever reaches SERVER_ARGS from a client.
//
// The dashboard mirrors these rules in server/src/settings.ts. Both test
// suites load testdata/rules.json, so change a rule in all three places.
package settings

import (
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Presets are the documented -preset values. "normal" means no -preset at all.
var Presets = []string{"normal", "casual", "easy", "hard", "hardcore", "immersive", "hammer"}

// Modifier is one -modifier name and its documented values, mildest first.
// Leaving a modifier out keeps the preset's (or the game's normal) value;
// "normal" itself is not a documented value, so it is never emitted.
type Modifier struct {
	Name   string
	Values []string
}

var Modifiers = []Modifier{
	{"combat", []string{"veryeasy", "easy", "hard", "veryhard"}},
	{"deathpenalty", []string{"casual", "veryeasy", "easy", "hard", "hardcore"}},
	{"resources", []string{"muchless", "less", "more", "muchmore", "most"}},
	{"raids", []string{"none", "muchless", "less", "more", "muchmore"}},
	{"portals", []string{"casual", "hard", "veryhard"}},
}

// Keys are the documented -setkey checkbox keys.
var Keys = []string{"nobuildcost", "playerevents", "passivemobs", "nomap"}

const (
	SaveIntervalMin     = 60
	SaveIntervalMax     = 7200
	SaveIntervalDefault = 1800

	NameMin     = 3
	NameMax     = 40
	PasswordMin = 5
	PasswordMax = 32
)

// Settings is the full structured state. Password is only ever stored in
// server.json and server.env; API views leave it out.
type Settings struct {
	Name     string `json:"name"`
	Password string `json:"password"`
	Public   bool   `json:"public"`
	// Preset is one of Presets; "normal" when none.
	Preset string `json:"preset"`
	// Modifiers maps a Modifiers name to one of its values. Absent = preset default.
	Modifiers map[string]string `json:"modifiers"`
	// Keys holds Keys entries, in allow-list order.
	Keys []string `json:"keys"`
	// SaveInterval in seconds; 0 = the game's default (1800).
	SaveInterval int `json:"saveInterval"`
	// Unmanaged are SERVER_ARGS tokens Skald does not manage (-crossplay,
	// -backups 4, ...). Read-only: kept verbatim and appended on write.
	Unmanaged []string `json:"unmanaged"`
}

// Input is the body of PUT /settings. A nil Password keeps the current one.
type Input struct {
	Name         string            `json:"name"`
	Password     *string           `json:"password,omitempty"`
	Public       bool              `json:"public"`
	Preset       string            `json:"preset"`
	Modifiers    map[string]string `json:"modifiers"`
	Keys         []string          `json:"keys"`
	SaveInterval int               `json:"saveInterval"`
}

// Errors maps a field to a short machine-readable reason.
type Errors map[string]string

func (e Errors) Error() string {
	parts := make([]string, 0, len(e))
	for k, v := range e {
		parts = append(parts, k+": "+v)
	}
	slices.Sort(parts)
	return "invalid settings: " + strings.Join(parts, ", ")
}

var nameChars = regexp.MustCompile(`^[\p{L}\p{N} \-_.'!]+$`)

// ValidateName checks an already trimmed name.
func ValidateName(n string) string {
	if l := utf8.RuneCountInString(n); l < NameMin || l > NameMax {
		return "length"
	}
	if !nameChars.MatchString(n) {
		return "chars"
	}
	return ""
}

// ValidatePassword applies the length and charset rules and Valheim's own:
// the password may not appear in the server name (checked case-insensitively,
// stricter than the game, which is safe).
func ValidatePassword(p, name string) string {
	if len(p) < PasswordMin || len(p) > PasswordMax {
		return "length"
	}
	for i := 0; i < len(p); i++ {
		if p[i] < 0x21 || p[i] > 0x7e {
			return "chars"
		}
	}
	if strings.Contains(strings.ToLower(name), strings.ToLower(p)) {
		return "inName"
	}
	return ""
}

// safe reports whether a value can go into a KEY=value line as is: no
// control characters, so no line breaks.
func safe(s string) bool {
	if !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// Apply validates in against prev and returns the next settings. Changed
// fields get the strict rules; a value carried over unchanged (seeded from
// the environment, maybe older than these rules) only has to be safe to
// write, so the first save never rejects what is already running.
func Apply(prev Settings, in Input) (Settings, error) {
	errs := Errors{}
	next := Settings{
		Name:         strings.TrimSpace(in.Name),
		Password:     prev.Password,
		Public:       in.Public,
		Preset:       strings.ToLower(in.Preset),
		Modifiers:    map[string]string{},
		SaveInterval: in.SaveInterval,
		Unmanaged:    slices.Clone(prev.Unmanaged),
	}
	if in.Password != nil {
		next.Password = *in.Password
	}

	if next.Name != prev.Name {
		if e := ValidateName(next.Name); e != "" {
			errs["name"] = e
		}
	} else if next.Name == "" || !safe(next.Name) {
		errs["name"] = "chars"
	}

	switch {
	case next.Password == "":
		errs["password"] = "required"
	case next.Password != prev.Password:
		if e := ValidatePassword(next.Password, next.Name); e != "" {
			errs["password"] = e
		}
	case !safe(next.Password):
		errs["password"] = "chars"
	case next.Name != prev.Name && strings.Contains(strings.ToLower(next.Name), strings.ToLower(next.Password)):
		// A new name must not swallow the password the server already uses.
		errs["password"] = "inName"
	}

	if next.Preset == "" {
		next.Preset = "normal"
	}
	if !slices.Contains(Presets, next.Preset) {
		errs["preset"] = "value"
	}
	for k, v := range in.Modifiers {
		k, v = strings.ToLower(k), strings.ToLower(v)
		if v == "" || v == "normal" {
			continue
		}
		m, ok := modifier(k)
		if !ok {
			errs["modifier."+k] = "unknown"
			continue
		}
		if !slices.Contains(m.Values, v) {
			errs["modifier."+k] = "value"
			continue
		}
		next.Modifiers[k] = v
	}
	seen := map[string]bool{}
	for _, k := range in.Keys {
		k = strings.ToLower(k)
		if !slices.Contains(Keys, k) {
			errs["keys"] = "value"
			continue
		}
		seen[k] = true
	}
	for _, k := range Keys {
		if seen[k] {
			next.Keys = append(next.Keys, k)
		}
	}
	if next.SaveInterval == SaveIntervalDefault {
		next.SaveInterval = 0
	}
	if next.SaveInterval != 0 && (next.SaveInterval < SaveIntervalMin || next.SaveInterval > SaveIntervalMax) {
		errs["saveInterval"] = "range"
	}
	if len(errs) > 0 {
		return prev, errs
	}
	return next, nil
}

func modifier(name string) (Modifier, bool) {
	for _, m := range Modifiers {
		if m.Name == name {
			return m, true
		}
	}
	return Modifier{}, false
}

// ParseArgs splits a SERVER_ARGS string into the options Skald manages and
// the tokens it does not. Option names and values match case-insensitively.
// A -preset clears modifiers seen before it, as in the game ("setting a
// preset will overwrite any other previous modifiers"). A known option with
// a value outside the allow-list stays unmanaged, verbatim.
func ParseArgs(args string) Settings {
	s := Settings{Preset: "normal", Modifiers: map[string]string{}}
	tok := strings.Fields(args)
	keys := map[string]bool{}
	for i := 0; i < len(tok); i++ {
		w := strings.ToLower(tok[i])
		next := func(n int) []string {
			if i+n < len(tok) {
				return tok[i+1 : i+1+n]
			}
			return nil
		}
		switch w {
		case "-preset":
			if v := next(1); v != nil && slices.Contains(Presets, strings.ToLower(v[0])) {
				s.Preset = strings.ToLower(v[0])
				clear(s.Modifiers)
				i++
				continue
			}
		case "-modifier":
			if v := next(2); v != nil {
				k, val := strings.ToLower(v[0]), strings.ToLower(v[1])
				if m, ok := modifier(k); ok && slices.Contains(m.Values, val) {
					s.Modifiers[k] = val
					i += 2
					continue
				}
			}
		case "-setkey":
			if v := next(1); v != nil && slices.Contains(Keys, strings.ToLower(v[0])) {
				keys[strings.ToLower(v[0])] = true
				i++
				continue
			}
		case "-saveinterval":
			if v := next(1); v != nil {
				if n, err := strconv.Atoi(v[0]); err == nil && n >= SaveIntervalMin && n <= SaveIntervalMax {
					if n != SaveIntervalDefault {
						s.SaveInterval = n
					}
					i++
					continue
				}
			}
		}
		// A control character would break the line-based env file.
		if safe(tok[i]) {
			s.Unmanaged = append(s.Unmanaged, tok[i])
		}
	}
	for _, k := range Keys {
		if keys[k] {
			s.Keys = append(s.Keys, k)
		}
	}
	return s
}

// Args renders the managed options and the unmanaged tokens as one
// SERVER_ARGS string. Every managed token comes from the allow-list, so none
// carries whitespace or glob characters: the image expands $SERVER_ARGS
// unquoted.
func (s Settings) Args() string {
	var out []string
	if s.Preset != "" && s.Preset != "normal" {
		out = append(out, "-preset", s.Preset)
	}
	for _, m := range Modifiers {
		if v, ok := s.Modifiers[m.Name]; ok {
			out = append(out, "-modifier", m.Name, v)
		}
	}
	for _, k := range s.Keys {
		out = append(out, "-setkey", k)
	}
	if s.SaveInterval != 0 {
		out = append(out, "-saveinterval", strconv.Itoa(s.SaveInterval))
	}
	out = append(out, s.Unmanaged...)
	return strings.Join(out, " ")
}

// EnvFile renders server.env: one KEY=value per line, newline-terminated (a
// shell `read` loop drops a last line without one). Only the four keys the
// hook accepts.
func (s Settings) EnvFile() []byte {
	pub := "0"
	if s.Public {
		pub = "1"
	}
	var b strings.Builder
	b.WriteString("SERVER_NAME=" + s.Name + "\n")
	b.WriteString("SERVER_PASS=" + s.Password + "\n")
	b.WriteString("SERVER_PUBLIC=" + pub + "\n")
	b.WriteString("SERVER_ARGS=" + s.Args() + "\n")
	return []byte(b.String())
}

// Changed lists what differs between a and b, for the settings_changed event.
// "password" may appear; its value never does.
func Changed(a, b Settings) []string {
	var out []string
	if a.Name != b.Name {
		out = append(out, "name")
	}
	if a.Password != b.Password {
		out = append(out, "password")
	}
	if a.Public != b.Public {
		out = append(out, "public")
	}
	if a.Preset != b.Preset {
		out = append(out, "preset")
	}
	for _, m := range Modifiers {
		if a.Modifiers[m.Name] != b.Modifiers[m.Name] {
			out = append(out, "modifier."+m.Name)
		}
	}
	for _, k := range Keys {
		if slices.Contains(a.Keys, k) != slices.Contains(b.Keys, k) {
			out = append(out, "key."+k)
		}
	}
	if a.SaveInterval != b.SaveInterval {
		out = append(out, "saveInterval")
	}
	return out
}

// ParsePublic reads the image's SERVER_PUBLIC convention (1/0/true/false,
// default public).
func ParsePublic(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "0", "false":
		return false
	}
	return true
}
