package worldmap

import (
	_ "embed"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
)

// A container's inventory is the byte array under ZDO key "items" (the 0x80
// map). Valheim 1.0 writes it compactly (inventory version 109 or 110), in the
// order the game's own inventory and item save code writes it:
//
//	i32 version (109, 110) | u16 count | count x item
//
//	item: i32 durability x 100 (10000 for anything without wear)
//	      u8 slot x | u8 slot y
//	      u8 world level (0, or the world level the item was made at)
//	      u8 flags
//	      flags&0x04: u16 quality     (absent: quality 1)
//	      flags&0x08: u16 stack       (absent: a stack of 1)
//	      flags&0x20: i64 crafter id, string crafter name (.NET 7-bit length)
//	      flags&0x40: i32 item prefab hash (GetStableHashCode of the prefab name)
//	      u8 extra flags (0x01: spawned by a cheat); read past unchecked,
//	         since nothing here depends on it and a cheat-spawned item is
//	         still an item
//
//	flags: 0x01 picked up by a player (set on everything a player has held;
//	            clear on the loot the game puts into world chests)
//	       0x04 quality follows      0x08 stack follows
//	       0x20 crafter follows      0x40 prefab hash follows
//	       0x02 equipped, 0x10 variant (i32) follows, 0x80 custom data
//	            (count, then key/value strings) follows: never seen in a
//	            container, so a blob with any of them is refused rather than
//	            decoded on an untested path.
//
// An item without 0x40 (or with a zero hash) has no prefab. The game reads it
// to its end and leaves it out (Inventory.Load adds an item only when its
// prefab hash is not 0), so it is read past and skipped here too, and the rest
// of the inventory still counts. Its layout is the game's item reader with the
// hash left out; none of the saves below holds one.
//
// Quality is written before stack. Both are u16, so a blob reads to its last
// byte in either order; only items with both a quality and a stack above 1
// show the difference.
//
// Checked against 647 real inventories (41 player chests, a cart, 5 graves, 600
// world treasure chests): flag sets 0x40 0x41 0x48 0x49 0x61 0x65 0x69, every
// blob read to its last byte and every prefab hash resolved.
//
// Versions 109 and 110 share this layout: game build l-1.0.20 writes 110, and
// 41 real 110 inventories (wood and reinforced chests) read to their last byte
// with every prefab hash resolved. Any other version (pre-1.0 saves carried a
// different item layout, a later one may again) is refused.
//
// The crafter id is a platform id: it is read past and never kept.

const (
	inventoryVersion = 110
	// inventoryVersionOld is the 1.0 version before game build l-1.0.20.
	inventoryVersionOld = 109
	maxItems            = 1024

	itemPickedUp = 0x01
	itemQuality  = 0x04
	itemStack    = 0x08
	itemCrafter  = 0x20
	itemPrefab   = 0x40
	itemKnown    = itemPickedUp | itemQuality | itemStack | itemCrafter | itemPrefab
)

// rawItem is one decoded stack; the crafter name is gated at assembly.
type rawItem struct {
	name, typ  string
	stack      int
	quality    int
	durability float32
	crafter    string
	x, y       int
}

var errInventory = errors.New("worldmap: unreadable inventory")

