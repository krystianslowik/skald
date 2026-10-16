using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEngine;
using static Skald.Bridge.Commands;

namespace Skald.Bridge
{
    // Priority-2 commands. Objects near players are owned (simulated) by that
    // player's client, so most of these send the same per-object RPC the game
    // itself sends to the owner. Objects nobody has loaded are skipped and
    // reported as "unloaded".
    static class Extras
    {
        const float MaxRadius = 100f;

        static float Radius(JObject a, float def)
        {
            float r = Float(a["radius"], "radius") ?? def;
            if (r <= 0 || r > MaxRadius) throw new CommandError(400, "'radius' must be in (0, " + MaxRadius + "]");
            return r;
        }

        // ZDOs within radius of center (the 5x5 zones around it, then a distance filter).
        static List<ZDO> ZdosAround(Vector3 center, float radius)
        {
            var near = new List<ZDO>();
            var far = new List<ZDO>();
            ZDOMan.instance.FindSectorObjects(ZoneSystem.GetZone(center), SimulationDistance.OriginalDistance, near, far);
            return near.Concat(far).Distinct()
                .Where(z => z != null && Utils.DistanceXZ(z.GetPosition(), center) <= radius).ToList();
        }

        static T PrefabComponent<T>(ZDO z) where T : Component
        {
            var prefab = ZNetScene.instance.GetPrefab(z.GetPrefab());
            return prefab != null ? prefab.GetComponent<T>() : null;
        }

        static string PrefabName(ZDO z)
        {
            var prefab = ZNetScene.instance.GetPrefab(z.GetPrefab());
            return prefab != null ? prefab.name : z.GetPrefab().ToString();
        }

        // The uid of the connected peer simulating this object, or 0 when nobody
        // has it loaded (then there is no instance to receive an RPC).
        static long LoadedBy(ZDO z)
        {
            long owner = z.GetOwner();
            if (owner == 0) return 0;
            // Server-owned objects only have an instance (and so can take an RPC)
            // while the server keeps them instantiated, i.e. right after a spawn.
            if (owner == ZDOMan.GetSessionID()) return ZNetScene.instance.FindInstance(z) != null ? owner : 0;
            return ZNet.instance.GetPeer(owner) != null ? owner : 0;
        }

        static string Id(ZDOID id) => id.UserID + ":" + id.ID;

        // ---- inspection -----------------------------------------------------

        public static object Nearby(JObject a)
        {
            Net();
            var pos = Target(a, out string near);
            float r = Radius(a, 30f);
            var list = ZdosAround(pos, r)
                .GroupBy(PrefabName)
                .Select(g => new { prefab = g.Key, count = g.Count(), loaded = g.Count(z => LoadedBy(z) != 0) })
                .OrderByDescending(x => x.count).Take(100).ToList();
            return Ok(new { near, radius = r, position = V3(pos), objects = list });
        }

        // ---- time -----------------------------------------------------------

        public static object FreezeTime(JObject a)
        {
            var n = Net();
            if (SkaldBridgePlugin.FrozenNetTime.HasValue) throw new CommandError(409, "time is already frozen");
            SkaldBridgePlugin.FrozenNetTime = n.GetTimeSeconds();
            return Ok(new
            {
                frozenAt = SkaldBridgePlugin.FrozenNetTime,
                note = "net time is pinned every frame: day/night stops, and so do every timer keyed on it (smelters, crops, respawns). Resets on server restart.",
            });
        }

        public static object ResumeTime(JObject a)
        {
            Net();
            if (!SkaldBridgePlugin.FrozenNetTime.HasValue) throw new CommandError(409, "time is not frozen");
            var at = SkaldBridgePlugin.FrozenNetTime;
            SkaldBridgePlugin.FrozenNetTime = null;
            return Ok(new { resumedAt = at });
        }

        // ---- creatures ------------------------------------------------------

