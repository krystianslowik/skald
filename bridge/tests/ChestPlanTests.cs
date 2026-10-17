using System;
using System.Collections.Generic;
using System.IO;
using Skald.Bridge;
using Xunit;

public class ChestPlanTests
{
    static readonly string Wood = ChestPlan.Key("$item_wood", 1, 0);
    static readonly string Iron = ChestPlan.Key("$item_iron", 1, 0);
    static readonly string Sword = ChestPlan.Key("$item_sword_iron", 2, 0);

    static ChestSlot S(int x, int y, string key, int stack, int max) => new ChestSlot { X = x, Y = y, Key = key, Stack = stack, MaxStack = max };

    [Fact]
    public void AnEmptyChestTakesAFullStackPerSlot()
    {
        Assert.Equal(5 * 2 * 50, ChestPlan.Room(5, 2, new ChestSlot[0], Wood, 50));
    }

    [Fact]
    public void RoomCountsFreeSpaceInMatchingStacksAndEmptySlots()
    {
        var slots = new[] { S(0, 0, Wood, 30, 50), S(1, 0, Wood, 50, 50), S(2, 0, Iron, 10, 30) };
        // 20 on top of the first wood stack, 7 empty slots of 50.
        Assert.Equal(20 + 7 * 50, ChestPlan.Room(5, 2, slots, Wood, 50));
        // Iron: 20 free in its stack, 7 empty slots of 30.
        Assert.Equal(20 + 7 * 30, ChestPlan.Room(5, 2, slots, Iron, 30));
    }

    [Fact]
    public void AStackOfAnotherQualityOrWorldLevelIsNotToppedUp()
    {
        var slots = new[] { S(0, 0, ChestPlan.Key("$item_wood", 1, 2), 10, 50) };
        Assert.Equal(1 * 50, ChestPlan.Room(2, 1, slots, Wood, 50));
    }

    [Fact]
    public void AFullChestHasNoRoomUnlessAStackHasSpace()
    {
        var full = new[] { S(0, 0, Iron, 30, 30), S(1, 0, Sword, 1, 1) };
        Assert.Equal(0, ChestPlan.Room(2, 1, full, Wood, 50));
        Assert.Equal(0, ChestPlan.Room(2, 1, full, Iron, 30));
        var space = new[] { S(0, 0, Iron, 25, 30), S(1, 0, Sword, 1, 1) };
        Assert.Equal(5, ChestPlan.Room(2, 1, space, Iron, 30));
    }

    [Fact]
    public void AChestGrownByAnOlderSaveFillsItsGrownRows()
    {
        // A 2x1 chest with an item on a third row: the game grows it to three
        // rows on load (Container.UpdateRows), and the plugin does the same.
        var slots = new[] { S(0, 2, Iron, 5, 30) };
        Assert.Equal(3, ChestPlan.Rows(1, slots));
        Assert.Equal(4, ChestPlan.Rows(4, slots));
        Assert.Equal(25 + 5 * 30, ChestPlan.Room(2, ChestPlan.Rows(1, slots), slots, Iron, 30));
        // Without growing, the out-of-grid slot is used and adds no room.
        Assert.Equal(25 + 2 * 30, ChestPlan.Room(2, 1, slots, Iron, 30));
    }

    [Fact]
    public void BadSizesHaveNoRoom()
    {
        Assert.Equal(0, ChestPlan.Room(0, 2, new ChestSlot[0], Wood, 50));
        Assert.Equal(0, ChestPlan.Room(5, 2, new ChestSlot[0], Wood, 0));
    }

    [Fact]
    public void ChangesListToppedUpAndNewSlots()
    {
        var before = new[] { S(0, 0, Wood, 30, 50), S(2, 0, Iron, 10, 30) };
        var after = new[] { S(0, 0, Wood, 50, 50), S(2, 0, Iron, 10, 30), S(1, 0, Wood, 50, 50), S(3, 1, Wood, 5, 50) };
        var c = ChestPlan.Changes(before, after);
        Assert.NotNull(c);
        Assert.Equal(3, c.Count);
        Assert.Equal((0, 0, 20, 50), (c[0].X, c[0].Y, c[0].Added, c[0].Stack));
        Assert.Equal((1, 0, 50, 50), (c[1].X, c[1].Y, c[1].Added, c[1].Stack));
        Assert.Equal((3, 1, 5, 5), (c[2].X, c[2].Y, c[2].Added, c[2].Stack));
    }

    [Fact]
    public void ChangesRefuseAnythingButAdding()
    {
        var before = new[] { S(0, 0, Wood, 30, 50), S(1, 0, Iron, 10, 30) };
        // A stack shrank.
        Assert.Null(ChestPlan.Changes(before, new[] { S(0, 0, Wood, 20, 50), S(1, 0, Iron, 10, 30) }));
        // A stack vanished.
        Assert.Null(ChestPlan.Changes(before, new[] { S(0, 0, Wood, 30, 50) }));
        // A slot now holds something else.
        Assert.Null(ChestPlan.Changes(before, new[] { S(0, 0, Iron, 30, 30), S(1, 0, Iron, 10, 30) }));
        // Two stacks in one slot.
        Assert.Null(ChestPlan.Changes(before, new[] { S(0, 0, Wood, 30, 50), S(1, 0, Iron, 10, 30), S(1, 0, Wood, 5, 50) }));
        // Nothing changed is not an error, just no change.
        Assert.Empty(ChestPlan.Changes(before, before));
    }

    static byte[] Blob(int version, int count)
    {
        var ms = new MemoryStream();
        var w = new BinaryWriter(ms);
        w.Write(version);
        if (version >= 108) w.Write((ushort)count); else w.Write(count);
        w.Write(new byte[] { 1, 2, 3 });
        return ms.ToArray();
    }

    [Fact]
    public void DeclaredCountReadsBothLayouts()
    {
        Assert.Equal(0, ChestPlan.DeclaredCount(null));
        Assert.Equal(0, ChestPlan.DeclaredCount(new byte[0]));
        Assert.Equal(7, ChestPlan.DeclaredCount(Blob(109, 7)));
        Assert.Equal(300, ChestPlan.DeclaredCount(Blob(106, 300)));
        Assert.Equal(-1, ChestPlan.DeclaredCount(new byte[] { 109, 0, 0 }));
    }
}
