package worldmap

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"reflect"
	"strings"
	"testing"
)

// invItem is one item for the test encoder; zero stack/quality mean 1. It
// writes the fields in the order ItemDrop.ItemData.Save does.
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
	cheated    byte
	zeroHash   bool // write a prefab hash of 0 under flag 0x40
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
		b.WriteByte(it.worldLevel)
		b.WriteByte(it.flags)
		if it.flags&itemQuality != 0 {
			w(it.quality)
		}
		if it.flags&itemStack != 0 {
			w(it.stack)
		}
		if it.flags&itemCrafter != 0 {
			w(it.crafterID)
			b.WriteByte(byte(len(it.crafter)))
			b.WriteString(it.crafter)
		}
		if it.flags&itemPrefab != 0 && it.zeroHash {
			w(int32(0))
		} else if it.flags&itemPrefab != 0 {
			w(stableHash(it.name))
		}
		b.WriteByte(it.cheated)
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
		// Stack and quality together: no save seen so far holds one (vanilla
		// stackables have a max quality of 1, mods can differ), but the
		// format allows it and quality comes first.
		{name: "ArrowFire", x: 2, y: 1, flags: 0x4c, stack: 37, quality: 3},
		{name: "SpearBronze", x: 3, y: 1, flags: 0x6d, stack: 2, quality: 4, crafterID: 42, crafter: "Freya", cheated: 1},
	}
	got, _, err := parseInventory(encodeInventory(in))
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
	if items, _, err := parseInventory(encodeInventory(nil)); err != nil || len(items) != 0 {
		t.Errorf("empty inventory = %v %v", items, err)
	}
	cases := map[string][]byte{
		"truncated":   good[:len(good)-2],
		"trailing":    append(append([]byte{}, good...), 0),
		"old version": append([]byte{106, 0, 0, 0}, good[4:]...),
		"new version": append([]byte{111, 0, 0, 0}, good[4:]...),
	}
	for _, bit := range []byte{0x02, 0x10, 0x80} {
		b := encodeInventory([]invItem{{name: "Wood", flags: 0x49 | bit, stack: 3}})
		cases[fmt.Sprintf("flag %#02x", bit)] = b
	}
	for name, b := range cases {
		if _, _, err := parseInventory(b); err == nil {
			t.Errorf("%s: parsed, want an error", name)
		}
	}
	unknown, _, err := parseInventory(encodeInventory([]invItem{{name: "NotAnItem_xyz", flags: 0x41}}))
	if err != nil || len(unknown) != 1 || !strings.HasPrefix(unknown[0].name, "#") {
		t.Errorf("unknown item = %v %v", unknown, err)
	}
	if _, _, err := parseInventory([]byte{1}); !errors.Is(err, errShort) {
		t.Errorf("short blob err = %v", err)
	}
}

func TestParseInventoryVersions(t *testing.T) {
	// 109 (Valheim 1.0) and 110 (game build l-1.0.20) share one layout.
	for _, v := range []byte{109, 110} {
		b := encodeInventory([]invItem{{name: "Wood", flags: 0x49, stack: 3}})
		b[0] = v
		items, _, err := parseInventory(b)
		if err != nil || len(items) != 1 || items[0].name != "Wood" || items[0].stack != 3 {
			t.Errorf("version %d = %v %v", v, items, err)
		}
	}
}

func TestParseInventorySkipsNoPrefab(t *testing.T) {
	// The game reads an item without a prefab hash (flag 0x40 clear) to its
	// end and leaves it out (Inventory.Load adds only a non-zero hash). The
	// rest of the chest stays, so the reader must stay aligned past it,
	// whatever optional fields the skipped item carries.
	in := []invItem{
		{name: "Wood", flags: 0x49, stack: 20},
		{flags: 0x09, x: 1, stack: 3},
		{flags: 0x2d, x: 2, stack: 2, quality: 3, crafterID: 42, crafter: "Astrid", cheated: 1},
		{flags: 0x01, x: 3},
		{name: "Stone", x: 4, y: 1, flags: 0x41},
	}
	got, skipped, err := parseInventory(encodeInventory(in))
	if err != nil {
		t.Fatal(err)
	}
	if skipped != 3 || len(got) != 2 || got[0].name != "Wood" || got[0].stack != 20 || got[1].name != "Stone" || got[1].x != 4 || got[1].y != 1 {
		t.Errorf("items = %+v, skipped %d", got, skipped)
	}
	// A prefab flag with a zero hash is skipped the same way.
	zero := encodeInventory([]invItem{{flags: 0x49, stack: 1, zeroHash: true}})
	if got, skipped, err := parseInventory(zero); err != nil || len(got) != 0 || skipped != 1 {
		t.Errorf("zero hash = %v %d %v", got, skipped, err)
	}
	// Skipping does not loosen the layout checks: an item without a prefab
	// is still refused when the blob around it is malformed.
	bad := encodeInventory([]invItem{{flags: 0x09, stack: 3}, {name: "Wood", flags: 0x49, stack: 1}})
	for name, b := range map[string][]byte{
		"truncated": bad[:len(bad)-1],
		"trailing":  append(append([]byte{}, bad...), 0),
		"variant":   encodeInventory([]invItem{{flags: 0x19, stack: 3}}),
	} {
		if _, _, err := parseInventory(b); err == nil {
			t.Errorf("%s: parsed, want an error", name)
		}
	}
}

