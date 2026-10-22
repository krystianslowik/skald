using System.Collections.Generic;
using Skald.Bridge;
using Xunit;

public class LinkPlanTests
{
    const float Frame = 0.02f;

    // Plays the game's keep-alive for one peer: a ping every second (the timer
    // restarts when it goes out), each reply `rtt` seconds after its ping,
    // observed once a frame the way Link.Tick does. Replies due inside
    // [stallFrom, stallTo) all arrive at stallTo; onePerFrame hands them to
    // the game one a frame instead of all in one. Returns the time reached.
    static float Play(LinkTracker t, long uid, float from, float seconds, float rtt,
        float stallFrom = -1f, float stallTo = -1f, bool onePerFrame = false)
    {
        float now = from, pingTimer = 0f, wait = 0f;
        // A new ZRpc: both timers at 0, the first ping after a second.
        var replies = new Queue<float>();
        for (float end = from + seconds; now < end; now += Frame)
        {
            // ZRpc.Update: replies are handled first, then the timers move on.
            while (replies.Count > 0 && replies.Peek() <= now + Frame)
            {
                replies.Dequeue();
                wait = 0f;
                if (onePerFrame) break;
            }
            pingTimer += Frame;
            wait += Frame;
            if (pingTimer > 1f)
            {
                pingTimer = 0f;
                float at = now + Frame + rtt;
                if (at >= stallFrom && at < stallTo) at = stallTo;
                replies.Enqueue(at);
            }
            t.Observe(uid, now + Frame, wait, pingTimer);
        }
        return now;
    }

    [Fact]
    public void TimesTheKeepAliveRoundTripWithinAFrame()
    {
        var t = new LinkTracker();
        // Past the window, so the join (first reply after 1 s plus the round trip) has aged out.
        float now = Play(t, 1, 0f, 14f, 0.24f);
        var s = t.Snapshot(1, now);
        Assert.NotNull(s.RttMs);
        Assert.InRange(s.RttMs.Value, 220, 270);
        Assert.InRange(s.RttMaxMs.Value, 220, 270);
        // A reply about every second: the gap stays near the ping interval.
        Assert.InRange(s.ReplyGapMaxS, 0.9f, 1.2f);
    }

    [Fact]
    public void APeerFirstSeenMidSessionIsPairedWithThePingsSinceItsLastReply()
    {
        var t = new LinkTracker();
        // Last reply 0.5 s ago, a ping went out 0.3 s ago and is in flight.
        t.Observe(3, 100f, 0.5f, 0.3f);
        // Its reply 0.25 s after it went out, plus the frame it lands in.
        t.Observe(3, 100.05f + Frame, Frame, 0.35f + Frame);
        Assert.InRange(t.Snapshot(3, 100.1f).RttMs.Value, 340, 380);
    }

    [Fact]
    public void AReplyWithNoPingLeftStartsThePairingOver()
    {
        var t = new LinkTracker();
        // First seen with the timers together: nothing in flight is expected,
        // so a reply now cannot be timed, and is only a gap.
        t.Observe(4, 10f, 0.4f, 0.4f);
        t.Observe(4, 10.02f, Frame, 0.42f);
        var s = t.Snapshot(4, 10.02f);
        Assert.Null(s.RttMs);
        Assert.InRange(s.ReplyGapMaxS, 0.39f, 0.41f);
    }

    [Fact]
    public void RepliesBatchedAfterAStallDoNotSkewLaterRoundTrips()
    {
        // 100 ms link, no replies from 5 s to 10 s, then all of them in one frame.
        var t = new LinkTracker();
        float now = Play(t, 1, 0f, 40f, 0.1f, stallFrom: 5f, stallTo: 10f);
        var s = t.Snapshot(1, now);
        Assert.InRange(s.RttMs.Value, 80, 140);
        Assert.InRange(s.RttMaxMs.Value, 80, 140);
    }

    [Fact]
    public void RepliesInConsecutiveFramesAreEachSeen()
    {
        // The same stall, its replies handed over one a frame.
        var t = new LinkTracker();
        float now = Play(t, 1, 0f, 40f, 0.1f, stallFrom: 5f, stallTo: 10f, onePerFrame: true);
        // One reply a second for 40 s, the first after the first second.
        Assert.InRange(t.RepliesSeen(1), 38, 40);
        var s = t.Snapshot(1, now);
        Assert.InRange(s.RttMs.Value, 80, 140);
        Assert.InRange(s.RttMaxMs.Value, 80, 140);
    }

    [Fact]
    public void RepliesInARowWithoutTheWaitDroppingStillCount()
    {
        var t = new LinkTracker();
        // Wait 0.02 after a reply, then another reply the next frame: the
        // wait reads 0.02 again, though without one it would be 0.04.
        t.Observe(2, 0f, 0.5f, 0.5f);
        t.Observe(2, 0.02f, 0.02f, 0.52f);
        t.Observe(2, 0.04f, 0.02f, 0.54f);
        t.Observe(2, 0.06f, 0.04f, 0.56f);
        Assert.Equal(2, t.RepliesSeen(2));
        Assert.InRange(t.Snapshot(2, 0.06f).ReplyGapMaxS, 0.49f, 0.51f);
    }

