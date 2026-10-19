package worldmap

import (
	"encoding/binary"
	"errors"
	"math"
)

var (
	errShort  = errors.New("worldmap: truncated data")
	errVarint = errors.New("worldmap: bad varint")
)

// buf is a bounds-checked little-endian reader over a byte slice. The first
// failed read sets err; every later read returns zero values, so callers can
// check err once per record instead of after every field.
type buf struct {
	b   []byte
	p   int
	err error
}

func (r *buf) need(n int) bool {
	if r.err != nil {
		return false
	}
	if n < 0 || n > len(r.b)-r.p {
		r.err = errShort
		return false
	}
	return true
}

func (r *buf) skip(n int) {
	if r.need(n) {
		r.p += n
	}
}

func (r *buf) u8() byte {
	if !r.need(1) {
		return 0
	}
	v := r.b[r.p]
	r.p++
	return v
}

func (r *buf) u16() uint16 {
	if !r.need(2) {
		return 0
	}
	v := binary.LittleEndian.Uint16(r.b[r.p:])
	r.p += 2
	return v
}

func (r *buf) i16() int16 { return int16(r.u16()) }

func (r *buf) i32() int32 {
	if !r.need(4) {
		return 0
	}
	v := int32(binary.LittleEndian.Uint32(r.b[r.p:]))
	r.p += 4
	return v
}

func (r *buf) i64() int64 {
	if !r.need(8) {
		return 0
	}
	v := int64(binary.LittleEndian.Uint64(r.b[r.p:]))
	r.p += 8
	return v
}

func (r *buf) f32() float32 { return math.Float32frombits(uint32(r.i32())) }

// bytes returns a sub-slice (no copy) of n bytes.
func (r *buf) bytes(n int) []byte {
	if !r.need(n) {
		return nil
	}
	v := r.b[r.p : r.p+n]
	r.p += n
	return v
}

// uvarint reads a .NET 7-bit encoded length.
func (r *buf) uvarint() int {
	var n uint32
	for shift := 0; shift < 35; shift += 7 {
		c := r.u8()
		if r.err != nil {
			return 0
		}
		n |= uint32(c&0x7f) << shift
		if c&0x80 == 0 {
			if n > math.MaxInt32 {
				r.err = errShort
				return 0
			}
			return int(n)
		}
	}
	r.err = errVarint
	return 0
}

// str reads a .NET BinaryWriter string; long strings are cut to max bytes.
func (r *buf) str(max int) string {
	n := r.uvarint()
	b := r.bytes(n)
	if len(b) > max {
		b = b[:max]
	}
	return string(b)
}

func (r *buf) skipStr() { r.skip(r.uvarint()) }
