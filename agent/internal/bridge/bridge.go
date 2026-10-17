// Package bridge talks to the Skald bridge plugin (bridge/plugin): a BepInEx
// plugin inside the game process that serves admin commands on 127.0.0.1.
//
// It is the only place that sees player platform ids and peer uids. The web
// tier names players; this package swaps a name for its uid before a command
// goes to the plugin, and strips every id from what comes back. It also
// publishes an `admin` event for every command it sends, built from the
// request and the plugin's reply, and polls live positions.
package bridge

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/krystianslowik/skald/agent/internal/events"
	"github.com/krystianslowik/skald/agent/internal/logparse"
)

// DefaultTimeout covers the plugin's own 5 s main-thread budget.
const DefaultTimeout = 8 * time.Second

// DefaultTestedBuilds are the game builds the plugin was checked against.
var DefaultTestedBuilds = []string{"l-1.0.17", "l-1.0.20"}

// Command is one entry of the allow-list: the plugin route behind an agent
// command name. Every command here changes the world.
type Command struct {
	Path string
}

// Commands is the allow-list of POST /bridge/{command}. Nothing else reaches
// the plugin.
var Commands = map[string]Command{
	"broadcast":        {"/v1/broadcast"},
	"save":             {"/v1/save"},
	"kick":             {"/v1/kick"},
	"ban":              {"/v1/ban"},
	"unban":            {"/v1/unban"},
	"time":             {"/v1/time"},
	"skip-to-morning":  {"/v1/time/skip-to-morning"},
	"time-freeze":      {"/v1/time/freeze"},
	"time-resume":      {"/v1/time/resume"},
	"event-start":      {"/v1/events/start"},
	"event-stop":       {"/v1/events/stop"},
	"spawn":            {"/v1/spawn"},
	"teleport":         {"/v1/teleport"},
	"globalkey-set":    {"/v1/globalkeys/set"},
	"globalkey-remove": {"/v1/globalkeys/remove"},
	"creature-spawn":   {"/v1/creatures/spawn"},
	"creature-kill":    {"/v1/creatures/kill"},
	"creature-tame":    {"/v1/creatures/tame"},
	"heal":             {"/v1/player/heal"},
	"status":           {"/v1/player/status"},
	"repair":           {"/v1/build/repair"},
	"fill":             {"/v1/build/fill"},
	"fill-kilns":       {"/v1/build/fill-kilns"},
	"fill-smelters":    {"/v1/build/fill-smelters"},
	"fill-fermenters":  {"/v1/build/fill-fermenters"},
	"grow":             {"/v1/build/grow"},
	"map-reveal":       {"/v1/map/reveal"},
	"map-pins":         {"/v1/map/pins"},
}

// Reads is the allow-list of GET /bridge/{name}, besides status, players and bans.
var Reads = map[string]string{
	"time":       "/v1/time",
	"events":     "/v1/events",
	"globalkeys": "/v1/globalkeys",
	"locations":  "/v1/locations",
	"stations":   "/v1/build/stations",
}

