package server

import (
	"compress/gzip"
	"encoding/json"
	"net/http"
	"testing"
)

func getPieces(t *testing.T, url, query, tok string, hdr map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("GET", url+"/pieces"+query, nil)
	if tok != "" {
		req.Header.Set("X-Agent-Token", tok)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := (&http.Transport{DisableCompression: true}).RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func TestPiecesEndpoint(t *testing.T) {
	_, srv := mapServer(t, true)
	// The fixture's main base sits around (80..130, -210..-170).
	base := "?x0=60&z0=-240&x1=160&z1=-160"

	if r := getPieces(t, srv.URL, base, "", nil); r.StatusCode != 401 {
		t.Errorf("no token = %d", r.StatusCode)
	}
	if r := getPieces(t, srv.URL, base, "wrong", nil); r.StatusCode != 401 {
		t.Errorf("wrong token = %d", r.StatusCode)
	}

	r := getPieces(t, srv.URL, base, token, nil)
	if r.StatusCode != 200 || r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		t.Fatalf("GET = %d %v", r.StatusCode, r.Header)
	}
	etag := r.Header.Get("ETag")
	var doc struct {
		Generation int         `json:"generation"`
		Prefabs    [][]any     `json:"prefabs"`
		Pieces     [][]float64 `json:"pieces"`
		Count      int         `json:"count"`
		Truncated  bool        `json:"truncated"`
	}
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	if doc.Generation != 3 || doc.Count < 36 || doc.Count != len(doc.Pieces) || doc.Truncated || etag == "" {
		t.Errorf("doc gen %d count %d/%d truncated %v etag %q", doc.Generation, doc.Count, len(doc.Pieces), doc.Truncated, etag)
	}
	for _, pc := range doc.Pieces {
		if len(pc) != 6 || int(pc[0]) >= len(doc.Prefabs) || pc[1] < 60 || pc[1] > 160 || pc[2] < -240 || pc[2] > -160 {
			t.Fatalf("piece %v outside the box or malformed", pc)
		}
	}

	gz := getPieces(t, srv.URL, base, token, map[string]string{"Accept-Encoding": "gzip"})
	if gz.Header.Get("Content-Encoding") != "gzip" || gz.Header.Get("ETag") != etag || gz.Header.Get("Vary") != "Accept-Encoding" {
		t.Fatalf("gzip headers = %v", gz.Header)
	}
	zr, err := gzip.NewReader(gz.Body)
	if err != nil {
		t.Fatal(err)
	}
	var again map[string]any
	if err := json.NewDecoder(zr).Decode(&again); err != nil || again["count"] != float64(doc.Count) {
		t.Errorf("gzip body = %v %v", again["count"], err)
	}

	if r := getPieces(t, srv.URL, base, token, map[string]string{"If-None-Match": etag}); r.StatusCode != 304 {
		t.Errorf("If-None-Match = %d", r.StatusCode)
	}
	other := getPieces(t, srv.URL, "?x0=0&z0=0&x1=10&z1=10", token, nil)
	if other.StatusCode != 200 || other.Header.Get("ETag") == etag {
		t.Errorf("another box = %d etag %q", other.StatusCode, other.Header.Get("ETag"))
	}

	for _, q := range []string{"", "?x0=0&z0=0&x1=10", "?x0=a&z0=0&x1=10&z1=10", "?x0=10&z0=0&x1=0&z1=10",
		"?x0=0&z0=0&x1=2000&z1=10", "?x0=NaN&z0=0&x1=1&z1=1"} {
		if r := getPieces(t, srv.URL, q, token, nil); r.StatusCode != 400 {
			t.Errorf("%q = %d, want 400", q, r.StatusCode)
		}
	}
}

func TestPiecesEndpointNotReady(t *testing.T) {
	_, srv := mapServer(t, false)
	if r := getPieces(t, srv.URL, "?x0=0&z0=0&x1=1&z1=1", token, nil); r.StatusCode != 503 || r.Header.Get("Retry-After") == "" {
		t.Errorf("before the first build = %d", r.StatusCode)
	}
	h := newHarness(t)
	if r := h.do(t, "GET", "/pieces?x0=0&z0=0&x1=1&z1=1", token); r.StatusCode != 404 {
		t.Errorf("map off = %d", r.StatusCode)
	}
}
