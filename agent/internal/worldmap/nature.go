package worldmap

import (
	"cmp"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"math"
	"slices"
	"sort"
	"strconv"
)

// Nature: the trees, stumps, logs, rocks, bushes, ore deposits and pickables
// the world generated, for drawing the land at close zoom. Only objects
// without a creator count (a player never placed them), only prefabs of the
// table below, and only outside dungeon interiors. A tree that was cut or a
// rock that was mined is gone from the save, so this is the world as it is
// now. Nothing here names a player.

// Nature categories.
const (
	NatureTree     = "tree"
	NatureStump    = "stump"
	NatureLog      = "log"
	NatureRock     = "rock"
	NatureBush     = "bush"
	NatureOre      = "ore"
	NaturePickable = "pickable"
)

// natureKind is one prefab of the table: its category, a short species (the
// tree, the ore, the plant) and its plan-view size in metres at scale 1: a
// tree's crown, a log's length, a rock's width. Sizes are drawing hints.
type natureKind struct {
	name, category, species string
	size                    float32
}

// natureGroups lists the prefabs by category and species. Every mineable
// rock and ore also has a "<name>_frac" prefab, the half-mined state the game
// swaps in on the first hit; it is added with the same kind.
var natureGroups = []struct {
	category, species string
	size              float32
	names             []string
}{
	{NatureTree, "beech", 8, []string{"Beech1"}},
	{NatureTree, "beech", 4, []string{"Beech_small1", "Beech_small2"}},
	{NatureTree, "pine", 6, []string{"Pinetree_01"}},
	{NatureTree, "fir", 5, []string{"FirTree"}},
	{NatureTree, "fir", 6, []string{"FirTree_small", "FirTree_small_dead"}},
	{NatureTree, "fir", 8, []string{"FirTree_big"}},
	{NatureTree, "birch", 8, []string{"Birch1", "Birch2", "Birch1_aut", "Birch2_aut"}},
	{NatureTree, "oak", 14, []string{"Oak1"}},
	{NatureTree, "swamp", 8, []string{"SwampTree1"}},
	{NatureTree, "swamp", 6, []string{"SwampTree2", "SwampTree2_darkland"}},
	{NatureTree, "yggashoot", 14, []string{"YggaShoot1", "YggaShoot2", "YggaShoot3"}},
	{NatureTree, "yggashoot", 8, []string{"YggaShoot_small1"}},
	{NatureTree, "ashwood", 8, []string{"AshlandsTree1", "AshlandsTree3", "AshlandsTree4", "AshlandsTree5", "AshlandsTree6"}},
	{NatureTree, "ashwood", 14, []string{"AshlandsTree6_big"}},
	{NatureTree, "snowpine", 6, []string{"Pinetree_Snow", "Pinetree_Snow_dead"}},
	{NatureTree, "snowfir", 5, []string{"SnowFirTree"}},
	{NatureTree, "snowfir", 4, []string{"SnowFirTree_small"}},

	{NatureStump, "beech", 1.5, []string{"Beech_Stub", "stubbe", "stubbe_deepnorth"}},
	{NatureStump, "birch", 1.5, []string{"BirchStub"}},
	{NatureStump, "oak", 2.5, []string{"OakStub"}},
	{NatureStump, "pine", 1.5, []string{"Pinetree_01_Stub"}},
	{NatureStump, "fir", 1.5, []string{"FirTree_Stub", "FirTree_Big_plantable_Stub"}},
	{NatureStump, "swamp", 2, []string{"SwampTree1_Stub"}},
	{NatureStump, "yggashoot", 3, []string{"ShootStump"}},
	{NatureStump, "ashwood", 2, []string{"AshlandsTreeStump1", "AshlandsTreeStump2", "AshlandsTreeStump3"}},
	{NatureStump, "snowpine", 1.5, []string{"Pinetree_Snow_Stub"}},
	{NatureStump, "snowfir", 1.5, []string{"FirTree_Snow_Stub"}},
	{NatureStump, "root", 4, []string{"root07", "root08", "root11", "root12"}},

	{NatureLog, "beech", 8, []string{"beech_log"}},
	{NatureLog, "beech", 4, []string{"beech_log_half"}},
	{NatureLog, "birch", 8, []string{"Birch_log"}},
	{NatureLog, "birch", 4, []string{"Birch_log_half"}},
	{NatureLog, "oak", 10, []string{"Oak_log"}},
	{NatureLog, "oak", 5, []string{"Oak_log_half"}},
	{NatureLog, "pine", 10, []string{"PineTree_log"}},
	{NatureLog, "pine", 5, []string{"PineTree_log_half"}},
	{NatureLog, "fir", 8, []string{"FirTree_log", "FirTree_oldLog", "FirTree_oldLog_deepnorth"}},
	{NatureLog, "fir", 4, []string{"FirTree_log_half"}},
	{NatureLog, "fir", 12, []string{"FirTree_Big_log"}},
	{NatureLog, "fir", 6, []string{"FirTree_big_log_half"}},
	{NatureLog, "swamp", 8, []string{"SwampTree1_log", "SwampTree2_log"}},
	{NatureLog, "yggashoot", 12, []string{"yggashoot_log"}},
	{NatureLog, "yggashoot", 6, []string{"yggashoot_log_half"}},
	{NatureLog, "ashwood", 8, []string{"AshlandsTreeLog1", "AshlandsTreeLog2"}},
	{NatureLog, "ashwood", 4, []string{"AshlandsTreeLogHalf1", "AshlandsTreeLogHalf2"}},
	{NatureLog, "snowpine", 10, []string{"PineTree_Snow_log", "PineTree_Snow_log_XL"}},
	{NatureLog, "snowpine", 5, []string{"PineTree_Snow_log_half", "PineTree_Snow_log_XL_half"}},
	{NatureLog, "snowfir", 8, []string{"FirTree_Snow_log"}},
	{NatureLog, "snowfir", 4, []string{"FirTree_Snow_log_half"}},

	{NatureRock, "boulder", 1.2, []string{"Rock_4", "Rock_4_plains", "Rock_4_deepnorth"}},
	{NatureRock, "boulder", 1.5, []string{"Rock_3", "Rock_3_deepnorth", "Rock_7", "Rock_7_meadows", "Rock_7_deepnorth"}},
	{NatureRock, "boulder", 2, []string{"MineRock_Stone"}},
	{NatureRock, "boulder", 4, []string{"rock4_coast", "rock4_forest", "rock4_heath", "rock2_heath"}},
	{NatureRock, "mountain", 4, []string{"rock1_mountain", "rock2_mountain", "rock3_mountain", "rock3_mountain_1"}},
	{NatureRock, "ice", 3, []string{"rock3_ice", "ice_rock1"}},
	{NatureRock, "pillar", 4, []string{"HeathRockPillar", "RockFinger", "RockFingerBroken", "RockThumb", "highstone", "highstone_2"}},
	{NatureRock, "pillar", 8, []string{"widestone", "widestone_2"}},
	{NatureRock, "mistlands", 4, []string{"rock_mistlands1", "rock_mistlands2", "rock1_mistlands"}},
	{NatureRock, "ashlands", 4, []string{"Ashlands_rock1", "Ashlands_rock2", "lavarock_ashlands1"}},
	{NatureRock, "cliff", 12, []string{"cliff_mistlands1", "cliff_mistlands1_creep", "cliff_mistlands2",
		"cliff_ashlands1", "cliff_ashlands2", "cliff_ashlands3_Arch_1", "cliff_ashlands4", "cliff_ashlands5",
		"cliff_ashlands6", "cliff_ashlands7_HalfArch", "cliff_ashlands8"}},

	{NatureBush, "bush", 1.5, []string{"Bush01", "Bush01_heath", "Bush01_deepnorth", "shrub_2", "shrub_2_heath"}},
	{NatureBush, "bush", 2, []string{"Bush02_en", "AshlandsBush1", "AshlandsBush2"}},

	{NatureOre, "copper", 6, []string{"rock4_copper"}},
	{NatureOre, "copper", 3, []string{"MineRock_Copper"}},
	{NatureOre, "tin", 2, []string{"MineRock_Tin"}},
	{NatureOre, "iron", 3, []string{"mudpile", "mudpile2", "mudpile_old", "mudpile_beacon", "MineRock_Iron"}},
	{NatureOre, "silver", 4, []string{"silvervein"}},
	{NatureOre, "silver", 6, []string{"rock3_silver"}},
	{NatureOre, "obsidian", 3, []string{"MineRock_Obsidian"}},
	{NatureOre, "tar", 3, []string{"tarlump1"}},
	{NatureOre, "guck", 1, []string{"GuckSack", "GuckSack_small"}},
	{NatureOre, "meteorite", 4, []string{"MineRock_Meteorite"}},
	{NatureOre, "giant", 6, []string{"giant_skull", "giant_ribs", "giant_sword1", "giant_sword2"}},
	{NatureOre, "softtissue", 4, []string{"giant_brain"}},
	{NatureOre, "flametal", 3, []string{"FlametalRockstand"}},
	{NatureOre, "flametal", 12, []string{"LeviathanLava"}},
	{NatureOre, "chitin", 12, []string{"Leviathan"}},

	{NaturePickable, "stone", 0.5, []string{"Pickable_Stone", "Pickable_StoneRock", "Pickable_Ashstone"}},
	{NaturePickable, "flint", 0.5, []string{"Pickable_Flint"}},
	{NaturePickable, "branch", 0.8, []string{"Pickable_Branch", "Pickable_Branch_Snow"}},
	{NaturePickable, "dandelion", 0.5, []string{"Pickable_Dandelion"}},
	{NaturePickable, "thistle", 0.5, []string{"Pickable_Thistle"}},
	{NaturePickable, "mushroom", 0.5, []string{"Pickable_Mushroom"}},
	{NaturePickable, "mushroom_yellow", 0.5, []string{"Pickable_Mushroom_yellow"}},
	{NaturePickable, "mushroom_blue", 0.5, []string{"Pickable_Mushroom_blue"}},
	{NaturePickable, "jotunpuffs", 0.5, []string{"Pickable_Mushroom_JotunPuffs"}},
	{NaturePickable, "magecap", 0.5, []string{"Pickable_Mushroom_Magecap"}},
	{NaturePickable, "smokepuff", 0.5, []string{"Pickable_SmokePuff"}},
	{NaturePickable, "raspberry", 1.5, []string{"RaspberryBush"}},
	{NaturePickable, "blueberry", 1.5, []string{"BlueberryBush"}},
	{NaturePickable, "cloudberry", 1, []string{"CloudberryBush"}},
	{NaturePickable, "lingonberry", 1, []string{"LingonberryBush"}},
	{NaturePickable, "carrotseeds", 0.5, []string{"Pickable_SeedCarrot"}},
	{NaturePickable, "turnipseeds", 0.5, []string{"Pickable_SeedTurnip"}},
	{NaturePickable, "onionseeds", 0.5, []string{"Pickable_SeedOnion"}},
	{NaturePickable, "barley", 0.5, []string{"Pickable_Barley_Wild"}},
	{NaturePickable, "flax", 0.5, []string{"Pickable_Flax_Wild"}},
	{NaturePickable, "fiddlehead", 0.5, []string{"Pickable_Fiddlehead"}},
	{NaturePickable, "royaljelly", 0.5, []string{"Pickable_RoyalJelly"}},
	{NaturePickable, "tar", 0.8, []string{"Pickable_Tar", "Pickable_TarBig"}},
	{NaturePickable, "obsidian", 0.5, []string{"Pickable_Obsidian"}},
	{NaturePickable, "tin", 0.5, []string{"Pickable_Tin"}},
	{NaturePickable, "iron", 0.5, []string{"Pickable_BogIronOre"}},
	{NaturePickable, "meteorite", 0.5, []string{"Pickable_Meteorite"}},
	{NaturePickable, "sulfur", 0.5, []string{"Pickable_SulfurRock"}},
	{NaturePickable, "voltureegg", 0.5, []string{"Pickable_VoltureEgg"}},
}

