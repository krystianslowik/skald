using System.Collections.Generic;
using Skald.Bridge;
using Xunit;

public class LinkPlanTests
{
    const float Frame = 0.02f;

    // Plays the game's keep-alive for one peer the way the hooks report it.
    // Each frame ZRpc.Update first handles every reply that has arrived
    // (Replied, one call each, all at the frame's time), then UpdatePing sends
    // a ping once its timer passes a second (Sent). Ping k's reply arrives
    // rttOf(k, sent) seconds after it went out, but never before the reply to
    // an earlier ping (the socket is ordered); `truth` gets each reply's real
    // round trip in ms. onFrame(now) runs after each frame. Returns the time
    // reached.
    static float Play(LinkTracker t, long id, float from, float seconds, System.Func<int, float, float> rttOf,
        System.Action<float> onFrame = null, List<(float at, int ms)> truth = null)
    {
        float now = from, pingTimer = 0f, latest = 0f;
        int k = 0;
        var replies = new Queue<(float at, float sent)>();
        t.Seen(id, from, true);
        for (float end = from + seconds; now < end - Frame / 2;)
        {
            now += Frame;
            while (replies.Count > 0 && replies.Peek().at <= now)
            {
                var r = replies.Dequeue();
                t.Replied(id, now);
                truth?.Add((now, (int)System.Math.Round((now - r.sent) * 1000f)));
            }
            pingTimer += Frame;
            if (pingTimer > 1f)
            {
                pingTimer = 0f;
                t.Sent(id, now);
                float at = now + rttOf(k++, now);
                if (at < latest) at = latest;
                latest = at;
                replies.Enqueue((at, now));
            }
            onFrame?.Invoke(now);
        }
        return now;
    }

    static float Play(LinkTracker t, long id, float from, float seconds, float rtt) =>
        Play(t, id, from, seconds, (k, sent) => rtt);

    // Within a frame or so of the expected round trip, in ms.
    static void Near(int expectMs, int? gotMs) => Assert.InRange(gotMs.Value, expectMs - 30, expectMs + 30);

    // The true round trips answered within the window, sorted.
    static List<int> Window(List<(float at, int ms)> truth, float now)
    {
        var ms = new List<int>();
        foreach (var x in truth) if (now - x.at <= LinkTracker.WindowS) ms.Add(x.ms);
        ms.Sort();
        return ms;
    }

    static int Median(List<(float at, int ms)> truth, float now)
    {
        var ms = Window(truth, now);
        return ms[ms.Count / 2];
    }

    [Fact]
    public void TimesTheKeepAliveRoundTripWithinAFrame()
    {
        // About what a crossplay player showed live: 150 ms.
        var t = new LinkTracker();
        float now = Play(t, 1, 0f, 14f, 0.15f);
        var s = t.Snapshot(1, now);
        Assert.False(s.Unsure);
        Near(150, s.RttMs);
        Near(150, s.RttMaxMs);
        // A reply about every second: the gap stays near the ping interval.
        Assert.InRange(s.ReplyGapMaxS, 0.9f, 1.2f);
    }

    [Fact]
    public void NoReplyYetIsUnsure()
    {
        // Joined 0.5 s ago: the first ping has not even gone out.
        var t = new LinkTracker();
        float now = Play(t, 1, 0f, 0.5f, 0.15f);
        var s = t.Snapshot(1, now);
        Assert.True(s.Unsure);
        Assert.Null(s.RttMs);
        Assert.InRange(s.ReplyGapMaxS, 0.45f, 0.55f);
    }