// CommandNames lists the allow-list, sorted.
func CommandNames() []string {
	out := make([]string, 0, len(Commands))
	for n := range Commands {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

type Options struct {
	// URL of the plugin, http://127.0.0.1:9010 in the game pod.
	URL string
	// Token is the game container's SKALD_BRIDGE_TOKEN.
	Token string
	// TestedBuilds are game builds commands may run on without an
	// acknowledgement; "*" allows any.
	TestedBuilds []string
	// AckPath keeps an operator's "this build is fine" across agent restarts;
	// empty keeps it in memory only.
	AckPath string
	Hub     *events.Hub
	Logger  *slog.Logger
	// Timeout per plugin call; DefaultTimeout when zero.
	Timeout time.Duration
	// HTTP overrides the client (tests).
	HTTP *http.Client
}

// Client calls the plugin and keeps the private name <-> id tables.
type Client struct {
	opt  Options
	http *http.Client
	// salt makes the opaque ban ids unguessable and different per run.
	salt []byte

	mu sync.Mutex
	// uidByName (lower-cased name) and nameByUID come from the last player list.
	uidByName map[string]string
	nameByUID map[string]string
	// nameByUserID remembers which platform id belonged to which character,
	// so a ban list entry can be shown by name. Never served.
	nameByUserID map[string]string
	// userIDByName (lower-cased name) is the reverse, for the last player list.
	userIDByName map[string]string
	// banIDs maps the opaque ids handed to the web back to ban list entries.
	banIDs   map[string]string
	health   *Health
	healthAt time.Time
	acked    string
	// last positions published, to skip unchanged samples.
	lastPositions string
}

// New returns a client; nil when token is empty (the bridge is off).
func New(opt Options) *Client {
	if opt.Token == "" {
		return nil
	}
	if opt.Timeout == 0 {
		opt.Timeout = DefaultTimeout
	}
	if opt.Logger == nil {
		opt.Logger = slog.Default()
	}
	if len(opt.TestedBuilds) == 0 {
		opt.TestedBuilds = DefaultTestedBuilds
	}
	opt.URL = strings.TrimRight(opt.URL, "/")
	hc := opt.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: opt.Timeout}
	}
	salt := make([]byte, 16)
	_, _ = rand.Read(salt)
	c := &Client{
		opt:          opt,
		http:         hc,
		salt:         salt,
		uidByName:    map[string]string{},
		nameByUID:    map[string]string{},
		nameByUserID: map[string]string{},
		userIDByName: map[string]string{},
		banIDs:       map[string]string{},
	}
	c.acked = c.loadAck()
	return c
}

// Error is a plugin answer that is not 200, or an unreachable plugin (502).
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("bridge %d: %s", e.Status, e.Message) }

// StatusOf is the HTTP status to hand on for err: the plugin's own status for
// 400/404/409/501/503/504, 502 when it could not be reached.
func StatusOf(err error) int {
	var e *Error
	if errors.As(err, &e) {
		return e.Status
	}
	return http.StatusBadGateway
}

type envelope struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data"`
	Error string          `json:"error"`
}

// call sends one request. POST always carries a JSON body, `{}` at least:
// the plugin's listener answers 411 to a POST without Content-Length.
func (c *Client) call(ctx context.Context, method, path, actor string, body any) (json.RawMessage, error) {
	var rd io.Reader
	if method == http.MethodPost {
		if body == nil {
			body = map[string]any{}
		}
		b, err := json.Marshal(body)
		if err != nil {
			return nil, &Error{http.StatusBadRequest, "bad body"}
		}
		rd = bytes.NewReader(b)
	}
	ctx, cancel := context.WithTimeout(ctx, c.opt.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, c.opt.URL+path, rd)
	if err != nil {
		return nil, &Error{http.StatusBadGateway, "bridge unavailable"}
	}
	req.Header.Set("X-Skald-Token", c.opt.Token)
	if actor = CleanActor(actor); actor != "" {
		req.Header.Set("X-Skald-Actor", actor)
	}
	if rd != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, unavailable(ctx)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, unavailable(ctx)
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, &Error{http.StatusBadGateway, fmt.Sprintf("bridge answered %d without JSON", res.StatusCode)}
	}
	if res.StatusCode != http.StatusOK || !env.OK {
		status := res.StatusCode
		if status == http.StatusOK || status == http.StatusUnauthorized || status >= 500 && status != 501 && status != 503 && status != 504 {
			// A bad token or a plugin crash is the agent's problem, not the caller's.
			status = http.StatusBadGateway
		}
		msg := env.Error
		if res.StatusCode == http.StatusUnauthorized {
			msg = "bridge rejected the token (BRIDGE_TOKEN differs from SKALD_BRIDGE_TOKEN)"
		}
		return nil, &Error{status, c.redact(msg)}
	}
	return env.Data, nil
}

// unavailable is a failed exchange with the plugin: 504 when it ran out of
// time (the request may have been sent and the command may still run, so the
// outcome is unknown), 502 when the plugin could not be reached.
func unavailable(ctx context.Context) *Error {
	if ctx.Err() != nil {
		return &Error{http.StatusGatewayTimeout, "the bridge did not answer in time"}
	}
	return &Error{http.StatusBadGateway, "bridge unavailable"}
}

var actorChars = regexp.MustCompile(`[^A-Za-z0-9_.@-]`)

