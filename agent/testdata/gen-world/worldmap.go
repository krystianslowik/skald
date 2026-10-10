package main

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"path/filepath"
)

// The -map world: a made-up island around the origin with a main base, a
// second island far north-east with an outpost, five portals (one pair by
// connection, one pair by tag only, one alone), two graves, two beds, a
// karve, a raft and a cart, a cartography table with an explored corridor and
// pins, terrain edits, and a few objects parked far outside the world the way
// the game parks zone controllers. Owner ids, tag authors and pin authors
// are fake platform ids so the privacy tests have something to look for.

// Fake platform ids. They must never show up in the map JSON.
const (
	fakeSteamID = "Steam_76561190000000099"
	fakeXboxID  = "Xbox_2533274900000077"
	fakeOwnerID = int64(-4611686018427387001)
)

func stableHash(s string) int32 {
	var a, b uint32 = 5381, 5381
	for i := 0; i < len(s); i += 2 {
		a = ((a << 5) + a) ^ uint32(s[i])
		if i == len(s)-1 {
			break
		}
		b = ((b << 5) + b) ^ uint32(s[i+1])
	}
	return int32(a + b*1566083941)
}

type kv[T any] struct {
	key string
	val T
}

// zdo describes one object; the writer derives the flags from what is set.
type zdo struct {
	prefab   string
	x, y, z  float32
	short    bool // 0x2000: i16 x, z
	rot      int  // 0, 2 (compact) or 4 bytes
	conn     bool
	connType byte
	connHash int32
	floats   []kv[float32]
	ints     []kv[int32]
	longs    []kv[int64]
	strs     []kv[string]
	byts     []kv[[]byte]
	// pad adds this many extra float entries so the map count needs two bytes.
	pad int
}

func mapCount(b *bytes.Buffer, n int) {
	if n < 0x80 {
		b.WriteByte(byte(n))
		return
	}
	b.WriteByte(byte(n>>8) | 0x80)
	b.WriteByte(byte(n))
}

func f32(b *bytes.Buffer, v float32) { _ = binary.Write(b, binary.LittleEndian, v) }
func i64(b *bytes.Buffer, v int64)   { _ = binary.Write(b, binary.LittleEndian, v) }

func (z zdo) write(b *bytes.Buffer) {
	var flags uint16
	if z.conn {
		flags |= 0x01
	}
	if len(z.floats) > 0 || z.pad > 0 {
		flags |= 0x02
	}
	if len(z.ints) > 0 {
		flags |= 0x10
	}
	if len(z.longs) > 0 {
		flags |= 0x20
	}
	if len(z.strs) > 0 {
		flags |= 0x40
	}
	if len(z.byts) > 0 {
		flags |= 0x80
	}
	if z.rot != 0 {
		flags |= 0x1000
	}
	if z.short {
		flags |= 0x2000
	}
	_ = binary.Write(b, binary.LittleEndian, flags)
	if z.short {
		_ = binary.Write(b, binary.LittleEndian, int16(z.x))
		_ = binary.Write(b, binary.LittleEndian, int16(z.z))
	} else {
		f32(b, z.x)
		f32(b, z.y)
		f32(b, z.z)
	}
	i32(b, stableHash(z.prefab))
	switch z.rot {
	case 2:
		_ = binary.Write(b, binary.LittleEndian, uint16(0x8000|0x1234))
	case 4:
		_ = binary.Write(b, binary.LittleEndian, uint16(0x0123))
		_ = binary.Write(b, binary.LittleEndian, uint16(0x4567))
	}
	if z.conn {
		b.WriteByte(z.connType)
		i32(b, z.connHash)
	}
	if flags&0x02 != 0 {
		mapCount(b, len(z.floats)+z.pad)
		for _, e := range z.floats {
			i32(b, stableHash(e.key))
			f32(b, e.val)
		}
		for i := 0; i < z.pad; i++ {
			i32(b, stableHash(fmt.Sprintf("pad%d", i)))
			f32(b, float32(i))
		}
	}
	if len(z.ints) > 0 {
		mapCount(b, len(z.ints))
		for _, e := range z.ints {
			i32(b, stableHash(e.key))
			i32(b, e.val)
		}
	}
	if len(z.longs) > 0 {
		mapCount(b, len(z.longs))
		for _, e := range z.longs {
			i32(b, stableHash(e.key))
			i64(b, e.val)
		}
	}
	if len(z.strs) > 0 {
		mapCount(b, len(z.strs))
		for _, e := range z.strs {
			i32(b, stableHash(e.key))
			str(b, e.val)
		}
	}
	if len(z.byts) > 0 {
		mapCount(b, len(z.byts))
		for _, e := range z.byts {
			i32(b, stableHash(e.key))
			i32(b, int32(len(e.val)))
			b.Write(e.val)
		}
	}
}

