package worldmap

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"testing"
)

func TestNatureKindOf(t *testing.T) {
	for _, c := range []struct {
		name, category, species string
	}{
		{"Beech1", NatureTree, "beech"},
		{"Beech_small2", NatureTree, "beech"},
		{"Pinetree_01", NatureTree, "pine"},
		{"FirTree_small_dead", NatureTree, "fir"},
		{"SwampTree1", NatureTree, "swamp"},
		{"YggaShoot2", NatureTree, "yggashoot"},
		{"AshlandsTree6_big", NatureTree, "ashwood"},
		{"stubbe", NatureStump, "beech"},
		{"root07", NatureStump, "root"},
		{"FirTree_oldLog", NatureLog, "fir"},
		{"Rock_4", NatureRock, "boulder"},
		{"Rock_3_frac", NatureRock, "boulder"},
		{"cliff_mistlands1", NatureRock, "cliff"},
		{"shrub_2", NatureBush, "bush"},
		{"rock4_copper", NatureOre, "copper"},
		{"rock4_copper_frac", NatureOre, "copper"},
		{"MineRock_Tin", NatureOre, "tin"},
		{"silvervein_frac", NatureOre, "silver"},
		{"mudpile_beacon", NatureOre, "iron"},
		{"MineRock_Obsidian", NatureOre, "obsidian"},
		{"giant_brain", NatureOre, "softtissue"},
		{"Pickable_Stone", NaturePickable, "stone"},
		{"Pickable_Mushroom_yellow", NaturePickable, "mushroom_yellow"},
		{"RaspberryBush", NaturePickable, "raspberry"},
		{"Pickable_Mushroom_JotunPuffs", NaturePickable, "jotunpuffs"},
		{"Pickable_Barley_Wild", NaturePickable, "barley"},
		{"GuckSack", NaturePickable, "guck"},
	} {
		k, ok := natureKindOf(c.name)
		if !ok || k.category != c.category || k.species != c.species || k.size <= 0 {
			t.Errorf("natureKindOf(%q) = %+v %v, want %s/%s", c.name, k, ok, c.category, c.species)
		}
	}
	// Creatures, spawners, player pieces, dungeon and location pieces,
	// dropped items, ships and graves are not nature.
	for _, name := range []string{
		"Greydwarf", "Boar", "Deer", "Leech", "Spawner_Greydwarf", "BonePileSpawner",
		"woodwall", "piece_workbench", "sapling_carrot", "portal_wood", "Cart", "Karve", "Player_tombstone",
		"stone_wall_2x1", "stone_wall_1x1_ruin", "goblin_woodwall_1m", "LocationProxy", "RockDolmen_1", "MountainGraveStone01",
		"dungeon_forestcrypt_door", "caverock_ice_stalagtite", "Pickable_ForestCryptRandom", "Pickable_SurtlingCoreStand",
		"Pickable_MountainCaveCrystal", "Pickable_DolmenTreasure", "TreasureChest_meadows", "shipwreck_karve_chest",
		"Wood", "Stone", "Resin", "CarrotSeeds", "Pickable_Item", "vines", "Beehive", "_ZoneCtrl", "beech_wood",
	} {
		if k, ok := natureKindOf(name); ok {
			t.Errorf("natureKindOf(%q) = %+v, want not nature", name, k)
		}
	}
	seen := map[string]bool{}
	cats := map[string]bool{NatureTree: true, NatureStump: true, NatureLog: true, NatureRock: true, NatureBush: true, NatureOre: true, NaturePickable: true}
	for _, k := range natureKinds {
		if seen[k.name] || !cats[k.category] || k.species == "" || k.size <= 0 {
			t.Errorf("bad or duplicate kind %+v", k)
		}
		seen[k.name] = true
		if _, ok := footprints[k.name]; ok {
			t.Errorf("%s is both a build piece and nature", k.name)
		}
	}
	if len(natureByHash) != len(natureKinds) {
		t.Errorf("%d hashes for %d kinds: a hash collides", len(natureByHash), len(natureKinds))
	}
}