        public static object SpawnCreature(JObject a)
        {
            Net();
            string name = Str(a, "prefab", max: 64);
            int count = Int(a, "count", 1, 1, 20);
            int level = Int(a, "level", 1, 1, 10);
            bool tamed = a["tamed"]?.Type == JTokenType.Boolean && (bool)a["tamed"];
            var prefab = ZNetScene.instance.GetPrefab(name);
            var ch = prefab != null ? prefab.GetComponent<Character>() : null;
            if (ch == null || prefab.GetComponent<Player>() != null)
                throw new CommandError(404, "unknown creature prefab '" + name + "' (e.g. Boar, Greyling, Troll, Eikthyr)");
            if (tamed && prefab.GetComponent<Tameable>() == null)
                throw new CommandError(400, "'" + name + "' cannot be tamed");
            var pos = Target(a, out string near);
            for (int i = 0; i < count; i++)
            {
                var off = UnityEngine.Random.insideUnitCircle * 4f;
                var at = pos + new Vector3(off.x + 2f, 0.5f, off.y + 2f);
                var go = UnityEngine.Object.Instantiate(prefab, at, Quaternion.Euler(0, UnityEngine.Random.Range(0, 360), 0));
                var c = go.GetComponent<Character>();
                if (level > 1) c.SetLevel(level);
                if (tamed) c.SetTamed(true);
            }
            return Ok(new { prefab = name, count, level, tamed, boss = ch.m_boss, near, position = V3(pos) });
        }

        // Kills hostile creatures around a point: never players, never tames,
        // bosses only with includeBosses=true. Drops happen as for a normal kill.
        public static object KillCreatures(JObject a)
        {
            Net();
            var pos = Target(a, out string near);
            float r = Radius(a, 30f);
            bool bosses = a["includeBosses"]?.Type == JTokenType.Boolean && (bool)a["includeBosses"];
            int killed = 0, unloaded = 0, skipped = 0;
            var names = new Dictionary<string, int>();
            foreach (var z in ZdosAround(pos, r))
            {
                var ch = PrefabComponent<Character>(z);
                if (ch == null || PrefabComponent<Player>(z) != null) continue;
                if (z.GetBool(ZDOVars.s_tamed) || (ch.m_boss && !bosses)) { skipped++; continue; }
                long owner = LoadedBy(z);
                if (owner == 0) { unloaded++; continue; }
                var hit = new HitData();
                hit.m_damage.m_damage = 1e7f;
                hit.m_point = z.GetPosition();
                hit.m_dodgeable = false;
                hit.m_blockable = false;
                hit.m_ignorePVP = true;
                hit.m_hitType = HitData.HitType.Undefined;
                ZRoutedRpc.instance.InvokeRoutedRPC(owner, z.m_uid, "RPC_Damage", hit);
                killed++;
                string n = PrefabName(z);
                names[n] = names.TryGetValue(n, out int k) ? k + 1 : 1;
            }
            return Ok(new { killed, skippedTamedOrBoss = skipped, unloaded, byPrefab = names, near, radius = r });
        }

        public static object TameCreatures(JObject a)
        {
            Net();
            var pos = Target(a, out string near);
            float r = Radius(a, 10f);
            int tamed = 0, unloaded = 0, already = 0;
            foreach (var z in ZdosAround(pos, r))
            {
                if (PrefabComponent<Tameable>(z) == null) continue;
                if (z.GetBool(ZDOVars.s_tamed)) { already++; continue; }
                long owner = LoadedBy(z);
                if (owner == 0) { unloaded++; continue; }
                ZRoutedRpc.instance.InvokeRoutedRPC(owner, z.m_uid, "RPC_SetTamed", true);
                tamed++;
            }
            return Ok(new { tamed, alreadyTamed = already, unloaded, near, radius = r });
        }

        // ---- player ---------------------------------------------------------

        static ZNetPeer PlayerWithCharacter(JObject a)
        {
            var p = FindPlayer(Str(a, "player"));
            if (p.m_characterID.IsNone()) throw new CommandError(409, "player has no character yet (still loading or dead)");
            return p;
        }

        public static object Heal(JObject a)
        {
            Net();
            var p = PlayerWithCharacter(a);
            float hp = Float(a["amount"], "amount") ?? 10000f;
            if (hp <= 0 || hp > 100000) throw new CommandError(400, "'amount' must be in (0, 100000]");
            // The player's own client owns its character and applies the heal.
            ZRoutedRpc.instance.InvokeRoutedRPC(p.m_uid, p.m_characterID, "RPC_Heal", hp, true);
            return Ok(new { player = p.m_playerName, amount = hp });
        }

