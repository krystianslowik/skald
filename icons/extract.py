#!/usr/bin/env python3
"""Build Skald's item icon sheet from the operator's own Valheim server install.

Skald ships no game assets. This reads the dedicated server files the operator
already has, read-only, and writes a sprite sheet plus a JSON map (item prefab
name -> cell in the sheet) to a directory the operator owns:

    extract.py --game /opt/valheim --out /icons            # once
    extract.py --game /opt/valheim --out /icons --every 600  # sidecar loop

How items map to icons: every item prefab carries an ItemDrop component whose
shared data lists its inventory icons (m_icons, PPtr<Sprite>). The bundles
ship with type trees, so the component is read by field name, not by offset,
and the sprite is resolved through the bundle's external file list. No name
guessing. v1 uses the first icon (m_icons[0]); variants are not keyed yet.

The item prefab bundle is ~750 MB. Only its object table and the ItemDrop and
GameObject records are needed (~100 MB of compressed blocks), so it is read
block by block with seek() instead of being loaded whole.

A build key (the SoftRef hash file plus the size of every bundle used) names
the game build. A run whose key matches map.json does nothing; in the loop
that check costs a few stat() calls and never imports UnityPy. The key is
taken again after the read: the game's updater rewrites the install in place,
and a read that straddles an update is thrown away and retried next tick.

Outputs, written atomically, map.json last:
    sheet.<build>.webp   the icons, `size` px cells, `columns` per row
    map.json             {"version", "build", "size", "columns", "width",
                          "height", "sheet", "count", "skald",
                          "items": {name: [x, y]}}
Older sheets are removed once map.json points at the new one.

Exit codes: 0 done or already up to date, 2 bad arguments or no game install,
3 the game files could not be read (mid-update, unknown format), 4 the output
could not be written, 5 nothing was found to extract.
"""

import argparse
import bisect
import hashlib
import io
import json
import mmap
import os
import re
import signal
import struct
import subprocess
import sys
import time
import types

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_UNREADABLE = 3
EXIT_WRITE = 4
EXIT_EMPTY = 5

SOFTREF = os.path.join("StreamingAssets", "SoftRef")
ICON_PATH = re.compile(r"^Assets/GameElements/Items/_icons/")
ITEM_PREFAB = re.compile(r"^Assets/GameElements/Items/.*\.prefab$")
SHEET_NAME = re.compile(r"^sheet\.[0-9a-f]+\.webp(\.tmp)?$")
COLUMNS = 32
MAP_VERSION = 1

NOTICE = (
    "Item icons are read from your own Valheim server installation and stay on your server. "
    "Skald does not include or distribute any Valheim artwork, and is not affiliated with, "
    "endorsed by, or sponsored by Iron Gate Studio or Coffee Stain."
)


class Unreadable(Exception):
    """The game files are missing, changing, or in a layout this does not know."""


def log(msg):
    print(f"skald-icons: {msg}", flush=True)


# --- locating the install ----------------------------------------------------

# Where the community server image keeps the game, vanilla first. /opt/valheim/dl
# is steamcmd's download directory and is never read: it changes mid-download.
INSTALL_DIRS = ("server", "bepinex", "plus")


def find_game(path):
    """The valheim_server_Data directory for `path`: that directory itself, an
    install holding it, or /opt/valheim (tries server, bepinex, plus)."""
    cands = [path, os.path.join(path, "valheim_server_Data")]
    cands += [os.path.join(path, d, "valheim_server_Data") for d in INSTALL_DIRS]
    for c in cands:
        if os.path.isfile(os.path.join(c, SOFTREF, "manifest_extended")):
            return c
    return None


def read_manifest(path):
    """bundle id -> asset paths in it, from SoftRef's manifest_extended."""
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


def select_bundles(manifest):
    """(icon bundles, item prefab bundles), each sorted."""
    icons = sorted(b for b, ps in manifest.items() if any(ICON_PATH.match(p) for p in ps))
    items = sorted(b for b, ps in manifest.items() if any(ITEM_PREFAB.match(p) for p in ps))
    return icons, items


