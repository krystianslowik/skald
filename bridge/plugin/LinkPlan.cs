using System;
using System.Collections.Generic;

namespace Skald.Bridge
{
    // One player's link as the server sees it over the last WindowS seconds.
    sealed class LinkSample
    {
        // Median and worst round trip of the game's own keep-alive (ZRpc
        // ping), in ms; null while no reply in the window was timed.
        public int? RttMs, RttMaxMs;
        // The longest wait for a keep-alive reply, now or within the window,
        // in seconds. About 1 on a healthy link (one ping a second); a stalled
        // link climbs towards the game's 30 s timeout.
        public float ReplyGapMaxS;
        // The round trip is not known: no reply was timed in the window (none
        // yet, or a stall), or the keep-alive is not counted at all (the
        // game patches are off, or the peer's pings were not all seen).
        public bool Unsure;
    }

    // What one player simulates: the objects in their active area (the zones
    // the game hands out by distance) and how many of those they own.
    sealed class SimLoad
    {
        public int Owned, Nearby, Zones;
    }

    // The game-independent half of the link probe (Link.cs), unit-tested in
    // bridge/tests.
    //
    // The game pings every peer once a second (ZRpc.UpdatePing) and the peer
    // answers each ping (ZRpc.ReceivePing). Link.cs hooks both and reports
    // each ping going out (Sent) and each reply being handled (Replied), with
    // its time. The socket is reliable and ordered, so the n-th reply answers
    // the n-th ping: a reply is paired with the oldest ping still unanswered,
    // whatever the round trip and however many replies one frame handles.
    sealed class LinkTracker
    {
        public const float WindowS = 10f;
        // Pings kept waiting for a reply. The game drops a peer after 30 s
        // without one and pings once a second, so more than this means the
        // count is off.
        const int MaxInFlight = 64;
        // How long the game may show a reply the hooks did not report before
        // the hooks count as not firing (a long frame alone can open a gap
        // of a few seconds between the two clocks, until the next reply).
        const float SilentS = 10f;
        // Gaps kept per peer: only the largest matter, so a flood of replies
        // (a client sending stray ones) cannot grow the list.
        const int MaxGaps = 256;

        // Why a peer's pairing stopped (Sent/Replied return it once).
        public enum Lost { None, StrayReply, Overflow }

        sealed class Peer
        {
            // The last reply, or when the peer was first seen.
            public float LastReplyAt;
            // The last ping, or when the peer was first seen.
            public float LastSentAt;
            // Pairing is off for good: a reply came with no ping left, more
            // pings waited than the game allows, or the transport dropped
            // what was in flight (see Reset).
            public bool Unpaired;
            public float LastWait = -1f, SilentSince = -1f, PingSilentSince = -1f;
            public int Replies;
            public readonly Queue<float> Sent = new Queue<float>();
            public readonly Queue<(float t, int ms)> Rtts = new Queue<(float, int)>();
            // Gaps in arrival order, each larger than every later one: the
            // first is the window's largest (a later, larger gap makes the
            // earlier ones irrelevant to the maximum).
            public readonly List<(float t, float gap)> Gaps = new List<(float, float)>();
        }

        readonly Dictionary<long, Peer> peers = new Dictionary<long, Peer>();

        Peer Get(long id, float now)
        {
            if (!peers.TryGetValue(id, out var p)) peers[id] = p = new Peer { LastReplyAt = now, LastSentAt = now };
            return p;
        }

        // A peer the watch starts on. fromStart: no ping can have gone out to
        // it unseen (its ZRpc is new, or the hooks were in place before it
        // connected); otherwise its replies are only gaps, never round trips.
        public void Seen(long id, float now, bool fromStart)
        {
            if (peers.ContainsKey(id)) return;
            Get(id, now).Unpaired = !fromStart;
        }

        // A ping went out at t. Overflow when this one stopped the pairing.
        public Lost Sent(long id, float t)
        {
            var p = Get(id, t);
            p.LastSentAt = t;
            if (p.Unpaired) return Lost.None;
            p.Sent.Enqueue(t);
            if (p.Sent.Count <= MaxInFlight) return Lost.None;
            Unpair(p);
            return Lost.Overflow;
        }

        // A reply was handled at t. StrayReply when it stopped the pairing.
        public Lost Replied(long id, float t)
        {
            var p = Get(id, t);
            p.Replies++;
            AddGap(p, t, t - p.LastReplyAt);
            p.LastReplyAt = t;
            var lost = Lost.None;
            if (!p.Unpaired)
            {
                if (p.Sent.Count > 0) p.Rtts.Enqueue((t, Ms(t - p.Sent.Dequeue())));
                else
                {
                    Unpair(p);
                    lost = Lost.StrayReply;
                }
            }
            Trim(p, t);
            return lost;
        }

        // The transport dropped what it had in flight on a live connection
        // (ZPlayFabSocket.ResetAll after the remote restarted its session):
        // the pings sent before never get a reply, and which later reply
        // answers which ping cannot be proven, so the pairing stops.
        public void Reset(long id)
        {
            if (peers.TryGetValue(id, out var p) && !p.Unpaired) Unpair(p);
        }

