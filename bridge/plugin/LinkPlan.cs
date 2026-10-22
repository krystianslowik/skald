using System;
using System.Collections.Generic;

namespace Skald.Bridge
{
    // One player's link as the server sees it over the last WindowS seconds.
    sealed class LinkSample
    {
        // Median and worst round trip of the game's own keep-alive (ZRpc
        // ping), in ms; null before the first reply was timed.
        public int? RttMs, RttMaxMs;
        // The longest wait for a keep-alive reply, now or within the window,
        // in seconds. About 1 on a healthy link (one ping a second); a stalled
        // link climbs towards the game's 30 s timeout.
        public float ReplyGapMaxS;
        // The round trip is not known right now (just after a stall that a
        // later reply has not explained yet): RttMs and RttMaxMs are null.
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
    // The game pings every peer once a second (ZRpc.UpdatePing: a timer that
    // restarts when the ping goes out) and resets "time since last ping"
    // when the reply comes back. Watching both once a frame sees each ping go
    // out (the timer drops) and each reply come in (the wait drops). The
    // socket is reliable and ordered, so a reply answers the oldest ping
    // still unanswered: pairing them in order times every round trip, also
    // one longer than the second between pings.
    sealed class LinkTracker
    {
        public const float WindowS = 10f;
        // How close (s) the round trip from a set-aside ping must come to the
        // one that ended the stall to count as a step up.
        const float SameRttS = 0.25f;
        // Replies this close behind each other are one burst.
        const float BurstS = 0.1f;
        // Pings kept waiting for a reply; the game gives up after 30 s.
        const int MaxInFlight = 32;
        // A wait for a reply this long may end with several replies at once.
        const float StallS = 1.5f;

        sealed class Peer
        {
            public float LastWait = -1f, LastPingTimer = -1f;
            public int Replies;
            // The round trip is not known right now (see Settle).
            public bool Unsure;
            // Pings a stall-ending reply took as answered, kept until the next
            // reply shows whether they were, and that reply's round trip.
            public readonly List<float> Maybe = new List<float>();
            public float StallRtt;
            public readonly Queue<float> Sent = new Queue<float>();
            public readonly Queue<(float t, int ms)> Rtts = new Queue<(float, int)>();
            public readonly Queue<(float t, float gap)> Gaps = new Queue<(float, float)>();
        }

        readonly Dictionary<long, Peer> peers = new Dictionary<long, Peer>();

        // One frame's reading of a peer: wait = seconds since the last reply,
        // pingTimer = seconds since the last ping went out (null when the
        // game's private timer cannot be read: then only gaps are known).
        public void Observe(long uid, float now, float wait, float? pingTimer)
        {
            if (!peers.TryGetValue(uid, out var p))
            {
                peers[uid] = p = new Peer();
                Start(p, now, wait, pingTimer);
            }
            // ZRpc.Update handles replies before it sends the next ping, so a
            // frame with both pairs the reply with an earlier ping.
            if (Replied(p, wait, pingTimer))
            {
                p.Replies++;
                p.Gaps.Enqueue((now, p.LastWait));
                // Handled during the frame the wait restarted in: half of it.
                float at = now - wait / 2f;
                bool stall = p.LastWait > StallS;
                if (pingTimer.HasValue && p.Maybe.Count > 0 && p.LastWait < BurstS)
                {
                    // The rest of a burst, a frame or two behind the reply that
                    // ended the stall: it answers a ping set aside. Pings go out
                    // a second apart, so a step up never answers this fast.
                    p.Rtts.Enqueue((now, Ms(at - p.Maybe[0])));
                    p.Maybe.RemoveAt(0);
                    if (p.Maybe.Count == 0) p.Unsure = false;
                }
                else if (pingTimer.HasValue && p.Maybe.Count > 0 && !stall) Settle(p, now, at);
                else if (pingTimer.HasValue && p.Sent.Count > 0)
                {
                    float rtt = at - p.Sent.Dequeue();
                    if (rtt >= 0f && rtt < 30f)
                    {
                        p.Rtts.Enqueue((now, Ms(rtt)));
                        if (stall) DropAnswered(p, at, rtt);
                    }
                    else
                    {
                        // Out of step: start over with the next ping, which
                        // also settles any doubt about the pairing.
                        p.Sent.Clear();
                        p.Maybe.Clear();
                        p.Unsure = false;
                    }
                }
                else if (stall) DropAnswered(p, at, -1f);
            }
            if (pingTimer.HasValue)
            {
                if (p.LastPingTimer >= 0 && pingTimer.Value < p.LastPingTimer)
                {
                    p.Sent.Enqueue(now - pingTimer.Value);
                    while (p.Sent.Count > MaxInFlight) p.Sent.Dequeue();
                }
                p.LastPingTimer = pingTimer.Value;
            }
            p.LastWait = wait;
            Trim(p, now);
        }