    // Like Play, with each ping's round trip from rttAt(send time) and the
    // socket's ordered delivery (a reply never overtakes an earlier one).
    // check(now, snapshot, true round trip of the pings answered lately) runs
    // every frame.
    static void PlaySteps(LinkTracker t, long uid, float seconds, System.Func<float, float> rttAt, System.Action<float, LinkSample, float> check)
    {
        float now = 0f, pingTimer = 0f, wait = 0f, lastTrue = rttAt(0f);
        var replies = new Queue<(float at, float rtt)>();
        float latest = 0f;
        for (; now < seconds; now += Frame)
        {
            while (replies.Count > 0 && replies.Peek().at <= now + Frame)
            {
                lastTrue = replies.Dequeue().rtt;
                wait = 0f;
            }
            pingTimer += Frame;
            wait += Frame;
            if (pingTimer > 1f)
            {
                pingTimer = 0f;
                float sent = now + Frame, at = sent + rttAt(sent);
                if (at < latest) at = latest;
                latest = at;
                replies.Enqueue((at, at - sent));
            }
            t.Observe(uid, now + Frame, wait, pingTimer);
            check(now + Frame, t.Snapshot(uid, now + Frame), lastTrue);
        }
    }

    [Theory]
    [InlineData(0.3f, 1.5f)]
    [InlineData(0.1f, 2.1f)]
    [InlineData(0.2f, 1.6f)]
    public void ARoundTripThatStepsUpIsNeverReadLow(float before, float after)
    {
        var t = new LinkTracker();
        LinkSample last = null;
        bool sawUnsure = false;
        PlaySteps(t, 1, 60f, sent => sent < 20f ? before : after, (now, s, truth) =>
        {
            last = s;
            if (s.Unsure)
            {
                // Between the reply that ends the wait and the next one: no number.
                sawUnsure = true;
                Assert.Null(s.RttMs);
                Assert.Null(s.RttMaxMs);
            }
            // Unsure (null) is fine; a number well under the round trip of the
            // pings it covers is not. Once the 10 s window holds only replies
            // to pings sent after the step, every sample must be the new one.
            if (now > 20f + after + LinkTracker.WindowS + 1f && s.RttMs.HasValue)
            {
                Assert.InRange(s.RttMs.Value, (int)(after * 1000) - 60, (int)(after * 1000) + 60);
                Assert.InRange(s.RttMaxMs.Value, (int)(after * 1000) - 60, (int)(after * 1000) + 60);
            }
            // Before that, never below the slower of what it has seen lately.
            if (now > 20f + after + 1f && s.RttMaxMs.HasValue) Assert.True(s.RttMaxMs.Value >= (int)(after * 1000) - 60, $"max {s.RttMaxMs} at {now}");
        });
        Assert.True(sawUnsure);
        // And it settles on the new round trip rather than staying unsure.
        Assert.False(last.Unsure);
        Assert.InRange(last.RttMs.Value, (int)(after * 1000) - 60, (int)(after * 1000) + 60);
    }

    [Fact]
    public void AFastLinkReadsLow()
    {
        var t = new LinkTracker();
        float now = Play(t, 1, 0f, 5f, 0.03f);
        Assert.InRange(t.Snapshot(1, now).RttMs.Value, 10, 60);
    }

    [Fact]
    public void AStallShowsAsALongReplyGapAndAgesOut()
    {
        var t = new LinkTracker();
        float now = Play(t, 1, 0f, 3f, 0.05f);
        // No reply for 6 s: the wait climbs, the round trip has nothing new.
        float wait = 0f;
        for (int i = 0; i < 300; i++)
        {
            wait += Frame;
            now += Frame;
            t.Observe(1, now, wait, (wait % 1f));
        }
        Assert.InRange(t.Snapshot(1, now).ReplyGapMaxS, 5.9f, 6.1f);
        // Replies again: the 6 s gap stays the worst for the window, then goes.
        now = Play(t, 1, now, 2f, 0.05f);
        Assert.InRange(t.Snapshot(1, now).ReplyGapMaxS, 5.9f, 6.1f);
        now = Play(t, 1, now, LinkTracker.WindowS + 1f, 0.05f);
        Assert.InRange(t.Snapshot(1, now).ReplyGapMaxS, 0.9f, 1.2f);
    }

    [Fact]
    public void WithoutThePingTimerOnlyTheGapIsKnown()
    {
        var t = new LinkTracker();
        float now = 0f, wait = 0f;
        for (int i = 0; i < 300; i++)
        {
            now += Frame;
            wait = (i % 50 == 0) ? Frame : wait + Frame;
            t.Observe(7, now, wait, null);
        }
        var s = t.Snapshot(7, now);
        Assert.Null(s.RttMs);
        Assert.Null(s.RttMaxMs);
        Assert.InRange(s.ReplyGapMaxS, 0.9f, 1.1f);
    }

    [Fact]
    public void ARoundTripLongerThanThePingIntervalIsStillTimed()
    {
        // Replies come about once a second, so the gap looks healthy; only
        // pairing each reply with its own ping shows the 1.2 s round trip.
        var t = new LinkTracker();
        float now = Play(t, 1, 0f, 16f, 1.2f);
        var s = t.Snapshot(1, now);
        Assert.InRange(s.RttMs.Value, 1150, 1260);
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
