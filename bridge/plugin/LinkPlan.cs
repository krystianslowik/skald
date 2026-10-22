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
        // The round trip is not known right now (after a stall no reply has
        // explained yet, or while a slow one falls): RttMs and RttMaxMs are null.
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
            // The last round trip paired, in ms (-1 before the first).
            public int LastRttMs = -1;
            // The median round trip just before the last stall, in ms (-1: none).
            public int PreStallMs = -1;
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
                    Sample(p, now, Ms(at - p.Maybe[0]));
                    p.Maybe.RemoveAt(0);
                    if (p.Maybe.Count == 0)
                    {
                        // The burst drained: aligned again, and its falling
                        // samples are no sign of a recovery.
                        p.Unsure = false;
                        p.LastRttMs = -1;
                    }
                }
                else if (pingTimer.HasValue && p.Maybe.Count > 0 && !stall) Settle(p, now, at);
                else if (pingTimer.HasValue && p.Sent.Count > 0)
                {
                    float rtt = at - p.Sent.Dequeue();
                    if (rtt >= 0f && rtt < 30f)
                    {
                        Sample(p, now, Ms(rtt));
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

        // A round trip over a second falling, without a stall: the link may be
        // recovering. When it falls by more than the second between pings,
        // replies bunch up behind the slow ones in the ordered socket and
        // some never show, which leaves the pairing whole seconds high. What
        // shows of the fall is only its remainder after whole ping intervals
        // (1.5 to 0.3 s reads as 1.5 to 1.3 s), so any clear fall counts.
        // The ping is left out until clear evidence, a drained burst or a
        // pairing that starts over realigns it (a stall alone does not);
        // over a second it was poor anyway.
        const int RecoverAboveMs = 1000, RecoverFallMs = 100;

        static void Sample(Peer p, float now, int ms)
        {
            if (p.LastRttMs >= RecoverAboveMs && p.LastRttMs - ms >= RecoverFallMs) p.Unsure = true;
            p.LastRttMs = ms;
            p.Rtts.Enqueue((now, ms));
        }

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
            p.PreStallMs = -1;
            if (p.Rtts.Count > 1)
            {
                // Without the sample the stall itself just added.
                var ms = new List<int>();
                foreach (var x in p.Rtts) ms.Add(x.ms);
                ms.RemoveAt(ms.Count - 1);
                ms.Sort();
                p.PreStallMs = ms[ms.Count / 2];
            }
            int min = int.MaxValue;
            foreach (var r in p.Rtts) min = Math.Min(min, r.ms);
            float before = p.Rtts.Count == 0 ? float.MaxValue : repliedAt - min * 0.8f / 1000f;
            while (p.Sent.Count > 0 && p.Sent.Peek() < before) p.Maybe.Add(p.Sent.Dequeue());
            if (p.Maybe.Count == 0) return;
            p.StallRtt = rtt;
            p.Unsure = true;
        }

        // The first reply after pings were set aside decides, on clear
        // evidence only:
        // - a step up: pairing it with the oldest set-aside ping gives about
        //   the round trip that ended the stall (and the listed one does not),
        //   so the set-aside pings are still in flight;
        // - a burst: those pings would have round trips well under the one
        //   that ended the stall (they went out later and came back with it),
        //   and the listed ping gives about the round trip from before it, so
        //   they were answered in the burst.
        // Anything else (a jittery link) keeps them, which can only read high,
        // never low, and leaves the round trip unsure until clear evidence or
        // a pairing that starts over.
        static void Settle(Peer p, float now, float at)
        {
            float kept = at - p.Maybe[0];
            float dropped = p.Sent.Count > 0 ? at - p.Sent.Peek() : -1f;
            float r = p.StallRtt;
            bool keptFits = r >= 0f && Math.Abs(kept - r) < SameRttS;
            bool droppedFits = dropped >= 0f && r >= 0f && Math.Abs(dropped - r) < SameRttS;
            bool burst = r >= 0f && dropped >= 0f && kept <= r - 0.5f && p.PreStallMs >= 0 && Math.Abs(Ms(dropped) - p.PreStallMs) <= 300;
            if (burst && !keptFits)
            {
                p.Sent.Dequeue();
                Sample(p, now, Ms(dropped));
                p.Unsure = false;
                p.Maybe.Clear();
                return;
            }
            // Keep the set-aside pings: this reply answers the oldest.
            var all = new List<float>(p.Maybe);
            all.AddRange(p.Sent);
            p.Sent.Clear();
            for (int i = 1; i < all.Count; i++) p.Sent.Enqueue(all[i]);
            p.Maybe.Clear();
            Sample(p, now, Ms(kept));
            p.Unsure = !(keptFits && !droppedFits);
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
