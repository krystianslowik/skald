using System;
using System.Collections.Generic;
using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.CompilerServices;
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
        // Peers by object, not uid: a peer is watched from the frame it joins
        // the game's list, before its uid is known (see LinkTracker.Start).
        static readonly Dictionary<ZNetPeer, long> Ids = new Dictionary<ZNetPeer, long>();
        static long nextId;
        static bool tickOff, pingTimerOff, simBroken;
        static readonly HashSet<string> QueueOff = new HashSet<string>(), QualityOff = new HashSet<string>();
        static float prunedAt;

        static void Off(string what, Exception e) =>
            SkaldBridgePlugin.Warn(what + " off: " + e.GetType().Name + ": " + e.Message);

        static bool IsBindingError(Exception e) => e is MissingMemberException || e is TypeLoadException;

        // ---- the per-frame keep-alive watch (Plugin.Update) ----------------

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
                var p = peers[i];
                if (p == null || p.m_rpc == null) continue;
                if (!Ids.TryGetValue(p, out long id)) Ids[p] = id = ++nextId;
                Tracker.Observe(id, now, p.m_rpc.GetTimeSinceLastPing(), PingTimer(p.m_rpc));
            }
            if (now - prunedAt > LinkTracker.WindowS && Ids.Count > 0)
            {
                prunedAt = now;
                var here = new HashSet<ZNetPeer>(peers);
                var live = new HashSet<long>();
                foreach (var kv in new List<KeyValuePair<ZNetPeer, long>>(Ids))
                {
                    if (here.Contains(kv.Key)) live.Add(kv.Value);
                    else Ids.Remove(kv.Key);
                }
                Tracker.Keep(live);
            }
        }

        // ZRpc.m_pingTimer is private: read through a getter compiled once,
        // so the per-frame read neither reflects nor boxes. Without it the
        // reply gap still works; only the round trip goes blank.
        static Func<ZRpc, float> readPingTimer;

        static float? PingTimer(ZRpc rpc)
        {
            if (pingTimerOff) return null;
            try
            {
                if (readPingTimer == null)
                {
                    var f = typeof(ZRpc).GetField("m_pingTimer", BindingFlags.NonPublic | BindingFlags.Instance);
                    if (f == null || f.FieldType != typeof(float))
                    {
                        pingTimerOff = true;
                        SkaldBridgePlugin.Warn("link probe: ZRpc.m_pingTimer not found, round trip off");
                        return null;
                    }
                    readPingTimer = Getter(f);
                }
                return readPingTimer(rpc);
            }
            catch (Exception e)
            {
                pingTimerOff = true;
                Off("link round trip", e);
                return null;
            }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        static Func<ZRpc, float> Getter(FieldInfo f)
        {
            try
            {
                var rpc = Expression.Parameter(typeof(ZRpc), "rpc");
                return Expression.Lambda<Func<ZRpc, float>>(Expression.Field(rpc, f), rpc).Compile();
            }
            catch (Exception e)
            {
                // A runtime that cannot compile: plain reflection, a box a frame.
                SkaldBridgePlugin.Warn("link probe: compiled getter unavailable (" + e.GetType().Name + "), reading by reflection");
                return r => (float)f.GetValue(r);
            }
        }

        // ---- per player, for GET /v1/players -------------------------------

        // The link as the server sees it; null when nothing could be read.
        internal static object Of(ZNetPeer p)
        {
            try
            {
                // With the probe off the tracker holds stale readings: none then.
                var s = !tickOff && Ids.TryGetValue(p, out long id) ? Tracker.Snapshot(id, Time.realtimeSinceStartup) : null;
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
                    // After a stall or while a slow round trip falls the
                    // keep-alive cannot be paired: no ping rather than a wrong one.
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
        // Whether a prefab is an item on the ground, by prefab hash.
        static readonly Dictionary<int, bool> ItemDrops = new Dictionary<int, bool>();

        static bool IsItemDrop(ZDO z)
        {
            int hash = z.GetPrefab();
            if (ItemDrops.TryGetValue(hash, out bool known)) return known;
            var prefab = ZNetScene.instance != null ? ZNetScene.instance.GetPrefab(hash) : null;
            bool drop = prefab != null && prefab.GetComponent<ItemDrop>() != null;
            // An unknown hash is not kept: the scene may not have every prefab yet.
            if (prefab != null) ItemDrops[hash] = drop;
            return drop;
        }

        // One object of a handover: its step, counted, and the move if it is taken.
        static void HandOne(ZDO z, Vector2s zone, long target, long server, HandoverCounter count)
        {
            long owner = z.GetOwner();
            var pos = z.GetPosition();
            bool candidate = z.Persistent && owner != 0 && owner != target && owner != server;
            var step = HandoverPlan.Step(
                z.Persistent,
                ZNetScene.InActiveArea(pos, zone),
                owner, target, server,
                owner != 0 && ZNet.instance.GetPeer(owner) != null,
                HandoverPlan.InUse(z.GetLong(ZDOVars.s_user, 0L), z.GetInt(ZDOVars.s_inUse), z.GetBool(ZDOVars.s_attachJointHash)),
                candidate && IsItemDrop(z));
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
                failed = count.Failed,
                capped = count.Capped,
            });
        }
    }
}
