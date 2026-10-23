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
        // Pings kept waiting for a reply; the game drops a peer after 30 s
        // without one, so more than this means pings went unseen.
        const int MaxInFlight = 40;

        sealed class Peer
        {
            // The last reply, or when the peer was first seen.
            public float LastReplyAt;
            // Pairing is off for good: a reply came with no ping left, or
            // more pings waited than the game allows, so some went unseen.
            public bool Unpaired;
            public float LastWait = -1f;
            public int Replies;
            public readonly Queue<float> Sent = new Queue<float>();
            public readonly Queue<(float t, int ms)> Rtts = new Queue<(float, int)>();
            public readonly Queue<(float t, float gap)> Gaps = new Queue<(float, float)>();
        }

        readonly Dictionary<long, Peer> peers = new Dictionary<long, Peer>();

        Peer Get(long id, float now)
        {
            if (!peers.TryGetValue(id, out var p)) peers[id] = p = new Peer { LastReplyAt = now };
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

        // A ping went out at t.
        public void Sent(long id, float t)
        {
            var p = Get(id, t);
            if (p.Unpaired) return;
            p.Sent.Enqueue(t);
            if (p.Sent.Count > MaxInFlight) Unpair(p);
        }

        // A reply was handled at t.
        public void Replied(long id, float t)
        {
            var p = Get(id, t);
            p.Replies++;
            p.Gaps.Enqueue((t, Math.Max(0f, t - p.LastReplyAt)));
            p.LastReplyAt = t;
            if (!p.Unpaired)
            {
                if (p.Sent.Count == 0) Unpair(p);
                else p.Rtts.Enqueue((t, Ms(t - p.Sent.Dequeue())));
            }
            Trim(p, t);
        }

        // Without the hooks: the game's own "time since the last reply"
        // (ZRpc.GetTimeSinceLastPing), read once a frame. A drop is a reply;
        // that gives the gaps but no round trip.
        public void Waited(long id, float now, float wait)
        {
            var p = Get(id, now);
            p.Unpaired = true;
            if (p.LastWait >= 0f && wait < p.LastWait)
            {
                p.Replies++;
                p.Gaps.Enqueue((now, p.LastWait));
            }
            p.LastWait = wait;
            p.LastReplyAt = now - wait;
            Trim(p, now);
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
            foreach (var g in p.Gaps) s.ReplyGapMaxS = Math.Max(s.ReplyGapMaxS, g.gap);
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

        // Pings still waiting for a reply.
        public int InFlight(long id) => peers.TryGetValue(id, out var p) ? p.Sent.Count : 0;

        static void Trim(Peer p, float now)
        {
            while (p.Rtts.Count > 0 && now - p.Rtts.Peek().t > WindowS) p.Rtts.Dequeue();
            while (p.Gaps.Count > 0 && now - p.Gaps.Peek().t > WindowS) p.Gaps.Dequeue();
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