// CleanActor keeps the characters the plugin accepts in X-Skald-Actor.
func CleanActor(s string) string {
	s = actorChars.ReplaceAllString(s, "")
	if len(s) > 64 {
		s = s[:64]
	}
	return s
}

// ---- status ---------------------------------------------------------------

// Health is the plugin's GET /v1/health.
type Health struct {
	Plugin      string `json:"plugin"`
	GameBuild   string `json:"gameBuild"`
	WorldLoaded bool   `json:"worldLoaded"`
	TimeFrozen  bool   `json:"timeFrozen"`
}

// Status is GET /bridge/status.
type Status struct {
	Available bool `json:"available"`
	// Reason when not available: unreachable (off, not installed, BepInEx
	// off, kill switch), disabled (the plugin turned itself off, usually
	// after a game patch), token, loading (world not loaded) or restarting.
	Reason       string   `json:"reason,omitempty"`
	Message      string   `json:"message,omitempty"`
	Plugin       string   `json:"plugin,omitempty"`
	GameBuild    string   `json:"gameBuild,omitempty"`
	WorldLoaded  bool     `json:"worldLoaded"`
	TimeFrozen   bool     `json:"timeFrozen"`
	Tested       bool     `json:"tested"`
	Acknowledged bool     `json:"acknowledged"`
	TestedBuilds []string `json:"testedBuilds"`
	Commands     []string `json:"commands"`
}

// Status asks the plugin how it is.
func (c *Client) Status(ctx context.Context) Status {
	st := Status{TestedBuilds: c.opt.TestedBuilds, Commands: CommandNames()}
	h, err := c.refreshHealth(ctx)
	if err != nil {
		var e *Error
		errors.As(err, &e)
		switch {
		case e != nil && e.Status == http.StatusServiceUnavailable:
			st.Reason, st.Message = "disabled", e.Message
		case e != nil && strings.Contains(e.Message, "token"):
			st.Reason, st.Message = "token", e.Message
		default:
			st.Reason = "unreachable"
		}
		return st
	}
	st.Plugin, st.GameBuild, st.WorldLoaded, st.TimeFrozen = h.Plugin, h.GameBuild, h.WorldLoaded, h.TimeFrozen
	st.Tested = c.tested(h.GameBuild)
	c.mu.Lock()
	st.Acknowledged = c.acked != "" && c.acked == h.GameBuild
	c.mu.Unlock()
	if !h.WorldLoaded {
		st.Reason = "loading"
		return st
	}
	st.Available = true
	return st
}

func (c *Client) refreshHealth(ctx context.Context) (*Health, error) {
	data, err := c.call(ctx, http.MethodGet, "/v1/health", "", nil)
	if err != nil {
		c.mu.Lock()
		c.health = nil
		c.mu.Unlock()
		return nil, err
	}
	var h Health
	if err := json.Unmarshal(data, &h); err != nil {
		return nil, &Error{http.StatusBadGateway, "bad health answer"}
	}
	c.mu.Lock()
	c.health, c.healthAt = &h, time.Now()
	c.mu.Unlock()
	return &h, nil
}

func (c *Client) tested(build string) bool {
	for _, b := range c.opt.TestedBuilds {
		if b == "*" || b == build {
			return true
		}
	}
	return false
}

// gate refuses commands on a game build nobody has checked yet.
func (c *Client) gate(ctx context.Context) error {
	c.mu.Lock()
	h, at := c.health, c.healthAt
	c.mu.Unlock()
	if h == nil || time.Since(at) > 30*time.Second {
		var err error
		if h, err = c.refreshHealth(ctx); err != nil {
			return err
		}
	}
	if c.tested(h.GameBuild) {
		return nil
	}
	c.mu.Lock()
	ok := c.acked == h.GameBuild
	c.mu.Unlock()
	if !ok {
		return &Error{http.StatusConflict, "untested game build " + h.GameBuild + ": confirm it in the admin panel first"}
	}
	return nil
}

