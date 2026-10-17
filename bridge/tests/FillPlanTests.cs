using System;
using Skald.Bridge;
using Xunit;

public class FillPlanTests
{
    // Stations as Extras.Stations reads them from the prefabs (fixtures only).
    static readonly Station Kiln = new Station { Prefab = "charcoal_kiln", Inputs = new[] { "Wood", "RoundLog" }, Outputs = new[] { "Coal", "Coal" }, MaxOre = 25 };
    static readonly Station Smelter = new Station { Prefab = "smelter", Fuel = "Coal", Inputs = new[] { "CopperOre", "TinOre", "IronScrap" }, Outputs = new[] { "Copper", "Tin", "Iron" }, MaxOre = 10, MaxFuel = 20 };
    static readonly Station Furnace = new Station { Prefab = "blastfurnace", Fuel = "Coal", Inputs = new[] { "BlackMetalScrap" }, Outputs = new[] { "BlackMetal" }, MaxOre = 10, MaxFuel = 20 };
    static readonly Station Windmill = new Station { Prefab = "windmill", Inputs = new[] { "Barley" }, Outputs = new[] { "BarleyFlour" }, MaxOre = 50 };
    static readonly Station Fermenter = new Station { Prefab = "fermenter", Inputs = new[] { "MeadBaseHealthMinor", "MeadBaseTasty" }, Outputs = new[] { "MeadHealthMinor", "MeadTasty" }, MaxOre = 1 };
    static readonly Station Refinery = new Station { Prefab = "eitrrefinery", Fuel = "Sap", Inputs = new[] { "Softtissue" }, Outputs = new[] { "Eitr" }, MaxOre = 20, MaxFuel = 20 };

    [Fact]
    public void ClassifiesByWhatTheStationsDoNotByName()
    {
        var kinds = FillPlan.Classify(new[] { Kiln, Smelter, Furnace, Windmill, Refinery });
        Assert.Equal(StationKind.Kiln, kinds["charcoal_kiln"]);
        Assert.Equal(StationKind.Smelter, kinds["smelter"]);
        Assert.Equal(StationKind.Smelter, kinds["blastfurnace"]);
        Assert.Equal(StationKind.Other, kinds["windmill"]);
        Assert.Equal(StationKind.Other, kinds["eitrrefinery"]);
    }

    [Fact]
    public void WithoutAKilnNothingIsASmelter()
    {
        var kinds = FillPlan.Classify(new[] { Smelter, Windmill });
        Assert.Equal(StationKind.Other, kinds["smelter"]);
        Assert.Equal(StationKind.Other, kinds["windmill"]);
    }

    [Fact]
    public void KilnsGetWoodUpToCapacity()
    {
        var s = FillPlan.Kiln(Kiln, 5);
        Assert.Equal("Wood", s.Ore);
        Assert.Equal(20, s.OreCount);
        Assert.Equal(0, s.FuelCount);
        Assert.Equal(FillSkip.Full, FillPlan.Kiln(Kiln, 25).Skip);
    }

    [Fact]
    public void SmeltersGetTheChosenOreNotTheFirstOne()
    {
        var s = FillPlan.Smelter(Smelter, FillWhat.Both, "IronScrap", null, 3, 4.5f);
        Assert.Equal(FillSkip.None, s.Skip);
        Assert.Equal("IronScrap", s.Ore);
        Assert.Equal(7, s.OreCount);
        Assert.Equal(15, s.FuelCount);
    }

    [Fact]
    public void AStationThatRejectsTheOreGetsNothing()
    {
        var s = FillPlan.Smelter(Furnace, FillWhat.Both, "CopperOre", null, 0, 0f);
        Assert.Equal(FillSkip.Rejects, s.Skip);
        Assert.Null(s.Ore);
        Assert.Equal(0, s.FuelCount);
    }

    [Fact]
    public void OreOnlyAndCoalOnly()
    {
        var ore = FillPlan.Smelter(Smelter, FillWhat.Ore, "TinOre", null, 0, 0f);
        Assert.Equal("TinOre", ore.Ore);
        Assert.Equal(10, ore.OreCount);
        Assert.Equal(0, ore.FuelCount);
        var coal = FillPlan.Smelter(Furnace, FillWhat.Fuel, null, "BlackMetalScrap", 2, 19f);
        Assert.Null(coal.Ore);
        Assert.Equal(0, coal.OreCount);
        Assert.Equal(1, coal.FuelCount);
        Assert.Equal(FillSkip.Full, FillPlan.Smelter(Furnace, FillWhat.Fuel, null, null, 0, 20f).Skip);
    }

    [Fact]
    public void KeepCurrentTopsUpTheQueuedOreAndGivesEmptyStationsOnlyCoal()
    {
        var s = FillPlan.Smelter(Smelter, FillWhat.Ore, FillPlan.KeepCurrent, "IronScrap", 4, 0f);
        Assert.Equal("IronScrap", s.Ore);
        Assert.Equal(6, s.OreCount);
        Assert.Equal(FillSkip.Empty, FillPlan.Smelter(Smelter, FillWhat.Ore, FillPlan.KeepCurrent, "", 0, 0f).Skip);
        var empty = FillPlan.Smelter(Smelter, FillWhat.Both, FillPlan.KeepCurrent, null, 0, 5f);
        Assert.Equal(FillSkip.None, empty.Skip);
        Assert.Null(empty.Ore);
        Assert.Equal(0, empty.OreCount);
        Assert.Equal(15, empty.FuelCount);
    }

    [Fact]
    public void ParsesWhat()
    {
        Assert.Equal(FillWhat.Ore, FillPlan.ParseWhat("ore"));
        Assert.Equal(FillWhat.Both, FillPlan.ParseWhat("both"));
        Assert.Equal(FillWhat.Fuel, FillPlan.ParseWhat("coal"));
        Assert.Equal(FillWhat.Both, FillPlan.ParseWhat(null));
        Assert.Throws<ArgumentException>(() => FillPlan.ParseWhat("everything"));
    }

    [Fact]
    public void FermentersTakeOneBaseOnlyWhenEmpty()
    {
        var s = FillPlan.Fermenter(Fermenter, "MeadBaseTasty", "");
        Assert.Equal(FillSkip.None, s.Skip);
        Assert.Equal("MeadBaseTasty", s.Ore);
        Assert.Equal(1, s.OreCount);
        Assert.Equal(0, s.FuelCount);
        // Fermenting, or mead waiting to be tapped: left alone.
        Assert.Equal(FillSkip.Full, FillPlan.Fermenter(Fermenter, "MeadBaseTasty", "MeadBaseHealthMinor").Skip);
        Assert.Equal(FillSkip.Rejects, FillPlan.Fermenter(Fermenter, "CopperOre", null).Skip);
        Assert.Equal(FillSkip.Rejects, FillPlan.Fermenter(Fermenter, null, null).Skip);
    }

    [Fact]
    public void FermentersAreNeverKilnsOrSmelters()
    {
        var kinds = FillPlan.Classify(new[] { Kiln, Smelter, Fermenter });
        Assert.Equal(StationKind.Other, kinds["fermenter"]);
    }
}