        public static object AddStatus(JObject a)
        {
            Net();
            var p = PlayerWithCharacter(a);
            string effect = Str(a, "effect", max: 64);
            int hash = effect.GetStableHashCode();
            if (ObjectDB.instance.GetStatusEffect(hash) == null)
                throw new CommandError(404, "unknown status effect '" + effect + "' (e.g. Rested, Rested is the usual one)");
            ZRoutedRpc.instance.InvokeRoutedRPC(p.m_uid, p.m_characterID, "RPC_AddStatusEffect", hash, true, 0, 0f, 0);
            return Ok(new { player = p.m_playerName, effect });
        }

        // ---- building -------------------------------------------------------

        public static object Repair(JObject a)
        {
            Net();
            var pos = Target(a, out string near);
            float r = Radius(a, 30f);
            int sent = 0, unloaded = 0;
            foreach (var z in ZdosAround(pos, r))
            {
                var wnt = PrefabComponent<WearNTear>(z);
                if (wnt == null) continue;
                // Only damaged pieces: health is stored once a piece takes damage.
                if (!z.GetFloat(ZDOVars.s_health, out float h) || h >= wnt.m_health) continue;
                long owner = LoadedBy(z);
                if (owner == 0) { unloaded++; continue; }
                ZRoutedRpc.instance.InvokeRoutedRPC(owner, z.m_uid, "RPC_Repair");
                sent++;
            }
            return Ok(new { repaired = sent, unloaded, near, radius = r });
        }

        // Every prefab with a Smelter component, read from the game once the
        // scene is up: inputs, outputs, fuel and capacity, and whether it is a
        // kiln or a smelter (FillPlan.Classify). Nothing here names an item.
        static Dictionary<string, (Station station, StationKind kind)> stations;

        static Dictionary<string, (Station station, StationKind kind)> Stations()
        {
            if (stations != null) return stations;
            if (ZNetScene.instance == null) throw new CommandError(503, "world not loaded yet");
            var list = new List<Station>();
            foreach (var prefab in ZNetScene.instance.m_prefabs)
            {
                var sm = prefab != null ? prefab.GetComponent<Smelter>() : null;
                if (sm == null || string.IsNullOrEmpty(prefab.name)) continue;
                try
                {
                    var conv = (sm.m_conversion ?? new List<Smelter.ItemConversion>()).Where(c => c != null && c.m_from != null).ToList();
                    list.Add(new Station
                    {
                        Prefab = prefab.name,
                        Fuel = sm.m_fuelItem != null ? sm.m_fuelItem.name : null,
                        Inputs = conv.Select(c => c.m_from.name).ToArray(),
                        Outputs = conv.Where(c => c.m_to != null).Select(c => c.m_to.name).ToArray(),
                        MaxOre = sm.m_maxOre,
                        MaxFuel = sm.m_maxFuel,
                    });
                }
                catch (Exception e)
                {
                    SkaldBridgePlugin.Warn("fill: skipping station prefab " + prefab.name + ": " + e.Message);
                }
            }
            var kinds = FillPlan.Classify(list);
            var byName = new Dictionary<string, (Station station, StationKind kind)>();
            foreach (var s in list) byName[s.Prefab] = (s, kinds.TryGetValue(s.Prefab, out var k) ? k : StationKind.Other);
            // An empty list is not kept, so a too-early call does not stick.
            if (byName.Count > 0) stations = byName;
            return byName;
        }

        // GET /v1/build/stations: what the fill commands can put where.
        public static object FillStations(JObject a)
        {
            Net();
            var all = Stations().Values;
            return Ok(new
            {
                kilns = all.Where(s => s.kind == StationKind.Kiln).Select(s => new { prefab = s.station.Prefab, inputs = s.station.Inputs }).ToList(),
                smelters = all.Where(s => s.kind == StationKind.Smelter).Select(s => new { prefab = s.station.Prefab, fuel = s.station.Fuel, inputs = s.station.Inputs }).ToList(),
            });
        }

        static void Count(Dictionary<string, int> d, string k) => d[k] = d.TryGetValue(k, out int n) ? n + 1 : 1;