// Acknowledge lets commands run on build, which must be the running one.
func (c *Client) Acknowledge(ctx context.Context, build, actor string) error {
	h, err := c.refreshHealth(ctx)
	if err != nil {
		return err
	}
	if build == "" || build != h.GameBuild {
		return &Error{http.StatusConflict, "the server runs " + h.GameBuild}
	}
	c.mu.Lock()
	c.acked = build
	c.mu.Unlock()
	c.saveAck(build)
	c.publishAdmin(map[string]any{"actor": auditActor(actor), "command": "ack-build", "result": "ok", "build": build})
	return nil
}

func (c *Client) loadAck() string {
	if c.opt.AckPath == "" {
		return ""
	}
	b, err := os.ReadFile(c.opt.AckPath)
	if err != nil {
		return ""
	}
	var v struct {
		Build string `json:"build"`
	}
	if json.Unmarshal(b, &v) != nil {
		return ""
	}
	return v.Build
}

func (c *Client) saveAck(build string) {
	if c.opt.AckPath == "" {
		return
	}
	b, _ := json.Marshal(map[string]string{"build": build})
	tmp := filepath.Join(filepath.Dir(c.opt.AckPath), ".bridge-ack.tmp")
	if err := os.WriteFile(tmp, b, 0o644); err == nil {
		err = os.Rename(tmp, c.opt.AckPath)
		if err == nil {
			return
		}
	}
	c.opt.Logger.Info("bridge acknowledgement kept in memory only", "path", c.opt.AckPath)
}

// ---- players --------------------------------------------------------------

// Player is one connected player as the web may see it: no uid, no platform
// or PlayFab id.
type Player struct {
	Name         string   `json:"name"`
	Platform     string   `json:"platform"`
	X            float64  `json:"x"`
	Y            float64  `json:"y"`
	Z            float64  `json:"z"`
	Health       *float64 `json:"health"`
	MaxHealth    *float64 `json:"maxHealth"`
	HasCharacter bool     `json:"hasCharacter"`
}

type rawPlayer struct {
	UID          json.Number `json:"uid"`
	Name         string      `json:"name"`
	PlatformID   string      `json:"platformId"`
	UserID       string      `json:"userId"`
	Position     struct{ X, Y, Z float64 }
	HasCharacter bool     `json:"hasCharacter"`
	Health       *float64 `json:"health"`
	MaxHealth    *float64 `json:"maxHealth"`
}

// Players reads the connected players and refreshes the private tables.
func (c *Client) Players(ctx context.Context) ([]Player, error) {
	data, err := c.call(ctx, http.MethodGet, "/v1/players", "", nil)
	if err != nil {
		return nil, err
	}
	var body struct {
		Players []rawPlayer `json:"players"`
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(&body); err != nil {
		return nil, &Error{http.StatusBadGateway, "bad player list"}
	}
	out := make([]Player, 0, len(body.Players))
	c.mu.Lock()
	c.uidByName = map[string]string{}
	c.nameByUID = map[string]string{}
	c.userIDByName = map[string]string{}
	for _, p := range body.Players {
		uid := p.UID.String()
		c.uidByName[strings.ToLower(p.Name)] = uid
		c.nameByUID[uid] = p.Name
		id := p.UserID
		if id == "" {
			id = p.PlatformID
		}
		if id != "" && len(c.nameByUserID) < 1000 {
			c.nameByUserID[strings.ToLower(id)] = p.Name
		}
		if id != "" {
			c.userIDByName[strings.ToLower(p.Name)] = id
		}
		out = append(out, Player{
			Name:         p.Name,
			Platform:     platformOf(id),
			X:            p.Position.X,
			Y:            p.Position.Y,
			Z:            p.Position.Z,
			Health:       p.Health,
			MaxHealth:    p.MaxHealth,
			HasCharacter: p.HasCharacter,
		})
	}
	c.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// platformOf reads the platform type off an id like Xbox_2533... or Steam_7656....
func platformOf(id string) string {
	if i := strings.IndexByte(id, '_'); i > 0 {
		return logparse.PlatformOf(id[:i])
	}
	return logparse.PlatformUnknown
}

// ---- bans -----------------------------------------------------------------

// Ban is one ban list entry, by opaque id: the platform id itself never leaves.
type Ban struct {
	ID       string `json:"id"`
	Platform string `json:"platform"`
	// Name when this agent has seen the player connected.
	Name string `json:"name,omitempty"`
}

// Bans reads the game's ban list.
func (c *Client) Bans(ctx context.Context) ([]Ban, error) {
	data, err := c.call(ctx, http.MethodGet, "/v1/bans", "", nil)
	if err != nil {
		return nil, err
	}
	var list []string
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, &Error{http.StatusBadGateway, "bad ban list"}
	}
	out := make([]Ban, 0, len(list))
	c.mu.Lock()
	c.banIDs = map[string]string{}
	for _, entry := range list {
		h := sha256.Sum256(append(append([]byte{}, c.salt...), entry...))
		id := hex.EncodeToString(h[:8])
		c.banIDs[id] = entry
		out = append(out, Ban{ID: id, Platform: platformOf(entry), Name: c.nameByUserID[strings.ToLower(entry)]})
	}
	c.mu.Unlock()
	return out, nil
}

// BanEntries reads the game's ban list as it stores it. For the agent's own
// admin-list routes only; never served as is to a viewer.
func (c *Client) BanEntries(ctx context.Context) ([]string, error) {
	data, err := c.call(ctx, http.MethodGet, "/v1/bans", "", nil)
	if err != nil {
		return nil, err
	}
	var list []string
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, &Error{http.StatusBadGateway, "bad ban list"}
	}
	return list, nil
}

