package worldmap

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"math"
)

// Chunk files (Valheim 1.0, uncompressed): u16 version | i32 count | count x ZDO.
//
//	ZDO: u16 flags
//	     pos: flags&0x2000 ? (i16 x, i16 z) : (f32 x, f32 y, f32 z)
//	     i32 prefab hash
//	     flags&0x1000: rotation as Euler angles in half degrees (see rotation)
//	     flags&0x01:   connection, u8 type + i32 target hash
//	     then one typed map per set bit, in this order:
//	       0x02 f32, 0x04 Vector3, 0x08 Quaternion, 0x10 i32, 0x20 i64,
//	       0x40 string (7-bit length), 0x80 bytes (i32 length)
//	     a map is a count (u8, or two bytes big-endian-ish when bit 7 is set:
//	     ((b0&127)<<8)|b1) and count x (i32 key hash, value).
//
// Only the values the map needs are decoded; everything else is skipped by
// length. Nothing in this file panics on bad input: a failed read sets the
// reader's error and the chunk is dropped by the caller.

const (
	flagConn      = 0x0001
	flagRotation  = 0x1000
	flagShortPos  = 0x2000
	maxChunkZDOs  = 4_000_000
	maxMapEntries = 1 << 15
	maxNameBytes  = 256
	// worldRadius bounds the playable world; the game parks some objects
	// (zone controllers, leviathans) far outside it.
	worldRadius = 10500.0
	// sampleCap bounds how many piece positions a zone keeps for the
	// "explored near a base" test.
	sampleCap = 64
)

type zoneKey struct{ x, z int32 }

func zoneOf(x, z float32) zoneKey {
	return zoneKey{int32(math.Floor((float64(x) + 32) / 64)), int32(math.Floor((float64(z) + 32) / 64))}
}

type zonePieces struct {
	count    int
	stations map[string]bool
	bed      bool
	samples  [][2]float32
}

type rawPortal struct {
	kind     string
	x, z     float32
	tag      string
	connType byte
	connHash int32
	hasConn  bool
}

type rawTomb struct {
	x, z  float32
	owner string
	ticks int64
	items []rawItem
}

type rawBed struct {
	x, z  float32
	owner string
}

type rawVehicle struct {
	kind  string
	x, z  float32
	built bool
}

// rawStore is a player-built container with its decoded inventory.
type rawStore struct {
	prefab     string
	x, y, z    float32
	items      []rawItem
	unreadable bool
}

type rawPin struct {
	typ  int32
	name string
	x, z float32
}

// chunkData is everything one chunk file contributes to the map.
type chunkData struct {
	zdos     int
	density  map[zoneKey]int32
	pieces   map[zoneKey]*zonePieces
	portals  []rawPortal
	tombs    []rawTomb
	beds     []rawBed
	vehicles []rawVehicle
	stores   []rawStore
	built    []rawPiece
	nature   []natureItem
	tables   int
	explored []uint64 // exploredWords words, nil when the chunk holds no table
	pins     []rawPin
	terrain  map[zoneKey]int
	// noPrefab is the inventory items left out for having no prefab, as
	// the game leaves them out on load.
	noPrefab int
	// badInventory is the containers whose inventory did not decode, and
	// badInventoryErr the first reason, so a new game format shows in the log.
	badInventory    int
	badInventoryErr error
}

func newChunkData() *chunkData {
	return &chunkData{
		density: map[zoneKey]int32{},
		pieces:  map[zoneKey]*zonePieces{},
		terrain: map[zoneKey]int{},
	}
}

func inWorld(x, z float32) bool {
	fx, fz := float64(x), float64(z)
	return !math.IsNaN(fx) && !math.IsNaN(fz) && fx*fx+fz*fz <= worldRadius*worldRadius
}

// zdoFields is the subset of one ZDO's maps the map cares about.
type zdoFields struct {
	creator bool
	// built is a creator that is not 0: a piece a player placed.
	built       bool
	tag         string
	ownerName   string
	timeOfDeath int64
	data        []byte
	tcdata      []byte
	items       []byte
	// scale is the x of the "scale" Vector3 (vegetation sets it), 0 when absent.
	scale float32
}

