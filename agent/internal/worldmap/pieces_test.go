package worldmap

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"strings"
	"testing"
)

// rot4 packs Euler angles (half degrees) the way WriteSmallRotation does.
func rot4(x, y, z uint32) [2]uint16 {
	v := x | y<<10 | z<<20
	return [2]uint16{uint16(v >> 16), uint16(v)}
}

func TestRotation(t *testing.T) {
	for _, c := range []struct {
		name   string
		has    bool
		w      [2]uint16
		yaw    uint16
		tilted bool
	}{
		{"absent", false, [2]uint16{}, 0, false},
		{"short 90", true, [2]uint16{0x8000 | 180}, 180, false},
		{"short wraps", true, [2]uint16{0x8000 | 0x1234}, 0x1234 % 720, false},
		{"long yaw only", true, rot4(0, 540, 0), 540, false},
		{"long 359.5", true, rot4(0, 719, 0), 719, false},
		// (180, 10, 180) is the upright piece turned 190 degrees.
		{"flipped twice", true, rot4(360, 20, 360), 380, false},
		{"slight lean", true, rot4(10, 90, 0), 90, false},
		{"pitched 26", true, rot4(52, 180, 0), 180, true},
		{"rolled 45", true, rot4(0, 0, 90), 0, true},
		{"on its side", true, rot4(0, 180, 180), 180, true},
	} {
		yaw, tilted := rotation(c.has, c.w)
		if yaw != c.yaw || tilted != c.tilted {
			t.Errorf("%s: rotation = %d %v, want %d %v", c.name, yaw, tilted, c.yaw, c.tilted)
		}
	}
}

func TestFootprintOf(t *testing.T) {
	for _, c := range []struct {
		name  string
		want  footprint
		known bool
	}{
		{"woodwall", footprint{PieceWall, 2, 0.25, 0}, true},
		{"wood_floor_1x1", footprint{PieceFloor, 1, 1, 0}, true},
		{"wood_roof", footprint{PieceRoof, 2, 2, 26}, true},
		{"wood_roof_67", footprint{PieceRoof, 2, 1, 67}, true},
		{"wood_stair", footprint{PieceStair, 2, 2, 0}, true},
		{"sapling_carrot", footprint{PiecePlant, 0.5, 0.5, 0}, true},
		{"#12345", unknownFootprint, false},
		{"WoodWall", unknownFootprint, false},
	} {
		got, known := footprintOf(c.name)
		if got != c.want || known != c.known {
			t.Errorf("footprintOf(%q) = %+v %v, want %+v %v", c.name, got, known, c.want, c.known)
		}
	}
	if pieceName(stableHash("woodwall")) != "woodwall" || pieceName(stableHash("piece_workbench")) != "piece_workbench" {
		t.Error("table prefabs are not named")
	}
	if n := pieceName(424242); n != "#424242" {
		t.Errorf("unknown name = %q", n)
	}
	for name, fp := range footprints {
		if fp.w <= 0 || fp.d <= 0 || fp.kind == "" {
			t.Errorf("%s: bad footprint %+v", name, fp)
		}
	}
}

// chunkWriter writes the subset of the ZDO layout the piece tests need.
type chunkWriter struct {
	b bytes.Buffer
	n int32
}

func (cw *chunkWriter) zdo(prefab string, x, y, z float32, rot *[2]uint16, creator *int64) {
	w := func(v any) { _ = binary.Write(&cw.b, binary.LittleEndian, v) }
	var flags uint16
	if rot != nil {
		flags |= flagRotation
	}
	if creator != nil {
		flags |= 0x20
	}
	w(flags)
	w(x)
	w(y)
	w(z)
	w(stableHash(prefab))
	if rot != nil {
		w(rot[0])
		if rot[0]&0x8000 == 0 {
			w(rot[1])
		}
	}
	if creator != nil {
		cw.b.WriteByte(1)
		w(keyCreator)
		w(*creator)
	}
	cw.n++
}

func (cw *chunkWriter) bytes() []byte {
	var out bytes.Buffer
	_ = binary.Write(&out, binary.LittleEndian, uint16(41))
	_ = binary.Write(&out, binary.LittleEndian, cw.n)
	out.Write(cw.b.Bytes())
	return out.Bytes()
}