        // POST /v1/build/fill-kilns: charcoal kilns get wood, nothing else.
        public static object FillKilns(JObject a)
        {
            Net();
            var pos = Target(a, out string near);
            float r = Radius(a, 20f);
            var known = Stations();
            int kilns = 0, skipped = 0, full = 0, unloaded = 0;
            var added = new Dictionary<string, int>();
            foreach (var z in ZdosAround(pos, r))
            {
                if (!known.TryGetValue(PrefabName(z), out var st) || st.kind != StationKind.Kiln) continue;
                long owner = LoadedBy(z);
                if (owner == 0) { unloaded++; continue; }
                var step = FillPlan.Kiln(st.station, z.GetInt(ZDOVars.s_queued));
                if (step.Skip == FillSkip.Full) { full++; continue; }
                if (step.Skip != FillSkip.None) { skipped++; continue; }
                // The owner checks capacity again and ignores the excess.
                for (int i = 0; i < step.OreCount; i++)
                    ZRoutedRpc.instance.InvokeRoutedRPC(owner, z.m_uid, "RPC_AddOre", step.Ore, false);
                Count(added, step.Ore);
                kilns++;
            }
            return Ok(new { kilns, skipped, full, unloaded, added, near, radius = r });
        }

        // POST /v1/build/fill-smelters: smelters and furnaces get the chosen
        // ore ("current" keeps the one each already holds) and/or their fuel.
        public static object FillSmelters(JObject a)
        {
            Net();
            var pos = Target(a, out string near);
            float r = Radius(a, 20f);
            FillWhat what;
            try { what = FillPlan.ParseWhat(Str(a, "what", required: false, max: 16)); }
            catch (ArgumentException e) { throw new CommandError(400, e.Message); }
            string ore = what == FillWhat.Fuel ? null : Str(a, "ore", max: 64);
            var known = Stations();
            if (ore != null && ore != FillPlan.KeepCurrent && !known.Values.Any(s => s.kind == StationKind.Smelter && s.station.Inputs.Contains(ore)))
                throw new CommandError(400, "no smelter takes '" + ore + "'; GET /v1/build/stations lists what each one takes");
            int smelters = 0, skipped = 0, full = 0, unloaded = 0;
            var added = new Dictionary<string, int>();
            string fuelAdded = null;
            foreach (var z in ZdosAround(pos, r))
            {
                if (!known.TryGetValue(PrefabName(z), out var st) || st.kind != StationKind.Smelter) continue;
                long owner = LoadedBy(z);
                if (owner == 0) { unloaded++; continue; }
                var step = FillPlan.Smelter(st.station, what, ore, z.GetString(ZDOVars.s_item0), z.GetInt(ZDOVars.s_queued), z.GetFloat(ZDOVars.s_fuel));
                if (step.Skip == FillSkip.Full) { full++; continue; }
                if (step.Skip != FillSkip.None) { skipped++; continue; }
                for (int i = 0; i < step.OreCount; i++)
                    ZRoutedRpc.instance.InvokeRoutedRPC(owner, z.m_uid, "RPC_AddOre", step.Ore, false);
                for (int i = 0; i < step.FuelCount; i++)
                    ZRoutedRpc.instance.InvokeRoutedRPC(owner, z.m_uid, "RPC_AddFuel");
                if (step.OreCount > 0) Count(added, step.Ore);
                if (step.FuelCount > 0) fuelAdded = st.station.Fuel;
                smelters++;
            }
            return Ok(new { smelters, skipped, full, unloaded, added, fuel = fuelAdded, near, radius = r });
        }

