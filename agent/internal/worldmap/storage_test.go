package worldmap

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
)

// invItem is one item for the test encoder; zero stack/quality mean 1.
type invItem struct {
	name       string
	x, y       byte
	flags      byte
	stack      uint16
	quality    uint16
	durability int32
	crafterID  int64
	crafter    string
	worldLevel byte
}

func encodeInventory(items []invItem) []byte {
	var b bytes.Buffer
	w := func(v any) { _ = binary.Write(&b, binary.LittleEndian, v) }
	w(int32(inventoryVersion))
	w(uint16(len(items)))
	for _, it := range items {
		dur := it.durability
		if dur == 0 {
			dur = 10000
		}
		w(dur)
		b.WriteByte(it.x)
		b.WriteByte(it.y)
		b.WriteByte(0)
		b.WriteByte(it.flags)
		if it.flags&itemStack != 0 {
			w(it.stack)
		}
		if it.flags&itemQuality != 0 {
			w(it.quality)
		}
		if it.flags&itemCrafter != 0 {
			w(it.crafterID)
			b.WriteByte(byte(len(it.crafter)))
			b.WriteString(it.crafter)
		}
		w(stableHash(it.name))
		b.WriteByte(it.worldLevel)
	}
	return b.Bytes()
}

func TestParseInventoryFlagSets(t *testing.T) {
	// One item per flag set seen in real saves.
	in := []invItem{
		{name: "AxeHead1", x: 0, y: 1, flags: 0x40},
		{name: "Stone", x: 1, y: 0, flags: 0x41},
		{name: "Honey", x: 2, y: 0, flags: 0x48, stack: 50},
		{name: "Wood", x: 3, y: 0, flags: 0x49, stack: 427, worldLevel: 1},
		{name: "Torch", x: 4, y: 0, flags: 0x61, durability: 444, crafterID: -1, crafter: "Sigrun"},
		{name: "SwordBronze", x: 0, y: 0, flags: 0x65, quality: 2, durability: 25000, crafterID: 76561190000000099, crafter: "Hakon"},
		{name: "ArrowWood", x: 1, y: 1, flags: 0x69, stack: 65, crafterID: 42, crafter: "Ulfgar"},
	}
	got, err := parseInventory(encodeInventory(in))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(in) {
		t.Fatalf("%d items, want %d", len(got), len(in))
	}
	for i, w := range in {
		g := got[i]
		stack, quality := int(w.stack), int(w.quality)
		if stack == 0 {
			stack = 1
		}
		if quality == 0 {
			quality = 1
		}
		if g.name != w.name || g.stack != stack || g.quality != quality || g.x != int(w.x) || g.y != int(w.y) || g.crafter != w.crafter {
			t.Errorf("item %d = %+v, want %+v", i, g, w)
		}
	}
	if got[4].durability != 4.44 || got[5].durability != 250 || got[0].durability != 100 {
		t.Errorf("durability = %v %v %v", got[4].durability, got[5].durability, got[0].durability)
	}
	if got[4].typ != "Torch" || got[2].typ != "Consumable" {
		t.Errorf("types = %q %q", got[4].typ, got[2].typ)
	}
}

func TestParseInventoryRefuses(t *testing.T) {
	good := encodeInventory([]invItem{{name: "Wood", flags: 0x49, stack: 3}})
	if items, err := parseInventory(encodeInventory(nil)); err != nil || len(items) != 0 {
		t.Errorf("empty inventory = %v %v", items, err)
	}
	cases := map[string][]byte{
		"truncated":   good[:len(good)-2],
		"trailing":    append(append([]byte{}, good...), 0),
		"old version": append([]byte{106, 0, 0, 0}, good[4:]...),
	}
	for _, bit := range []byte{0x02, 0x10, 0x80} {
		b := encodeInventory([]invItem{{name: "Wood", flags: 0x49 | bit, stack: 3}})
		cases[fmt.Sprintf("flag %#02x", bit)] = b
	}
	cases["no 0x40"] = encodeInventory([]invItem{{name: "Wood", flags: 0x09, stack: 3}})
	for name, b := range cases {
		if _, err := parseInventory(b); err == nil {
			t.Errorf("%s: parsed, want an error", name)
		}
	}
	unknown, err := parseInventory(encodeInventory([]invItem{{name: "NotAnItem_xyz", flags: 0x41}}))
	if err != nil || len(unknown) != 1 || !strings.HasPrefix(unknown[0].name, "#") {
		t.Errorf("unknown item = %v %v", unknown, err)
	}
	if _, err := parseInventory([]byte{1}); !errors.Is(err, errShort) {
		t.Errorf("short blob err = %v", err)
	}
}