func TestParseChunkPieces(t *testing.T) {
	player, nobody := int64(-77), int64(0)
	yaw := [2]uint16{0x8000 | 180}
	tilt := rot4(52, 0, 0)
	var cw chunkWriter
	cw.zdo("woodwall", 10, 31.5, 20, &yaw, &player)
	cw.zdo("wood_roof", 12, 34, 20, &tilt, &player)
	cw.zdo("wood_floor", 14, 30, 20, nil, &player)
	cw.zdo("woodwall", 16, 30, 20, &yaw, &nobody) // creator 0: not a player's
	cw.zdo("woodwall", 18, 30, 20, &yaw, nil)     // a dungeon wall
	cw.zdo("Karve", 20, 30, 20, &yaw, &player)    // ships are not pieces
	cd, err := parseChunk(cw.bytes())
	if err != nil {
		t.Fatal(err)
	}
	want := []rawPiece{
		{hash: stableHash("woodwall"), x: 10, y: 31.5, z: 20, yaw: 180},
		{hash: stableHash("wood_roof"), x: 12, y: 34, z: 20, yaw: 0, tilted: true},
		{hash: stableHash("wood_floor"), x: 14, y: 30, z: 20},
	}
	if len(cd.built) != len(want) {
		t.Fatalf("built = %+v", cd.built)
	}
	for i := range want {
		if cd.built[i] != want[i] {
			t.Errorf("built[%d] = %+v, want %+v", i, cd.built[i], want[i])
		}
	}
}

func testPieces() *Pieces {
	a, b := newChunkData(), newChunkData()
	// A 5 x 5 grid of walls every 10 m, on two floors, split over two chunks.
	for i := 0; i < 25; i++ {
		x, z := float32(i%5*10), float32(i/5*10)
		a.built = append(a.built, rawPiece{hash: stableHash("woodwall"), x: x, y: 30, z: z, yaw: 180})
		b.built = append(b.built, rawPiece{hash: stableHash("wood_floor"), x: x + 0.123, y: 33, z: z})
	}
	b.built = append(b.built, rawPiece{hash: 99, x: 500, y: 30, z: 500, yaw: 719, tilted: true})
	return buildPieces([]*chunkData{a, b})
}

type piecesDoc struct {
	Generation int         `json:"generation"`
	BBox       []float64   `json:"bbox"`
	Prefabs    [][]any     `json:"prefabs"`
	Pieces     [][]float64 `json:"pieces"`
	Count      int         `json:"count"`
	Truncated  bool        `json:"truncated"`
}

func decodePieces(t *testing.T, b []byte) piecesDoc {
	t.Helper()
	var d piecesDoc
	if err := json.Unmarshal(b, &d); err != nil {
		t.Fatalf("%v: %s", err, b)
	}
	return d
}