// BanEntry bans a platform id (or a connected player by name) live, and
// UnbanEntry lifts one ban list entry. The plugin writes bannedlist.txt; the
// `admin` event is published here, like for every command.
func (c *Client) BanEntry(ctx context.Context, who, actor string) error {
	return c.post(ctx, "ban", who, actor)
}

func (c *Client) UnbanEntry(ctx context.Context, entry, actor string) error {
	return c.post(ctx, "unban", entry, actor)
}

func (c *Client) post(ctx context.Context, name, player, actor string) error {
	if err := c.gate(ctx); err != nil {
		return err
	}
	_, err := c.command(ctx, name, actor, map[string]any{"player": player})
	return err
}

// UserIDs maps the connected players of the last player list (lower-cased
// names) to their platform ids. A copy; private to the agent.
func (c *Client) UserIDs() map[string]string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]string, len(c.userIDByName))
	for name, id := range c.userIDByName {
		out[name] = id
	}
	return out
}

// Names is every platform id this agent has seen connected, with its
// character name. A copy; private to the agent.
func (c *Client) Names() map[string]string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]string, len(c.nameByUserID))
	for id, name := range c.nameByUserID {
		out[id] = name
	}
	return out
}

// ---- reads and commands -----------------------------------------------------

// Read runs one allow-listed GET.
func (c *Client) Read(ctx context.Context, name string) (any, error) {
	path, ok := Reads[name]
	if !ok {
		return nil, &Error{http.StatusNotFound, "unknown read " + name}
	}
	data, err := c.call(ctx, http.MethodGet, path, "", nil)
	if err != nil {
		return nil, err
	}
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return nil, &Error{http.StatusBadGateway, "bad answer"}
	}
	return scrub(v), nil
}

// Run sends one allow-listed command. Player names in `player` and
// `toPlayer` become uids here, and `unban` takes an opaque id from Bans.
func (c *Client) Run(ctx context.Context, name string, body map[string]any, actor string) (any, error) {
	if _, ok := Commands[name]; !ok {
		return nil, &Error{http.StatusNotFound, "unknown command " + name}
	}
	if body == nil {
		body = map[string]any{}
	}
	if err := c.gate(ctx); err != nil {
		return nil, err
	}
	out := map[string]any{}
	for k, v := range body {
		out[k] = v
	}
	if name == "unban" {
		id, _ := body["id"].(string)
		c.mu.Lock()
		entry, known := c.banIDs[id]
		c.mu.Unlock()
		if !known {
			return nil, &Error{http.StatusNotFound, "not on the ban list (reload it)"}
		}
		delete(out, "id")
		out["player"] = entry
	} else {
		for _, k := range []string{"player", "toPlayer"} {
			v, present := body[k]
			if !present {
				continue
			}
			who, _ := v.(string)
			uid, err := c.uidOf(ctx, who)
			if err != nil {
				return nil, err
			}
			out[k] = uid
		}
	}
	data, err := c.command(ctx, name, actor, out)
	if err != nil {
		return nil, err
	}
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return nil, &Error{http.StatusBadGateway, "bad answer"}
	}
	return scrub(v), nil
}