// natureZDO writes a ZDO with an optional rotation, "scale" Vector3 and
// creator, the maps vegetation carries.
func natureZDO(b *bytes.Buffer, prefab string, x, y, z float32, rot *[2]uint16, scale *float32, creator *int64) {
	w := func(v any) { _ = binary.Write(b, binary.LittleEndian, v) }
	var flags uint16
	if rot != nil {
		flags |= flagRotation
	}
	if scale != nil {
		flags |= 0x04
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
	if scale != nil {
		b.WriteByte(1)
		w(keyScale)
		w([3]float32{*scale, *scale, *scale})
	}
	if creator != nil {
		b.WriteByte(1)
		w(keyCreator)
		w(*creator)
	}
}

func TestParseChunkNature(t *testing.T) {
	player := int64(-77)
	big, small := float32(1.25), float32(0.6)
	yaw := [2]uint16{0x8000 | 181}
	tilted := rot4(10, 90, 4)
	var b bytes.Buffer
	natureZDO(&b, "Beech1", 10, 32, 20, &yaw, &big, nil)
	natureZDO(&b, "FirTree_small", 12, 40, 22, &tilted, &small, nil)
	natureZDO(&b, "rock4_copper_frac", 14, 30, 24, nil, nil, nil)
	natureZDO(&b, "Beech1", 16, 32, 26, &yaw, &big, &player)               // planted by a player
	natureZDO(&b, "Pickable_Mushroom_yellow", 18, 5030, 28, nil, nil, nil) // in a burial chamber
	natureZDO(&b, "Greydwarf", 20, 32, 30, &yaw, nil, nil)
	natureZDO(&b, "stone_wall_2x1", 22, 32, 32, &yaw, nil, nil)
	natureZDO(&b, "Rock_4", 1e6, 0, 1e6, nil, nil, nil) // parked outside the world
	var raw bytes.Buffer
	_ = binary.Write(&raw, binary.LittleEndian, uint16(41))
	_ = binary.Write(&raw, binary.LittleEndian, int32(8))
	raw.Write(b.Bytes())
	cd, err := parseChunk(raw.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	id := func(n string) uint16 { return natureByHash[stableHash(n)] }
	want := []natureItem{
		{x: 10, z: 20, kind: id("Beech1"), yaw: 45, scale: 25},
		{x: 12, z: 22, kind: id("FirTree_small"), yaw: 22, scale: 12},
		{x: 14, z: 24, kind: id("rock4_copper_frac"), yaw: 0, scale: 20},
	}
	if len(cd.nature) != len(want) {
		t.Fatalf("nature = %+v", cd.nature)
	}
	for i := range want {
		if cd.nature[i] != want[i] {
			t.Errorf("nature[%d] = %+v, want %+v", i, cd.nature[i], want[i])
		}
	}
	if len(cd.built) != 1 {
		t.Errorf("built = %+v, want the planted beech only", cd.built)
	}
}

// testNature puts a grid of beeches every 10 m over two chunks, a copper
// deposit at (300, 300) and tin at (40, 40). Spots with x < 100 are found.
func testNature() *Nature {
	a, b := newChunkData(), newChunkData()
	for i := 0; i < 400; i++ {
		x, z := float32(i%20*10), float32(i/20*10)
		c := a
		if i%2 == 1 {
			c = b
		}
		c.nature = append(c.nature, newNatureItem(natureByHash[stableHash("Beech1")], x, z, 360, 1.3))
	}
	a.nature = append(a.nature, newNatureItem(natureByHash[stableHash("rock4_copper")], 300, 300, 0, 0))
	b.nature = append(b.nature, newNatureItem(natureByHash[stableHash("MineRock_Tin")], 40, 40, 0, 0))
	return buildNature([]*chunkData{a, b}, func(x, z float32) bool { return x < 100 })
}

type natureDoc struct {
	Generation int         `json:"generation"`
	BBox       []float64   `json:"bbox"`
	Spoilers   bool        `json:"spoilers"`
	Kinds      [][]any     `json:"kinds"`
	Items      [][]float64 `json:"items"`
	Count      int         `json:"count"`
	Truncated  bool        `json:"truncated"`
}

func TestNatureQuery(t *testing.T) {
	n := testNature()
	if n.Len() != 402 {
		t.Fatalf("len = %d", n.Len())
	}
	decode := func(q *NatureQuery) natureDoc {
		t.Helper()
		var d natureDoc
		if err := json.Unmarshal(n.AppendJSON(nil, q, 7), &d); err != nil {
			t.Fatal(err)
		}
		return d
	}

	// Without spoilers only found spots: the left half of the grid and the tin.
	d := decode(n.Query(-5, -5, 1000, 1000, false, MaxNature))
	if d.Count != 201 || len(d.Items) != 201 || d.Truncated || d.Spoilers || d.Generation != 7 {
		t.Fatalf("found = %d items, truncated %v", d.Count, d.Truncated)
	}
	for _, it := range d.Items {
		if it[1] >= 100 {
			t.Fatalf("item %v on an unfound spot", it)
		}
	}
	if len(d.Kinds) != 2 || d.Kinds[0][0] != "Beech1" || d.Kinds[1][0] != "MineRock_Tin" || d.Kinds[1][1] != "ore" {
		t.Errorf("kinds = %v", d.Kinds)
	}

	// Ore in land nobody has seen does not leave without spoilers.
	if q := n.Query(250, 250, 350, 350, false, MaxNature); q.Count() != 0 {
		t.Errorf("unfound copper leaked: %d items", q.Count())
	}
	d = decode(n.Query(250, 250, 350, 350, true, MaxNature))
	if d.Count != 1 || !d.Spoilers || d.Kinds[0][0] != "rock4_copper" || d.Kinds[0][2] != "copper" {
		t.Errorf("copper with spoilers = %+v", d)
	}
	if got := d.Items[0]; got[0] != 0 || got[1] != 300 || got[2] != 300 || got[3] != 0 || got[4] != 1 {
		t.Errorf("copper row = %v", got)
	}

	// A box: edges count, rows are rounded, yaw in degrees and scale kept.
	d = decode(n.Query(10, 10, 30, 20, true, MaxNature))
	if d.Count != 6 {
		t.Errorf("box count = %d, want 6", d.Count)
	}
	for _, it := range d.Items {
		if it[1] < 10 || it[1] > 30 || it[2] < 10 || it[2] > 20 || it[3] != 180 || it[4] != 1.3 {
			t.Errorf("row %v", it)
		}
	}

	// The cap.
	q := n.Query(-5, -5, 1000, 1000, true, 50)
	if q.Count() != 50 || !q.Truncated {
		t.Errorf("capped = %d truncated %v", q.Count(), q.Truncated)
	}
	if q := n.Query(-5, -5, 1000, 1000, true, 402); q.Count() != 402 || q.Truncated {
		t.Errorf("exact cap = %d truncated %v", q.Count(), q.Truncated)
	}

	// An empty index answers with empty lists, not null.
	var none *Nature
	if s := string(none.AppendJSON(nil, none.Query(0, 0, 1, 1, false, 10), 1)); s != `{"generation":1,"bbox":[0,0,1,1],"spoilers":false,"kinds":[],"items":[],"count":0,"truncated":false}` {
		t.Errorf("empty = %s", s)
	}
}

func TestNatureETag(t *testing.T) {
	mk := func(found func(x, z float32) bool, flip bool) string {
		a, b := newChunkData(), newChunkData()
		a.nature = []natureItem{newNatureItem(natureByHash[stableHash("Beech1")], 1, 2, 0, 1)}
		b.nature = []natureItem{newNatureItem(natureByHash[stableHash("Rock_4")], 3, 4, 0, 2)}
		chunks := []*chunkData{a, b}
		if flip {
			chunks = []*chunkData{b, a}
		}
		return buildNature(chunks, found).ETag
	}
	all := func(x, z float32) bool { return true }
	if mk(all, false) != mk(all, true) {
		t.Error("ETag depends on chunk order")
	}
	if mk(all, false) == mk(func(x, z float32) bool { return x < 2 }, false) {
		t.Error("ETag ignores what is found")
	}
}

func TestBuildFixtureNature(t *testing.T) {
	enc := build(t, fixture, true).Current()
	n := enc.Nature
	// 6+zx^2 beeches per island zone, 45 firs at the outpost, one mushroom;
	// the leviathan the game parked outside the world is not there.
	if n.Len() != 486+45+1 {
		t.Errorf("nature = %d objects", n.Len())
	}
	found := n.Query(-1024, -1024, 0, 0, false, MaxNature).Count()
	all := n.Query(-1024, -1024, 0, 0, true, MaxNature).Count()
	if found == 0 || found >= all {
		t.Errorf("south-west quarter: %d found of %d", found, all)
	}
	// The island's east edge is outside the explored area and far from the base.
	if q := n.Query(220, -40, 300, 40, false, MaxNature); q.Count() != 0 {
		t.Errorf("unexplored east edge = %d items without spoilers", q.Count())
	}
	if q := n.Query(220, -40, 300, 40, true, MaxNature); q.Count() == 0 {
		t.Error("east edge empty with spoilers")
	}
	if q := n.Query(25, 25, 35, 35, false, MaxNature); q.Count() != 1 || natureKinds[q.items[0].kind&^natureFound].name != "Pickable_Mushroom" {
		t.Errorf("mushroom = %+v", q.items)
	}
}