func TestNoPrefabDebugLog(t *testing.T) {
	var logs bytes.Buffer
	b := New(Options{Dir: fixture, Logger: slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))})
	if _, err := b.Refresh(); err != nil {
		t.Fatal(err)
	}
	out := logs.String()
	if strings.Count(out, "inventory items without a prefab skipped") != 1 || !strings.Contains(out, "chunk=20_20__1_4.chunk items=1") {
		t.Errorf("logs = %s", out)
	}
}

func TestStorageFixture(t *testing.T) {
	s := build(t, fixture, true).Current().Snapshot
	byID := map[string]Container{}
	for _, c := range s.Storage {
		byID[c.ID] = c
	}
	// Built: three wood chests (one empty, no items key, one holding an
	// item without a prefab), a reinforced chest with an unreadable
	// inventory, the karve, the cart and the raft.
	want := map[string]string{
		"piece_chest_wood@110,-200": KindChest,
		"piece_chest_wood@112,-200": KindChest,
		"piece_chest@114,-200":      KindChest,
		"piece_chest_wood@116,-200": KindChest,
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
	if full.Width != 5 || full.Height != 2 || len(full.Items) != 8 || full.Unreadable {
		t.Fatalf("wood chest = %+v", full)
	}
	if it := full.Items[0]; it.Name != "SwordBronze" || it.Quality != 2 || it.Durability == nil || *it.Durability != 250 || it.Crafter != "Hakon" {
		t.Errorf("first slot = %+v", it)
	}
	if it := full.Items[1]; it.Name != "Stone" || it.Durability != nil || it.Quality != 0 || it.Stack != 1 {
		t.Errorf("second slot = %+v", it)
	}
	if it := full.Items[7]; it.Name != "ArrowFire" || it.Stack != 37 || it.Quality != 3 || it.X != 2 || it.Y != 1 {
		t.Errorf("stack and quality = %+v", it)
	}
	if c := byID["piece_chest_wood@112,-200"]; len(c.Items) != 0 || c.Unreadable {
		t.Errorf("empty chest = %+v", c)
	}
	if c := byID["piece_chest@114,-200"]; !c.Unreadable || len(c.Items) != 0 || c.Width != 6 || c.Height != 4 {
		t.Errorf("unreadable chest = %+v", c)
	}
	// The item without a prefab is left out, as the game does on load; the
	// rest of the chest stays and its grid does not grow to the dropped
	// item's slot.
	if c := byID["piece_chest_wood@116,-200"]; c.Unreadable || len(c.Items) != 2 || c.Items[0].Name != "Resin" || c.Items[0].Stack != 12 ||
		c.Items[1].Name != "Flint" || c.Items[1].X != 2 || c.Items[1].Y != 1 || c.Width != 5 || c.Height != 2 || c.Items[0].Crafter != "" || c.Items[1].Crafter != "" {
		t.Errorf("chest with an item without a prefab = %+v", c)
	}
	if c := byID["Cart@90,40"]; c.Width != 6 || c.Height != 3 || len(c.Items) != 2 {
		t.Errorf("cart = %+v", c)
	}
	if c := byID["Raft@1800,1900"]; c.Width != 0 || len(c.Items) != 0 {
		t.Errorf("raft = %+v", c)
	}
	if full.Y != 31 || byID["Karve@-150,250"].Y != 30 || byID["Cart@90,40"].Y != 34 {
		t.Errorf("heights = %v %v %v", full.Y, byID["Karve@-150,250"].Y, byID["Cart@90,40"].Y)
	}
	if !bytes.Contains(must(json.Marshal(full)), []byte(`"y":31,`)) {
		t.Error("container JSON has no y")
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

func must(b []byte, err error) []byte {
	if err != nil {
		panic(err)
	}
	return b
}

func TestStackedContainers(t *testing.T) {
	// Three chests on one spot, handed over top first, and one beside them.
	stores := []rawStore{
		{prefab: "piece_chest_wood", x: 10.1, y: 33.734, z: 5, items: []rawItem{}},
		{prefab: "piece_chest_wood", x: 9.9, y: 31.98, z: 5.2},
		{prefab: "piece_chest_wood", x: 10, y: 32.86, z: 4.9},
		{prefab: "piece_chest_wood", x: 12, y: 32, z: 5},
	}
	got := exportStorage(stores, nil, true)
	want := []struct {
		id string
		y  float64
	}{
		{"piece_chest_wood@10,5", 32},
		{"piece_chest_wood@10,5#1", 32.85},
		{"piece_chest_wood@10,5#2", 33.75},
		{"piece_chest_wood@12,5", 32},
	}
	if len(got) != len(want) {
		t.Fatalf("storage = %+v", got)
	}
	for i, w := range want {
		if got[i].ID != w.id || got[i].Y != w.y {
			t.Errorf("[%d] = %s y %v, want %s y %v", i, got[i].ID, got[i].Y, w.id, w.y)
		}
	}
}

// TestRealWorldStorage reads a real 1.0 save when SKALD_REAL_WORLD points at
// its world directory. The save is never committed. Decoding is checked
// exactly (every inventory reads, every item is known, no world container
// leaks); what players keep in their chests is a range calibrated on the save
// TestRealWorld describes.
func TestRealWorldStorage(t *testing.T) {
	dir := os.Getenv("SKALD_REAL_WORLD")
	if dir == "" {
		t.Skip("SKALD_REAL_WORLD not set")
	}
	s := build(t, dir, true).Current().Snapshot
	var ck checks
	kinds := map[string]int{}
	totals := map[string]int{}
	for _, c := range s.Storage {
		kinds[c.Prefab]++
		if c.Unreadable {
			ck.fail("%s: inventory did not decode", c.ID)
		}
		for _, it := range c.Items {
			totals[it.Name] += it.Stack
			if strings.HasPrefix(it.Name, "#") {
				ck.fail("%s: unknown item %s", c.ID, it.Name)
			}
		}
		if strings.Contains(c.Prefab, "Treasure") || strings.Contains(c.Prefab, "shipwreck") {
			ck.fail("world container exported: %s", c.ID)
		}
	}
	raw, _ := json.Marshal(s)
	if bytes.Contains(raw, []byte("TreasureChest")) || bytes.Contains(raw, []byte("shipwreck")) {
		ck.fail("snapshot names a world container")
	}

	// Play state.
	ck.in("containers", len(s.Storage), 40, 70)
	ck.in("piece_chest_wood", kinds["piece_chest_wood"], 35, 60)
	// Vehicles take their own export path; keep each kind exercised.
	for _, v := range []string{"Cart", "Karve", "Raft"} {
		ck.in(v, kinds[v], 1, 5)
	}
	ck.in("item kinds", len(totals), 60, 150)
	// Totals sum many stacks, so a stack-size decoding slip (every stack read
	// as 1, or halved) falls far below these floors.
	for name, lo := range map[string]int{"Honey": 400, "Wood": 200, "Stone": 200} {
		ck.in(name+" total", totals[name], lo, 2000)
	}
	graveItems := 0
	for _, g := range s.Tombstones {
		graveItems += len(g.Items)
	}
	ck.in("graves", len(s.Tombstones), 1, 15)
	ck.in("grave stacks", graveItems, 1, 15*60)
	ck.report(t)

	t.Logf("storage: %v, %d item kinds; graves %d with %d stacks; json %d bytes", kinds, len(totals), len(s.Tombstones), graveItems, len(raw))
}

// Every refusal has a fixed reason code (and its value) that the web panel
// and the notifications translate (#152). Renaming a code breaks them.
func TestInventoryReasonCodes(t *testing.T) {
	good := encodeInventory([]invItem{{name: "Wood", flags: 0x49, stack: 3}})
	many := append([]byte{}, good...)
	binary.LittleEndian.PutUint16(many[4:], 2000)
	varint := []byte{110, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, itemCrafter, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0xff}
	cases := []struct {
		name string
		blob []byte
		want InvReason
	}{
		{"new version", append([]byte{111, 0, 0, 0}, good[4:]...), InvReason{ReasonVersion, 111}},
		{"too many items", many, InvReason{ReasonItems, 2000}},
		{"unknown flag", encodeInventory([]invItem{{name: "Wood", flags: 0x49 | 0x80, stack: 3}}), InvReason{ReasonFlags, 0xc9}},
		{"trailing", append(append([]byte{}, good...), 0, 0), InvReason{ReasonTrailing, 2}},
		{"truncated", good[:len(good)-2], InvReason{Code: ReasonTruncated}},
		{"bad varint", varint, InvReason{Code: ReasonBadVarint}},
	}
	for _, c := range cases {
		_, _, err := parseInventory(c.blob)
		if got := reasonOf(err); got != c.want {
			t.Errorf("%s: reason = %+v (%v), want %+v", c.name, got, err, c.want)
		}
	}
	if got := reasonOf(errors.New("something new")); got != (InvReason{Code: ReasonOther}) {
		t.Errorf("other = %+v", got)
	}
	want := []string{"inventory_version", "inventory_items", "inventory_flags", "inventory_trailing", "truncated", "bad_varint", "other"}
	if !reflect.DeepEqual(ReasonCodes, want) {
		t.Errorf("ReasonCodes = %v, want %v", ReasonCodes, want)
	}
}