func chunkBytes(zs []zdo) []byte {
	var b bytes.Buffer
	_ = binary.Write(&b, binary.LittleEndian, uint16(41))
	i32(&b, int32(len(zs)))
	for _, z := range zs {
		z.write(&b)
	}
	return b.Bytes()
}

func gz(raw []byte) []byte {
	var out bytes.Buffer
	zw := gzip.NewWriter(&out)
	_, _ = zw.Write(raw)
	_ = zw.Close()
	return out.Bytes()
}

// piece is a player-built object: it carries a creator id.
func piece(prefab string, x, z float32) zdo {
	return zdo{prefab: prefab, x: x, y: 30, z: z, rot: 4, longs: []kv[int64]{{"creator", fakeOwnerID}}}
}

// cartographyData writes a table's explored mask (a corridor from the main
// base towards the outpost plus a disc around spawn) and three pins.
func cartographyData() []byte {
	const size, mpp = 2048, 12
	var raw bytes.Buffer
	i32(&raw, 3)
	i32(&raw, size*size)
	mask := make([]byte, size*size)
	mark := func(x, z float64) {
		col := int(math.Round(x/mpp)) + size/2
		row := int(math.Round(z/mpp)) + size/2
		if col >= 0 && row >= 0 && col < size && row < size {
			mask[row*size+col] = 1
		}
	}
	for x := -170.0; x <= 170; x += 6 {
		for z := -170.0; z <= 170; z += 6 {
			if x*x+z*z <= 160*160 {
				mark(x, z)
			}
		}
	}
	for t := 0.0; t <= 1; t += 0.002 {
		for w := -60.0; w <= 60; w += 6 {
			mark(t*2000+w, t*2000-w)
		}
	}
	raw.Write(mask)
	pins := []struct {
		name string
		x, z float32
		typ  int32
	}{
		{"Home fire", 100, -200, 0},
		{"Copper here", 40, 60, 3},
		{"Eikthyr", 120, 90, 9},
	}
	i32(&raw, int32(len(pins)))
	for _, p := range pins {
		i64(&raw, fakeOwnerID)
		str(&raw, p.name)
		f32(&raw, p.x)
		f32(&raw, 40)
		f32(&raw, p.z)
		i32(&raw, p.typ)
		raw.WriteByte(1)
		str(&raw, fakeSteamID)
	}
	return gz(raw.Bytes())
}

// terrainData writes a terrain compiler's TCData with `levelled` levelled
// cells, `painted` painted cells and `both` cells that are both.
func terrainData(levelled, painted, both int) []byte {
	var raw bytes.Buffer
	i32(&raw, 1)
	i32(&raw, 12)
	f32(&raw, 1)
	f32(&raw, 2)
	f32(&raw, 3)
	f32(&raw, 4)
	const cells = 65 * 65
	i32(&raw, cells)
	for i := 0; i < cells; i++ {
		if i < levelled+both {
			raw.WriteByte(1)
			f32(&raw, 0.5)
			f32(&raw, 0)
		} else {
			raw.WriteByte(0)
		}
	}
	i32(&raw, cells)
	for i := 0; i < cells; i++ {
		// The first `both` cells are levelled and painted, the next `painted` only painted.
		if i < both || (i >= levelled+both && i < levelled+both+painted) {
			raw.WriteByte(1)
			for k := 0; k < 4; k++ {
				f32(&raw, 0.25)
			}
		} else {
			raw.WriteByte(0)
		}
	}
	return gz(raw.Bytes())
}

func onIsland(zx, zz int) bool { return zx*zx+zz*zz <= 16 }