// parseInventory decodes an "items" blob and counts the items it skipped for
// having no prefab. A blob that does not match the layout above exactly
// (unknown version or flag bits, trailing bytes) is an error; nothing is
// half-read.
func parseInventory(blob []byte) (items []rawItem, skipped int, err error) {
	r := &buf{b: blob}
	if v := r.i32(); r.err == nil && v != inventoryVersion && v != inventoryVersionOld {
		return nil, 0, fmt.Errorf("%w: version %d", errInventory, v)
	}
	n := int(r.u16())
	if r.err != nil {
		return nil, 0, r.err
	}
	if n > maxItems {
		return nil, 0, fmt.Errorf("%w: %d items", errInventory, n)
	}
	items = make([]rawItem, 0, n)
	for i := 0; i < n; i++ {
		dur := r.i32()
		x, y := r.u8(), r.u8()
		r.u8() // world level
		flags := r.u8()
		if r.err != nil {
			return nil, 0, r.err
		}
		if flags&^itemKnown != 0 {
			return nil, 0, fmt.Errorf("%w: item flags %#02x", errInventory, flags)
		}
		it := rawItem{stack: 1, quality: 1, durability: float32(dur) / 100, x: int(x), y: int(y)}
		if flags&itemQuality != 0 {
			it.quality = int(r.u16())
		}
		if flags&itemStack != 0 {
			it.stack = int(r.u16())
		}
		if flags&itemCrafter != 0 {
			r.i64() // crafter id: platform id, dropped
			it.crafter = r.str(maxNameBytes)
		}
		var hash int32
		if flags&itemPrefab != 0 {
			hash = r.i32()
		}
		r.u8() // extra flags
		if r.err != nil {
			return nil, 0, r.err
		}
		if hash == 0 {
			skipped++
			continue
		}
		if info, ok := itemByHash[hash]; ok {
			it.name, it.typ = info.name, info.typ
		} else {
			it.name = fmt.Sprintf("#%08x", uint32(hash))
		}
		items = append(items, it)
	}
	if r.p != len(blob) {
		return nil, 0, fmt.Errorf("%w: %d trailing bytes", errInventory, len(blob)-r.p)
	}
	return items, skipped, nil
}

// items.tsv is every item prefab name with its game item type (from the
// Jotunn item list), so the hashes in an inventory can be named.
//
//go:embed items.tsv
var itemList string

type itemInfo struct{ name, typ string }

var itemByHash = map[int32]itemInfo{}

func init() {
	for _, line := range strings.Split(itemList, "\n") {
		name, typ, ok := strings.Cut(strings.TrimSpace(line), "\t")
		if ok && name != "" {
			itemByHash[stableHash(name)] = itemInfo{name: name, typ: typ}
		}
	}
}

// wears is the item types that lose durability; for everything else the
// stored value is a constant and not exported.
var wears = map[string]bool{
	"OneHandedWeapon": true, "TwoHandedWeapon": true, "TwoHandedWeaponLeft": true, "Bow": true,
	"Shield": true, "Helmet": true, "Chest": true, "Legs": true, "Shoulder": true,
	"Utility": true, "Tool": true, "Torch": true,
}

// Container kinds.
const (
	KindChest = "chest"
	KindCart  = "cart"
	KindShip  = "ship"
)

// storageSize is the inventory grid (columns, rows) of the containers whose
// size is known. A grid is never smaller than the slots in use, so an
// unknown or wrong entry only changes how empty slots are drawn.
var storageSize = map[string][2]int{
	"piece_chest_wood":       {5, 2},
	"piece_chest":            {6, 4},
	"piece_chest_private":    {3, 2},
	"piece_chest_barrel":     {6, 2},
	"piece_chest_blackmetal": {8, 4},
	"Cart":                   {6, 3},
	"Karve":                  {2, 2},
	"VikingShip":             {6, 3},
	"Player_tombstone":       {8, 4},
}

// gridOf is the container's grid: the known size, grown to fit every slot.
func gridOf(prefab string, items []rawItem) (w, h int) {
	s := storageSize[prefab]
	w, h = s[0], s[1]
	for _, it := range items {
		w, h = max(w, it.x+1), max(h, it.y+1)
	}
	return w, h
}

func exportItems(raw []rawItem, showNames bool) []Item {
	out := make([]Item, 0, len(raw))
	for _, r := range raw {
		it := Item{Name: r.name, Type: r.typ, Stack: r.stack, X: r.x, Y: r.y}
		if r.quality > 1 {
			it.Quality = r.quality
		}
		if wears[r.typ] && !math.IsNaN(float64(r.durability)) {
			d := math.Round(float64(r.durability)*10) / 10
			it.Durability = &d
		}
		if showNames {
			it.Crafter = r.crafter
		}
		out = append(out, it)
	}
	// Slot order: row by row, as the game draws the grid.
	sort.Slice(out, func(i, j int) bool {
		if out[i].Y != out[j].Y {
			return out[i].Y < out[j].Y
		}
		return out[i].X < out[j].X
	})
	return out
}