// parseChunk decodes a whole chunk file. A panic is turned into an error as a
// last line of defence; the reader itself never indexes out of bounds.
func parseChunk(b []byte) (cd *chunkData, err error) {
	defer func() {
		if p := recover(); p != nil {
			cd, err = nil, fmt.Errorf("worldmap: chunk parse panic: %v", p)
		}
	}()
	r := &buf{b: b}
	r.u16() // version
	count := int(r.i32())
	if r.err != nil {
		return nil, r.err
	}
	if count < 0 || count > maxChunkZDOs {
		return nil, errors.New("worldmap: bad ZDO count")
	}
	cd = newChunkData()
	var f zdoFields
	for i := 0; i < count; i++ {
		flags := r.u16()
		var x, y, z float32
		if flags&flagShortPos != 0 {
			x, z = float32(r.i16()), float32(r.i16())
		} else {
			x = r.f32()
			y = r.f32()
			z = r.f32()
		}
		prefab := r.i32()
		var rot [2]uint16
		if flags&flagRotation != 0 {
			rot[0] = r.u16()
			if rot[0]&0x8000 == 0 {
				rot[1] = r.u16()
			}
		}
		var connType byte
		var connHash int32
		if flags&flagConn != 0 {
			connType = r.u8()
			connHash = r.i32()
		}
		info, interesting := prefabByHash[prefab]
		f = zdoFields{}
		readMaps(r, flags, interesting, &f)
		if r.err != nil {
			return nil, r.err
		}
		cd.zdos++
		if !inWorld(x, z) {
			continue
		}
		zk := zoneOf(x, z)
		cd.density[zk]++
		// Ships and carts carry a creator too, but they move: not part of a base.
		if f.creator && info.role != roleVehicle {
			zp := cd.pieces[zk]
			if zp == nil {
				zp = &zonePieces{}
				cd.pieces[zk] = zp
			}
			zp.count++
			if len(zp.samples) < sampleCap {
				zp.samples = append(zp.samples, [2]float32{x, z})
			}
			if info.role == roleStation {
				if zp.stations == nil {
					zp.stations = map[string]bool{}
				}
				zp.stations[info.name] = true
			}
			if info.role == roleBed {
				zp.bed = true
			}
			if f.built {
				yaw, tilted := rotation(flags&flagRotation != 0, rot)
				cd.built = append(cd.built, rawPiece{hash: prefab, x: x, y: y, z: z, yaw: yaw, tilted: tilted})
			}
		}
		if !f.creator && y <= maxNatureY {
			if kind, ok := natureByHash[prefab]; ok && (flags&flagShortPos != 0 || !underwater(kind, y)) {
				yaw, _ := rotation(flags&flagRotation != 0, rot)
				cd.nature = append(cd.nature, newNatureItem(kind, x, z, yaw, f.scale))
			}
		}
		if !interesting {
			continue
		}
		switch info.role {
		case rolePortal:
			cd.portals = append(cd.portals, rawPortal{kind: info.name, x: x, z: z, tag: f.tag, connType: connType, connHash: connHash, hasConn: flags&flagConn != 0})
		case roleTombstone:
			// A grave whose inventory does not decode is still a grave.
			items, _ := cd.inventory(f.items)
			cd.tombs = append(cd.tombs, rawTomb{x: x, z: z, owner: f.ownerName, ticks: f.timeOfDeath, items: items})
		case roleBed:
			cd.beds = append(cd.beds, rawBed{x: x, z: z, owner: f.ownerName})
		case roleVehicle:
			cd.vehicles = append(cd.vehicles, rawVehicle{kind: info.name, x: x, z: z, built: f.creator})
			if f.creator {
				cd.addStore(info.name, x, y, z, f.items)
			}
		case roleContainer:
			// Only what a player built: a listed prefab without a creator is
			// not exported, contents or not.
			if f.creator {
				cd.addStore(info.name, x, y, z, f.items)
			}
		case roleTable:
			cd.tables++
			if f.data != nil {
				// A table whose data does not decode still counts as a table;
				// it just adds nothing to the mask or the pins.
				_ = cd.addTable(f.data)
			}
		case roleTerrain:
			if n, err := terrainCells(f.tcdata); err == nil && n > 0 {
				cd.terrain[zk] += n
			}
		}
	}
	return cd, nil
}

// readMaps walks the typed maps of one ZDO. Values are decoded only for the
// keys the map uses; with keep false only `creator` is looked at.
func readMaps(r *buf, flags uint16, keep bool, f *zdoFields) {
	for bit := uint16(0x02); bit <= 0x80; bit <<= 1 {
		if flags&bit == 0 {
			continue
		}
		n := int(r.u8())
		if n&0x80 != 0 {
			n = (n&0x7f)<<8 | int(r.u8())
		}
		if r.err != nil {
			return
		}
		if n > maxMapEntries {
			r.err = errors.New("worldmap: bad map size")
			return
		}
		for j := 0; j < n && r.err == nil; j++ {
			key := r.i32()
			switch bit {
			case 0x02, 0x10:
				r.skip(4)
			case 0x04:
				if key == keyScale {
					f.scale = r.f32()
					r.skip(8)
				} else {
					r.skip(12)
				}
			case 0x08:
				r.skip(16)
			case 0x20:
				v := r.i64()
				if key == keyCreator {
					f.creator = true
					f.built = v != 0
				} else if keep && key == keyTimeOfDeath {
					f.timeOfDeath = v
				}
			case 0x40:
				if keep && (key == keyTag || key == keyOwnerName) {
					s := r.str(maxNameBytes)
					if key == keyTag {
						f.tag = s
					} else {
						f.ownerName = s
					}
				} else {
					r.skipStr()
				}
			case 0x80:
				l := int(r.i32())
				if l < 0 {
					r.err = errShort
					return
				}
				v := r.bytes(l)
				if keep && key == keyData {
					f.data = v
				} else if keep && key == keyTCData {
					f.tcdata = v
				} else if keep && key == keyItems {
					f.items = v
				}
			}
		}
	}
}