func writeMapWorld(dir string) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		panic(err)
	}
	write := func(name string, b []byte) {
		if err := os.WriteFile(filepath.Join(dir, name), b, 0o644); err != nil {
			panic(err)
		}
	}

	// Chunk 20_20__1_4: the main island, its base and everything around it.
	var island []zdo
	for zx := -4; zx <= 4; zx++ {
		for zz := -4; zz <= 4; zz++ {
			if !onIsland(zx, zz) {
				continue
			}
			for k := 0; k < 6+zx*zx; k++ {
				x := float32(zx*64 + (k*7)%40 - 20)
				z := float32(zz*64 + (k*11)%40 - 20)
				// Alternate the encodings the game uses.
				island = append(island, zdo{prefab: "Beech1", x: x, y: 32, z: z, short: k%2 == 0, rot: 2 * (k % 3), floats: []kv[float32]{{"health", 40}}})
			}
		}
	}
	for i := 0; i < 30; i++ {
		island = append(island, piece("wood_wall", float32(80+(i%6)*8), float32(-210+(i/6)*8)))
	}
	island = append(island,
		piece("piece_workbench", 100, -196),
		piece("forge", 108, -188),
		zdo{prefab: "bed", x: 90, y: 31, z: -185, rot: 4,
			longs: []kv[int64]{{"owner", fakeOwnerID}, {"creator", fakeOwnerID}},
			strs:  []kv[string]{{"ownerName", "Ragnar"}}},
		zdo{prefab: "piece_cartographytable", x: 104, y: 31, z: -204, rot: 4,
			ints:  []kv[int32]{{"addedDefaultItems", 1}},
			longs: []kv[int64]{{"creator", fakeOwnerID}},
			byts:  []kv[[]byte]{{"data", cartographyData()}}},
		zdo{prefab: "Player_tombstone", x: 120.4, y: 33, z: -260.6, rot: 4,
			floats: []kv[float32]{{"health", 1}},
			longs:  []kv[int64]{{"owner", fakeOwnerID}, {"timeOfDeath", int64((12*1800 + 400) * 1e7)}},
			strs:   []kv[string]{{"ownerName", "Bjorn"}},
			byts:   []kv[[]byte]{{"items", []byte{1, 2, 3}}}},
		zdo{prefab: "Karve", x: -150, y: 30, z: 250, rot: 4,
			floats: []kv[float32]{{"rudder", 0.1}},
			longs:  []kv[int64]{{"creator", fakeOwnerID}, {"user", fakeOwnerID}}},
		zdo{prefab: "Cart", x: 90, y: 34, z: 40, rot: 4, longs: []kv[int64]{{"creator", fakeOwnerID}}},
		zdo{prefab: "_TerrainCompiler", x: 128, y: 0, z: -192, byts: []kv[[]byte]{{"TCData", terrainData(40, 20, 10)}}},
		zdo{prefab: "_TerrainCompiler", x: 0, y: 0, z: 0, byts: []kv[[]byte]{{"TCData", terrainData(0, 5, 0)}}},
		// An object with a map of 130 entries: the count takes two bytes.
		zdo{prefab: "Pickable_Mushroom", x: 30, y: 31, z: 30, pad: 130},
		// A location proxy with a string the map does not read.
		zdo{prefab: "LocationProxy", x: 120, y: 31, z: 90, strs: []kv[string]{{"text", "a long rune text the map skips"}}, ints: []kv[int32]{{"location", stableHash("Eikthyrnir")}}},
	)

	// Chunk 22_22__1_2: the outpost island far to the north-east.
	var outpost []zdo
	for zx := 30; zx <= 32; zx++ {
		for zz := 30; zz <= 32; zz++ {
			for k := 0; k < 5; k++ {
				outpost = append(outpost, zdo{prefab: "FirTree", x: float32(zx*64 + k*9 - 20), y: 50, z: float32(zz*64 - k*7 + 10), rot: 4})
			}
		}
	}
	for i := 0; i < 8; i++ {
		outpost = append(outpost, piece("stone_wall", float32(1990+i*10), 2000))
	}
	outpost = append(outpost,
		zdo{prefab: "piece_bed02", x: 2010, y: 52, z: 2010, rot: 4,
			longs: []kv[int64]{{"owner", fakeOwnerID}, {"creator", fakeOwnerID}},
			strs:  []kv[string]{{"ownerName", "Freya"}}},
		zdo{prefab: "Player_tombstone", x: 1950, y: 50, z: 2080, rot: 4,
			longs: []kv[int64]{{"owner", fakeOwnerID}, {"timeOfDeath", int64((38*1800 + 10) * 1e7)}},
			strs:  []kv[string]{{"ownerName", "Freya"}}},
		zdo{prefab: "Raft", x: 1800, y: 30, z: 1900, rot: 4, longs: []kv[int64]{{"creator", fakeOwnerID}}},
	)

	// Chunk 00_01__0_7: every portal, as the game keeps them.
	portal := func(x, z float32, tag string) zdo {
		return zdo{prefab: "portal_wood", x: x, y: 31, z: z, rot: 4,
			ints:  []kv[int32]{{"state", 1}},
			longs: []kv[int64]{{"creator", fakeOwnerID}},
			strs:  []kv[string]{{"tag", tag}, {"tagauthor", fakeXboxID}}}
	}
	home := portal(96, -180, "home")
	home.conn, home.connType, home.connHash = true, 1, 777
	far := portal(2020, 1990, "home")
	far.conn, far.connType, far.connHash = true, 17, 777
	mineA := portal(84, -214, "mine")
	mineB := portal(260, -140, "mine")
	alone := portal(200, 200, "lost")
	portals := []zdo{home, far, mineA, mineB, alone}

	// Chunk 00_00__0_1: objects the game parks outside the world.
	parked := []zdo{
		{prefab: "_ZoneCtrl", x: 1e6, y: 0, z: 1e6},
		{prefab: "Leviathan", x: -1e6, y: 0, z: 1e6, rot: 4},
	}

	type chunk struct {
		x, z, g byte
		rev     int32
		zdos    []zdo
	}
	chunks := []chunk{
		{0x20, 0x20, 1, 4, island},
		{0x22, 0x22, 1, 2, outpost},
		{0x01, 0x00, 0, 7, portals},
		{0x00, 0x00, 0, 1, parked},
	}
	var index bytes.Buffer
	_ = binary.Write(&index, binary.LittleEndian, uint16(41))
	total := 0
	for _, c := range chunks {
		total += len(c.zdos)
	}
	i32(&index, int32(total))
	i32(&index, int32(len(chunks)))
	for _, c := range chunks {
		index.WriteByte(c.x)
		index.WriteByte(c.z)
		index.WriteByte(c.g)
		i32(&index, c.rev)
		i32(&index, int32(len(c.zdos)))
		write(fmt.Sprintf("%02x_%02x__%d_%d.chunk", c.z, c.x, c.g, c.rev), chunkBytes(c.zdos))
	}

	// .fwl2
	var p bytes.Buffer
	i32(&p, 41)
	str(&p, "Midgard")
	str(&p, "Yggdrasil1")
	i32(&p, 123456789)
	i64(&p, 987654321)
	i32(&p, 2)
	p.WriteByte(1)
	strs(&p, []string{})
	i32(&p, 0)
	var fwl bytes.Buffer
	i32(&fwl, int32(p.Len()))
	fwl.Write(p.Bytes())

	// .db2: generated zones (the two islands and the sea around them), the
	// global keys and the location list.
	var blob bytes.Buffer
	var zones [][2]int16
	for zx := -8; zx <= 8; zx++ {
		for zz := -8; zz <= 8; zz++ {
			zones = append(zones, [2]int16{int16(zx), int16(zz)})
		}
	}
	for zx := 28; zx <= 34; zx++ {
		for zz := 28; zz <= 34; zz++ {
			zones = append(zones, [2]int16{int16(zx), int16(zz)})
		}
	}
	i32(&blob, int32(len(zones)))
	for _, z := range zones {
		_ = binary.Write(&blob, binary.LittleEndian, z)
	}
	i32(&blob, 32)
	strs(&blob, []string{"defeated_eikthyr"})
	blob.WriteByte(1)
	locations := []struct {
		name   string
		x, z   float32
		placed bool
	}{
		{"StartTemple", 0, 0, true},
		{"Eikthyrnir", 120, 90, true},     // inside the explored disc
		{"Crypt2", 40, -190, true},        // outside the mask, near the base
		{"TrollCave02", 1000, 1000, true}, // on the explored corridor
		{"GDKing", 3000, -2500, false},    // never seen
		{"Vendor_BlackForest", -2600, 4100, false},
		{"Hildir_camp", 2100, 1950, true}, // in the outpost's zone, not near it
		{"Greydwarf_camp1", 100, 100, true},
		{"Runestone_Meadows", -50, 80, true},
		{"InfestedTree01", 7000, 7000, false},
	}
	i32(&blob, int32(len(locations)))
	for _, l := range locations {
		i32(&blob, stableHash(l.name))
		f32(&blob, l.x)
		f32(&blob, 30)
		f32(&blob, l.z)
		if l.placed {
			blob.WriteByte(1)
		} else {
			blob.WriteByte(0)
		}
	}
	gzBlob := gz(blob.Bytes())
	var db bytes.Buffer
	i32(&db, 41)
	_ = binary.Write(&db, binary.LittleEndian, math.Float64bits(40*1800+900))
	i32(&db, int32(len(gzBlob)))
	db.Write(gzBlob)
	db.Write(make([]byte, 40))

	write("_main.3.fwl2", fwl.Bytes())
	write("_main.3.db2", db.Bytes())
	write("_main.3.chunks", index.Bytes())
	write("_main.3.ok", []byte{41, 0, 0, 0})
}
