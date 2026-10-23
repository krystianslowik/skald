using Skald.Bridge;
using Xunit;

public class HandoverPlanTests
{
    // Peer uids as the game hands them out (fixtures only).
    const long Ragnar = 1001, Freya = 2002, Server = 9009;

    static HandoverStep Step(bool persistent = true, bool inArea = true, long owner = Freya, bool connected = true, bool inUse = false) =>
        HandoverPlan.Step(persistent, inArea, owner, Ragnar, Server, connected, inUse);

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