def build_key(game, bundles):
    """A short hash of the SoftRef hash file and the size of every bundle used."""
    h = hashlib.sha256()
    with open(os.path.join(game, SOFTREF, "hash"), "rb") as f:
        h.update(f.read())
    for b in sorted(set(bundles)):
        size = os.path.getsize(os.path.join(game, SOFTREF, "Bundles", b))
        h.update(f"{b}:{size}\n".encode())
    return h.hexdigest()[:16]


def plan(game):
    """(icon bundles, item bundles, build key); raises Unreadable."""
    try:
        manifest = read_manifest(os.path.join(game, SOFTREF, "manifest_extended"))
        icons, items = select_bundles(manifest)
        if not icons or not items:
            raise Unreadable("the SoftRef manifest lists no item icons or item prefabs")
        return icons, items, build_key(game, icons + items)
    except OSError as e:
        raise Unreadable(str(e)) from e


def current_build(out):
    """The build recorded in out/map.json, or None."""
    try:
        with open(os.path.join(out, "map.json"), encoding="utf-8") as f:
            doc = json.load(f)
        sheet = doc.get("sheet", "")
        if not SHEET_NAME.match(sheet) or not os.path.isfile(os.path.join(out, sheet)):
            return None
        return doc.get("build")
    except (OSError, ValueError, AttributeError):
        return None


# --- reading bundles -----------------------------------------------------------


def _lz4():
    import lz4.block

    return lz4.block


class LazyBundle:
    """A UnityFS bundle whose first serialized file is decompressed on demand."""

    def __init__(self, path):
        self.f = open(path, "rb")
        try:
            self._open(path)
        except BaseException:
            self.f.close()
            raise

    def _open(self, path):
        self.read_bytes = 0
        head = self.f.read(256)
        try:
            p = head.index(b"\0") + 1
            if head[:p] != b"UnityFS\0":
                raise Unreadable(f"{path}: not a UnityFS bundle")
            (version,) = struct.unpack(">I", head[p:p + 4])
            p += 4
            p = head.index(b"\0", p) + 1  # player version
            p = head.index(b"\0", p) + 1  # engine version
            _, csize, usize, flags = struct.unpack(">qIII", head[p:p + 20])
        except (ValueError, struct.error) as e:
            raise Unreadable(f"{path}: truncated bundle header") from e
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
        try:
            self._parse_info(info, p)
        except (ValueError, struct.error, StopIteration) as e:
            raise Unreadable(f"{path}: bad block info") from e
        # Anonymous mmap: pages cost memory only once a block is written there.
        self.buf = mmap.mmap(-1, max(1, self.size))
        self.cache = {}  # a few decompressed blocks, oldest evicted first
        self.seen = set()

    def _parse_info(self, info, p):
        q = 16  # uncompressed data hash
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
        # The first serialized file (flag 4); a bundle's .resS nodes are skipped.
        self.base, self.size, _, self.name = next(x for x in self.nodes if x[2] & 4)

    @staticmethod
    def _decompress(data, usize, flags):
        kind = flags & 0x3F
        if kind == 0:
            return data
        if kind in (2, 3):
            try:
                return _lz4().decompress(data, uncompressed_size=usize)
            except Exception as e:  # lz4 raises its own error type
                raise Unreadable(f"LZ4 block did not decompress: {e}") from e
        raise Unreadable(f"unsupported bundle compression {kind} (only LZ4 and none are read)")

    def _block(self, i):
        if i not in self.cache:
            c, cs, u, us, bf = self.blocks[i]
            self.f.seek(c)
            raw = self.f.read(cs)
            if len(raw) != cs:
                raise Unreadable("bundle shorter than its block table (being rewritten?)")
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
        a, b = self.base + start, self.base + min(end, self.size)
        i = max(0, bisect.bisect_right(self.ustarts, a) - 1)
        while i < len(self.blocks) and self.blocks[i][2] < b:
            u, us = self.blocks[i][2], self.blocks[i][3]
            lo, hi = max(u, a), min(u + us, b)
            if lo < hi:
                self.buf[lo - self.base:hi - self.base] = self._block(i)[lo - u:hi - u]
            i += 1

    def read(self, start, end):
        self.ensure(start, end)
        return bytes(self.buf[start:min(end, self.size)])

    def close(self):
        # The mmap is left to the garbage collector: UnityPy may still hold views of it.
        self.f.close()


