package worldmap

import (
	"bufio"
	"compress/gzip"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"os"
)

// The .db2 file: i32 version | f64 netTime | i32 gzipLen | gzip blob | trailer.
// The blob (as far as the map reads it):
//
//	i32 zoneCount | zoneCount x (i16 x, i16 z)          generated zones
//	i32 (32)
//	i32 k | k x string                                   global keys
//	bool locationsGenerated
//	i32 n | n x (i32 nameHash, f32 x y z, bool placed)  every location of the seed
//
// internal/world reads only the head of this blob; the location list is
// ~17 bytes per location (12k+ on a full world), so it is decoded here.

const (
	maxGenZones  = 1 << 20
	maxLocations = 1 << 20
	maxKeyCount  = 4096
)

type rawLocation struct {
	info   locationInfo
	x, z   float32
	placed bool
}

type db2Data struct {
	generated []zoneKey
	locations []rawLocation
	total     int
	placed    int
}

func readDB2(path string) (*db2Data, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	head := make([]byte, 16)
	if _, err := io.ReadFull(f, head); err != nil {
		return nil, err
	}
	gzLen := int64(binary.LittleEndian.Uint32(head[12:16]))
	zr, err := gzip.NewReader(io.LimitReader(f, gzLen))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	br := bufio.NewReaderSize(io.LimitReader(zr, 256<<20), 64*1024)
	return parseDB2Blob(br)
}

func parseDB2Blob(br *bufio.Reader) (*db2Data, error) {
	var tmp [17]byte
	i32 := func() (int32, error) {
		if _, err := io.ReadFull(br, tmp[:4]); err != nil {
			return 0, err
		}
		return int32(binary.LittleEndian.Uint32(tmp[:4])), nil
	}
	zones, err := i32()
	if err != nil {
		return nil, err
	}
	if zones < 0 || zones > maxGenZones {
		return nil, errors.New("worldmap: bad zone count")
	}
	d := &db2Data{generated: make([]zoneKey, 0, zones)}
	for i := int32(0); i < zones; i++ {
		if _, err := io.ReadFull(br, tmp[:4]); err != nil {
			return nil, err
		}
		d.generated = append(d.generated, zoneKey{int32(int16(binary.LittleEndian.Uint16(tmp[0:2]))), int32(int16(binary.LittleEndian.Uint16(tmp[2:4])))})
	}
	if _, err := i32(); err != nil { // version-like int (32)
		return nil, err
	}
	keys, err := i32()
	if err != nil {
		return nil, err
	}
	if keys < 0 || keys > maxKeyCount {
		return nil, errors.New("worldmap: bad global key count")
	}
	for i := int32(0); i < keys; i++ {
		n, err := readUvarint(br)
		if err != nil {
			return nil, err
		}
		if n > 4096 {
			return nil, errors.New("worldmap: bad key length")
		}
		if _, err := br.Discard(n); err != nil {
			return nil, err
		}
	}
	if b, err := br.ReadByte(); err != nil || b > 1 {
		return nil, errors.New("worldmap: locations not where expected")
	}
	n, err := i32()
	if err != nil {
		return nil, err
	}
	if n < 0 || n > maxLocations {
		return nil, errors.New("worldmap: bad location count")
	}
	for i := int32(0); i < n; i++ {
		if _, err := io.ReadFull(br, tmp[:17]); err != nil {
			return nil, err
		}
		hash := int32(binary.LittleEndian.Uint32(tmp[0:4]))
		x := math.Float32frombits(binary.LittleEndian.Uint32(tmp[4:8]))
		z := math.Float32frombits(binary.LittleEndian.Uint32(tmp[12:16]))
		placed := tmp[16] != 0
		d.total++
		if placed {
			d.placed++
		}
		info, listed := locationByHash[hash]
		if !listed || !inWorld(x, z) {
			continue
		}
		d.locations = append(d.locations, rawLocation{info: info, x: x, z: z, placed: placed})
	}
	return d, nil
}

func readUvarint(br *bufio.Reader) (int, error) {
	var n uint32
	for shift := 0; shift < 35; shift += 7 {
		c, err := br.ReadByte()
		if err != nil {
			return 0, err
		}
		n |= uint32(c&0x7f) << shift
		if c&0x80 == 0 {
			return int(n), nil
		}
	}
	return 0, errors.New("worldmap: bad varint")
}