        // Without the hooks: the game's own "time since the last reply"
        // (ZRpc.GetTimeSinceLastPing), read once a frame. A drop is a reply;
        // that gives the gaps but no round trip.
        public void Waited(long id, float now, float wait)
        {
            var p = Get(id, now);
            if (!p.Unpaired) Unpair(p);
            if (p.LastWait >= 0f && wait < p.LastWait)
            {
                p.Replies++;
                AddGap(p, now, p.LastWait);
            }
            p.LastWait = wait;
            p.LastReplyAt = now - wait;
            Trim(p, now);
        }

        // Cross-checks the hooks against the game's own "time since the last
        // reply" (ZRpc.GetTimeSinceLastPing), once a frame. True once the game
        // has kept showing a recent reply the hooks never reported for
        // SilentS: the reply hook does not fire (inlined, or the game moved
        // the code), so the reply times are not to be trusted.
        public bool Silent(long id, float now, float gameWait)
        {
            if (!peers.TryGetValue(id, out var p)) return false;
            if (gameWait < 1.5f && now - p.LastReplyAt > gameWait + 3f)
            {
                if (p.SilentSince < 0f) p.SilentSince = now;
                return now - p.SilentSince > SilentS;
            }
            p.SilentSince = -1f;
            return false;
        }

        // The other half of the cross-check: the game pings every peer once a
        // second, whatever the link does, so no ping reported for more than
        // 3 s, for SilentS on end, means the ping hook does not fire.
        public bool PingSilent(long id, float now)
        {
            if (!peers.TryGetValue(id, out var p)) return false;
            if (now - p.LastSentAt > 3f)
            {
                if (p.PingSilentSince < 0f) p.PingSilentSince = now;
                return now - p.PingSilentSince > SilentS;
            }
            p.PingSilentSince = -1f;
            return false;
        }

        static void AddGap(Peer p, float t, float gap)
        {
            // Replies handled in one frame add nothing to the maximum.
            if (gap <= 0f) return;
            var g = p.Gaps;
            while (g.Count > 0 && g[g.Count - 1].gap <= gap) g.RemoveAt(g.Count - 1);
            g.Add((t, gap));
            // Strictly falling gaps within the window: drop the smallest.
            if (g.Count > MaxGaps) g.RemoveAt(g.Count - 2);
        }

        static void Unpair(Peer p)
        {
            p.Unpaired = true;
            p.Sent.Clear();
            p.Rtts.Clear();
        }

        static int Ms(float s) => (int)Math.Round(s * 1000f);

        public LinkSample Snapshot(long id, float now)
        {
            if (!peers.TryGetValue(id, out var p)) return null;
            Trim(p, now);
            var s = new LinkSample { ReplyGapMaxS = Math.Max(0f, now - p.LastReplyAt) };
            if (p.Gaps.Count > 0) s.ReplyGapMaxS = Math.Max(s.ReplyGapMaxS, p.Gaps[0].gap);
            if (p.Rtts.Count > 0)
            {
                var ms = new List<int>(p.Rtts.Count);
                foreach (var r in p.Rtts) ms.Add(r.ms);
                ms.Sort();
                s.RttMs = ms[ms.Count / 2];
                s.RttMaxMs = ms[ms.Count - 1];
            }
            s.Unsure = !s.RttMs.HasValue;
            return s;
        }

        // Forgets peers that left.
        public void Keep(ICollection<long> live)
        {
            var gone = new List<long>();
            foreach (var id in peers.Keys) if (!live.Contains(id)) gone.Add(id);
            foreach (var id in gone) peers.Remove(id);
        }

        public int Count => peers.Count;

        // Replies seen from one peer since it was first observed.
        public int RepliesSeen(long id) => peers.TryGetValue(id, out var p) ? p.Replies : 0;

        // Gaps kept for one peer (bounded by MaxGaps).
        public int GapsKept(long id) => peers.TryGetValue(id, out var p) ? p.Gaps.Count : 0;

        // Pings still waiting for a reply.
        public int InFlight(long id) => peers.TryGetValue(id, out var p) ? p.Sent.Count : 0;

        static void Trim(Peer p, float now)
        {
            while (p.Rtts.Count > 0 && now - p.Rtts.Peek().t > WindowS) p.Rtts.Dequeue();
            int old = 0;
            while (old < p.Gaps.Count && now - p.Gaps[old].t > WindowS) old++;
            if (old > 0) p.Gaps.RemoveRange(0, old);
        }
    }

    // Counts what one peer simulates among the objects in their area.
    sealed class SimCounter
    {
        readonly long uid;
        readonly HashSet<(int, int)> zones = new HashSet<(int, int)>();
        int owned, nearby;

        public SimCounter(long uid) { this.uid = uid; }

        // One object in the area: its owner and its zone.
        public void Add(long owner, int zoneX, int zoneY)
        {
            nearby++;
            if (owner != uid) return;
            owned++;
            zones.Add((zoneX, zoneY));
        }

        public SimLoad Result() => new SimLoad { Owned = owned, Nearby = nearby, Zones = zones.Count };
    }
}
