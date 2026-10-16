package bridge

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTerrainInfoAndTile(t *testing.T) {
	var got http.Header
	var query string
	tile := append([]byte("SKT1"), bytes.Repeat([]byte{7}, 40)...)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, query = r.Header, r.URL.RawQuery
		switch r.URL.Path {
		case "/v1/terrain/info":
			_, _ = w.Write([]byte(`{"ok":true,"data":{"seedHash":-12,"worldGenVersion":2,"gameBuild":"l-1.0.17","forest":"mask","palette":{"source":"none"}}}`))
		case "/v1/terrain/tile":
			if r.URL.Query().Get("x") == "999" {
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = w.Write([]byte(`{"ok":false,"error":"terrain sampler busy"}`))
				return
			}
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("X-Skald-Sample-Ms", "321")
			_, _ = w.Write(tile)
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	c := New(Options{URL: srv.URL, Token: testToken})
	ctx := context.Background()
	info, err := c.TerrainInfo(ctx)
	if err != nil || info.SeedHash != -12 || info.Forest != "mask" || info.Palette.Source != "none" {
		t.Fatalf("info %+v err %v", info, err)
	}
	if got.Get("X-Skald-Token") != testToken {
		t.Fatal("no token on the info call")
	}
	body, ms, err := c.TerrainTile(ctx, 258, -10500.5, 10500.25, 0.640869140625)
	if err != nil || !bytes.Equal(body, tile) || ms != 321 {
		t.Fatalf("tile %q ms %d err %v", body, ms, err)
	}
	if got.Get("X-Skald-Token") != testToken || query != "n=258&step=0.64086914&x=-10500.5&z=10500.25" {
		t.Fatalf("query %q", query)
	}
	if _, _, err := c.TerrainTile(ctx, 258, 999, 0, 1); StatusOf(err) != http.StatusTooManyRequests {
		t.Fatalf("busy: %v", err)
	}
}