    [Theory]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(8)]
    public void SeveralRepliesInOneFrameAreEachPaired(int n)
    {
        // On crossplay several replies can reach the game in one frame. Here
        // the replies to pings 10 .. 10+n-2 are held back until the reply to
        // the next one is in, and all n are handled in one frame.
        var t = new LinkTracker();
        float release = 0f, burstAt = -1f, first = 0f, period = 0f;
        var truth = new List<(float at, int ms)>();
        bool checkedBurst = false;
        float now = Play(t, 1, 0f, 40f, (k, sent) =>
        {
            // The harness's ping period (a whole number of frames over 1 s).
            if (k == 0) first = sent;
            if (k == 1) period = sent - first;
            if (k == 10) burstAt = release = sent + (n - 1) * period + 0.1f;
            return k >= 10 && k < 10 + n - 1 ? release - sent : 0.1f;
        }, now =>
        {
            // Right after the burst, every reply in it is paired with its own
            // ping: the median and the worst are what the window really saw.
            // The frame that handled the burst: the first at or after its release.
            if (checkedBurst || burstAt < 0f || now < burstAt) return;
            checkedBurst = true;
            // All n replies were handled in that one frame.
            Assert.Equal(n, truth.FindAll(x => x.at == now).Count);
            var b = t.Snapshot(1, now);
            Assert.False(b.Unsure);
            Assert.Equal(Median(truth, now), b.RttMs);
            Assert.Equal(Window(truth, now)[^1], b.RttMaxMs);
            Assert.Equal(truth.Count, t.RepliesSeen(1));
        }, truth);
        Assert.True(checkedBurst);
        // Once the burst has left the window, only the 100 ms link is left.
        var s = t.Snapshot(1, now);
        Near(100, s.RttMs);
        Near(100, s.RttMaxMs);
        Assert.Equal(0, t.InFlight(1));
    }

    [Fact]
    public void TheBurstThatBrokeTheOldInferenceReadsExact()
    {
        // The 0.6/0.7 tracker inferred replies from "time since last ping"
        // dropping. On a 0.8 s link whose ping 10 is late and lands in the
        // same frame as the fast (0.1 s) reply to ping 11, with no stall
        // before them, it saw one reply, kept a ping that never drained, and
        // read 1110 ms from then on (unsure for good once jitter made it
        // fall). Live on crossplay: unsure for some players all session.
        var t = new LinkTracker();
        var truth = new List<(float at, int ms)>();
        float now = Play(t, 1, 0f, 40f, (k, sent) => k == 10 ? 1.2f : k >= 11 ? 0.1f : 0.8f, truth: truth);
        // The replies to pings 10 and 11 were handled in one frame.
        Assert.Equal(truth[10].at, truth[11].at);
        Assert.True(truth[10].at - truth[9].at < 1.5f, "no stall before them");
        var s = t.Snapshot(1, now);
        Assert.False(s.Unsure);
        Near(100, s.RttMs);
        Near(100, s.RttMaxMs);
        Assert.Equal(0, t.InFlight(1));
    }

    [Theory]
    [InlineData(0.15f, 1.6f)]
    [InlineData(0.1f, 2.1f)]
    [InlineData(2.1f, 0.1f)]
    [InlineData(1.5f, 0.3f)]
    [InlineData(0.15f, 3.15f)]
    public void ARoundTripThatStepsByMoreThanASecondIsReadExactly(float before, float after)
    {
        // A step down by more than the second between pings bunches replies
        // in the ordered socket; a step up leaves several pings in flight.
        // Either way every frame's reading is the median of the true round
        // trips in the window.
        var t = new LinkTracker();
        var truth = new List<(float at, int ms)>();
        int checkedFrames = 0;
        float now = Play(t, 1, 0f, 60f, (k, sent) => sent < 20f ? before : after, now =>
        {
            var s = t.Snapshot(1, now);
            if (truth.Count == 0 || now - truth[truth.Count - 1].at > LinkTracker.WindowS)
            {
                Assert.True(s.Unsure);
                return;
            }
            checkedFrames++;
            Assert.False(s.Unsure);
            Assert.Equal(Median(truth, now), s.RttMs);
        }, truth);
        Assert.True(checkedFrames > 2000);
        Near((int)(after * 1000), t.Snapshot(1, now).RttMs);
    }

    [Theory]
    [InlineData(3)]
    [InlineData(11)]
    [InlineData(23)]
    public void AJitteryLinkIsReadExactly(int seed)
    {
        // Round trips anywhere from 0.1 to 1.8 s: replies bunch and spread
        // all the time, and the reading still matches the truth every frame.
        var rnd = new System.Random(seed);
        var t = new LinkTracker();
        var truth = new List<(float at, int ms)>();
        Play(t, 1, 0f, 120f, (k, sent) => 0.1f + (float)rnd.NextDouble() * 1.7f, now =>
        {
            if (now < 15f) return;
            var s = t.Snapshot(1, now);
            Assert.Equal(Median(truth, now), s.RttMs);
        }, truth);
    }

    [Fact]
    public void AStallThenRecoveryShowsAsAGapAndAgesOut()
    {
        // 150 ms; the replies to the pings sent from 10 s to 16 s all come at
        // 16.15 s, then the link is fine again.
        var t = new LinkTracker();
        bool sawStall = false;
        float now = Play(t, 1, 0f, 30f, (k, sent) => sent >= 10f && sent < 16f ? 16.15f - sent : 0.15f, now =>
        {
            if (sawStall || now < 17f) return;
            sawStall = true;
            var x = t.Snapshot(1, now);
            Assert.InRange(x.ReplyGapMaxS, 6.0f, 7.2f);
            // The pings held up really took that long: the worst shows it.
            Assert.InRange(x.RttMaxMs.Value, 5800, 6200);
            Assert.Equal(0, t.InFlight(1));
        });
        Assert.True(sawStall);
        // A window later only the healthy link is left.
        var s = t.Snapshot(1, now);
        Near(150, s.RttMs);
        Near(150, s.RttMaxMs);
        Assert.InRange(s.ReplyGapMaxS, 0.9f, 1.2f);
    }

    [Fact]
    public void AStallInProgressClimbs()
    {
        // No reply for 6 s: the wait climbs, and with no reply in the window
        // the round trip is unknown rather than stale.
        var t = new LinkTracker();
        t.Seen(1, 0f, true);
        t.Sent(1, 1f);
        t.Replied(1, 1.05f);
        float now = 1.05f;
        for (int i = 1; i <= 6; i++) t.Sent(1, now + i - 0.05f);
        now += 6f;
        var s = t.Snapshot(1, now);
        Assert.InRange(s.ReplyGapMaxS, 5.99f, 6.01f);
        Assert.Equal(6, t.InFlight(1));
        s = t.Snapshot(1, now + LinkTracker.WindowS);
        Assert.True(s.Unsure);
        Assert.Null(s.RttMs);
    }

    [Fact]
    public void PeersAreCountedApartAndOneJoiningMidFlightIsExact()
    {
        // Peer 1 has a slow link with two pings in flight when peer 2 joins;
        // their replies interleave.
        var t = new LinkTracker();
        t.Seen(1, 0f, true);
        t.Sent(1, 1f);
        t.Sent(1, 2f);
        t.Seen(2, 2.5f, true);
        t.Replied(1, 3.1f);   // ping at 1 s: 2.1 s
        t.Sent(1, 3.1f);
        t.Sent(2, 3.6f);
        t.Replied(2, 3.75f);  // 150 ms
        t.Replied(1, 4.1f);   // ping at 2 s: 2.1 s
        Assert.Equal(2100, t.Snapshot(1, 4.2f).RttMs);
        Assert.Equal(150, t.Snapshot(2, 4.2f).RttMs);
        Assert.Equal(1, t.InFlight(1));
        // Its first gap counts from when it was first seen.
        Assert.InRange(t.Snapshot(2, 3.8f).ReplyGapMaxS, 1.24f, 1.26f);
    }

    [Fact]
    public void APeerSeenLateOnlyHasGaps()
    {
        // First seen with pings possibly already in flight: its replies
        // cannot be paired, so no round trip, but the gaps are right.
        var t = new LinkTracker();
        t.Seen(3, 10f, false);
        for (int i = 1; i <= 5; i++)
        {
            t.Sent(3, 10f + i);
            t.Replied(3, 10.2f + i);
        }
        var s = t.Snapshot(3, 15.3f);
        Assert.True(s.Unsure);
        Assert.Null(s.RttMs);
        Assert.InRange(s.ReplyGapMaxS, 1.19f, 1.21f);
        Assert.Equal(5, t.RepliesSeen(3));
    }

    [Fact]
    public void AReplyWithNoPingInFlightStopsThePairing()
    {
        // A ping went unseen: from here every pairing could be off by one, so
        // the round trip stays unknown for that peer instead of wrong.
        var t = new LinkTracker();
        t.Seen(4, 0f, true);
        t.Sent(4, 1f);
        t.Replied(4, 1.1f);
        t.Replied(4, 1.6f);
        t.Sent(4, 2f);
        t.Replied(4, 2.1f);
        var s = t.Snapshot(4, 2.2f);
        Assert.True(s.Unsure);
        Assert.Null(s.RttMs);
        // The gaps still count every reply: 1.1 s from joining to the first.
        Assert.InRange(s.ReplyGapMaxS, 1.09f, 1.11f);
        Assert.Equal(3, t.RepliesSeen(4));
    }

    [Fact]
    public void MorePingsInFlightThanTheGameAllowsStopsThePairing()
    {
        var t = new LinkTracker();
        t.Seen(5, 0f, true);
        for (int i = 1; i <= 70; i++) t.Sent(5, i);
        t.Replied(5, 70.5f);
        Assert.True(t.Snapshot(5, 70.5f).Unsure);
        Assert.Equal(0, t.InFlight(5));
    }

    [Fact]
    public void WithoutTheHooksOnlyTheGapIsKnown()
    {
        // The game's "time since last ping", read once a frame: a reply every
        // second.
        var t = new LinkTracker();
        float now = 0f, wait = 0f;
        for (int i = 0; i < 300; i++)
        {
            now += Frame;
            wait = (i % 50 == 0) ? Frame : wait + Frame;
            t.Waited(7, now, wait);
        }
        var s = t.Snapshot(7, now);
        Assert.True(s.Unsure);
        Assert.Null(s.RttMs);
        Assert.Null(s.RttMaxMs);
        Assert.InRange(s.ReplyGapMaxS, 0.9f, 1.1f);
        Assert.Equal(5, t.RepliesSeen(7));
    }

    [Fact]
    public void FallingBackToTheGameWaitDropsTheHookedRoundTrip()
    {
        // The hooks turned off mid-session: what they timed is not shown as
        // current any more.
        var t = new LinkTracker();
        float now = Play(t, 1, 0f, 5f, 0.15f);
        Assert.False(t.Snapshot(1, now).Unsure);
        t.Waited(1, now + Frame, 0.5f);
        var s = t.Snapshot(1, now + Frame);
        Assert.True(s.Unsure);
        Assert.Null(s.RttMs);
    }

    [Fact]
    public void HooksThatDoNotSeeTheGameRepliesAreCaught()
    {
        // The game keeps showing a reply within the last second, but the hook
        // reports none: after a while the hooks count as not firing.
        var t = new LinkTracker();
        t.Seen(1, 0f, true);
        bool silent = false;
        float at = -1f;
        for (float now = Frame; now < 30f && !silent; now += Frame)
        {
            if (t.Silent(1, now, now % 1f)) { silent = true; at = now; }
        }
        Assert.True(silent);
        Assert.InRange(at, 13f, 16f);
    }

    [Fact]
    public void ALongFrameAloneIsNotTakenForSilentHooks()
    {
        // A 5 s frame: the game's wait moves by its capped frame time only,
        // so the clocks part by seconds until the next reply, which the hook
        // does report.
        var t = new LinkTracker();
        float now = Play(t, 1, 0f, 5f, 0.15f);
        float gameWait = 0.5f;
        Assert.False(t.Silent(1, now + 5f, gameWait + 0.333f));
        Assert.False(t.Silent(1, now + 6f, gameWait + 0.4f));
        t.Replied(1, now + 6.2f);
        for (float x = now + 6.2f; x < now + 30f; x += 0.5f) Assert.False(t.Silent(1, x, x - (now + 6.2f) < 1f ? x - (now + 6.2f) : 2f));
    }

    [Fact]
    public void AFastLinkReadsLow()
    {
        var t = new LinkTracker();
        float now = Play(t, 1, 0f, 5f, 0.03f);
        Near(30, t.Snapshot(1, now).RttMs);
    }

    [Fact]
    public void ARoundTripLongerThanThePingIntervalIsStillTimed()
    {
        // Replies come about once a second, so the gap looks healthy; only
        // pairing each reply with its own ping shows the 1.2 s round trip.
        var t = new LinkTracker();
        float now = Play(t, 1, 0f, 16f, 1.2f);
        var s = t.Snapshot(1, now);
        Near(1200, s.RttMs);
        Assert.InRange(s.ReplyGapMaxS, 0.9f, 1.2f);
    }

    [Fact]
    public void UnknownAndDepartedPeersHaveNoSample()
    {
        var t = new LinkTracker();
        Assert.Null(t.Snapshot(5, 0f));
        float now = Play(t, 5, 0f, 2f, 0.1f);
        Play(t, 6, 0f, 2f, 0.1f);
        t.Keep(new HashSet<long> { 6 });
        Assert.Null(t.Snapshot(5, now));
        Assert.NotNull(t.Snapshot(6, now));
        Assert.Equal(1, t.Count);
    }

    [Fact]
    public void CountsWhatThePeerOwnsAndInHowManyZones()
    {
        var c = new SimCounter(42);
        c.Add(42, 0, 0);
        c.Add(42, 0, 0);
        c.Add(42, 1, 0);
        c.Add(7, 1, 0);   // another player's
        c.Add(0, 2, 2);   // nobody's: the server keeps it
        var s = c.Result();
        Assert.Equal(3, s.Owned);
        Assert.Equal(5, s.Nearby);
        Assert.Equal(2, s.Zones);
        var none = new SimCounter(9).Result();
        Assert.Equal(0, none.Owned);
        Assert.Equal(0, none.Zones);
    }
}
