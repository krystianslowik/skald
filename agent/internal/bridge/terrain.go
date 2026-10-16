package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// TerrainTimeout covers the plugin's queue wait and one duty-cycled tile.
const TerrainTimeout = 30 * time.Second

// maxTerrainTile is the largest tile the plugin can answer: 258^2 * 4 bytes plus the header.
const maxTerrainTile = 24 + 258*258*4

// TerrainPalette is the game's own minimap colours, when the plugin could
// read them; Source "none" otherwise.
type TerrainPalette struct {
	Source     string            `json:"source"`
	Biomes     map[string]string `json:"biomes,omitempty"`
	ForestMask string            `json:"forestMask,omitempty"`
}

// TerrainInfo is the plugin's GET /v1/terrain/info: what the running world
// generator samples.
type TerrainInfo struct {
	SeedHash        int32          `json:"seedHash"`
	WorldGenVersion int32          `json:"worldGenVersion"`
	GameBuild       string         `json:"gameBuild"`
	WaterLevel      float64        `json:"waterLevel"`
	Biomes          []string       `json:"biomes"`
	Forest          string         `json:"forest"`
	MaxEdge         int            `json:"maxEdge"`
	MinStep         float64        `json:"minStep"`
	Palette         TerrainPalette `json:"palette"`
}

// TerrainInfo asks the plugin which world it samples. Read-only: no build
// gate, the plugin switches the route off itself when a patch breaks it.
func (c *Client) TerrainInfo(ctx context.Context) (*TerrainInfo, error) {
	data, err := c.call(ctx, http.MethodGet, "/v1/terrain/info", "", nil)
	if err != nil {
		return nil, err
	}
	var ti TerrainInfo
	if err := json.Unmarshal(data, &ti); err != nil {
		return nil, &Error{http.StatusBadGateway, "bad terrain info"}
	}
	return &ti, nil
}

// TerrainTile samples an n x n grid with its north-west sample at (x0, z0)
// and `step` metres between samples, in the plugin's binary tile format
// (bridge/plugin/TerrainTile.cs). sampleMs is the plugin's own sampling time.
func (c *Client) TerrainTile(ctx context.Context, n int, x0, z0, step float64) (body []byte, sampleMs int, err error) {
	q := url.Values{}
	q.Set("n", strconv.Itoa(n))
	q.Set("x", strconv.FormatFloat(x0, 'f', -1, 32))
	q.Set("z", strconv.FormatFloat(z0, 'f', -1, 32))
	q.Set("step", strconv.FormatFloat(step, 'f', -1, 32))
	ctx, cancel := context.WithTimeout(ctx, TerrainTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.opt.URL+"/v1/terrain/tile?"+q.Encode(), nil)
	if err != nil {
		return nil, 0, &Error{http.StatusBadGateway, "bridge unavailable"}
	}
	req.Header.Set("X-Skald-Token", c.opt.Token)
	// The default client's timeout is the command one, too short for a tile.
	hc := *c.http
	hc.Timeout = 0
	res, err := hc.Do(req)
	if err != nil {
		return nil, 0, &Error{http.StatusBadGateway, "bridge unavailable"}
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxTerrainTile+1))
	if err != nil {
		return nil, 0, &Error{http.StatusBadGateway, "bridge unavailable"}
	}
	if res.StatusCode != http.StatusOK {
		var env envelope
		_ = json.Unmarshal(raw, &env)
		status := res.StatusCode
		if status != http.StatusTooManyRequests && status != http.StatusServiceUnavailable && status != http.StatusBadRequest {
			status = http.StatusBadGateway
		}
		return nil, 0, &Error{status, c.redact(env.Error)}
	}
	if len(raw) > maxTerrainTile {
		return nil, 0, &Error{http.StatusBadGateway, fmt.Sprintf("terrain tile over %d bytes", maxTerrainTile)}
	}
	ms, _ := strconv.Atoi(res.Header.Get("X-Skald-Sample-Ms"))
	return raw, ms, nil
}