// natureKinds is the table in name order; a kind's id is its index.
var (
	natureKinds  []natureKind
	natureByHash = map[int32]uint16{}
)

func init() {
	for _, g := range natureGroups {
		for _, n := range g.names {
			natureKinds = append(natureKinds, natureKind{n, g.category, g.species, g.size})
			if g.category == NatureRock || g.category == NatureOre {
				natureKinds = append(natureKinds, natureKind{n + "_frac", g.category, g.species, g.size})
			}
		}
	}
	sort.Slice(natureKinds, func(i, j int) bool { return natureKinds[i].name < natureKinds[j].name })
	for i, k := range natureKinds {
		natureByHash[stableHash(k.name)] = uint16(i)
	}
}

// natureKindOf is the table entry for a prefab name.
func natureKindOf(name string) (natureKind, bool) {
	id, ok := natureByHash[stableHash(name)]
	if !ok || natureKinds[id].name != name {
		return natureKind{}, false
	}
	return natureKinds[id], true
}

// maxNatureY drops dungeon and cave interiors: the game builds them about
// 5,000 m above the world, out of sight.
const maxNatureY = 1000

// MaxNature caps one /nature answer.
const MaxNature = 30000

// natureItem is one object, 12 bytes. kind is an index into natureKinds,
// with bit 15 set in the index when the spot counts as found (explored or
// near a base, as for locations). yaw is in 2 degree steps (0..179), scale
// the object's scale in 0.05 steps (20 is 1).
type natureItem struct {
	x, z  float32
	kind  uint16
	yaw   uint8
	scale uint8
}

