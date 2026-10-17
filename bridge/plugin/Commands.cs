using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace Skald.Bridge
{
    sealed class Route
    {
        public string Method, Path;
        public bool Mutating;
        public Func<JObject, object> Handler;
        // Runs on the request's own thread instead of the Unity main thread:
        // only for read-only work that is safe there (Terrain.cs).
        public bool OffThread;
        // Set when a game patch broke this command; it then answers 503.
        public volatile string Broken;
    }

    // All handlers run on the Unity main thread (see SkaldBridgePlugin.RunOnMainThread).
    static class Router
    {
        static readonly List<Route> Routes = new List<Route>
        {
            R("GET", "/v1/health", false, Commands.Health),
            R("GET", "/v1/players", false, Commands.Players),
            R("POST", "/v1/broadcast", true, Commands.Broadcast),
            R("POST", "/v1/save", true, Commands.Save),
            R("POST", "/v1/kick", true, Commands.Kick),
            R("GET", "/v1/bans", false, Commands.Bans),
            R("POST", "/v1/ban", true, Commands.Ban),
            R("POST", "/v1/unban", true, Commands.Unban),
            R("GET", "/v1/time", false, Commands.Time),
            R("POST", "/v1/time/skip-to-morning", true, Commands.SkipToMorning),
            R("POST", "/v1/time", true, Commands.SetTime),
            R("GET", "/v1/events", false, Commands.Events),
            R("POST", "/v1/events/stop", true, Commands.StopEvent),
            R("POST", "/v1/events/start", true, Commands.StartEvent),
            R("POST", "/v1/spawn", true, Commands.Spawn),
            R("POST", "/v1/teleport", true, Commands.Teleport),
            R("GET", "/v1/globalkeys", false, Commands.GlobalKeys),
            R("POST", "/v1/globalkeys/set", true, Commands.SetGlobalKey),
            R("POST", "/v1/globalkeys/remove", true, Commands.RemoveGlobalKey),
            R("GET", "/v1/locations", false, Commands.Locations),
            // Priority-2 commands, see Extras.cs.
            R("POST", "/v1/time/freeze", true, Extras.FreezeTime),
            R("POST", "/v1/time/resume", true, Extras.ResumeTime),
            R("POST", "/v1/creatures/spawn", true, Extras.SpawnCreature),
            R("POST", "/v1/creatures/kill", true, Extras.KillCreatures),
            R("POST", "/v1/creatures/tame", true, Extras.TameCreatures),
            R("POST", "/v1/player/heal", true, Extras.Heal),
            R("POST", "/v1/player/status", true, Extras.AddStatus),
            R("POST", "/v1/build/repair", true, Extras.Repair),
            R("POST", "/v1/build/fill", true, Extras.Fill),
            R("POST", "/v1/build/fill-kilns", true, Extras.FillKilns),
            R("POST", "/v1/build/fill-smelters", true, Extras.FillSmelters),
            R("POST", "/v1/build/fill-fermenters", true, Extras.FillFermenters),
            R("GET", "/v1/build/stations", false, Extras.FillStations),
            R("POST", "/v1/build/grow", true, Extras.Grow),
            R("GET", "/v1/tombstones", false, Extras.Tombstones),
            R("POST", "/v1/tombstones/move", true, Extras.MoveTombstone),
            R("POST", "/v1/map/reveal", true, Extras.RevealMap),
            R("POST", "/v1/map/pins", true, Extras.AddPins),
            R("POST", "/v1/nearby", false, Extras.Nearby),
            R("POST", "/v1/containers/add", true, Chests.Add),
            // Read-only terrain sampling, off the main thread (see Terrain.cs).
            new Route { Method = "GET", Path = "/v1/terrain/info", Handler = Terrain.Info, OffThread = true },
            new Route { Method = "GET", Path = "/v1/terrain/tile", Handler = Terrain.Tile, OffThread = true },
#if SKALD_TEST
            R("POST", "/v1/debug/spawn-prefab", true, Extras.DebugSpawnPrefab),
#endif
            // Client-authoritative state: answered with 501 and the reason.
            R("POST", "/v1/weather", true, Extras.Unsupported("each client picks its own environment from time and biome; there is no server RPC to force it (a raid event's environment is the only server-driven override)")),
            R("POST", "/v1/player/feed", true, Extras.Unsupported("food slots live in the client's player profile and have no server RPC")),
            R("POST", "/v1/player/godmode", true, Extras.Unsupported("god mode is a local debug flag on the client")),
            R("POST", "/v1/player/fly", true, Extras.Unsupported("fly is a local debug flag on the client")),
            R("POST", "/v1/player/ghost", true, Extras.Unsupported("ghost mode is a local debug flag on the client")),
            R("POST", "/v1/player/freebuild", true, Extras.Unsupported("per-player no-cost build is a local debug flag; the world-wide equivalent is the nobuildcost global key")),
        };

        static Route R(string m, string p, bool mut, Func<JObject, object> h) =>
            new Route { Method = m, Path = p, Mutating = mut, Handler = h };

        public static Route Find(string method, string path) =>
            Routes.FirstOrDefault(r => r.Method == method && string.Equals(r.Path, path, StringComparison.Ordinal));
    }

    static class Commands
    {
        // ---- helpers ------------------------------------------------------

        internal static ZNet Net()
        {
            var n = ZNet.instance;
            if (n == null || !n.IsServer()) throw new CommandError(503, "world not loaded yet");
            return n;
        }

        internal static string Str(JObject a, string k, bool required = true, int max = 200)
        {
            var t = a[k];
            string s = t == null || t.Type == JTokenType.Null ? null : t.ToString().Trim();
            if (string.IsNullOrEmpty(s))
            {
                if (required) throw new CommandError(400, "missing '" + k + "'");
                return null;
            }
            if (s.Length > max) throw new CommandError(400, "'" + k + "' longer than " + max + " characters");
            return s;
        }

        internal static int Int(JObject a, string k, int def, int min, int max)
        {
            var t = a[k];
            if (t == null || t.Type == JTokenType.Null) return def;
            if (!int.TryParse(t.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out int v))
                throw new CommandError(400, "'" + k + "' is not an integer");
            if (v < min || v > max) throw new CommandError(400, "'" + k + "' must be between " + min + " and " + max);
            return v;
        }

        internal static float? Float(JToken t, string k)
        {
            if (t == null || t.Type == JTokenType.Null) return null;
            if (!float.TryParse(t.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out float v) || float.IsNaN(v) || float.IsInfinity(v))
                throw new CommandError(400, "'" + k + "' is not a number");
            return v;
        }

        // The id the ban list stores: the platform user id when the game reports
        // one, else the socket host name.
        static string BanId(ZNetPeer p)
        {
            return UserIds().TryGetValue(p.m_characterID, out var u) && !string.IsNullOrEmpty(u) ? u : PlatformId(p);
        }

        internal static string PlatformId(ZNetPeer p)
        {
            try { return p.m_socket?.GetHostName() ?? ""; } catch { return ""; }
        }

        // The character ZDO carries the live position and health; the peer's
        // reference position is the fallback right after join.
        internal static Vector3 PositionOf(ZNetPeer p, out ZDO zdo)
        {
            zdo = p.m_characterID.IsNone() ? null : ZDOMan.instance.GetZDO(p.m_characterID);
            return zdo != null ? zdo.GetPosition() : p.m_refPos;
        }

        // Accepts a peer uid, a platform id as the game prints it (Steam_..., Xbox_...,
        // PlayFab id) or a character name (case-insensitive).
        internal static ZNetPeer FindPlayer(string who)
        {
            var peers = Net().GetPeers().Where(p => p.IsReady()).ToList();
            if (long.TryParse(who, NumberStyles.Integer, CultureInfo.InvariantCulture, out long uid))
            {
                var byUid = peers.FirstOrDefault(p => p.m_uid == uid);
                if (byUid != null) return byUid;
            }
            var ids = UserIds();
            var byId = peers.FirstOrDefault(p => string.Equals(PlatformId(p), who, StringComparison.OrdinalIgnoreCase)
                                              || string.Equals(p.m_playfabId, who, StringComparison.OrdinalIgnoreCase)
                                              || (ids.TryGetValue(p.m_characterID, out var u) && string.Equals(u, who, StringComparison.OrdinalIgnoreCase)));
            if (byId != null) return byId;
            var byName = peers.Where(p => string.Equals(p.m_playerName, who, StringComparison.OrdinalIgnoreCase)).ToList();
            if (byName.Count == 1) return byName[0];
            if (byName.Count > 1) throw new CommandError(409, "more than one player is called '" + who + "', use the uid");
            throw new CommandError(404, "no connected player '" + who + "'");
        }

        internal static object Ok(object data) => new { ok = true, data };

        internal static object V3(Vector3 v) => new { x = Math.Round(v.x, 2), y = Math.Round(v.y, 2), z = Math.Round(v.z, 2) };

        // ---- read-only ----------------------------------------------------

        public static object Health(JObject a)
        {
            var n = ZNet.instance;
            return Ok(new
            {
                plugin = SkaldBridgePlugin.Version,
                gameBuild = SkaldBridgePlugin.SafeGameVersion(),
                worldLoaded = n != null && n.IsServer(),
                world = n != null ? n.GetWorldName() : null,
                timeFrozen = SkaldBridgePlugin.FrozenNetTime.HasValue,
                // Which game singletons exist on this dedicated server; the
                // client-UI ones (MessageHud, Chat, Minimap) are expected to be absent.
                instances = new
                {
                    envMan = EnvMan.instance != null,
                    randEventSystem = RandEventSystem.instance != null,
                    objectDB = ObjectDB.instance != null,
                    zoneSystem = ZoneSystem.instance != null,
                    messageHud = MessageHud.instance != null,
                    chat = Chat.instance != null,
                    minimap = Minimap.instance != null,
                },
            });
        }

        // The game's own player list carries the platform user id (e.g. Steam_...,
        // Xbox_...) inside m_userInfo; read it by reflection so a renamed field
        // only blanks this value instead of breaking the command.
        static Dictionary<ZDOID, string> UserIds()
        {
            var ids = new Dictionary<ZDOID, string>();
            try
            {
                foreach (var info in ZNet.instance.GetPlayerList())
                {
                    object ui = info.m_userInfo;
                    if (ui == null || info.m_characterID.IsNone()) continue;
                    var t = ui.GetType();
                    object v = t.GetFields().Where(f => f.FieldType == typeof(Splatform.PlatformUserID)).Select(f => f.GetValue(ui)).FirstOrDefault()
                            ?? t.GetProperties().Where(pr => pr.PropertyType == typeof(Splatform.PlatformUserID)).Select(pr => pr.GetValue(ui, null)).FirstOrDefault();
                    if (v != null) ids[info.m_characterID] = v.ToString();
                }
            }
            catch (Exception) { }
            return ids;
        }

        public static object Players(JObject a)
        {
            var list = new List<object>();
            var userIds = UserIds();
            foreach (var p in Net().GetPeers())
            {
                if (!p.IsReady()) continue;
                var pos = PositionOf(p, out var zdo);
                float? hp = null, maxHp = null;
                if (zdo != null)
                {
                    if (zdo.GetFloat(ZDOVars.s_health, out float h)) hp = (float)Math.Round(h, 1);
                    if (zdo.GetFloat(ZDOVars.s_maxHealth, out float mh)) maxHp = (float)Math.Round(mh, 1);
                }
                list.Add(new
                {
                    uid = p.m_uid,
                    name = p.m_playerName,
                    // socket host name: what kick/ban match on
                    platformId = PlatformId(p),
                    userId = userIds.TryGetValue(p.m_characterID, out var uidStr) ? uidStr : null,
                    playfabId = p.m_playfabId,
                    position = V3(pos),
                    hasCharacter = zdo != null,
                    health = hp,
                    maxHealth = maxHp,
                });
            }
            return Ok(new { time = ZNet.instance.GetTimeSeconds(), players = list });
        }

        public static object Bans(JObject a) => Ok(Net().Banned.ToList());

        public static object Time(JObject a)
        {
            Net();
            var env = EnvMan.instance;
            if (env == null) throw new CommandError(503, "EnvMan not available");
            return Ok(new
            {
                day = env.GetDay(),
                dayFraction = Math.Round(env.GetDayFraction(), 4),
                netTimeSeconds = ZNet.instance.GetTimeSeconds(),
                dayLengthSeconds = env.m_dayLengthSec,
                timeSkipping = env.IsTimeSkipping(),
            });
        }

        public static object Events(JObject a)
        {
            Net();
            var rs = RandEventSystem.instance;
            if (rs == null) throw new CommandError(503, "RandEventSystem not available");
            var cur = rs.GetCurrentRandomEvent();
            return Ok(new
            {
                current = cur == null ? null : new { name = cur.m_name, position = V3(cur.m_pos), elapsed = Math.Round(cur.m_time, 1), duration = cur.m_duration },
                available = rs.m_events.Where(e => e != null && e.m_enabled).Select(e => e.m_name).Distinct().OrderBy(s => s).ToList(),
            });
        }

        public static object GlobalKeys(JObject a)
        {
            Net();
            return Ok(ZoneSystem.instance.GetGlobalKeys().OrderBy(s => s).ToList());
        }

        // ---- mutating -----------------------------------------------------

        // type: center (default), topleft or narrator (center, styled as the
        // storyteller). chat answers 501: clients drop server-originated shouts.
        public static object Broadcast(JObject a)
        {
            Net();
            string text = Str(a, "text", max: 300);
            string where = (Str(a, "type", required: false) ?? "center").ToLowerInvariant();
            int sentTo = ZNet.instance.GetPeers().Count(p => p.IsReady());
            if (where == "chat")
                throw new CommandError(501, "not possible server-side: chat lines carry a sender platform user id, and a shout " +
                    "sent by the server (which has none) was not shown on an Xbox client; use center, topleft or narrator");
            MessageHud.MessageType type;
            if (where == "center") type = MessageHud.MessageType.Center;
            else if (where == "topleft") type = MessageHud.MessageType.TopLeft;
            else if (where == "narrator")
            {
                type = MessageHud.MessageType.Center;
                // TextMeshPro rich text: the client renders it, nothing new ships.
                text = "<i><color=#E8C170><noparse>" + System.Text.RegularExpressions.Regex.Replace(text, "</?noparse>", "", System.Text.RegularExpressions.RegexOptions.IgnoreCase) + "</noparse></color></i>";
            }
            else throw new CommandError(400, "'type' must be center, topleft, narrator or chat");
            // Same routed RPC the game uses for MessageHud.MessageAll; MessageHud
            // itself is client UI and does not exist on a dedicated server.
            ZRoutedRpc.instance.InvokeRoutedRPC(ZRoutedRpc.Everybody, "ShowMessage", (int)type, text);
            return Ok(new { sentTo, type = where });
        }

        public static object Save(JObject a)
        {
            var n = Net();
            n.Save(false);
            return Ok(new { started = true, note = "world save started; watch the log for the save-finished line" });
        }

        public static object Kick(JObject a)
        {
            var n = Net();
            var p = FindPlayer(Str(a, "player"));
            string name = p.m_playerName, id = BanId(p);
            n.Kick(id != "" ? id : name);
            return Ok(new { kicked = name, uid = p.m_uid });
        }

        // Accepts a connected player (name/uid/platform id) or, for offline
        // players, a platform id as the game stores it in bannedlist.txt.
        public static object Ban(JObject a)
        {
            var n = Net();
            string who = Str(a, "player");
            string id;
            string name = null;
            try
            {
                var p = FindPlayer(who);
                id = BanId(p);
                name = p.m_playerName;
                if (id == "") throw new CommandError(409, "player has no platform id to ban");
            }
            catch (CommandError e) when (e.Status == 404)
            {
                if (!who.Contains("_")) throw new CommandError(404, "no connected player '" + who + "'; to ban an offline player pass a platform id like Steam_<id> or Xbox_<id>");
                id = who;
            }
            n.Ban(id);
            return Ok(new { banned = id, name, banList = n.Banned.ToList() });
        }

        public static object Unban(JObject a)
        {
            var n = Net();
            string who = Str(a, "player");
            if (!n.Banned.Any(b => string.Equals(b, who, StringComparison.OrdinalIgnoreCase)))
                throw new CommandError(404, "'" + who + "' is not on the ban list");
            n.Unban(who);
            return Ok(new { unbanned = who, banList = n.Banned.ToList() });
        }

        public static object SkipToMorning(JObject a)
        {
            Net();
            var env = EnvMan.instance;
            if (env == null) throw new CommandError(503, "EnvMan not available");
            if (env.IsTimeSkipping()) throw new CommandError(409, "already skipping time");
            int day = env.GetDay();
            env.SkipToMorning();
            return Ok(new { fromDay = day, note = "time fast-forwards to the next morning, as when everyone sleeps" });
        }

        // Moves time forward only: going backwards would confuse spawn and
        // respawn timers that are keyed on net time.
        public static object SetTime(JObject a)
        {
            var n = Net();
            var env = EnvMan.instance;
            if (env == null) throw new CommandError(503, "EnvMan not available");
            float frac = Float(a["dayFraction"], "dayFraction") ?? throw new CommandError(400, "missing 'dayFraction' (0..1, 0.25 is morning, 0.5 noon)");
            if (frac < 0f || frac >= 1f) throw new CommandError(400, "'dayFraction' must be in [0, 1)");
            double len = env.m_dayLengthSec;
            double now = n.GetTimeSeconds();
            long day = (long)Math.Floor(now / len);
            double target = day * len + frac * len;
            if (target <= now) target += len;
            n.SetNetTime(target);
            if (SkaldBridgePlugin.FrozenNetTime.HasValue) SkaldBridgePlugin.FrozenNetTime = target;
            return Ok(new { fromSeconds = now, toSeconds = target, day = (long)Math.Floor(target / len), dayFraction = frac });
        }

        public static object StopEvent(JObject a)
        {
            Net();
            var rs = RandEventSystem.instance;
            if (rs == null) throw new CommandError(503, "RandEventSystem not available");
            var cur = rs.GetCurrentRandomEvent();
            if (cur == null) throw new CommandError(409, "no random event is running");
            rs.ResetRandomEvent();
            return Ok(new { stopped = cur.m_name });
        }

        public static object StartEvent(JObject a)
        {
            Net();
            var rs = RandEventSystem.instance;
            if (rs == null) throw new CommandError(503, "RandEventSystem not available");
            string name = Str(a, "name", max: 64);
            if (!rs.m_events.Any(e => e != null && e.m_name == name))
                throw new CommandError(404, "unknown event '" + name + "'; GET /v1/events lists the names");
            var pos = Target(a, out string near);
            rs.SetRandomEventByName(name, pos);
            return Ok(new { started = name, near, position = V3(pos) });
        }

        // Where a command acts: next to 'player' (uid / platform id / name) or at
        // 'at': {x, z[, y]}. Sets near to the player's name or "position".
        internal static Vector3 Target(JObject a, out string near)
        {
            if (a["at"] is JObject at)
            {
                near = "position";
                return Coords(at, "at");
            }
            var p = FindPlayer(Str(a, "player"));
            near = p.m_playerName;
            return PositionOf(p, out _);
        }

        internal static Vector3 Coords(JObject to, string k)
        {
            float x = Float(to["x"], k + ".x") ?? throw new CommandError(400, "missing '" + k + ".x'");
            float z = Float(to["z"], k + ".z") ?? throw new CommandError(400, "missing '" + k + ".z'");
            if (Math.Abs(x) > 10500 || Math.Abs(z) > 10500) throw new CommandError(400, "'" + k + "' is outside the world");
            // Without y, use the generated terrain height (ignores terraforming),
            // never below the water line.
            float y = Float(to["y"], k + ".y") ?? Math.Max(WorldGenerator.instance.GetHeight(x, z), 30f) + 1f;
            return new Vector3(x, y, z);
        }

        // One item ({item, amount, quality}) or a kit ({items: [{item, amount, quality}, ...]}),
        // dropped next to 'player' or at 'at'.
        public static object Spawn(JObject a)
        {
            Net();
            var odb = ObjectDB.instance;
            if (odb == null) throw new CommandError(503, "ObjectDB not available");
            var lines = new List<JObject>();
            if (a["items"] is JArray arr)
            {
                if (arr.Count == 0 || arr.Count > 20) throw new CommandError(400, "'items' must hold 1 to 20 entries");
                foreach (var t in arr)
                    lines.Add(t as JObject ?? throw new CommandError(400, "'items' entries must be objects"));
            }
            else lines.Add(a);

            // Validate the whole kit before dropping anything.
            var plan = new List<(string item, GameObject prefab, int amount, int quality, int maxStack)>();
            foreach (var l in lines)
            {
                string item = Str(l, "item", max: 64);
                int amount = Int(l, "amount", 1, 1, 999);
                int quality = Int(l, "quality", 1, 1, 10);
                var prefab = odb.GetItemPrefab(item);
                var proto = prefab != null ? prefab.GetComponent<ItemDrop>() : null;
                if (proto == null) throw new CommandError(404, "unknown item prefab '" + item + "' (use the prefab name, e.g. Wood, SwordIron)");
                quality = Math.Min(quality, Math.Max(1, proto.m_itemData.m_shared.m_maxQuality));
                plan.Add((item, prefab, amount, quality, Math.Max(1, proto.m_itemData.m_shared.m_maxStackSize)));
            }
            if (plan.Sum(x => (x.amount + x.maxStack - 1) / x.maxStack) > 60) throw new CommandError(400, "too many stacks in one call (max 60)");

            var pos = Target(a, out string near);
            var done = new List<object>();
            int drops = 0;
            foreach (var x in plan)
            {
                int left = x.amount;
                while (left > 0)
                {
                    int n = Math.Min(left, x.maxStack);
                    // Small offset so stacks do not spawn inside the player or each other.
                    var at = pos + new Vector3(UnityEngine.Random.Range(-1f, 1f), 1f + (drops % 10) * 0.3f, UnityEngine.Random.Range(-1f, 1f));
                    var go = UnityEngine.Object.Instantiate(x.prefab, at, Quaternion.identity);
                    var drop = go.GetComponent<ItemDrop>();
                    drop.m_itemData.m_durability = drop.m_itemData.GetMaxDurability(x.quality);
                    drop.SetQuality(x.quality);
                    drop.SetStack(n);
                    left -= n;
                    drops++;
                }
                done.Add(new { x.item, x.amount, x.quality });
            }
            return Ok(new { items = done, stacks = drops, near, position = V3(pos) });
        }

        // Destination: 'toPlayer', 'to': {x, z[, y]} or 'toSpot' (a named world
        // location closest to the player, see GET /v1/locations).
        public static object Teleport(JObject a)
        {
            Net();
            var p = FindPlayer(Str(a, "player"));
            Vector3 dest;
            string toPlayer = Str(a, "toPlayer", required: false);
            string toSpot = Str(a, "toSpot", required: false, max: 64);
            string label;
            if (toPlayer != null)
            {
                var t = FindPlayer(toPlayer);
                if (t == p) throw new CommandError(400, "player and toPlayer are the same");
                dest = PositionOf(t, out _) + new Vector3(1.5f, 0.5f, 0f);
                label = t.m_playerName;
            }
            else if (toSpot != null)
            {
                string loc = Spots.TryGetValue(toSpot.ToLowerInvariant(), out var mapped) ? mapped : toSpot;
                if (!ZoneSystem.instance.FindClosestLocation(loc, PositionOf(p, out _), out var inst))
                    throw new CommandError(404, "no location '" + loc + "' in this world; aliases: " + string.Join(", ", Spots.Keys.ToArray()));
                // Land a few metres off the location centre, at ground level.
                var c = inst.m_position;
                dest = new Vector3(c.x + 4f, Math.Max(WorldGenerator.instance.GetHeight(c.x + 4f, c.z), 30f) + 1f, c.z);
                label = loc;
            }
            else if (a["to"] is JObject to)
            {
                dest = Coords(to, "to");
                label = "position";
            }
            else throw new CommandError(400, "pass 'toPlayer', 'toSpot' or 'to': {x, z[, y]}");
            // The client registers this routed RPC; distantTeleport makes it load
            // the destination zone first, like a portal.
            ZRoutedRpc.instance.InvokeRoutedRPC(p.m_uid, "RPC_TeleportPlayer", dest, Quaternion.identity, true);
            return Ok(new { player = p.m_playerName, to = V3(dest), label });
        }

        // Friendly names for world locations (ZoneSystem location prefab names).
        static readonly Dictionary<string, string> Spots = new Dictionary<string, string>
        {
            { "spawn", "StartTemple" }, { "eikthyr", "Eikthyrnir" }, { "elder", "GDKing" },
            { "bonemass", "Bonemass" }, { "moder", "Dragonqueen" }, { "yagluth", "GoblinKing" },
            { "queen", "Mistlands_DvergrBossEntrance1" }, { "fader", "FaderLocation" },
            { "haldor", "Vendor_BlackForest" }, { "hildir", "Hildir_camp" }, { "bogwitch", "BogWitch_Camp" },
        };

        public static object Locations(JObject a)
        {
            Net();
            var names = ZoneSystem.instance.GetLocationList().Where(l => l.m_location != null)
                .Select(l => l.m_location.m_prefabName).Distinct().OrderBy(x => x).ToList();
            return Ok(new { aliases = Spots, locations = names });
        }

        public static object SetGlobalKey(JObject a)
        {
            Net();
            string key = Str(a, "key", max: 64);
            ZoneSystem.instance.SetGlobalKey(key);
            return Ok(ZoneSystem.instance.GetGlobalKeys().OrderBy(s => s).ToList());
        }

        public static object RemoveGlobalKey(JObject a)
        {
            Net();
            string key = Str(a, "key", max: 64);
            if (!ZoneSystem.instance.GetGlobalKey(key)) throw new CommandError(404, "global key '" + key + "' is not set");
            ZoneSystem.instance.RemoveGlobalKey(key);
            return Ok(ZoneSystem.instance.GetGlobalKeys().OrderBy(s => s).ToList());
        }
    }
}