_unity = None


def unity():
    """UnityPy, imported once, with typetree reads routed through LazyBundle."""
    global _unity
    if _unity is not None:
        return _unity
    # UnityPy imports its audio exporter eagerly, which pulls in fmod_toolkit and
    # the proprietary libfmod. Audio is never read here, so a stub keeps libfmod
    # out of the image (installed with pip --no-deps).
    sys.modules.setdefault("fmod_toolkit", types.ModuleType("fmod_toolkit"))
    import UnityPy
    from UnityPy.files.ObjectReader import ObjectReader
    from UnityPy.files.SerializedFile import SerializedFile
    from UnityPy.streams import EndianBinaryReader

    lazy_by_reader = {}
    original = ObjectReader.read_typetree

    def read_typetree(self, *args, **kwargs):
        lazy = lazy_by_reader.get(id(self.assets_file.reader))
        if lazy is not None:
            lazy.ensure(self.byte_start, self.byte_start + self.byte_size)
        return original(self, *args, **kwargs)

    ObjectReader.read_typetree = read_typetree

    def serialized_file(lazy):
        h = lazy.read(0, 64)
        meta = struct.unpack(">I", h[20:24])[0] if struct.unpack(">I", h[8:12])[0] >= 22 else struct.unpack(">I", h[0:4])[0]
        lazy.ensure(0, 64 + meta + 64)
        reader = EndianBinaryReader(memoryview(lazy.buf))
        lazy_by_reader[id(reader)] = lazy
        return SerializedFile(reader, name=lazy.name), lambda: lazy_by_reader.pop(id(reader), None)

    _unity = types.SimpleNamespace(UnityPy=UnityPy, serialized_file=serialized_file)
    return _unity


# --- the mapping -------------------------------------------------------------


def field_names(node, acc):
    acc.add(node.m_Name)
    for ch in node.m_Children:
        field_names(ch, acc)
    return acc


ITEMDROP_FIELDS = {"m_itemData", "m_shared", "m_icons"}


def item_icons(sf):
    """prefab name -> (external CAB name or None for this file, sprite path id).

    Only MonoBehaviours whose type tree has m_itemData > m_shared > m_icons
    (ItemDrop) count, only on a prefab root in this file, and only the first
    icon. Creature attacks share the type but have no icon and are skipped.
    """
    item_types = set()
    for t in sf.types:
        if t.class_id == 114 and t.node is not None and ITEMDROP_FIELDS <= field_names(t.node, set()):
            item_types.add(id(t))
    externals = [e.path.replace("\\", "/").rsplit("/", 1)[-1] for e in sf.externals]
    out = {}
    for obj in sf.objects.values():
        if id(obj.serialized_type) not in item_types:
            continue
        d = obj.read_typetree()
        try:
            icons = d["m_itemData"]["m_shared"]["m_icons"]
            go = d["m_GameObject"]
        except (KeyError, TypeError):
            continue
        if not icons or go.get("m_FileID") != 0 or go.get("m_PathID") not in sf.objects:
            continue
        name = sf.objects[go["m_PathID"]].read_typetree().get("m_Name")
        fid, pid = icons[0].get("m_FileID", 0), icons[0].get("m_PathID", 0)
        if not name or pid == 0 or fid < 0 or fid > len(externals):
            continue
        out.setdefault(name, (externals[fid - 1] if fid > 0 else None, pid))
    return out


