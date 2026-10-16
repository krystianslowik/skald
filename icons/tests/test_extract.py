"""Unit tests for extract.py on synthetic fixtures: no game files needed.

    python -m unittest discover -s icons/tests
"""

import io
import json
import os
import struct
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import lz4.block  # noqa: E402
from PIL import Image  # noqa: E402

import extract  # noqa: E402

MANIFEST = """﻿bundle: 6a33a62
path in bundle: Assets/GameElements/Items/_icons/wood.png
path in bundle: Assets/GameElements/Items/_icons/stone.png
bundle: c4210710
path in bundle: Assets/GameElements/Items/Wood.prefab
path in bundle: Assets/GameElements/Items/Weapons/SwordBronze.prefab
bundle: 11b3f7ee
path in bundle: Assets/GameElements/Items/Extra/Honey.prefab
bundle: deadbeef
path in bundle: Assets/World/Trees/Pine.prefab
"""


def fake_game(root, sizes=None):
    """A valheim_server_Data with a SoftRef manifest, hash and bundle files."""
    data = os.path.join(root, "server", "valheim_server_Data")
    soft = os.path.join(data, "StreamingAssets", "SoftRef")
    os.makedirs(os.path.join(soft, "Bundles"))
    with open(os.path.join(soft, "manifest_extended"), "w", encoding="utf-8") as f:
        f.write(MANIFEST)
    with open(os.path.join(soft, "hash"), "w") as f:
        f.write("build-1")
    for b, n in (sizes or {"6a33a62": 10, "c4210710": 20, "11b3f7ee": 5, "deadbeef": 7}).items():
        with open(os.path.join(soft, "Bundles", b), "wb") as f:
            f.write(b"\0" * n)
    return data


def unityfs(payload, block=64, name="CAB-test", compress=True):
    """A minimal UnityFS v8 bundle: header, LZ4 block info, LZ4 data blocks, one serialized-file node."""
    blocks = [payload[i:i + block] for i in range(0, len(payload), block)]
    stored = [lz4.block.compress(b, store_size=False) if compress else b for b in blocks]
    bflag = 2 if compress else 0
    info = b"\0" * 16 + struct.pack(">i", len(blocks))
    for raw, st in zip(blocks, stored):
        info += struct.pack(">IIH", len(raw), len(st), bflag)
    info += struct.pack(">i", 1) + struct.pack(">qqI", 0, len(payload), 4) + name.encode() + b"\0"
    cinfo = lz4.block.compress(info, store_size=False)
    flags = 2 | 0x40 | 0x200  # LZ4 block info, combined with the header, padded
    head = b"UnityFS\0" + struct.pack(">I", 8) + b"5.x.x\0" + b"6000.0.75f1\0"
    head += struct.pack(">qIII", 0, len(cinfo), len(info), flags)
    head += b"\0" * ((16 - len(head) % 16) % 16)
    body = head + cinfo
    body += b"\0" * ((16 - len(body) % 16) % 16)
    return body + b"".join(stored)


