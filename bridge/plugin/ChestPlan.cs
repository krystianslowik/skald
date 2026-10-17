using System;
using System.Collections.Generic;
using System.Linq;

namespace Skald.Bridge
{
    // One stack in a chest as the plan sees it. Key is what the game stacks
    // by (ChestPlan.Key): two stacks with the same key may merge.
    struct ChestSlot
    {
        public int X, Y;
        public string Key;
        public int Stack;
        public int MaxStack;
    }

    // A slot an add touched: how many went in and the stack it holds now.
    struct SlotChange
    {
        public int X, Y, Added, Stack;
    }

    // The game-independent half of POST /v1/containers/add, unit-tested in
    // bridge/tests. The inventory itself is read and written by the game's own
    // Inventory class (Chests.cs); this only decides whether an add fits and
    // checks that it did nothing but add.
    static class ChestPlan
    {
        public const int MaxAmount = 9999;

        // The game stacks items with the same shared name, quality and world
        // level (Inventory.FindFreeStackItem).
        public static string Key(string sharedName, int quality, int worldLevel) => sharedName + "|" + quality + "|" + worldLevel;

        // How many items with this key fit: the free space of the stacks that
        // hold it, plus a full stack for every empty slot of the grid. The
        // caller passes the grid the game uses, grown to fit every slot
        // (Rows); a slot outside it is still counted as used.
        public static int Room(int width, int height, IEnumerable<ChestSlot> slots, string key, int maxStack)
        {
            if (width <= 0 || height <= 0 || maxStack <= 0) return 0;
            var list = slots.ToList();
            long room = 0;
            foreach (var s in list)
                if (s.Key == key && s.Stack < s.MaxStack) room += s.MaxStack - s.Stack;
            var used = new HashSet<(int, int)>();
            foreach (var s in list)
                if (s.X >= 0 && s.Y >= 0 && s.X < width && s.Y < height) used.Add((s.X, s.Y));
            room += (long)(width * height - used.Count) * maxStack;
            return (int)Math.Min(room, int.MaxValue);
        }

        // Rows the grid needs to hold every slot. Container.UpdateRows grows a
        // chest to this on every load, so the game also fills those rows.
        public static int Rows(int height, IEnumerable<ChestSlot> slots) =>
            slots.Aggregate(height, (h, s) => Math.Max(h, s.Y + 1));

        // Compares a chest before and after an add, slot by slot. Returns the
        // slots that grew or appeared, or null when anything was taken away,
        // moved or swapped: an add must never do that.
        public static List<SlotChange> Changes(IEnumerable<ChestSlot> before, IEnumerable<ChestSlot> after)
        {
            var old = new Dictionary<(int, int), ChestSlot>();
            foreach (var s in before)
            {
                if (old.ContainsKey((s.X, s.Y))) return null;
                old[(s.X, s.Y)] = s;
            }
            var seen = new HashSet<(int, int)>();
            var changes = new List<SlotChange>();
            foreach (var s in after)
            {
                if (!seen.Add((s.X, s.Y))) return null;
                if (old.TryGetValue((s.X, s.Y), out var o))
                {
                    if (o.Key != s.Key || s.Stack < o.Stack) return null;
                    if (s.Stack > o.Stack) changes.Add(new SlotChange { X = s.X, Y = s.Y, Added = s.Stack - o.Stack, Stack = s.Stack });
                }
                else changes.Add(new SlotChange { X = s.X, Y = s.Y, Added = s.Stack, Stack = s.Stack });
            }
            if (old.Keys.Any(k => !seen.Contains(k))) return null;
            return changes.OrderBy(c => c.Y).ThenBy(c => c.X).ToList();
        }

        // The item count an "items" blob declares: an i32 inventory version,
        // then a u16 count (version 108 and later) or an i32 count (older).
        // -1 when the blob is too short to say.
        public static int DeclaredCount(byte[] blob)
        {
            if (blob == null || blob.Length == 0) return 0;
            if (blob.Length < 6) return -1;
            int version = BitConverter.ToInt32(blob, 0);
            if (version >= 108) return BitConverter.ToUInt16(blob, 4);
            return blob.Length < 8 ? -1 : BitConverter.ToInt32(blob, 4);
        }
    }
}