def assign_cells(refs, available):
    """(order of distinct sprites, prefab -> cell index). Prefabs whose sprite
    is not in `available` are left out; prefabs sharing a sprite share a cell."""
    order, cells, items = [], {}, {}
    for name in sorted(refs):
        ref = refs[name]
        if ref not in available:
            continue
        if ref not in cells:
            cells[ref] = len(order)
            order.append(ref)
        items[name] = cells[ref]
    return order, items


def compose_sheet(images, size, columns=COLUMNS):
    """One RGBA sheet, `columns` cells of `size` px per row, in order."""
    from PIL import Image

    rows = max(1, (len(images) + columns - 1) // columns)
    sheet = Image.new("RGBA", (columns * size, rows * size), (0, 0, 0, 0))
    for k, im in enumerate(images):
        im = im.convert("RGBA")
        if im.size != (size, size):
            im = im.resize((size, size), Image.LANCZOS)
        sheet.paste(im, ((k % columns) * size, (k // columns) * size))
    return sheet


def map_doc(build, size, columns, sheet_size, sheet_name, items):
    w, h = sheet_size
    return {
        "version": MAP_VERSION,
        "build": build,
        "size": size,
        "columns": columns,
        "width": w,
        "height": h,
        "sheet": sheet_name,
        "count": len(items),
        # The skald-icons release that wrote this file.
        "skald": os.environ.get("SKALD_VERSION") or "dev",
        "items": {n: [(c % columns) * size, (c // columns) * size] for n, c in sorted(items.items())},
    }


def write_atomic(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def publish(out, build, sheet, size, columns, items, quality):
    """Write sheet.<build>.webp, then map.json, then drop older sheets."""
    os.makedirs(out, exist_ok=True)
    name = f"sheet.{build}.webp"
    buf = io.BytesIO()
    if quality > 100:
        sheet.save(buf, "WEBP", lossless=True, method=4)
    else:
        sheet.save(buf, "WEBP", quality=quality, alpha_quality=100, method=4)
    write_atomic(os.path.join(out, name), buf.getvalue())
    doc = map_doc(build, size, columns, sheet.size, name, items)
    write_atomic(os.path.join(out, "map.json"), json.dumps(doc, separators=(",", ":"), sort_keys=True).encode())
    for f in os.listdir(out):
        if f != name and SHEET_NAME.match(f):
            try:
                os.remove(os.path.join(out, f))
            except OSError:
                pass
    return len(buf.getvalue())


def extract(game, size):
    """(build key, sheet image, prefab -> cell, stats). Raises Unreadable."""
    t0 = time.time()
    icon_bundles, item_bundles, key = plan(game)
    u = unity()
    bdir = os.path.join(game, SOFTREF, "Bundles")
    try:
        sprites = {}  # (cab, path id) -> Sprite object
        for b in icon_bundles:
            env = u.UnityPy.load(os.path.join(bdir, b))
            for obj in env.objects:
                if obj.type.name == "Sprite":
                    sprites[(obj.assets_file.name, obj.path_id)] = obj
        refs, read = {}, 0
        for b in item_bundles:
            lazy = LazyBundle(os.path.join(bdir, b))
            try:
                sf, release = u.serialized_file(lazy)
                for name, (cab, pid) in item_icons(sf).items():
                    refs.setdefault(name, (cab or lazy.name, pid))
                read += lazy.read_bytes
                release()
            finally:
                lazy.close()
        t1 = time.time()
        order, items = assign_cells(refs, sprites)
        images = [sprites[ref].read().image for ref in order]
    except Unreadable:
        raise
    except Exception as e:  # UnityPy raises plain exceptions on truncated or unknown data
        raise Unreadable(f"{type(e).__name__}: {e}") from e
    # The updater rewrites the install in place: a read that straddled an update is not kept.
    if plan(game)[2] != key:
        raise Unreadable("the game files changed during the read (update in progress)")
    sheet = compose_sheet(images, size)
    stats = {
        "prefabs": len(refs),
        "items": len(items),
        "sprites": len(order),
        "unresolved": len(refs) - len(items),
        "readMB": read / 1e6,
        "scan": t1 - t0,
    }
    return key, sheet, items, stats


# --- entry points --------------------------------------------------------------


def run_once(a):
    t0 = time.time()
    game = find_game(a.game)
    if game is None:
        log(f"no Valheim server install under {a.game} (looked for StreamingAssets/SoftRef/manifest_extended)")
        return EXIT_USAGE
    try:
        _, _, key = plan(game)
        if not a.force and current_build(a.out) == key:
            log(f"up to date for build {key}")
            return EXIT_OK
        log(f"extracting build {key} from {game}")
        key, sheet, items, st = extract(game, a.size)
    except Unreadable as e:
        log(f"cannot read the game files, keeping the previous icons: {e}")
        return EXIT_UNREADABLE
    if not items:
        log("no item icons found; nothing written")
        return EXIT_EMPTY
    try:
        nbytes = publish(a.out, key, sheet, a.size, COLUMNS, items, a.quality)
    except OSError as e:
        log(f"cannot write to {a.out}: {e}")
        return EXIT_WRITE
    log(
        f"build {key}: {st['items']} items, {st['sprites']} sprites, {st['unresolved']} unresolved, "
        f"sheet {sheet.size[0]}x{sheet.size[1]} {nbytes / 1e6:.2f} MB, read {st['readMB']:.0f} MB of item bundles, "
        f"scan {st['scan']:.1f}s, total {time.time() - t0:.1f}s"
    )
    return EXIT_OK


def loop(a):
    """Check every `a.every` seconds; extract in a child process (so its memory is
    returned after each build) only when the build key changed."""
    log(NOTICE)
    log(f"watching {a.game} every {a.every}s, writing to {a.out}")
    child = [sys.executable, "-I", os.path.abspath(__file__), "--game", a.game, "--out", a.out,
             "--size", str(a.size), "--quality", str(a.quality)]
    last = None
    while True:
        msg = None
        game = find_game(a.game)
        if game is None:
            msg = f"no Valheim server install under {a.game} yet"
        else:
            try:
                key = plan(game)[2]
            except Unreadable as e:
                msg = f"cannot read the game files yet: {e}"
            else:
                if key != current_build(a.out):
                    rc = subprocess.call(child)
                    if rc != EXIT_OK:
                        msg = f"extraction exited with {rc}; retrying in {a.every}s"
        # Say a lasting problem once, not every tick.
        if msg and msg != last:
            log(msg)
        last = msg
        time.sleep(a.every)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--game", required=True, help="/opt/valheim, an install dir, or valheim_server_Data (read-only)")
    ap.add_argument("--out", required=True, help="writable output directory")
    ap.add_argument("--size", type=int, default=64, help="icon edge in px (default 64)")
    ap.add_argument("--quality", type=int, default=85, help="WebP quality 1-100, 101 = lossless (default 85)")
    ap.add_argument("--force", action="store_true", help="rebuild even if the game build is unchanged")
    ap.add_argument("--every", type=int, default=0, help="keep running and check every N seconds")
    ap.add_argument("--nice", type=int, default=0, help="lower the process priority by N first")
    a = ap.parse_args(argv)
    if a.size < 8 or a.size > 256 or not 1 <= a.quality <= 101 or a.every < 0:
        ap.error("--size must be 8..256, --quality 1..101, --every >= 0")
    if a.nice > 0:
        try:
            os.nice(a.nice)
        except OSError:
            pass
    if a.every > 0:
        # PID 1 in a container ignores SIGTERM without a handler.
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(EXIT_OK))
        try:
            loop(a)
        except KeyboardInterrupt:
            return EXIT_OK
    return run_once(a)


if __name__ == "__main__":
    sys.exit(main())