// uidOf finds a connected player's uid by name, from a fresh player list.
func (c *Client) uidOf(ctx context.Context, name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", &Error{http.StatusBadRequest, "missing player name"}
	}
	if _, err := c.Players(ctx); err != nil {
		return "", err
	}
	c.mu.Lock()
	uid, ok := c.uidByName[strings.ToLower(name)]
	c.mu.Unlock()
	if !ok {
		return "", &Error{http.StatusNotFound, "no connected player '" + name + "'"}
	}
	return uid, nil
}

// idKeys never leave the agent, wherever they turn up in an answer.
var idKeys = map[string]bool{"uid": true, "platformId": true, "userId": true, "playfabId": true, "banned": true, "unbanned": true, "banList": true}

func scrub(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for k, x := range t {
			if idKeys[k] {
				delete(t, k)
				continue
			}
			t[k] = scrub(x)
		}
	case []any:
		for i, x := range t {
			t[i] = scrub(x)
		}
	}
	return v
}

// redact hides ids in a plugin error message: platform ids by the log
// redactions, peer uids by the names they belong to.
func (c *Client) redact(msg string) string {
	msg = logparse.Redact(msg)
	c.mu.Lock()
	defer c.mu.Unlock()
	for uid, name := range c.nameByUID {
		msg = strings.ReplaceAll(msg, uid, name)
	}
	return msg
}

// ---- live positions ---------------------------------------------------------

// Position is one marker of the `positions` event: the map is 2D, so no y.
type Position struct {
	Name      string   `json:"name"`
	Platform  string   `json:"platform"`
	X         float64  `json:"x"`
	Z         float64  `json:"z"`
	Health    *float64 `json:"health"`
	MaxHealth *float64 `json:"maxHealth"`
}

// RunPositions publishes a volatile `positions` event every `every` while
// wanted() says someone is watching and someone is playing. Unchanged
// samples are skipped; when the watch ends with markers out, an empty list
// clears them.
func (c *Client) RunPositions(ctx context.Context, every time.Duration, wanted func() bool) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if !wanted() {
			c.publishPositions(nil)
			continue
		}
		players, err := c.Players(ctx)
		if err != nil {
			continue
		}
		list := make([]Position, 0, len(players))
		for _, p := range players {
			if !p.HasCharacter {
				continue
			}
			list = append(list, Position{Name: p.Name, Platform: p.Platform, X: round1(p.X), Z: round1(p.Z), Health: p.Health, MaxHealth: p.MaxHealth})
		}
		c.publishPositions(list)
	}
}

func (c *Client) publishPositions(list []Position) {
	if list == nil {
		list = []Position{}
	}
	b, _ := json.Marshal(list)
	key := string(b)
	c.mu.Lock()
	same := key == c.lastPositions || (c.lastPositions == "" && len(list) == 0)
	c.lastPositions = key
	c.mu.Unlock()
	if same || c.opt.Hub == nil {
		return
	}
	c.opt.Hub.PublishVolatile("positions", map[string]any{"t": time.Now().UnixMilli(), "players": list})
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }

// ---- admin events -----------------------------------------------------------

// command sends one allow-listed command to the plugin and publishes its
// `admin` event from what the agent holds: the body it sent and the reply it
// got. Reads never come through here, so they are never audited. The event
// holds no ids: players by name, nothing else from the arguments unless it is
// on the list below.
func (c *Client) command(ctx context.Context, name, actor string, body map[string]any) (json.RawMessage, error) {
	data, err := c.call(ctx, http.MethodPost, Commands[name].Path, actor, body)
	ev := c.summarizeArgs(body)
	ev["actor"] = auditActor(actor)
	ev["command"] = name
	var e *Error
	switch {
	case err == nil:
		ev["result"] = "ok"
		c.summarizeResult(name, data, ev)
	case errors.As(err, &e) && e.Status == http.StatusGatewayTimeout:
		ev["result"] = "timeout"
	default:
		ev["result"] = "error"
		msg := "bridge unavailable"
		if e != nil {
			msg = e.Message
		}
		ev["error"] = truncate(msg, 200)
	}
	c.publishAdmin(ev)
	return data, err
}

