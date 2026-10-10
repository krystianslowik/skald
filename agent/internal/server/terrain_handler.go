package server

import (
	"bytes"
	"net/http"
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
// sits, for the web to place it. Revalidated by the same ETag.
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
