#!/usr/bin/env python3
"""Build Skald's item icon sheet from the operator's own Valheim server install.

Prototype. Skald ships no game assets: this reads the dedicated server files
the operator already has (read-only), and writes a sprite sheet plus a JSON
map (prefab name -> rect in the sheet) into a directory the operator owns.

    extract.py --game /opt/valheim/server/valheim_server_Data --out /icons

How it maps items to icons: every item prefab carries an ItemDrop component
whose shared data lists its inventory icons (m_icons, PPtr<Sprite>). The
bundles ship with type trees, so the component is read by field name, not by
offset, and the sprite is resolved through the bundle's external file list.
No name guessing.

The item prefab bundle is ~750 MB; only its object table and the ItemDrop and
GameObject records are needed (~110 MB of compressed blocks), so it is read
block by block with seek() instead of being loaded whole.

The run is skipped when map.json already records the current game build.
"""

import argparse
import bisect
import hashlib
import json
import mmap
import os
import re
import struct
import sys
import time
import types

# UnityPy imports its audio exporter eagerly, which pulls in fmod_toolkit and
# the proprietary libfmod. Audio is never touched here, so a stub keeps libfmod
# out of the image.
sys.modules.setdefault("fmod_toolkit", types.ModuleType("fmod_toolkit"))

import lz4.block  # noqa: E402
import UnityPy  # noqa: E402
from PIL import Image  # noqa: E402
from UnityPy.files.ObjectReader import ObjectReader  # noqa: E402
from UnityPy.files.SerializedFile import SerializedFile  # noqa: E402
from UnityPy.streams import EndianBinaryReader  # noqa: E402

SOFTREF = "StreamingAssets/SoftRef"
ICON_PATH = re.compile(r"^Assets/GameElements/Items/_icons/")
ITEM_PREFAB = re.compile(r"^Assets/GameElements/Items/.*\.prefab$")


def read_manifest(path):
    """bundle id -> list of asset paths, from manifest_extended."""
    bundles = {}
    bundle = None
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            s = line.strip()
            if s.startswith("bundle:"):
                bundle = s.split(":", 1)[1].strip()
            elif s.startswith("path in bundle:") and bundle:
                bundles.setdefault(bundle, []).append(s.split(":", 1)[1].strip())
    return bundles