// inventory decodes an "items" blob; no blob is an empty inventory. The
// result holds no reference into the chunk file, which may be cached.
func (cd *chunkData) inventory(blob []byte) ([]rawItem, error) {
	if len(blob) == 0 {
		return nil, nil
	}
	items, skipped, err := parseInventory(blob)
	cd.noPrefab += skipped
	if err != nil {
		cd.badInventory++
		if cd.badInventoryErr == nil {
			cd.badInventoryErr = err
		}
	}
	return items, err
}

func (cd *chunkData) addStore(prefab string, x, y, z float32, blob []byte) {
	items, err := cd.inventory(blob)
	cd.stores = append(cd.stores, rawStore{prefab: prefab, x: x, y: y, z: z, items: items, unreadable: err != nil})
}

// The cartography table's explored mask: 2048 x 2048 pixels of 12 m.
const (
	exploredSize  = 2048
	exploredMPP   = 12
	exploredWords = exploredSize * exploredSize / 64
	maxPins       = 10000
)

// addTable decodes a cartography table's `data` blob (gzip):
//
//	i32 version (3) | i32 n (4194304 = 2048^2) | n explored bytes (0 or 1)
//	| i32 pins | pins x {i64 owner, string name, f32 x y z, i32 type,
//	  u8 checked, string author}
//
// The mask is ORed into the chunk's union. Pin owner and author (platform
// ids) are read past and dropped here.
func (cd *chunkData) addTable(blob []byte) error {
	zr, err := gzip.NewReader(bytes.NewReader(blob))
	if err != nil {
		return err
	}
	defer zr.Close()
	br := bufio.NewReaderSize(zr, 64*1024)
	head := make([]byte, 8)
	if _, err := io.ReadFull(br, head); err != nil {
		return err
	}
	h := &buf{b: head}
	h.i32()
	if n := h.i32(); n != exploredSize*exploredSize {
		return fmt.Errorf("worldmap: explored size %d", n)
	}
	mask := make([]uint64, exploredWords)
	row := make([]byte, exploredSize)
	for y := 0; y < exploredSize; y++ {
		if _, err := io.ReadFull(br, row); err != nil {
			return err
		}
		base := y * exploredSize
		for x, v := range row {
			if v != 0 {
				i := base + x
				mask[i>>6] |= 1 << (i & 63)
			}
		}
	}
	// The rest (pins) is small; read it whole, capped.
	rest, err := io.ReadAll(io.LimitReader(br, 4<<20))
	if err != nil {
		return err
	}
	if cd.explored == nil {
		cd.explored = mask
	} else {
		for i, w := range mask {
			cd.explored[i] |= w
		}
	}
	r := &buf{b: rest}
	n := int(r.i32())
	if r.err != nil || n < 0 || n > maxPins {
		return errors.New("worldmap: bad pin count")
	}
	for i := 0; i < n; i++ {
		r.i64() // owner: platform id, dropped
		name := r.str(maxNameBytes)
		x := r.f32()
		r.f32()
		z := r.f32()
		typ := r.i32()
		r.u8()      // checked
		r.skipStr() // author: platform id, dropped
		if r.err != nil {
			return r.err
		}
		if inWorld(x, z) {
			cd.pins = append(cd.pins, rawPin{typ: typ, name: name, x: x, z: z})
		}
	}
	return nil
}

// terrainCells counts the cells a terrain compiler changed (TCData, gzip):
//
//	i32 version (1) | i32 operations | Vector3 last op | f32 last radius
//	| i32 n (4225) | n x {u8 modified, [f32 level, f32 smooth] if modified}
//	| i32 m (4225) | m x {u8 painted, [4 x f32 colour] if painted}
//
// A cell counts once whether it was levelled, painted or both.
func terrainCells(blob []byte) (int, error) {
	if len(blob) == 0 {
		return 0, nil
	}
	zr, err := gzip.NewReader(bytes.NewReader(blob))
	if err != nil {
		return 0, err
	}
	defer zr.Close()
	b, err := io.ReadAll(io.LimitReader(zr, 1<<20))
	if err != nil {
		return 0, err
	}
	r := &buf{b: b}
	r.skip(4 + 4 + 12 + 4)
	n := int(r.i32())
	if r.err != nil || n < 0 || n > 65*65 {
		return 0, errors.New("worldmap: bad terrain cell count")
	}
	changed := make([]bool, n)
	count := 0
	for i := 0; i < n; i++ {
		if r.u8() != 0 {
			r.skip(8)
			changed[i] = true
			count++
		}
	}
	m := int(r.i32())
	if r.err != nil || m < 0 || m > 65*65 {
		return 0, errors.New("worldmap: bad terrain paint count")
	}
	for i := 0; i < m; i++ {
		if r.u8() != 0 {
			r.skip(16)
			if i >= n || !changed[i] {
				count++
			}
		}
	}
	if r.err != nil {
		return 0, r.err
	}
	return count, nil
}