const natureFound = 0x8000

// newNatureItem packs a parsed object; yaw is in half degrees (rotation),
// scale 0 when the object carries none.
func newNatureItem(kind uint16, x, z float32, yaw uint16, scale float32) natureItem {
	s := 20.0
	if scale > 0 && !math.IsNaN(float64(scale)) {
		s = math.Round(float64(scale) * 20)
	}
	s = math.Max(1, math.Min(255, s))
	return natureItem{x: x, z: z, kind: kind, yaw: uint8(yaw / 4 % 180), scale: uint8(s)}
}

// Nature is the nature index of one snapshot: the objects sorted by 64 m
// zone, then kind and position, with each zone's span. It is read-only once
// built and shared by every request.
type Nature struct {
	ETag  string
	items []natureItem
	zones map[zoneKey][2]int32
}

// Len is how many objects the index holds.
func (n *Nature) Len() int {
	if n == nil {
		return 0
	}
	return len(n.items)
}

// buildNature indexes the chunks' objects; found says whether a spot is
// explored or near a base.
func buildNature(chunks []*chunkData, found func(x, z float32) bool) *Nature {
	byZone := map[zoneKey][]natureItem{}
	total := 0
	for _, c := range chunks {
		for _, it := range c.nature {
			if found(it.x, it.z) {
				it.kind |= natureFound
			}
			k := zoneOf(it.x, it.z)
			byZone[k] = append(byZone[k], it)
			total++
		}
	}
	keys := make([]zoneKey, 0, len(byZone))
	for k := range byZone {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].x != keys[j].x {
			return keys[i].x < keys[j].x
		}
		return keys[i].z < keys[j].z
	})
	out := &Nature{items: make([]natureItem, 0, total), zones: make(map[zoneKey][2]int32, len(keys))}
	for _, k := range keys {
		zs := byZone[k]
		slices.SortFunc(zs, func(a, b natureItem) int {
			return cmp.Or(
				cmp.Compare(a.kind&^natureFound, b.kind&^natureFound),
				cmp.Compare(a.x, b.x), cmp.Compare(a.z, b.z),
				cmp.Compare(a.yaw, b.yaw), cmp.Compare(a.scale, b.scale))
		})
		start := int32(len(out.items))
		out.items = append(out.items, zs...)
		out.zones[k] = [2]int32{start, int32(len(out.items))}
	}
	h := sha256.New()
	for _, k := range natureKinds {
		h.Write([]byte(k.name + "\x00" + k.category + "\x00" + k.species + "\x00"))
		_ = binary.Write(h, binary.LittleEndian, k.size)
	}
	var rec [12]byte
	for _, it := range out.items {
		binary.LittleEndian.PutUint32(rec[0:], math.Float32bits(it.x))
		binary.LittleEndian.PutUint32(rec[4:], math.Float32bits(it.z))
		binary.LittleEndian.PutUint16(rec[8:], it.kind)
		rec[10], rec[11] = it.yaw, it.scale
		h.Write(rec[:])
	}
	out.ETag = hex.EncodeToString(h.Sum(nil)[:12])
	return out
}

