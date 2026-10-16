package server

import (
	"bytes"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/krystianslowik/skald/agent/internal/terrain"
)

// terrainInfo is /state.terrain: null when there is neither a terrain
// directory nor a readable save to ask for terrain with.
func terrainInfo(t *terrain.Terrain) *terrain.Info {
	i := t.Info()
	if i == nil || (!i.Enabled && i.Request == nil) {
		return nil
	}
	return i
}

// terrainPNG serves GET /terrain.png: the world generator's terrain for the
// current save, painted by the agent, north up, spanning [-radius, radius]
// on both axes (see /terrain.json). The ETag is the render's cache key.
// 404 when there is none for this save (never another seed's).
func (s *Server) terrainPNG(w http.ResponseWriter, r *http.Request) {
	img, _ := s.opt.Terrain.Current()
	if img == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "message": "no terrain for this world"})
		return
	}
	h := w.Header()
	h.Set("ETag", img.ETag)
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	h.Set("Content-Type", "image/png")
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(img.PNG))
}

type terrainDoc struct {
	Build           string    `json:"build"`
	Stale           bool      `json:"stale"`
	Reason          string    `json:"reason,omitempty"`
	SeedHash        int32     `json:"seedHash"`
	WorldGenVersion int32     `json:"worldGenVersion"`
	GameBuild       string    `json:"gameBuild"`
	Resolution      int       `json:"resolution"`
	Radius          float64   `json:"radius"`
	WaterLevel      float64   `json:"waterLevel"`
	RenderedAt      time.Time `json:"renderedAt"`
	Biomes          []string  `json:"biomes"`
}

// terrainJSON serves GET /terrain.json: what the image shows and where it
// sits, for the web to place it. Small and sent fresh (no-cache, no ETag).
func (s *Server) terrainJSON(w http.ResponseWriter, r *http.Request) {
	img, info := s.opt.Terrain.Current()
	if img == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "message": "no terrain for this world"})
		return
	}
	m := img.Manifest
	w.Header().Set("Cache-Control", "no-cache")
	// Stale is not part of the image, so it is not in the ETag either: the
	// document is small and always sent fresh.
	writeJSON(w, http.StatusOK, terrainDoc{
		Build: img.Build, Stale: info.Stale, Reason: info.Reason, SeedHash: m.SeedHash, WorldGenVersion: m.WorldGenVersion,
		GameBuild: m.GameBuild, Resolution: m.Resolution, Radius: m.Radius, WaterLevel: terrain.WaterLevel,
		RenderedAt: img.RenderedAt, Biomes: terrain.BiomeNames,
	})
}

// terrainTilesJSON serves GET /terrain/tiles.json: the tile pyramid's build,
// levels and the game's palette when the bridge could read it. Small and
// sent fresh: the build changes with a game update.
func (s *Server) terrainTilesJSON(w http.ResponseWriter, r *http.Request) {
	if s.opt.Tiles == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "message": "no terrain tiles"})
		return
	}
	doc, err := s.opt.Tiles.Doc(r.Context())
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "message": err.Error()})
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	writeJSON(w, http.StatusOK, doc)
}

// terrainTile serves GET /terrain/tile?z=&x=&y=&v=: one gzipped tile
// (bridge/plugin/TerrainTile.cs format). v is the build from tiles.json; a
// tile for another build is 404, so the URL is immutable.
func (s *Server) terrainTile(w http.ResponseWriter, r *http.Request) {
	if s.opt.Tiles == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "message": "no terrain tiles"})
		return
	}
	q := r.URL.Query()
	z, ez := strconv.Atoi(q.Get("z"))
	x, ex := strconv.Atoi(q.Get("x"))
	y, ey := strconv.Atoi(q.Get("y"))
	if ez != nil || ex != nil || ey != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "z, x and y must be integers"})
		return
	}
	v := q.Get("v")
	if len(v) > 64 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "bad build"})
		return
	}
	body, build, err := s.opt.Tiles.Tile(r.Context(), z, x, y, v)
	if err != nil {
		status := http.StatusBadGateway
		var te *terrain.TileError
		if errors.As(err, &te) {
			status = te.Status
		} else if r.Context().Err() != nil {
			return
		}
		if status == http.StatusTooManyRequests || status == http.StatusServiceUnavailable {
			w.Header().Set("Retry-After", "1")
		}
		writeJSON(w, status, map[string]any{"ok": false, "message": err.Error()})
		return
	}
	h := w.Header()
	h.Set("ETag", `"tt-`+build+`-`+strconv.Itoa(z)+`-`+strconv.Itoa(x)+`-`+strconv.Itoa(y)+`"`)
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	h.Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(body))
}

func (s *Server) terrainTileMetrics(p *promWriter) {
	if s.opt.Tiles == nil {
		return
	}
	st := s.opt.Tiles.Stats()
	p.family("valheim_terrain_tiles_total", "counter", "Terrain tile requests by how they were answered.")
	p.sample("valheim_terrain_tiles_total", float64(st.Hits), "result", "cache")
	p.sample("valheim_terrain_tiles_total", float64(st.BridgeTiles), "result", "bridge")
	p.sample("valheim_terrain_tiles_total", float64(st.GridTiles), "result", "grid")
	p.sample("valheim_terrain_tiles_total", float64(st.Derived), "result", "derived")
	p.sample("valheim_terrain_tiles_total", float64(st.Errors), "result", "error")
	p.sample("valheim_terrain_tiles_total", float64(st.Dropped), "result", "dropped")
	p.family("valheim_terrain_bridge_sample_seconds_total", "counter", "Time the bridge plugin spent sampling terrain tiles.")
	p.sample("valheim_terrain_bridge_sample_seconds_total", float64(st.BridgeMs)/1000)
	p.family("valheim_terrain_cache_bytes", "gauge", "Bytes of terrain tiles in the cache.")
	p.sample("valheim_terrain_cache_bytes", float64(st.CacheBytes))
	if st.BakeTotal > 0 {
		p.family("valheim_terrain_bake_progress", "gauge", "Share of the current build's tile pyramid on disk, 0 to 1.")
		p.sample("valheim_terrain_bake_progress", float64(st.BakeDone)/float64(st.BakeTotal))
	}
}