        // The 0.1/0.2 command, kept for older panels: every Smelter gets its
        // first (or the requested) input and fuel, fermenters get mead base.
        // The panel now uses fill-kilns and fill-smelters.
        public static object Fill(JObject a)
        {
            Net();
            var pos = Target(a, out string near);
            float r = Radius(a, 20f);
            string want = Str(a, "item", required: false, max: 64);
            int smelters = 0, fermenters = 0, unloaded = 0;
            foreach (var z in ZdosAround(pos, r))
            {
                var sm = PrefabComponent<Smelter>(z);
                var fe = sm == null ? PrefabComponent<Fermenter>(z) : null;
                if (sm == null && fe == null) continue;
                long owner = LoadedBy(z);
                if (owner == 0) { unloaded++; continue; }
                if (sm != null)
                {
                    var conv = sm.m_conversion.Where(c => c.m_from != null)
                        .FirstOrDefault(c => want == null || c.m_from.name == want);
                    if (conv == null) continue;
                    // The owner checks capacity and ignores the excess.
                    for (int i = 0; i < sm.m_maxOre; i++)
                        ZRoutedRpc.instance.InvokeRoutedRPC(owner, z.m_uid, "RPC_AddOre", conv.m_from.name, false);
                    if (sm.m_fuelItem != null)
                        for (int i = 0; i < sm.m_maxFuel; i++)
                            ZRoutedRpc.instance.InvokeRoutedRPC(owner, z.m_uid, "RPC_AddFuel");
                    smelters++;
                }
                else
                {
                    var conv = fe.m_conversion.Where(c => c.m_from != null)
                        .FirstOrDefault(c => want == null || c.m_from.name == want);
                    if (conv == null) continue;
                    ZRoutedRpc.instance.InvokeRoutedRPC(owner, z.m_uid, "RPC_AddItem", conv.m_from.name.GetStableHashCode(), false);
                    fermenters++;
                }
            }
            return Ok(new { smelters, fermenters, unloaded, near, radius = r });
        }

        // Back-dates the plant time of crops and saplings so they are ready on
        // their next growth check.
        public static object Grow(JObject a)
        {
            var n = Net();
            var pos = Target(a, out string near);
            float r = Radius(a, 20f);
            int grown = 0;
            foreach (var z in ZdosAround(pos, r))
            {
                var plant = PrefabComponent<Plant>(z);
                if (plant == null) continue;
                long when = n.GetTime().Ticks - TimeSpan.FromSeconds(plant.m_growTimeMax + 60).Ticks;
                z.Set(ZDOVars.s_plantTime, when);
                grown++;
            }
            return Ok(new { plants = grown, near, radius = r, note = "crops grow on the owning client's next check (within ~10 s when loaded)" });
        }

        // ---- tombstones -----------------------------------------------------

        static List<ZDO> AllTombstones()
        {
            var list = new List<ZDO>();
            int index = 0;
            int guard = 0;
            while (!ZDOMan.instance.GetAllZDOsWithPrefabIterative("Player_tombstone", list, ref index) && guard++ < 10000) { }
            return list;
        }

        public static object Tombstones(JObject a)
        {
            Net();
            var list = AllTombstones().Select(z => new
            {
                id = Id(z.m_uid),
                owner = z.GetString(ZDOVars.s_ownerName),
                position = V3(z.GetPosition()),
                loaded = LoadedBy(z) != 0,
            }).ToList();
            return Ok(list);
        }

        // Moves a tombstone that no player currently has loaded. A loaded one is
        // simulated by that client, which would keep its own position.
        public static object MoveTombstone(JObject a)
        {
            Net();
            string id = Str(a, "id", max: 64);
            var z = AllTombstones().FirstOrDefault(t => Id(t.m_uid) == id)
                    ?? throw new CommandError(404, "no tombstone '" + id + "'; GET /v1/tombstones lists them");
            long owner = LoadedBy(z);
            if (owner != 0 && owner != ZDOMan.GetSessionID())
                throw new CommandError(409, "a player has that tombstone loaded; move it when nobody is near it");
            var from = z.GetPosition();
            var to = Target(a, out string near) + new Vector3(1.5f, 0.5f, 0f);
            z.SetPosition(to);
            return Ok(new { id, owner = z.GetString(ZDOVars.s_ownerName), from = V3(from), to = V3(to), near });
        }

        // ---- not possible server-side ---------------------------------------

        // Cartography tables keep explored fog + shared pins in one gzip blob in
        // the table ZDO's "data" (layout in MapData.cs). The server's Minimap is
        // never initialised on a dedicated server, so the bridge edits the blob
        // itself: decode, merge (never replace), encode, write back. Players see
        // the result the next time they read the table.

        // Owner id stamped on bridge pins so clients treat them as shared pins
        // from someone else, not as their own.
        const long PinOwner = 0x534B414C44; // "SKALD"