// NatureQuery is the result of Nature.Query.
type NatureQuery struct {
	X0, Z0, X1, Z1 float64
	Spoilers       bool
	Truncated      bool
	kinds          []int // kind ids in output order
	items          []natureItem
}

// Count is how many objects the query returns.
func (q *NatureQuery) Count() int { return len(q.items) }

// Query collects the objects whose position lies inside [x0, x1] x [z0, z1],
// zone by zone in index order, at most max of them. Without spoilers only
// objects on found spots are returned.
func (n *Nature) Query(x0, z0, x1, z1 float64, spoilers bool, max int) *NatureQuery {
	q := &NatureQuery{X0: x0, Z0: z0, X1: x1, Z1: z1, Spoilers: spoilers}
	if n == nil {
		return q
	}
	lo, hi := zoneOf(float32(x0), float32(z0)), zoneOf(float32(x1), float32(z1))
	seen := map[uint16]bool{}
	for zx := lo.x; zx <= hi.x; zx++ {
		for zz := lo.z; zz <= hi.z; zz++ {
			span, ok := n.zones[zoneKey{zx, zz}]
			if !ok {
				continue
			}
			for _, it := range n.items[span[0]:span[1]] {
				if !spoilers && it.kind&natureFound == 0 {
					continue
				}
				x, z := float64(it.x), float64(it.z)
				if x < x0 || x > x1 || z < z0 || z > z1 {
					continue
				}
				if len(q.items) >= max {
					q.Truncated = true
					return q.finish(seen)
				}
				q.items = append(q.items, it)
				seen[it.kind&^natureFound] = true
			}
		}
	}
	return q.finish(seen)
}

