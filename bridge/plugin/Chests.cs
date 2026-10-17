using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEngine;
using static Skald.Bridge.Commands;

namespace Skald.Bridge
{
    // POST /v1/containers/add: puts items into one chest.
    //
    // The dashboard knows a chest from the last world save, by prefab and
    // position (the save keeps no object id), so the chest is found the same
    // way. Its inventory is the byte array under "items" on its ZDO, read and
    // written here with the game's own Inventory class.
    //
    // Who may write: in the game only the ZDO's owner writes, and every peer
    // that has the chest loaded reloads it once a second when its data
    // revision moves (Container.CheckForChanges). The server takes ownership
    // and writes, which bumps both revisions: the owning client drops
    // ownership (so it stops saving its copy) and reloads the new items;
    // the server's ReleaseNearbyZDOS hands ownership back to a nearby player
    // within two seconds, as for any object the server owns. A chest nobody
    // has loaded is written the same way and simply waits in the world.
    //
    // A chest someone has open is refused: its owner holds the inventory in
    // memory and writes it back on close. So is a chest a player stands at,
    // who could open it, stack into it or take everything from it while the
    // write travels; that is the only way a client changes a closed chest.
    static class Chests
    {
        // The save rounds positions to 0.05 m; the chest is the one within this.
        const float FindTolerance = 0.5f;
        // A player this close can reach the chest (interact distance 5 m, plus the eye).
        const float ReachDistance = 6f;

        public static object Add(JObject a)
        {
            Net();
            var odb = ObjectDB.instance;
            if (odb == null || ZNetScene.instance == null) throw new CommandError(503, "world not loaded yet");

            string prefabName = Str(a, "prefab", max: 64);
            var at = a["at"] as JObject ?? throw new CommandError(400, "missing 'at': {x, y, z} of the chest");
            float x = Float(at["x"], "at.x") ?? throw new CommandError(400, "missing 'at.x'");
            float y = Float(at["y"], "at.y") ?? throw new CommandError(400, "missing 'at.y'");
            float z = Float(at["z"], "at.z") ?? throw new CommandError(400, "missing 'at.z'");
            if (Math.Abs(x) > 10500 || Math.Abs(z) > 10500) throw new CommandError(400, "'at' is outside the world");
            string item = Str(a, "item", max: 64);
            if (a["amount"] == null || a["amount"].Type == JTokenType.Null) throw new CommandError(400, "missing 'amount'");
            int amount = Int(a, "amount", 0, 1, ChestPlan.MaxAmount);

            var itemPrefab = odb.GetItemPrefab(item);
            var drop = itemPrefab != null ? itemPrefab.GetComponent<ItemDrop>() : null;
            if (drop == null) throw new CommandError(404, "unknown item prefab '" + item + "' (use the prefab name, e.g. Wood, Iron)");

            var chestPrefab = ZNetScene.instance.GetPrefab(prefabName);
            var proto = chestPrefab != null ? chestPrefab.GetComponentInChildren<Container>(true) : null;
            if (proto == null) throw new CommandError(400, "'" + prefabName + "' is not a container");
            if (proto.m_wagon != null || chestPrefab.GetComponentInChildren<Vagon>(true) != null || chestPrefab.GetComponentInChildren<Ship>(true) != null || chestPrefab.GetComponentInChildren<TombStone>(true) != null)
                throw new CommandError(400, "only chests can take items this way, not carts, ships or graves");

            var pos = new Vector3(x, y, z);
            var zdo = Find(prefabName.GetStableHashCode(), pos);
            long owner = Extras.LoadedBy(zdo);
            if (owner != 0 && zdo.GetInt(ZDOVars.s_inUse) == 1)
                throw new CommandError(409, "a player has that chest open; try again once it is closed");
            string reaching = PlayerAt(zdo.GetPosition());
            if (reaching != null)
                throw new CommandError(409, reaching + " is standing at that chest; try again once they step away");

            // The chest as the game reads it. Load drops stacks whose prefab
            // the server does not know, and Save would then lose them, so
            // every declared stack must load, and what Save writes must read
            // back to the same stacks, before anything is written. (Not the
            // same bytes: durability is stored as hundredths and the game's
            // own float round trip can move it by 0.01, as on every client save.)
            byte[] old = zdo.GetByteArray(ZDOVars.s_items);
            var inv = new Inventory(proto.m_name, null, proto.m_width, proto.m_height);
            if (old != null && old.Length > 0)
            {
                int declared = ChestPlan.DeclaredCount(old);
                inv.Load(new ZPackage(old));
                if (declared < 0 || inv.NrOfItems() != declared)
                    throw new CommandError(409, "that chest holds items this server does not know; left untouched");
            }
            var before = Slots(inv);
            if (ChestPlan.Changes(before, Slots(Decode(Encode(inv), proto)))?.Count != 0)
                throw new CommandError(409, "that chest's items do not read back the same; left untouched");
            inv.SetHeight(ChestPlan.Rows(proto.m_height, before));

