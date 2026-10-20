using Skald.Bridge;
using Xunit;

public class RefuelPlanTests
{
    // Fires as Extras.Refuel reads them from the prefabs' Fireplace (fixtures only).
    static readonly Fire Torch = new Fire { Prefab = "piece_groundtorch_wood", Fuel = "Resin", MaxFuel = 4 };
    static readonly Fire Campfire = new Fire { Prefab = "fire_pit", Fuel = "Wood", MaxFuel = 10 };
    static readonly Fire Eternal = new Fire { Prefab = "eternal_flame", Fuel = "Wood", MaxFuel = 10, Infinite = true };
    static readonly Fire Locked = new Fire { Prefab = "location_torch", Fuel = "Resin", MaxFuel = 4, CanRefill = false };
    static readonly Fire NoFuel = new Fire { Prefab = "lantern_without_fuel", MaxFuel = 4 };

    [Fact]
    public void OnlyFiresAPlayerCouldFeedAreTaken()
    {
        Assert.True(RefuelPlan.Takes(Torch));
        Assert.True(RefuelPlan.Takes(Campfire));
        // Burns forever, refuses fuel, or has no fuel item: not a fire to refuel.
        Assert.False(RefuelPlan.Takes(Eternal));
        Assert.False(RefuelPlan.Takes(Locked));
        Assert.False(RefuelPlan.Takes(NoFuel));
        Assert.False(RefuelPlan.Takes(new Fire { Prefab = "zero", Fuel = "Wood", MaxFuel = 0 }));
        Assert.False(RefuelPlan.Takes(null));
    }

    [Fact]
    public void FullIsJudgedLikeTheGameDoes()
    {
        // The game refuses fuel once the rounded-up level reaches the maximum.
        Assert.True(RefuelPlan.Full(Campfire, 10f));
        Assert.True(RefuelPlan.Full(Campfire, 9.3f));
        Assert.False(RefuelPlan.Full(Campfire, 9f));
        Assert.False(RefuelPlan.Full(Campfire, 0f));
        Assert.False(RefuelPlan.Full(Torch, 3f));
        Assert.True(RefuelPlan.Full(Torch, 3.01f));
    }

    [Fact]
    public void ARefuelSetsTheFiresOwnMaximum()
    {
        Assert.Equal(10f, RefuelPlan.Target(Campfire));
        Assert.Equal(4f, RefuelPlan.Target(Torch));
    }
}