func (q *NatureQuery) finish(seen map[uint16]bool) *NatureQuery {
	for id := range seen {
		q.kinds = append(q.kinds, int(id))
	}
	sort.Ints(q.kinds)
	return q
}

// AppendJSON writes the query as GET /nature:
//
//	{"generation":N,"bbox":[x0,z0,x1,z1],"spoilers":false,
//	 "kinds":[[name,category,species,size],...],
//	 "items":[[kind,x,z,yaw,scale],...],"count":n,"truncated":false}
//
// kind indexes "kinds"; positions are metres rounded to 0.1, yaw whole
// degrees 0..358 in steps of 2, scale the object's scale rounded to 0.05
// (1 when the save holds none). An object's drawn size is size x scale.
func (n *Nature) AppendJSON(b []byte, q *NatureQuery, generation int) []byte {
	num := func(v float64, steps float64) {
		b = strconv.AppendFloat(b, math.Round(v*steps)/steps, 'f', -1, 64)
	}
	b = append(b, `{"generation":`...)
	b = strconv.AppendInt(b, int64(generation), 10)
	b = append(b, `,"bbox":[`...)
	for i, v := range []float64{q.X0, q.Z0, q.X1, q.Z1} {
		if i > 0 {
			b = append(b, ',')
		}
		num(v, 10)
	}
	b = append(b, `],"spoilers":`...)
	b = strconv.AppendBool(b, q.Spoilers)
	b = append(b, `,"kinds":[`...)
	local := map[uint16]int{}
	for i, id := range q.kinds {
		local[uint16(id)] = i
		k := natureKinds[id]
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, '[')
		b = strconv.AppendQuote(b, k.name)
		b = append(b, ',')
		b = strconv.AppendQuote(b, k.category)
		b = append(b, ',')
		b = strconv.AppendQuote(b, k.species)
		b = append(b, ',')
		num(float64(k.size), 10)
		b = append(b, ']')
	}
	b = append(b, `],"items":[`...)
	for i, it := range q.items {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, '[')
		b = strconv.AppendInt(b, int64(local[it.kind&^natureFound]), 10)
		b = append(b, ',')
		num(float64(it.x), 10)
		b = append(b, ',')
		num(float64(it.z), 10)
		b = append(b, ',')
		b = strconv.AppendInt(b, int64(it.yaw)*2, 10)
		b = append(b, ',')
		num(float64(it.scale)/20, 20)
		b = append(b, ']')
	}
	b = append(b, `],"count":`...)
	b = strconv.AppendInt(b, int64(len(q.items)), 10)
	b = append(b, `,"truncated":`...)
	b = strconv.AppendBool(b, q.Truncated)
	return append(b, '}')
}