class LazyBundle:
    """A UnityFS bundle whose first serialized file is decompressed on demand."""

    def __init__(self, path):
        self.f = open(path, "rb")
        self.read_bytes = 0
        head = self.f.read(256)
        p = head.index(b"\0") + 1
        if head[:p] != b"UnityFS\0":
            raise ValueError(f"{path}: not a UnityFS bundle")
        (version,) = struct.unpack(">I", head[p:p + 4])
        p += 4
        p = head.index(b"\0", p) + 1  # player version
        p = head.index(b"\0", p) + 1  # engine version
        _, csize, usize, flags = struct.unpack(">qIII", head[p:p + 20])
        p += 20
        if version >= 7:
            p = (p + 15) // 16 * 16
        if flags & 0x80:  # block info at the end of the file
            self.f.seek(-csize, os.SEEK_END)
            info = self._decompress(self.f.read(csize), usize, flags)
        else:
            self.f.seek(p)
            info = self._decompress(self.f.read(csize), usize, flags)
            p += csize
            if flags & 0x200:
                p = (p + 15) // 16 * 16
        q = 16
        (n,) = struct.unpack(">i", info[q:q + 4])
        q += 4
        self.blocks = []
        c, u = p, 0
        for _ in range(n):
            us, cs, bf = struct.unpack(">IIH", info[q:q + 10])
            q += 10
            self.blocks.append((c, cs, u, us, bf))
            c += cs
            u += us
        self.ustarts = [b[2] for b in self.blocks]
        (n,) = struct.unpack(">i", info[q:q + 4])
        q += 4
        self.nodes = []
        for _ in range(n):
            off, size, nf = struct.unpack(">qqI", info[q:q + 20])
            q += 20
            e = info.index(b"\0", q)
            self.nodes.append((off, size, nf, info[q:e].decode()))
            q = e + 1
        off, size, _, self.name = next(x for x in self.nodes if x[2] & 4)
        self.base = off
        # Anonymous mmap: pages cost memory only once a block is written there.
        self.buf = mmap.mmap(-1, size)
        self.cache = {}  # a few decompressed blocks, oldest evicted first
        self.seen = set()

    @staticmethod
    def _decompress(data, usize, flags):
        kind = flags & 0x3F
        if kind == 0:
            return data
        if kind in (2, 3):
            return lz4.block.decompress(data, uncompressed_size=usize)
        raise ValueError(f"unsupported bundle compression {kind}")

    def _block(self, i):
        if i not in self.cache:
            c, cs, u, us, bf = self.blocks[i]
            self.f.seek(c)
            raw = self.f.read(cs)
            if i not in self.seen:
                self.seen.add(i)
                self.read_bytes += cs
            if len(self.cache) >= 8:
                self.cache.pop(next(iter(self.cache)))
            self.cache[i] = self._decompress(raw, us, bf)
        return self.cache[i]

    def ensure(self, start, end):
        """Copy only [start, end) of the serialized file into the buffer, so
        resident memory follows the bytes actually read, not whole blocks."""
        a, b = self.base + start, self.base + end
        i = bisect.bisect_right(self.ustarts, a) - 1
        while i < len(self.blocks) and self.blocks[i][2] < b:
            u, us = self.blocks[i][2], self.blocks[i][3]
            lo, hi = max(u, a), min(u + us, b)
            if lo < hi:
                self.buf[lo - self.base:hi - self.base] = self._block(i)[lo - u:hi - u]
            i += 1

    def serialized_file(self):
        self.ensure(0, 64)
        h = bytes(self.buf[:64])
        msize = struct.unpack(">I", h[20:24])[0] if struct.unpack(">I", h[8:12])[0] >= 22 else struct.unpack(">I", h[0:4])[0]
        self.ensure(0, 64 + msize + 64)
        reader = EndianBinaryReader(memoryview(self.buf))
        _lazy[id(reader)] = self
        return SerializedFile(reader, name=self.name)


_lazy = {}
_read_typetree = ObjectReader.read_typetree


def _read_typetree_lazy(self, *args, **kwargs):
    lazy = _lazy.get(id(self.assets_file.reader))
    if lazy is not None:
        lazy.ensure(self.byte_start, self.byte_start + self.byte_size)
    return _read_typetree(self, *args, **kwargs)


ObjectReader.read_typetree = _read_typetree_lazy


def field_names(node, acc):
    acc.add(node.m_Name)
    for ch in node.m_Children:
        field_names(ch, acc)
    return acc


def item_icons(sf):
    """prefab name -> (external CAB name or None, sprite path id), first icon only."""
    item_types = set()
    for t in sf.types:
        if t.class_id == 114 and t.node is not None:
            names = field_names(t.node, set())
            if {"m_itemData", "m_shared", "m_icons"} <= names:
                item_types.add(id(t))
    externals = [e.path.rsplit("/", 1)[-1] for e in sf.externals]
    out = {}
    for obj in sf.objects.values():
        if id(obj.serialized_type) not in item_types:
            continue
        d = obj.read_typetree()
        icons = d["m_itemData"]["m_shared"]["m_icons"]
        go = d["m_GameObject"]
        if not icons or go["m_FileID"] != 0:
            continue
        name = sf.objects[go["m_PathID"]].read_typetree()["m_Name"]
        fid, pid = icons[0]["m_FileID"], icons[0]["m_PathID"]
        out.setdefault(name, (externals[fid - 1] if fid > 0 else None, pid))
    return out