        static List<ZDO> TablesAround(JObject a)
        {
            var pos = Target(a, out _);
            float r = Radius(a, 30f);
            var tables = ZdosAround(pos, r).Where(z => PrefabComponent<MapTable>(z) != null).ToList();
            if (tables.Count == 0) throw new CommandError(404, "no cartography table within " + r + " m");
            return tables;
        }

        static object EditTables(List<ZDO> tables, Func<MapData, object> edit)
        {
            var result = new List<object>();
            foreach (var z in tables)
            {
                byte[] old = z.GetByteArray(ZDOVars.s_data);
                MapData map;
                try
                {
                    map = old != null && old.Length > 0
                        ? MapData.Decode(old)
                        : new MapData { Explored = new byte[2048 * 2048] };
                }
                catch (Exception e) when (e is NotSupportedException || e is System.IO.InvalidDataException || e is System.IO.EndOfStreamException)
                {
                    throw new CommandError(409, "table " + Id(z.m_uid) + ": cannot read its map data (" + e.Message + "); left untouched");
                }
                object change = edit(map);
                byte[] data = map.Encode();
                // Take ownership so the write wins over the client that has the
                // table loaded; ownership returns to a nearby client afterwards.
                z.SetOwner(ZDOMan.GetSessionID());
                z.Set(ZDOVars.s_data, data);
                result.Add(new { id = Id(z.m_uid), change, pins = map.Pins.Count, bytesBefore = old?.Length ?? 0, bytesAfter = data.Length });
            }
            return result;
        }

        public static object RevealMap(JObject a)
        {
            Net();
            var tables = TablesAround(a);
            var result = EditTables(tables, m => new { revealedPixels = m.RevealAll() });
            return Ok(new { tables = result, note = "players see it after reading the table" });
        }

        // pins: [{x, z, name, type?}] with type one of icon0..icon4 (default icon0).
        public static object AddPins(JObject a)
        {
            Net();
            var arr = a["pins"] as JArray ?? throw new CommandError(400, "missing 'pins': [{x, z, name}]");
            if (arr.Count == 0 || arr.Count > 50) throw new CommandError(400, "'pins' must hold 1 to 50 entries");
            string author = Splatform.PlatformUserID.None.ToString();
            var add = new List<MapData.Pin>();
            foreach (var t in arr)
            {
                var o = t as JObject ?? throw new CommandError(400, "pins entries must be objects");
                var pos = Coords(o, "pin");
                string name = Str(o, "name", required: false, max: 40) ?? "";
                string ty = (Str(o, "type", required: false) ?? "icon0").ToLowerInvariant();
                Minimap.PinType type;
                switch (ty)
                {
                    case "icon0": type = Minimap.PinType.Icon0; break;
                    case "icon1": type = Minimap.PinType.Icon1; break;
                    case "icon2": type = Minimap.PinType.Icon2; break;
                    case "icon3": type = Minimap.PinType.Icon3; break;
                    case "icon4": type = Minimap.PinType.Icon4; break;
                    default: throw new CommandError(400, "pin type must be icon0..icon4");
                }
                add.Add(new MapData.Pin { Owner = PinOwner, Name = name, X = pos.x, Y = pos.y, Z = pos.z, Type = (int)type, Author = author });
            }
            var tables = TablesAround(a);
            var result = EditTables(tables, m => new { pinsAdded = m.AddPins(add) });
            return Ok(new { tables = result, note = "players see the pins after reading the table" });
        }

#if SKALD_TEST
        // Test builds only (-p:DefineConstants=SKALD_TEST): places any prefab so
        // tables and tombstones can be exercised without a player. Never in
        // release builds.
        public static object DebugSpawnPrefab(JObject a)
        {
            Net();
            string name = Str(a, "prefab", max: 64);
            var prefab = ZNetScene.instance.GetPrefab(name) ?? throw new CommandError(404, "unknown prefab " + name);
            var pos = Target(a, out string near);
            var go = UnityEngine.Object.Instantiate(prefab, pos, Quaternion.identity);
            var nv = go.GetComponent<ZNetView>();
            var z = nv != null ? nv.GetZDO() : null;
            return Ok(new { prefab = name, id = z != null ? Id(z.m_uid) : null, position = V3(pos) });
        }
#endif

        public static Func<JObject, object> Unsupported(string why) => a => throw new CommandError(501, "not possible server-side: " + why);
    }
}