        // The first look at a peer. Link.Tick watches every peer from the
        // frame it joins the game's peer list, when its ZRpc is new: both
        // timers started together and no ping has gone out until the first
        // second is over, so nothing is in flight. Seen later than that (the
        // wait and the ping timer apart), the pings sent since the last reply
        // are taken as the ones in flight; a guess that is off shows as a
        // reply with no ping left, which starts the pairing over.
        static void Start(Peer p, float now, float wait, float? pingTimer)
        {
            if (!pingTimer.HasValue || Math.Abs(wait - pingTimer.Value) < 0.1f) return;
            var sent = new List<float>();
            for (float ago = pingTimer.Value; ago < wait; ago += 1f) sent.Add(now - ago);
            sent.Reverse();
            foreach (var t in sent) p.Sent.Enqueue(t);
        }

        static int Ms(float s) => (int)Math.Round(s * 1000f);

        // A reply ending a stall often comes with the replies to the pings
        // sent during it, in one frame, and only one shows: left listed, every
        // round trip after it would read seconds high. A ping sent longer ago
        // than the shortest round trip seen is taken as answered with it; a
        // later one is still on its way (a long first wait after joining on a
        // slow link is the same case). But a round trip that has just gone up
        // for good looks the same at this point, and then the pings set aside
        // are still on their way: they are kept in Maybe, and the round trip
        // is unsure until the next reply settles it.
        static void DropAnswered(Peer p, float repliedAt, float rtt)
        {
            p.Maybe.Clear();
            int min = int.MaxValue;
            foreach (var r in p.Rtts) min = Math.Min(min, r.ms);
            float before = p.Rtts.Count == 0 ? float.MaxValue : repliedAt - min * 0.8f / 1000f;
            while (p.Sent.Count > 0 && p.Sent.Peek() < before) p.Maybe.Add(p.Sent.Dequeue());
            if (p.Maybe.Count == 0) return;
            p.StallRtt = rtt;
            p.Unsure = true;
        }

        // The first reply after pings were set aside. If they were answered
        // in the stall, it answers the oldest ping still listed. If the round
        // trip went up instead, it answers the oldest one set aside, and
        // pairing them gives about the round trip that ended the stall. Only
        // a clear match decides; otherwise the round trip stays unsure until
        // the pairing starts over.
        static void Settle(Peer p, float now, float at)
        {
            float kept = at - p.Maybe[0];
            float dropped = p.Sent.Count > 0 ? at - p.Sent.Peek() : -1f;
            bool keptFits = p.StallRtt >= 0f && Math.Abs(kept - p.StallRtt) < SameRttS;
            bool droppedFits = dropped >= 0f && p.StallRtt >= 0f && Math.Abs(dropped - p.StallRtt) < SameRttS;
            if (keptFits && !droppedFits)
            {
                // A step up: the set-aside pings are still in flight.
                var all = new List<float>(p.Maybe);
                all.AddRange(p.Sent);
                p.Sent.Clear();
                for (int i = 1; i < all.Count; i++) p.Sent.Enqueue(all[i]);
                p.Rtts.Enqueue((now, Ms(kept)));
                p.Unsure = false;
            }
            else if (!keptFits && dropped >= 0f)
            {
                // Answered in the stall, as taken.
                p.Sent.Dequeue();
                p.Rtts.Enqueue((now, Ms(dropped)));
                p.Unsure = false;
            }
            else if (p.Sent.Count > 0) p.Sent.Dequeue();
            p.Maybe.Clear();
        }

        // Whether a reply came in since the last frame. The wait restarts
        // when one is handled, so it drops; but a reply in each of two
        // frames in a row can leave it no lower than the frame before. The
        // ping timer grows by the same frame time as the wait, so without a
        // reply the wait must have grown by exactly that much.
        static bool Replied(Peer p, float wait, float? pingTimer)
        {
            if (p.LastWait < 0) return false;
            if (wait < p.LastWait) return true;
            if (!pingTimer.HasValue || p.LastPingTimer < 0 || pingTimer.Value < p.LastPingTimer) return false;
            float dt = pingTimer.Value - p.LastPingTimer;
            return wait < p.LastWait + dt - 1e-4f;
        }

        public LinkSample Snapshot(long uid, float now)
        {
            if (!peers.TryGetValue(uid, out var p)) return null;
            Trim(p, now);
            var s = new LinkSample { ReplyGapMaxS = Math.Max(0f, p.LastWait) };
            foreach (var g in p.Gaps) s.ReplyGapMaxS = Math.Max(s.ReplyGapMaxS, g.gap);
            s.Unsure = p.Unsure;
            if (p.Rtts.Count > 0 && !p.Unsure)
            {
                var ms = new List<int>(p.Rtts.Count);
                foreach (var r in p.Rtts) ms.Add(r.ms);
                ms.Sort();
                s.RttMs = ms[ms.Count / 2];
                s.RttMaxMs = ms[ms.Count - 1];
            }
            return s;
        }

        // Forgets peers that left.
        public void Keep(ICollection<long> live)
        {
            var gone = new List<long>();
            foreach (var uid in peers.Keys) if (!live.Contains(uid)) gone.Add(uid);
            foreach (var uid in gone) peers.Remove(uid);
        }

        public int Count => peers.Count;

        // Replies seen from one peer since it was first observed.
        public int RepliesSeen(long uid) => peers.TryGetValue(uid, out var p) ? p.Replies : 0;

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