class ManifestTest(unittest.TestCase):
    def test_bundles_are_selected_by_asset_path(self):
        with tempfile.TemporaryDirectory() as d:
            game = fake_game(d)
            m = extract.read_manifest(os.path.join(game, extract.SOFTREF, "manifest_extended"))
            self.assertEqual(extract.select_bundles(m), (["6a33a62"], ["11b3f7ee", "c4210710"]))

    def test_find_game_tries_server_then_bepinex(self):
        with tempfile.TemporaryDirectory() as d:
            game = fake_game(d)
            self.assertEqual(extract.find_game(d), game)
            self.assertEqual(extract.find_game(game), game)
            self.assertEqual(extract.find_game(os.path.dirname(game)), game)
            self.assertIsNone(extract.find_game(os.path.join(d, "nope")))

    def test_build_key_follows_hash_and_bundle_sizes(self):
        with tempfile.TemporaryDirectory() as d:
            game = fake_game(d)
            _, _, k1 = extract.plan(game)
            self.assertRegex(k1, r"^[0-9a-f]{16}$")
            self.assertEqual(extract.plan(game)[2], k1)
            # A bundle the extractor does not read does not matter.
            with open(os.path.join(game, extract.SOFTREF, "Bundles", "deadbeef"), "ab") as f:
                f.write(b"x")
            self.assertEqual(extract.plan(game)[2], k1)
            with open(os.path.join(game, extract.SOFTREF, "Bundles", "c4210710"), "ab") as f:
                f.write(b"x")
            k2 = extract.plan(game)[2]
            self.assertNotEqual(k2, k1)
            with open(os.path.join(game, extract.SOFTREF, "hash"), "w") as f:
                f.write("build-2")
            self.assertNotEqual(extract.plan(game)[2], k2)

    def test_missing_bundle_is_unreadable(self):
        with tempfile.TemporaryDirectory() as d:
            game = fake_game(d)
            os.remove(os.path.join(game, extract.SOFTREF, "Bundles", "c4210710"))
            with self.assertRaises(extract.Unreadable):
                extract.plan(game)


