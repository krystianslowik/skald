using Skald.Bridge;
using Xunit;

public class HandoverPlanTests
{
    // Peer uids as the game hands them out (fixtures only).
    const long Ragnar = 1001, Freya = 2002, Server = 9009;

    static HandoverStep Step(bool persistent = true, bool inArea = true, long owner = Freya, bool connected = true, bool inUse = false, bool itemDrop = false) =>
        HandoverPlan.Step(persistent, inArea, owner, Ragnar, Server, connected, inUse, itemDrop);

    [Fact]
    public void TakesWhatAnotherConnectedPlayerSimulates()
    {
        Assert.Equal(HandoverStep.Take, Step());
    }

    [Fact]
    public void LeavesWhatTheGamesOwnPassWouldUndoOrHandOutByItself()
    {
        // Not saved with the world: player characters, projectiles. The game's
        // pass never moves them, and they die with their owner's connection.
        Assert.Equal(HandoverStep.Transient, Step(persistent: false));
        // Outside the target's active area the target's own pass lets go of it.
        Assert.Equal(HandoverStep.OutOfArea, Step(inArea: false));
        Assert.Equal(HandoverStep.Unowned, Step(owner: 0));
        Assert.Equal(HandoverStep.Already, Step(owner: Ragnar));
        Assert.Equal(HandoverStep.NotAPlayer, Step(owner: Server));
        Assert.Equal(HandoverStep.NotAPlayer, Step(connected: false));
    }

    [Fact]
    public void LeavesWhatSomeoneIsUsing()
    {
        Assert.Equal(HandoverStep.InUse, Step(inUse: true));
        // A transient object in use is still just transient.
        Assert.Equal(HandoverStep.Transient, Step(persistent: false, inUse: true));
        // The target's own ship or mount stays theirs, counted as already.
        Assert.Equal(HandoverStep.Already, Step(owner: Ragnar, inUse: true));
    }

    [Fact]
    public void LeavesItemsOnTheGround()
    {
        // A pickup in flight asks the owner first: moving the owner then could
        // duplicate or lose the item.
        Assert.Equal(HandoverStep.Loose, Step(itemDrop: true));
        Assert.Equal(HandoverStep.Loose, Step(itemDrop: true, inUse: true));
        // Rules that come first still win.
        Assert.Equal(HandoverStep.Already, Step(owner: Ragnar, itemDrop: true));
        Assert.Equal(HandoverStep.Unowned, Step(owner: 0, itemDrop: true));
        var c = new HandoverCounter();
        c.Add(HandoverStep.Loose, Freya, 1, 1);
        Assert.Equal(1, c.Loose);
        Assert.Equal(0, c.Objects);
        Assert.Equal(0, c.FromPeers);
    }

    [Fact]
    public void MovesTheDataRevisionPastTheOldOwnersLateUpdates()
    {
        // A late update from the old owner carries at most a few revisions
        // more than the server had: after the bump it is no longer newer.
        uint server = 4000;
        uint bumped = HandoverPlan.BumpedDataRevision(server);
        Assert.Equal(server + HandoverPlan.DataRevisionMargin, bumped);
        Assert.False(server + 50 > bumped);
        // Saturates instead of wrapping to an old-looking revision.
        Assert.Equal(uint.MaxValue, HandoverPlan.BumpedDataRevision(uint.MaxValue - 10));
        Assert.Equal(uint.MaxValue, HandoverPlan.BumpedDataRevision(uint.MaxValue));
        Assert.Equal(HandoverPlan.DataRevisionMargin, HandoverPlan.BumpedDataRevision(0));
    }

    [Fact]
    public void InUseIsReadFromTheSavedValues()
    {
        Assert.False(HandoverPlan.InUse(0, 0, false));
        // A ship's helm or a saddle names its user.
        Assert.True(HandoverPlan.InUse(Freya, 0, false));
        // An open chest.
        Assert.True(HandoverPlan.InUse(0, 1, false));
        // A cart in harness.
        Assert.True(HandoverPlan.InUse(0, 0, true));
    }

    [Fact]
    public void CountsObjectsZonesAndPlayersMovedFrom()
    {
        var c = new HandoverCounter();
        c.Add(HandoverStep.Take, Freya, 3, 4);
        c.Add(HandoverStep.Take, Freya, 3, 4);
        c.Add(HandoverStep.Take, 3003, 3, 5);
        c.Add(HandoverStep.Already, Ragnar, 3, 6);
        c.Add(HandoverStep.InUse, Freya, 3, 7);
        c.Add(HandoverStep.Transient, Freya, 9, 9);
        c.Add(HandoverStep.Unowned, 0, 9, 9);
        Assert.Equal(3, c.Objects);
        // Only zones something moved in.
        Assert.Equal(2, c.Zones);
        Assert.Equal(2, c.FromPeers);
        Assert.Equal(1, c.Already);
        Assert.Equal(1, c.InUse);
        Assert.False(c.Capped);
    }

    [Fact]
    public void StopsAtTheCap()
    {
        var c = new HandoverCounter();
        int moved = 0;
        for (int i = 0; i < HandoverPlan.MaxObjects + 10; i++)
        {
            if (!c.Room()) break;
            c.Add(HandoverStep.Take, Freya, i % 7, 0);
            moved++;
        }
        Assert.Equal(HandoverPlan.MaxObjects, moved);
        Assert.Equal(HandoverPlan.MaxObjects, c.Objects);
        Assert.True(c.Capped);
        Assert.Equal(7, c.Zones);
    }
}