func TestStorageFixture(t *testing.T) {
	s := build(t, fixture, true).Current().Snapshot
	byID := map[string]Container{}
	for _, c := range s.Storage {
		byID[c.ID] = c
	}
	// Built: two wood chests (one empty, no items key), a reinforced chest
	// with an unreadable inventory, the karve, the cart and the raft.
	want := map[string]string{
		"piece_chest_wood@110,-200": KindChest,
		"piece_chest_wood@112,-200": KindChest,
		"piece_chest@114,-200":      KindChest,
		"Karve@-150,250":            KindShip,
		"Cart@90,40":                KindCart,
		"Raft@1800,1900":            KindShip,
	}
	if len(s.Storage) != len(want) {
		t.Errorf("storage = %+v", s.Storage)
	}
	for id, kind := range want {
		if c, ok := byID[id]; !ok || c.Kind != kind {
			t.Errorf("%s = %+v", id, c)
		}
	}
	full := byID["piece_chest_wood@110,-200"]
	if full.Width != 5 || full.Height != 2 || len(full.Items) != 7 || full.Unreadable {
		t.Fatalf("wood chest = %+v", full)
	}
	if it := full.Items[0]; it.Name != "SwordBronze" || it.Quality != 2 || it.Durability == nil || *it.Durability != 250 || it.Crafter != "Hakon" {
		t.Errorf("first slot = %+v", it)
	}
	if it := full.Items[1]; it.Name != "Stone" || it.Durability != nil || it.Quality != 0 || it.Stack != 1 {
		t.Errorf("second slot = %+v", it)
	}
	if c := byID["piece_chest_wood@112,-200"]; len(c.Items) != 0 || c.Unreadable {
		t.Errorf("empty chest = %+v", c)
	}
	if c := byID["piece_chest@114,-200"]; !c.Unreadable || len(c.Items) != 0 || c.Width != 6 || c.Height != 4 {
		t.Errorf("unreadable chest = %+v", c)
	}
	if c := byID["Cart@90,40"]; c.Width != 6 || c.Height != 3 || len(c.Items) != 2 {
		t.Errorf("cart = %+v", c)
	}
	if c := byID["Raft@1800,1900"]; c.Width != 0 || len(c.Items) != 0 {
		t.Errorf("raft = %+v", c)
	}
	for _, v := range s.Vehicles {
		if _, ok := byID[v.ID]; !ok {
			t.Errorf("vehicle %+v has no storage entry", v)
		}
	}
	var grave *Tombstone
	for i := range s.Tombstones {
		if s.Tombstones[i].Owner == "Bjorn" {
			grave = &s.Tombstones[i]
		}
	}
	if grave == nil || len(grave.Items) != 2 || grave.Items[0].Name != "HelmetBronze" {
		t.Errorf("grave = %+v", grave)
	}

	raw, _ := json.Marshal(s)
	for _, leak := range []string{
		"TreasureChest", "shipwreck", "Ruby", // the world chests and their loot
		"Coins",               // the chest without a creator
		"76561190000000099",   // a crafter id
		"4611686018427387001", // the owner/creator id
		"worldLevel", "pickedUp",
	} {
		if bytes.Contains(raw, []byte(leak)) {
			t.Errorf("snapshot contains %q", leak)
		}
	}

	hidden := build(t, fixture, false).Current().Snapshot
	hj, _ := json.Marshal(hidden)
	for _, name := range []string{"Hakon", "Sigrun", "Ulfgar"} {
		if bytes.Contains(hj, []byte(name)) {
			t.Errorf("crafter %q exported with ShowNames off", name)
		}
	}
	if len(hidden.Storage) != len(s.Storage) {
		t.Error("ShowNames changed what is exported")
	}
}

// TestRealWorldStorage reads a real 1.0 save when SKALD_REAL_WORLD points at
// its world directory. It is never committed; the expectations are that
// save's counts.
func TestRealWorldStorage(t *testing.T) {
	dir := os.Getenv("SKALD_REAL_WORLD")
	if dir == "" {
		t.Skip("SKALD_REAL_WORLD not set")
	}
	s := build(t, dir, true).Current().Snapshot
	kinds := map[string]int{}
	totals := map[string]int{}
	for _, c := range s.Storage {
		kinds[c.Prefab]++
		if c.Unreadable {
			t.Errorf("%s: inventory did not decode", c.ID)
		}
		for _, it := range c.Items {
			totals[it.Name] += it.Stack
			if strings.HasPrefix(it.Name, "#") {
				t.Errorf("%s: unknown item %s", c.ID, it.Name)
			}
		}
		if strings.Contains(c.Prefab, "Treasure") || strings.Contains(c.Prefab, "shipwreck") {
			t.Errorf("world container exported: %s", c.ID)
		}
	}
	for prefab, n := range map[string]int{"piece_chest_wood": 42, "Cart": 2, "Karve": 1, "Raft": 2} {
		if kinds[prefab] != n {
			t.Errorf("%s = %d, want %d", prefab, kinds[prefab], n)
		}
	}
	if len(s.Storage) != 47 {
		t.Errorf("storage = %d containers, want 47: %v", len(s.Storage), kinds)
	}
	for name, n := range map[string]int{"Honey": 523, "Wood": 471, "Stone": 295} {
		if totals[name] != n {
			t.Errorf("%s total = %d, want %d", name, totals[name], n)
		}
	}
	graveItems := 0
	for _, g := range s.Tombstones {
		graveItems += len(g.Items)
	}
	if len(s.Tombstones) != 5 || graveItems == 0 {
		t.Errorf("graves = %d with %d items", len(s.Tombstones), graveItems)
	}
	raw, _ := json.Marshal(s)
	if bytes.Contains(raw, []byte("TreasureChest")) || bytes.Contains(raw, []byte("shipwreck")) {
		t.Error("snapshot names a world container")
	}
	t.Logf("storage: %v, %d item kinds; graves %d with %d stacks; json %d bytes", kinds, len(totals), len(s.Tombstones), graveItems, len(raw))
}