class LazyBundleTest(unittest.TestCase):
    def write(self, d, data):
        p = os.path.join(d, "bundle")
        with open(p, "wb") as f:
            f.write(data)
        return p

    def test_reads_ranges_across_blocks_without_reading_everything(self):
        payload = bytes(range(256)) * 4  # 1 KiB, 16 blocks of 64 bytes
        with tempfile.TemporaryDirectory() as d:
            lb = extract.LazyBundle(self.write(d, unityfs(payload)))
            self.assertEqual(lb.name, "CAB-test")
            self.assertEqual(lb.size, len(payload))
            self.assertEqual(len(lb.blocks), 16)
            self.assertEqual(lb.read(60, 200), payload[60:200])
            self.assertEqual(lb.read(1000, 1024), payload[1000:1024])
            self.assertEqual(len(lb.seen), 5)  # blocks 0-3 and 15 only
            lb.close()

    def test_uncompressed_blocks(self):
        payload = os.urandom(300)
        with tempfile.TemporaryDirectory() as d:
            lb = extract.LazyBundle(self.write(d, unityfs(payload, compress=False)))
            self.assertEqual(lb.read(0, 300), payload)
            lb.close()

    def test_not_a_bundle(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(extract.Unreadable):
                extract.LazyBundle(self.write(d, b"PK\x03\x04 not unity at all\0"))

    def test_truncated_bundle_is_unreadable(self):
        payload = os.urandom(1024)
        with tempfile.TemporaryDirectory() as d:
            data = unityfs(payload)
            lb = extract.LazyBundle(self.write(d, data[:-100]))
            with self.assertRaises(extract.Unreadable):
                lb.read(0, 1024)
            lb.close()

    def test_lzma_is_refused_clearly(self):
        with self.assertRaisesRegex(extract.Unreadable, "compression 1"):
            extract.LazyBundle._decompress(b"x", 1, 1)


# --- item_icons on duck-typed serialized files ---------------------------------


def node(name, *children):
    return types.SimpleNamespace(m_Name=name, m_Children=list(children))


ITEMDROP_TREE = node("Base", node("m_GameObject"), node("m_itemData", node("m_shared", node("m_icons"))))
OTHER_TREE = node("Base", node("m_GameObject"), node("m_health"))


class Obj:
    def __init__(self, stype, tree):
        self.serialized_type = stype
        self.tree = tree

    def read_typetree(self):
        return self.tree


def fake_sf():
    item_t = types.SimpleNamespace(class_id=114, node=ITEMDROP_TREE)
    other_t = types.SimpleNamespace(class_id=114, node=OTHER_TREE)
    go_t = types.SimpleNamespace(class_id=1, node=node("Base", node("m_Name")))

    def drop(go, *icons):
        return Obj(item_t, {"m_GameObject": {"m_FileID": 0, "m_PathID": go}, "m_itemData": {"m_shared": {"m_icons": list(icons)}}})

    objects = {
        1: Obj(go_t, {"m_Name": "Wood"}),
        2: drop(1, {"m_FileID": 1, "m_PathID": 500}, {"m_FileID": 1, "m_PathID": 501}),
        3: Obj(go_t, {"m_Name": "SwordBronze"}),
        4: drop(3, {"m_FileID": 2, "m_PathID": 600}),
        5: Obj(go_t, {"m_Name": "troll_attack"}),
        6: drop(5),  # a creature attack: ItemDrop type, no icon
        7: Obj(go_t, {"m_Name": "Honey"}),
        8: drop(7, {"m_FileID": 0, "m_PathID": 77}),  # sprite inside this file
        9: Obj(other_t, {"m_GameObject": {"m_FileID": 0, "m_PathID": 1}, "m_health": 5}),
        10: Obj(item_t, {"m_GameObject": {"m_FileID": 3, "m_PathID": 1}, "m_itemData": {"m_shared": {"m_icons": [{"m_FileID": 1, "m_PathID": 9}]}}}),
        11: Obj(go_t, {"m_Name": "BadRef"}),
        12: drop(11, {"m_FileID": 9, "m_PathID": 1}),  # external index out of range
    }
    return types.SimpleNamespace(
        types=[item_t, other_t, go_t],
        externals=[types.SimpleNamespace(path="archive:/CAB-icons/CAB-icons"), types.SimpleNamespace(path="archive:\\CAB-other\\CAB-other")],
        objects=objects,
    )


class ItemIconsTest(unittest.TestCase):
    def test_maps_prefabs_to_their_first_icon_through_the_externals(self):
        self.assertEqual(
            extract.item_icons(fake_sf()),
            {"Wood": ("CAB-icons", 500), "SwordBronze": ("CAB-other", 600), "Honey": (None, 77)},
        )

    def test_assign_cells_shares_sprites_and_skips_missing(self):
        refs = {"Wood": ("A", 1), "WoodAlias": ("A", 1), "Stone": ("A", 2), "Ghost": ("A", 9)}
        order, items = extract.assign_cells(refs, {("A", 1): 0, ("A", 2): 0})
        self.assertEqual(order, [("A", 2), ("A", 1)])  # sorted by prefab name: Stone first
        self.assertEqual(items, {"Stone": 0, "Wood": 1, "WoodAlias": 1})


class SheetTest(unittest.TestCase):
    def test_compose_and_map_doc(self):
        colours = [(255, 0, 0, 255), (0, 255, 0, 128), (0, 0, 255, 255)]
        images = [Image.new("RGBA", (32, 32), c) for c in colours]
        sheet = extract.compose_sheet(images, 16, columns=2)
        self.assertEqual(sheet.size, (32, 32))
        self.assertEqual(sheet.getpixel((0, 0)), colours[0])
        self.assertEqual(sheet.getpixel((16, 0)), colours[1])
        self.assertEqual(sheet.getpixel((0, 16)), colours[2])
        self.assertEqual(sheet.getpixel((20, 20)), (0, 0, 0, 0))
        doc = extract.map_doc("abc", 16, 2, sheet.size, "sheet.abc.webp", {"A": 0, "B": 1, "C": 2})
        self.assertEqual(doc["items"], {"A": [0, 0], "B": [16, 0], "C": [0, 16]})
        self.assertEqual((doc["width"], doc["height"], doc["count"], doc["version"]), (32, 32, 3, 1))
        self.assertEqual(doc["skald"], os.environ.get("SKALD_VERSION") or "dev")
        with mock.patch.dict(os.environ, {"SKALD_VERSION": "2026.10.0"}):
            self.assertEqual(extract.map_doc("abc", 16, 2, sheet.size, "sheet.abc.webp", {})["skald"], "2026.10.0")

    def test_publish_writes_map_last_and_prunes_old_sheets(self):
        with tempfile.TemporaryDirectory() as out:
            for stale in ("sheet.0001.webp", "sheet.0002.webp.tmp", "notes.txt"):
                with open(os.path.join(out, stale), "w") as f:
                    f.write("x")
            sheet = extract.compose_sheet([Image.new("RGBA", (8, 8), (9, 9, 9, 255))], 8, columns=4)
            extract.publish(out, "beef", sheet, 8, 4, {"A": 0}, 85)
            self.assertEqual(sorted(os.listdir(out)), ["map.json", "notes.txt", "sheet.beef.webp"])
            with open(os.path.join(out, "map.json")) as f:
                doc = json.load(f)
            self.assertEqual(doc["sheet"], "sheet.beef.webp")
            self.assertEqual(extract.current_build(out), "beef")
            with Image.open(os.path.join(out, "sheet.beef.webp")) as im:
                self.assertEqual(im.size, (32, 8))
            self.assertEqual(oct(os.stat(os.path.join(out, "map.json")).st_mode & 0o777), "0o644")

    def test_current_build_needs_the_sheet(self):
        with tempfile.TemporaryDirectory() as out:
            self.assertIsNone(extract.current_build(out))
            with open(os.path.join(out, "map.json"), "w") as f:
                json.dump({"build": "beef", "sheet": "sheet.beef.webp"}, f)
            self.assertIsNone(extract.current_build(out))
            with open(os.path.join(out, "sheet.beef.webp"), "wb") as f:
                f.write(b"x")
            self.assertEqual(extract.current_build(out), "beef")
            with open(os.path.join(out, "map.json"), "w") as f:
                json.dump({"build": "beef", "sheet": "../../etc/passwd"}, f)
            self.assertIsNone(extract.current_build(out))


class RunOnceTest(unittest.TestCase):
    def args(self, game, out, **kw):
        return types.SimpleNamespace(game=game, out=out, size=8, quality=85, force=False, **kw)

    def test_no_install(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(extract.run_once(self.args(os.path.join(d, "x"), d)), extract.EXIT_USAGE)

    def test_up_to_date_is_a_no_op(self):
        with tempfile.TemporaryDirectory() as d:
            game = fake_game(d)
            out = os.path.join(d, "out")
            key = extract.plan(game)[2]
            os.makedirs(out)
            with open(os.path.join(out, f"sheet.{key}.webp"), "wb") as f:
                f.write(b"x")
            with open(os.path.join(out, "map.json"), "w") as f:
                json.dump({"build": key, "sheet": f"sheet.{key}.webp"}, f)
            calls = []
            real = extract.extract
            extract.extract = lambda *a: calls.append(a)
            try:
                self.assertEqual(extract.run_once(self.args(d, out)), extract.EXIT_OK)
            finally:
                extract.extract = real
            self.assertEqual(calls, [])

    def test_unreadable_keeps_previous_output(self):
        with tempfile.TemporaryDirectory() as d:
            fake_game(d)
            out = os.path.join(d, "out")
            real = extract.extract

            def boom(*a):
                raise extract.Unreadable("changed during the read")

            extract.extract = boom
            try:
                self.assertEqual(extract.run_once(self.args(d, out)), extract.EXIT_UNREADABLE)
            finally:
                extract.extract = real
            self.assertFalse(os.path.exists(os.path.join(out, "map.json")))

    def test_writes_outputs(self):
        with tempfile.TemporaryDirectory() as d:
            fake_game(d)
            out = os.path.join(d, "out")
            real = extract.extract
            img = Image.new("RGBA", (8, 8), (1, 2, 3, 255))
            extract.extract = lambda game, size: ("cafe", extract.compose_sheet([img], 8), {"Wood": 0}, {"items": 1, "sprites": 1, "unresolved": 0, "readMB": 0, "scan": 0})
            try:
                self.assertEqual(extract.run_once(self.args(d, out)), extract.EXIT_OK)
            finally:
                extract.extract = real
            self.assertEqual(extract.current_build(out), "cafe")


if __name__ == "__main__":
    unittest.main()
