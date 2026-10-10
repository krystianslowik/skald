// Command gen-world writes a small synthetic Valheim 1.0 save generation
// with starting keys, a player list and boss progress, in the layout
// internal/world decodes. With -map it writes a whole world for
// internal/worldmap instead: chunk files with land, bases, portals, graves,
// beds, ships, a cartography table and terrain edits, plus the chunk index
// and the location list (see worldmap.go). Every value is made up: real
// saves hold private player data and never enter the repository.
//
//	go run ./testdata/gen-world testdata/world-progress
//	go run ./testdata/gen-world -map testdata/world-map
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

func str(b *bytes.Buffer, s string) {
	n := uint32(len(s))
	for n >= 0x80 {
		b.WriteByte(byte(n) | 0x80)
		n >>= 7
	}
	b.WriteByte(byte(n))
	b.WriteString(s)
}

func i32(b *bytes.Buffer, v int32) { _ = binary.Write(b, binary.LittleEndian, v) }

func strs(b *bytes.Buffer, list []string) {
	i32(b, int32(len(list)))
	for _, s := range list {
		str(b, s)
	}
}

func main() {
	if len(os.Args) == 3 && os.Args[1] == "-map" {
		writeMapWorld(os.Args[2])
		return
	}
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: gen-world [-map] <dir>")
		os.Exit(2)
	}
	dir := os.Args[1]
	if err := os.MkdirAll(dir, 0o755); err != nil {
		panic(err)
	}

	// .fwl2
	var p bytes.Buffer
	i32(&p, 41) // version
	str(&p, "Midgard")
	str(&p, "Yggdrasil1")
	i32(&p, 123456789)                                          // seed
	_ = binary.Write(&p, binary.LittleEndian, int64(987654321)) // uid
	i32(&p, 2)                                                  // worldGenVersion
	p.WriteByte(1)                                              // needsDB
	strs(&p, []string{
		"resourcerate 200",
		"teleportall",
		"preset combat_default:deathpenalty_default:resources_muchmore:raids_default:portals_casual",
	})
	players := [][4]string{
		{"Xbox_2533274900000001", "ragnar#1111", "ragnar#1111", "AAAA000000000001"},
		{"Steam_76561190000000003", "bjornthebold", "bjornthebold", "AAAA000000000003"},
	}
	i32(&p, int32(len(players)))
	for _, pl := range players {
		for _, s := range pl {
			str(&p, s)
		}
	}
	var fwl bytes.Buffer
	i32(&fwl, int32(p.Len()))
	fwl.Write(p.Bytes())

	// .db2 blob: generated zones, a version int, the global keys, then
	// locationsGenerated and an empty location list.
	var blob bytes.Buffer
	i32(&blob, 9)
	for x := int16(-1); x <= 1; x++ {
		for y := int16(-1); y <= 1; y++ {
			_ = binary.Write(&blob, binary.LittleEndian, [2]int16{x, y})
		}
	}
	i32(&blob, 32)
	strs(&blob, []string{"activebosses 0", "defeated_eikthyr", "killedtroll", "defeated_gdking", "killed_surtling"})
	blob.WriteByte(1)
	i32(&blob, 0)
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write(blob.Bytes())
	zw.Close()

	var db bytes.Buffer
	i32(&db, 41)
	_ = binary.Write(&db, binary.LittleEndian, math.Float64bits(48*1800+367.5))
	i32(&db, int32(gz.Len()))
	db.Write(gz.Bytes())
	db.Write(make([]byte, 40)) // trailer, as in real saves

	write := func(name string, b []byte) {
		if err := os.WriteFile(filepath.Join(dir, name), b, 0o644); err != nil {
			panic(err)
		}
	}
	write("_main.1.fwl2", fwl.Bytes())
	write("_main.1.db2", db.Bytes())
	write("_main.1.ok", []byte{41, 0, 0, 0})
}