def build_key(game, bundles):
    h = hashlib.sha256()
    with open(os.path.join(game, SOFTREF, "hash"), "rb") as f:
        h.update(f.read())
    for b in sorted(bundles):
        h.update(f"{b}:{os.path.getsize(os.path.join(game, SOFTREF, 'Bundles', b))}".encode())
    return h.hexdigest()[:16]


def write_atomic(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--game", required=True, help="valheim_server_Data directory (read-only)")
    ap.add_argument("--out", required=True, help="writable output directory")
    ap.add_argument("--size", type=int, default=64, help="icon edge in px")
    ap.add_argument("--quality", type=int, default=85, help="WebP quality, 101 = lossless")
    ap.add_argument("--force", action="store_true", help="rebuild even if the game build is unchanged")
    a = ap.parse_args()
    t0 = time.time()

    manifest = read_manifest(os.path.join(a.game, SOFTREF, "manifest_extended"))
    icon_bundles = sorted(b for b, ps in manifest.items() if any(ICON_PATH.match(p) for p in ps))
    item_bundles = sorted(b for b, ps in manifest.items() if any(ITEM_PREFAB.match(p) for p in ps))
    key = build_key(a.game, icon_bundles + item_bundles)
    map_path = os.path.join(a.out, "map.json")
    if not a.force and os.path.exists(map_path):
        with open(map_path) as f:
            if json.load(f).get("build") == key:
                print(f"icons: up to date for build {key}")
                return

    sprites = {}  # (cab, path id) -> Sprite object
    for b in icon_bundles:
        env = UnityPy.load(os.path.join(a.game, SOFTREF, "Bundles", b))
        for obj in env.objects:
            if obj.type.name == "Sprite":
                sprites[(obj.assets_file.name, obj.path_id)] = obj

    refs, read = {}, 0
    for b in item_bundles:
        lazy = LazyBundle(os.path.join(a.game, SOFTREF, "Bundles", b))
        sf = lazy.serialized_file()
        for name, (cab, pid) in item_icons(sf).items():
            refs.setdefault(name, (cab or lazy.name, pid))
        read += lazy.read_bytes
        del _lazy[id(sf.reader)]
    t1 = time.time()

    # One cell per distinct sprite; several prefabs may share one.
    order, cells, items = [], {}, {}
    for name in sorted(refs):
        ref = refs[name]
        if ref not in sprites:
            continue
        if ref not in cells:
            cells[ref] = len(order)
            order.append(ref)
        items[name] = cells[ref]
    s, cols = a.size, 32
    rows = (len(order) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * s, max(rows, 1) * s), (0, 0, 0, 0))
    for k, ref in enumerate(order):
        im = sprites[ref].read().image.convert("RGBA")
        if im.size != (s, s):
            im = im.resize((s, s), Image.LANCZOS)
        sheet.paste(im, ((k % cols) * s, (k // cols) * s))
    os.makedirs(a.out, exist_ok=True)
    tmp = os.path.join(a.out, "sheet.webp.tmp")
    if a.quality > 100:
        sheet.save(tmp, "WEBP", lossless=True, method=4)
    else:
        sheet.save(tmp, "WEBP", quality=a.quality, alpha_quality=100, method=4)
    os.replace(tmp, os.path.join(a.out, "sheet.webp"))
    doc = {
        "version": 1,
        "build": key,
        "size": s,
        "sheet": "sheet.webp",
        "items": {n: [(c % cols) * s, (c // cols) * s, s, s] for n, c in items.items()},
    }
    write_atomic(map_path, json.dumps(doc, separators=(",", ":"), sort_keys=True).encode())
    print(
        f"icons: build {key}, {len(items)} items, {len(order)} sprites, "
        f"{len(refs) - len(items)} unresolved, read {read / 1e6:.0f} MB of item bundles, "
        f"scan {t1 - t0:.1f}s, total {time.time() - t0:.1f}s"
    )


if __name__ == "__main__":
    main()