            var data = drop.m_itemData;
            int maxStack = Math.Max(1, data.m_shared.m_maxStackSize);
            // Inventory.AddItem(GameObject, int) adds quality 1 at the world's level.
            string key = ChestPlan.Key(data.m_shared.m_name, 1, Game.m_worldLevel);
            int room = ChestPlan.Room(inv.GetWidth(), inv.GetHeight(), before, key, maxStack);
            if (room < amount)
                throw new CommandError(409, room == 0 ? "that chest has no room for " + item : "only " + room + " " + item + " fit in that chest");

            // One stack per call: AddItem tops up stacks of the same kind
            // first, then takes one empty slot.
            for (int left = amount; left > 0;)
            {
                int n = Math.Min(left, maxStack);
                if (!inv.AddItem(itemPrefab, n)) break;
                left -= n;
            }
            var after = Slots(inv);
            var changes = ChestPlan.Changes(before, after);
            if (changes == null || changes.Sum(c => c.Added) != amount)
                throw new CommandError(409, "the items did not fit as planned; chest left untouched");
            byte[] bytes = Encode(inv);
            if (ChestPlan.Changes(after, Slots(Decode(bytes, proto)))?.Count != 0)
                throw new CommandError(409, "the new contents do not read back the same; chest left untouched");

            zdo.SetOwner(ZDOMan.GetSessionID());
            zdo.Set(ZDOVars.s_items, bytes);
            if (owner != 0 && owner != ZDOMan.GetSessionID()) ZDOMan.instance.ForceSendZDO(owner, zdo.m_uid);

            return Ok(new
            {
                prefab = prefabName,
                item,
                amount,
                position = V3(zdo.GetPosition()),
                loaded = owner != 0,
                room = room - amount,
                slots = changes.Select(c => new { x = c.X, y = c.Y, added = c.Added, stack = c.Stack }).ToList(),
            });
        }

        // The chest of that prefab nearest to pos, within FindTolerance.
        static ZDO Find(int prefabHash, Vector3 pos)
        {
            var hits = Extras.ZdosAround(pos, FindTolerance + 1f)
                .Where(c => c.GetPrefab() == prefabHash)
                .Select(c => (zdo: c, d: Vector3.Distance(c.GetPosition(), pos)))
                .Where(h => h.d <= FindTolerance)
                .OrderBy(h => h.d)
                .ToList();
            if (hits.Count == 0)
                throw new CommandError(404, "no such chest at " + Math.Round(pos.x) + ", " + Math.Round(pos.z) + " any more: it was moved or destroyed after the last save");
            if (hits.Count > 1 && hits[1].d - hits[0].d < 0.05f)
                throw new CommandError(409, "two chests sit on that spot; cannot tell which one is meant");
            return hits[0].zdo;
        }

        // The name of a connected player within reach of pos, else null.
        static string PlayerAt(Vector3 pos)
        {
            foreach (var p in ZNet.instance.GetPeers())
            {
                if (!p.IsReady()) continue;
                var at = PositionOf(p, out var character);
                if (character != null && Vector3.Distance(at, pos) <= ReachDistance) return p.m_playerName;
            }
            return null;
        }

        static List<ChestSlot> Slots(Inventory inv) =>
            inv.GetAllItems().Select(i => new ChestSlot
            {
                X = i.m_gridPos.x,
                Y = i.m_gridPos.y,
                Key = ChestPlan.Key(i.m_shared.m_name, i.m_quality, i.m_worldLevel),
                Stack = i.m_stack,
                MaxStack = Math.Max(1, i.m_shared.m_maxStackSize),
            }).ToList();

        static Inventory Decode(byte[] bytes, Container proto)
        {
            var inv = new Inventory(proto.m_name, null, proto.m_width, proto.m_height);
            inv.Load(new ZPackage(bytes));
            return inv;
        }

        static byte[] Encode(Inventory inv)
        {
            var pkg = new ZPackage();
            inv.Save(pkg);
            return pkg.GetArray();
        }
    }
}
