package server

import (
	"compress/gzip"
	"encoding/json"
	"net/http"
	"testing"
)

func getNature(t *testing.T, url, query, tok string, hdr map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("GET", url+"/nature"+query, nil)
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

type natureBody struct {
	Generation int         `json:"generation"`
	Spoilers   bool        `json:"spoilers"`
	Kinds      [][]any     `json:"kinds"`
	Items      [][]float64 `json:"items"`
	Count      int         `json:"count"`
	Truncated  bool        `json:"truncated"`
}

func decodeNature(t *testing.T, r *http.Response) natureBody {
	t.Helper()
	var doc natureBody
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func TestNatureEndpoint(t *testing.T) {
	_, srv := mapServer(t, true)
	// The fixture's island spans about (-280..280) on both axes; its east
	// edge is outside the explored area and far from the base.
	island := "?x0=-300&z0=-300&x1=300&z1=300"
	east := "?x0=220&z0=-40&x1=300&z1=40"

	if r := getNature(t, srv.URL, island, "", nil); r.StatusCode != 401 {
		t.Errorf("no token = %d", r.StatusCode)
	}
	if r := getNature(t, srv.URL, island, "wrong", nil); r.StatusCode != 401 {
		t.Errorf("wrong token = %d", r.StatusCode)
	}

	r := getNature(t, srv.URL, island, token, nil)
	if r.StatusCode != 200 || r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		t.Fatalf("GET = %d %v", r.StatusCode, r.Header)
	}
	etag := r.Header.Get("ETag")
	doc := decodeNature(t, r)
	if doc.Generation != 3 || doc.Count == 0 || doc.Count != len(doc.Items) || doc.Truncated || doc.Spoilers || etag == "" {
		t.Errorf("doc gen %d count %d/%d truncated %v spoilers %v etag %q", doc.Generation, doc.Count, len(doc.Items), doc.Truncated, doc.Spoilers, etag)
	}
	for _, it := range doc.Items {
		if len(it) != 5 || int(it[0]) >= len(doc.Kinds) || it[1] < -300 || it[1] > 300 || it[2] < -300 || it[2] > 300 {
			t.Fatalf("item %v outside the box or malformed", it)
		}
	}
	for _, k := range doc.Kinds {
		if len(k) != 4 {
			t.Fatalf("kind %v malformed", k)
		}
	}

	// Spoilers: the unexplored edge is empty by default and shown on request,
	// with its own ETag.
	if d := decodeNature(t, getNature(t, srv.URL, east, token, nil)); d.Count != 0 {
		t.Errorf("east edge without spoilers = %d items", d.Count)
	}
	sp := getNature(t, srv.URL, island+"&spoilers=true", token, nil)
	if sp.StatusCode != 200 || sp.Header.Get("ETag") == etag {
		t.Errorf("spoilers = %d etag %q", sp.StatusCode, sp.Header.Get("ETag"))
	}
	if d := decodeNature(t, sp); !d.Spoilers || d.Count <= doc.Count {
		t.Errorf("spoilers count %d, without %d", d.Count, doc.Count)
	}
	if d := decodeNature(t, getNature(t, srv.URL, east+"&spoilers=1", token, nil)); d.Count == 0 {
		t.Error("east edge empty with spoilers")
	}
	if r := getNature(t, srv.URL, island+"&spoilers=false", token, nil); r.Header.Get("ETag") != etag {
		t.Errorf("spoilers=false etag %q, want %q", r.Header.Get("ETag"), etag)
	}

	gz := getNature(t, srv.URL, island, token, map[string]string{"Accept-Encoding": "gzip"})
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

	if r := getNature(t, srv.URL, island, token, map[string]string{"If-None-Match": etag}); r.StatusCode != 304 {
		t.Errorf("If-None-Match = %d", r.StatusCode)
	}

	for _, q := range []string{"", "?x0=0&z0=0&x1=10", "?x0=a&z0=0&x1=10&z1=10", "?x0=10&z0=0&x1=0&z1=10",
		"?x0=0&z0=0&x1=2000&z1=10", "?x0=NaN&z0=0&x1=1&z1=1", "?x0=0&z0=0&x1=1&z1=1&spoilers=maybe"} {
		if r := getNature(t, srv.URL, q, token, nil); r.StatusCode != 400 {
			t.Errorf("%q = %d, want 400", q, r.StatusCode)
		}
	}
}

func TestNatureEndpointNotReady(t *testing.T) {
	_, srv := mapServer(t, false)
	if r := getNature(t, srv.URL, "?x0=0&z0=0&x1=1&z1=1", token, nil); r.StatusCode != 503 || r.Header.Get("Retry-After") == "" {
		t.Errorf("before the first build = %d", r.StatusCode)
	}
	h := newHarness(t)
	if r := h.do(t, "GET", "/nature?x0=0&z0=0&x1=1&z1=1", token); r.StatusCode != 404 {
		t.Errorf("map off = %d", r.StatusCode)
	}
}
