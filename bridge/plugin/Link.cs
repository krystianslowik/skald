using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using HarmonyLib;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace Skald.Bridge
{
    // Per-player link quality and simulation load for GET /v1/players.
    //
    // Everything here is optional: each game call sits in its own method that
    // is not inlined, called inside a try, so a game update that renames one
    // blanks that value (one warning line) instead of breaking the players
    // list, which the map's positions depend on. None of these members are in
    // Binding.Required.
    static class Link
    {
        static readonly LinkTracker Tracker = new LinkTracker();
        // Peers by their ZRpc (one per connection): the hooks see only the
        // ZRpc, and Tick drops the ones no longer in the game's peer list.
        static readonly Dictionary<ZRpc, long> Ids = new Dictionary<ZRpc, long>();
        static long nextId;
        static bool tickOff, simBroken;
        // The keep-alive hooks are in place and working.
        static bool hooked;
        static readonly HashSet<string> QueueOff = new HashSet<string>(), QualityOff = new HashSet<string>();
        static float prunedAt;

        static void Off(string what, Exception e) =>
            SkaldBridgePlugin.Warn(what + " off: " + e.GetType().Name + ": " + e.Message);

        static bool IsBindingError(Exception e) => e is MissingMemberException || e is TypeLoadException;

        // ---- the keep-alive hooks (Harmony, applied once in Awake) ----------
        //
        // ZRpc.UpdatePing sends the ping once a second; ZRpc.ReceivePing
        // handles both a ping from the peer (true: answered) and the reply to
        // ours (false: "time since last ping" restarts). Each send and each
        // reply is reported with its time to the tracker, which pairs them in
        // order. Nothing here changes what the game does, and nothing throws
        // into it: the first failure unhooks the round trip, with one line.
        // Without the hooks the reply gaps still come from the game's own
        // GetTimeSinceLastPing, read once a frame.

        internal static void Hook()
        {
            try
            {
                string missing = Patch();
                if (missing != null) SkaldBridgePlugin.Warn("link round trip off: ZRpc." + missing + " not found");
            }
            catch (Exception e)
            {
                hooked = false;
                Off("link round trip", e);
            }
        }

        // Kept apart so a missing HarmonyLib fails here, inside Hook's try.
        [MethodImpl(MethodImplOptions.NoInlining)]
        static string Patch()
        {
            var receive = AccessTools.Method(typeof(ZRpc), "ReceivePing", new[] { typeof(ZPackage) });
            if (receive == null) return "ReceivePing";
            var update = AccessTools.Method(typeof(ZRpc), "UpdatePing", new[] { typeof(float) });
            if (update == null) return "UpdatePing";
            var h = new Harmony(SkaldBridgePlugin.Guid + ".link");
            try
            {
                // ___m_pingTimer binds the private field when patching: a game
                // update that renames it fails here, not in the game loop.
                h.Patch(update, prefix: new HarmonyMethod(typeof(Link), nameof(PingBefore)), postfix: new HarmonyMethod(typeof(Link), nameof(PingAfter)));
                h.Patch(receive, prefix: new HarmonyMethod(typeof(Link), nameof(OnReceivePing)));
            }
            catch
            {
                try { h.UnpatchSelf(); } catch (Exception) { }
                throw;
            }
            hooked = true;
            return null;
        }

        static void PingBefore(float ___m_pingTimer, out float __state) => __state = ___m_pingTimer;

        // The ping went out when the timer restarted instead of moving on by
        // dt (__0). Half of dt keeps clear of float rounding either way.
        static void PingAfter(ZRpc __instance, float __0, float ___m_pingTimer, float __state)
        {
            if (!hooked || tickOff || !(___m_pingTimer < __state + __0 * 0.5f)) return;
            try { Record(__instance, true); }
            catch (Exception e) { Unhook(e); }
        }

        // Peeks the ping's flag and puts the read position back, so the
        // game reads the package as if nothing had looked.
        static void OnReceivePing(ZRpc __instance, ZPackage __0)
        {
            if (!hooked || tickOff) return;
            try
            {
                int pos = __0.GetPos();
                bool ask;
                try { ask = __0.ReadBool(); }
                catch (System.IO.EndOfStreamException) { return; } // malformed: the game deals with it
                finally { __0.SetPos(pos); }
                if (!ask) Record(__instance, false);
            }
            catch (Exception e) { Unhook(e); }
        }

        // Server side only: on a client the plugin has no peers to report.
        static void Record(ZRpc rpc, bool ping)
        {
            var net = ZNet.instance;
            if (net == null || !net.IsServer()) return;
            float now = Time.realtimeSinceStartup;
            long id = IdOf(rpc, now);
            if (ping) Tracker.Sent(id, now);
            else Tracker.Replied(id, now);
        }

        static void Unhook(Exception e)
        {
            if (!hooked) return;
            hooked = false;
            Off("link round trip", e);
        }

        static void Unhook(string why)
        {
            if (!hooked) return;
            hooked = false;
            SkaldBridgePlugin.Warn("link round trip off: " + why);
        }

        // The tracker id of a connection, made on first sight. With the hooks
        // in place since Awake (before the game opens a socket) every ping to
        // it has been seen, so its replies can be paired.
        static long IdOf(ZRpc rpc, float now)
        {
            if (!Ids.TryGetValue(rpc, out long id))
            {
                Ids[rpc] = id = ++nextId;
                Tracker.Seen(id, now, hooked);
            }
            return id;
        }

        // ---- once a frame (Plugin.Update) ------------------------------------

        internal static void Tick()
        {
            if (tickOff) return;
            try { TickPeers(); }
            catch (Exception e)
            {
                tickOff = true;
                Off("link probe", e);
            }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        static void TickPeers()
        {
            var net = ZNet.instance;
            if (net == null || !net.IsServer()) return;
            float now = Time.realtimeSinceStartup;
            var peers = net.GetPeers();
            for (int i = 0; i < peers.Count; i++)
            {
                var rpc = peers[i]?.m_rpc;
                if (rpc == null) continue;
                long id = IdOf(rpc, now);
                float wait = rpc.GetTimeSinceLastPing();
                if (hooked && Tracker.Silent(id, now, wait)) Unhook("the game handles keep-alive replies the hook does not see");
                if (!hooked) Tracker.Waited(id, now, wait);
            }
            if (now - prunedAt > LinkTracker.WindowS && Ids.Count > 0)
            {
                prunedAt = now;
                var here = new HashSet<ZRpc>();
                for (int i = 0; i < peers.Count; i++) if (peers[i]?.m_rpc != null) here.Add(peers[i].m_rpc);
                var live = new HashSet<long>();
                foreach (var kv in new List<KeyValuePair<ZRpc, long>>(Ids))
                {
                    if (here.Contains(kv.Key)) live.Add(kv.Value);
                    else Ids.Remove(kv.Key);
                }
                Tracker.Keep(live);
            }
        }

        // ---- per player, for GET /v1/players -------------------------------

        // The link as the server sees it; null when nothing could be read.
        internal static object Of(ZNetPeer p)
        {
            try
            {
                // With the probe off the tracker holds stale readings: none then.
                var s = !tickOff && p.m_rpc != null && Ids.TryGetValue(p.m_rpc, out long id) ? Tracker.Snapshot(id, Time.realtimeSinceStartup) : null;
                var sock = p.m_socket;
                string kind = sock?.GetType().Name ?? "";
                int? queue = null, socketPing = null, outBps = null, inBps = null;
                if (sock != null && !QueueOff.Contains(kind))
                {
                    try { queue = Math.Max(0, SendQueue(sock)); }
                    catch (Exception e) { QueueOff.Add(kind); Off("send queue on " + kind, e); }
                }
                // Crossplay (ZPlayFabSocket) answers from ZNetStats: no ping,
                // no quality, only the byte rates. Steam answers through the
                // client networking API, which a dedicated server may not have:
                // the first failure turns it off for that socket kind only.
                // GetCurrentSendRate is never called: crossplay throws
                // NotImplementedException.
                if (sock != null && !QualityOff.Contains(kind))
                {
                    try
                    {
                        Quality(sock, out int ping, out float outB, out float inB);
                        if (ping > 0) socketPing = ping;
                        outBps = (int)Math.Round(Math.Max(0f, outB));
                        inBps = (int)Math.Round(Math.Max(0f, inB));
                    }
                    catch (Exception e) { QualityOff.Add(kind); Off("connection quality on " + kind, e); }
                }
                if (s == null && queue == null && outBps == null) return null;
                return new
                {
                    transport = Transport(kind),
                    // Steam's own ping when it has one, else the timed keep-alive.
                    pingMs = socketPing ?? s?.RttMs,
                    pingMaxMs = socketPing.HasValue ? null : s?.RttMaxMs,
                    // No reply timed in the window, or the hooks are off:
                    // no ping rather than a wrong one.
                    pingUnsure = !socketPing.HasValue && s != null && s.Unsure ? true : (bool?)null,
                    replyGapMaxS = s == null ? (float?)null : (float)Math.Round(s.ReplyGapMaxS, 1),
                    queueBytes = queue,
                    outBps,
                    inBps,
                };
            }
            catch (Exception) { return null; }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        static int SendQueue(ISocket s) => s.GetSendQueueSize();

        [MethodImpl(MethodImplOptions.NoInlining)]
        static void Quality(ISocket s, out int ping, out float outB, out float inB) =>
            s.GetConnectionQuality(out _, out _, out ping, out outB, out inB);

        // The socket kind by type name: never an address or an id.
        static string Transport(string kind)
        {
            switch (kind)
            {
                case "ZPlayFabSocket": return "playfab";
                case "ZSteamSocket": return "steam";
                case "ZSocket2": return "tcp";
                default: return "other";
            }
        }

        // ---- simulation load: one cached scan for everyone ------------------

        const float SimEveryS = 5f;
        static readonly List<ZDO> Scratch = new List<ZDO>();
        static Dictionary<long, SimLoad> sims;
        static float simAt = -SimEveryS;
        static bool simWarned;

        // What the peer simulates; null when the scan is off or failed. A game
        // update that breaks the binding turns it off; anything else (a world
        // still loading) is retried at the next scan.
        internal static object SimOf(ZNetPeer p)
        {
            if (simBroken) return null;
            float now = Time.realtimeSinceStartup;
            if (now - simAt > SimEveryS)
            {
                simAt = now;
                try { sims = ScanAll(); }
                catch (Exception e)
                {
                    sims = null;
                    if (IsBindingError(e)) { simBroken = true; Off("simulation load", e); }
                    else if (!simWarned) { simWarned = true; SkaldBridgePlugin.Warn("simulation load scan failed, retrying: " + e.GetType().Name + ": " + e.Message); }
                }
            }
            if (sims == null || !sims.TryGetValue(p.m_uid, out var s)) return null;
            return new { owned = s.Owned, nearby = s.Nearby, zones = s.Zones };
        }

        // The objects in each peer's active area, found the way the game hands
        // out ownership (ZDOMan.ReleaseNearbyZDOS): the zone of the peer's
        // reference position and the near simulation distance around it.
        [MethodImpl(MethodImplOptions.NoInlining)]
        static Dictionary<long, SimLoad> ScanAll()
        {
            var res = new Dictionary<long, SimLoad>();
            var man = ZDOMan.instance;
            if (man == null) return res;
            var synced = ZNet.instance.GetSyncedSimulationDistance();
            var near = new SimulationDistance(synced.NearSimulationDistance, 0, synced.IsClassic);
            try
            {
                foreach (var p in ZNet.instance.GetPeers())
                {
                    if (p == null || !p.IsReady()) continue;
                    Scratch.Clear();
                    man.FindSectorObjects(ZoneSystem.GetZone(p.m_refPos), near, Scratch);
                    var c = new SimCounter(p.m_uid);
                    foreach (var z in Scratch)
                    {
                        if (z == null) continue;
                        var zone = ZoneSystem.GetZone(z.GetPosition());
                        c.Add(z.GetOwner(), zone.x, zone.y);
                    }
                    res[p.m_uid] = c.Result();
                }
            }
            finally { Scratch.Clear(); }
            return res;
        }

        // ---- POST /v1/sim/handover ------------------------------------------

        static readonly List<ZDO> HandoverScratch = new List<ZDO>();
        // What a prefab is to a handover, by prefab hash: an item on the
        // ground, or something that holds or works items (HandoverStep.Keeps
        // says why each is left alone).
        enum Holds { Nothing, ItemDrop, Items }
        static readonly Dictionary<int, Holds> Holding = new Dictionary<int, Holds>();

        // Containers are looked for in children too: a cart's and a ship's
        // storage sit on a child object.
        static readonly Type[] ItemHolders =
        {
            typeof(Container), typeof(Smelter), typeof(Fermenter), typeof(Beehive), typeof(CookingStation),
            typeof(ItemStand), typeof(ArmorStand), typeof(Pickable), typeof(PickableItem), typeof(SapCollector),
            typeof(Fireplace), typeof(ShieldGenerator), typeof(Turret), typeof(Catapult), typeof(Feast),
            typeof(Fish), typeof(MineRock), typeof(MineRock5),
            // The saddle lives in the animal's data: a dropped add or remove loses or doubles it.
            typeof(Sadle),
        };

        static Holds HoldingOf(ZDO z)
        {
            int hash = z.GetPrefab();
            if (Holding.TryGetValue(hash, out var known)) return known;
            var prefab = ZNetScene.instance != null ? ZNetScene.instance.GetPrefab(hash) : null;
            if (prefab == null) return Holds.Nothing; // not kept: the scene may not have every prefab yet
            var h = Holds.Nothing;
            if (prefab.GetComponent<ItemDrop>() != null) h = Holds.ItemDrop;
            else foreach (var t in ItemHolders)
                if (prefab.GetComponentInChildren(t, true) != null) { h = Holds.Items; break; }
            Holding[hash] = h;
            return h;
        }

        // One object of a handover: its step, counted, and the move if it is taken.
        static void HandOne(ZDO z, Vector2s zone, long target, long server, HandoverCounter count)
        {
            long owner = z.GetOwner();
            var pos = z.GetPosition();
            bool candidate = z.Persistent && owner != 0 && owner != target && owner != server;
            var holds = candidate ? HoldingOf(z) : Holds.Nothing;
            var step = HandoverPlan.Step(
                z.Persistent,
                ZNetScene.InActiveArea(pos, zone),
                owner, target, server,
                owner != 0 && ZNet.instance.GetPeer(owner) != null,
                HandoverPlan.InUse(z.GetLong(ZDOVars.s_user, 0L), z.GetInt(ZDOVars.s_inUse), z.GetBool(ZDOVars.s_attachJointHash)),
                holds == Holds.ItemDrop,
                holds == Holds.Items || !HandoverPlan.RoomToBump(z.DataRevision));
            if (step == HandoverStep.Take && !count.Room()) return;
            var zz = ZoneSystem.GetZone(pos);
            if (step == HandoverStep.Take)
            {
                // Data revision first (see HandoverPlan.DataRevisionMargin),
                // then the owner, which bumps the owner revision and marks the
                // sector dirty: every peer in range gets the object again.
                z.DataRevision = HandoverPlan.BumpedDataRevision(z.DataRevision);
                z.SetOwner(target);
            }
            count.Add(step, owner, zz.x, zz.y);
        }

        // Hands the simulation of the target's area to the target: every saved
        // object in the area the game's own ownership pass covers for them
        // (the same scan as the sim block above) that another connected
        // player simulates now, and that nobody is using, gets the target as
        // owner (HandoverPlan has the rules and why). The game's pass then
        // leaves them with the target while the target stays near. Answers
        // counts only, never who the objects came from.
        public static object Handover(JObject a)
        {
            Commands.Net();
            var p = Commands.FindPlayer(Commands.Str(a, "player"));
            var man = ZDOMan.instance;
            if (man == null) throw new CommandError(503, "world not loaded yet");
            var synced = ZNet.instance.GetSyncedSimulationDistance();
            var near = new SimulationDistance(synced.NearSimulationDistance, 0, synced.IsClassic);
            var zone = ZoneSystem.GetZone(p.m_refPos);
            long target = p.m_uid, server = ZDOMan.GetSessionID();
            var count = new HandoverCounter();
            try
            {
                HandoverScratch.Clear();
                man.FindSectorObjects(zone, near, HandoverScratch);
                foreach (var z in HandoverScratch)
                {
                    // A player's own character is not saved, so Step skips it
                    // anyway; this keeps it out whatever a game update does.
                    if (z == null || z.m_uid == p.m_characterID) continue;
                    if (count.Capped) break;
                    // One object that throws (a half-loaded or odd prefab) is
                    // skipped and counted; the rest still move. A game update
                    // that broke a binding still turns the command off.
                    try { HandOne(z, zone, target, server, count); }
                    catch (Exception e) when (!(e is MissingMemberException || e is TypeLoadException || e is TypeInitializationException))
                    {
                        // One line per call, with the first failure: enough to
                        // find the cause without a line per object.
                        if (count.Failed == 0) SkaldBridgePlugin.Warn("sim handover: skipped an object that failed: " + e.GetType().Name + ": " + e.Message);
                        count.Failed++;
                    }
                }
            }
            finally
            {
                HandoverScratch.Clear();
                // Fresh numbers for the next player list, not the scan from before.
                simAt = -SimEveryS;
            }
            return Commands.Ok(new
            {
                player = p.m_playerName,
                objects = count.Objects,
                zones = count.Zones,
                fromPeers = count.FromPeers,
                already = count.Already,
                inUse = count.InUse,
                loose = count.Loose,
                kept = count.Kept,
                failed = count.Failed,
                capped = count.Capped,
            });
        }
    }
}