// auditActor is who an `admin` event names: the cleaned X-Skald-Actor, or
// "unknown" like the plugin's own audit line.
func auditActor(actor string) string {
	if actor = CleanActor(actor); actor != "" {
		return actor
	}
	return "unknown"
}

func (c *Client) publishAdmin(ev map[string]any) {
	if c.opt.Hub != nil {
		c.opt.Hub.Publish("admin", ev)
	}
}

// argKeys are the arguments an admin event may repeat.
var argKeys = map[string]bool{
	"type": true, "item": true, "amount": true, "quality": true, "prefab": true, "count": true, "level": true,
	"tamed": true, "includeBosses": true, "name": true, "key": true, "effect": true, "dayFraction": true,
	"toSpot": true, "radius": true, "what": true, "ore": true, "base": true,
}

// summarizeArgs reads the body as the plugin got it (a JSON round trip, so
// numbers are float64 whatever the caller put in).
func (c *Client) summarizeArgs(body map[string]any) map[string]any {
	out := map[string]any{}
	var args map[string]any
	raw, err := json.Marshal(body)
	if err != nil || json.Unmarshal(raw, &args) != nil {
		return out
	}
	for k, v := range args {
		switch {
		case argKeys[k]:
			if s, ok := v.(string); ok {
				v = truncate(s, 64)
			}
			out[k] = v
		case k == "text":
			if s, ok := v.(string); ok {
				out["text"] = truncate(s, 120)
			}
		case k == "items":
			if list, ok := v.([]any); ok {
				var items []map[string]any
				for _, x := range list {
					if m, ok := x.(map[string]any); ok && len(items) < 20 {
						items = append(items, pick(m, "item", "amount", "quality"))
					}
				}
				out["items"] = items
			}
		case k == "pins":
			if list, ok := v.([]any); ok {
				out["pins"] = len(list)
			}
		case k == "at" || k == "to":
			if m, ok := v.(map[string]any); ok {
				out[k] = map[string]any{"x": roundAny(m["x"]), "z": roundAny(m["z"])}
			}
		case k == "player" || k == "toPlayer":
			s, _ := v.(string)
			c.mu.Lock()
			name, known := c.nameByUID[s]
			c.mu.Unlock()
			if known {
				out[k] = name
			}
		}
	}
	return out
}

// summarizeResult adds the counts and the target's name from the answer.
func (c *Client) summarizeResult(cmd string, data json.RawMessage, ev map[string]any) {
	var d map[string]any
	if json.Unmarshal(data, &d) != nil {
		return
	}
	for _, k := range []string{"killed", "tamed", "alreadyTamed", "repaired", "smelters", "kilns", "skipped", "full", "fermenters", "plants", "sentTo", "stopped", "started", "label", "stacks", "unloaded", "day"} {
		if v, ok := d[k]; ok {
			ev[k] = v
		}
	}
	for _, k := range []string{"near", "kicked", "player"} {
		if s, ok := d[k].(string); ok && s != "" && s != "position" {
			ev["player"] = s
		}
	}
	if cmd == "ban" {
		if s, ok := d["name"].(string); ok && s != "" {
			ev["player"] = s
		}
	}
	if t, ok := d["tables"].([]any); ok {
		ev["tables"] = len(t)
	}
	// What the fill commands put in: item -> stations, and the fuel item.
	if m, ok := d["added"].(map[string]any); ok {
		added := map[string]any{}
		for k, v := range m {
			if n, ok := v.(float64); ok && len(added) < 10 {
				added[truncate(k, 64)] = n
			}
		}
		ev["added"] = added
	}
	if s, ok := d["fuel"].(string); ok && s != "" {
		ev["fuel"] = truncate(s, 64)
	}
}

func pick(m map[string]any, keys ...string) map[string]any {
	out := map[string]any{}
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s, ok := v.(string); ok {
				v = truncate(s, 64)
			}
			out[k] = v
		}
	}
	return out
}

func roundAny(v any) any {
	if f, ok := v.(float64); ok {
		return math.Round(f)
	}
	return nil
}

func truncate(s string, n int) string {
	if len([]rune(s)) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "..."
}