func TestPiecesQuery(t *testing.T) {
	p := testPieces()
	if p.Len() != 51 {
		t.Fatalf("len = %d", p.Len())
	}
	for _, c := range []struct {
		name           string
		x0, z0, x1, z1 float64
		max            int
		count          int
		truncated      bool
	}{
		{"everything", -100, -100, 600, 600, MaxPieces, 51, false},
		{"one corner, edges inclusive", 0, 0, 10, 10, MaxPieces, 4 + 2, false},
		{"empty sea", 1000, 1000, 1100, 1100, MaxPieces, 0, false},
		{"capped", -100, -100, 600, 600, 7, 7, true},
		{"exactly at cap", 0, 0, 10, 10, 6, 6, false},
		{"across a zone edge", 25, -5, 45, 45, MaxPieces, 20, false},
	} {
		q := p.Query(c.x0, c.z0, c.x1, c.z1, c.max)
		if q.Count() != c.count || q.Truncated != c.truncated {
			t.Errorf("%s: count %d truncated %v, want %d %v", c.name, q.Count(), q.Truncated, c.count, c.truncated)
		}
	}

	d := decodePieces(t, p.AppendJSON(nil, p.Query(0, 0, 10, 10, MaxPieces), 7))
	if d.Generation != 7 || d.Count != 6 || d.Truncated || len(d.BBox) != 4 || d.BBox[2] != 10 {
		t.Errorf("doc = %+v", d)
	}
	// Only the prefabs used, sorted by name; floors at 0.123 round to 0.1.
	if len(d.Prefabs) != 2 || d.Prefabs[0][0] != "wood_floor" || d.Prefabs[1][0] != "woodwall" ||
		d.Prefabs[1][1] != "wall" || d.Prefabs[1][2] != 2.0 || d.Prefabs[1][3] != 0.25 || d.Prefabs[1][5] != true {
		t.Errorf("prefabs = %v", d.Prefabs)
	}
	floors, walls := 0, 0
	for _, pc := range d.Pieces {
		switch pc[0] {
		case 0:
			floors++
			if pc[1] != 0.1 && pc[1] != 10.1 || pc[3] != 33 {
				t.Errorf("floor = %v", pc)
			}
		case 1:
			walls++
			if pc[4] != 90 || pc[5] != 0 || pc[3] != 30 {
				t.Errorf("wall = %v", pc)
			}
		}
	}
	if floors != 2 || walls != 4 {
		t.Errorf("floors %d walls %d", floors, walls)
	}
	// Within a zone, lower pieces come first.
	if d.Pieces[0][0] != 1 {
		t.Errorf("first piece = %v, want a wall (lowest)", d.Pieces[0])
	}

	far := decodePieces(t, p.AppendJSON(nil, p.Query(490, 490, 510, 510, MaxPieces), 7))
	if len(far.Pieces) != 1 || far.Prefabs[0][0] != "#99" || far.Prefabs[0][1] != "other" || far.Prefabs[0][5] != false ||
		far.Pieces[0][4] != 0 || far.Pieces[0][5] != 1 {
		t.Errorf("unknown tilted piece = %+v", far)
	}
}

func TestPiecesDeterministic(t *testing.T) {
	a := testPieces()
	b := testPieces()
	if a.ETag == "" || a.ETag != b.ETag {
		t.Errorf("etags %q %q", a.ETag, b.ETag)
	}
	// Chunk order does not matter.
	c1, c2 := newChunkData(), newChunkData()
	c1.built = []rawPiece{{hash: stableHash("woodwall"), x: 1, y: 2, z: 3}}
	c2.built = []rawPiece{{hash: stableHash("wood_floor"), x: 1, y: 1, z: 3}}
	x, y := buildPieces([]*chunkData{c1, c2}), buildPieces([]*chunkData{c2, c1})
	jx := x.AppendJSON(nil, x.Query(0, 0, 5, 5, MaxPieces), 1)
	jy := y.AppendJSON(nil, y.Query(0, 0, 5, 5, MaxPieces), 1)
	if x.ETag != y.ETag || !bytes.Equal(jx, jy) {
		t.Errorf("order dependent:\n%s\n%s", jx, jy)
	}
	c2.built[0].yaw = 2
	if buildPieces([]*chunkData{c1, c2}).ETag == x.ETag {
		t.Error("a turned piece kept the etag")
	}
}

func TestFixturePieces(t *testing.T) {
	enc := build(t, fixture, false).Current()
	p := enc.Pieces
	// Every built, non-vehicle object of the fixture; none of the world's.
	if p.Len() < 40 || p.Len() != enc.Snapshot.Stats.Pieces {
		t.Errorf("pieces = %d, stats = %d", p.Len(), enc.Snapshot.Stats.Pieces)
	}
	j := string(p.AppendJSON(nil, p.Query(-10500, -10500, 10500, 10500, MaxPieces), enc.Generation))
	for _, bad := range []string{"Beech1", "FirTree", "TreasureChest", "Karve", "Raft", "Cart", "Pickable"} {
		if strings.Contains(j, bad) {
			t.Errorf("pieces include %s", bad)
		}
	}
	if !strings.Contains(j, `"piece_workbench","station"`) {
		t.Errorf("no workbench: %s", j[:200])
	}
}
