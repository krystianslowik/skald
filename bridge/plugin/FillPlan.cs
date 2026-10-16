using System;
using System.Collections.Generic;
using System.Linq;

namespace Skald.Bridge
{
    // A station prefab as the game defines it, read at runtime from its
    // Smelter component (Extras.Stations): what it takes, what it makes, its
    // fuel and its capacity. No game data is kept in the plugin itself.
    sealed class Station
    {
        public string Prefab;
        // m_fuelItem, null when the station burns nothing.
        public string Fuel;
        // m_conversion: the inputs in the game's own order, and their outputs.
        public string[] Inputs = new string[0];
        public string[] Outputs = new string[0];
        public int MaxOre;
        public int MaxFuel;
    }

    enum StationKind { Other, Kiln, Smelter }

    enum FillWhat { Ore, Both, Fuel }

    // What to add to one station, or why it gets nothing.
    struct FillStep
    {
        public string Ore;
        public int OreCount;
        public int FuelCount;
        // "rejects" (does not take the chosen ore), "empty" (nothing to keep),
        // "full", or null.
        public string Skip;
    }

    // The game-independent half of the fill commands, unit-tested in
    // bridge/tests.
    static class FillPlan
    {
        public const string KeepCurrent = "current";

        // Kilns and smelters are told apart by what they do, not by name: a
        // smelter burns fuel that a kiln makes, a kiln burns nothing and makes
        // a smelter's fuel. Windmills, spinning wheels (no fuel, make nothing
        // anyone burns) and stations fuelled by something no kiln makes (eitr
        // refinery) are neither.
        public static Dictionary<string, StationKind> Classify(IEnumerable<Station> stations)
        {
            var list = stations.Where(s => s != null && !string.IsNullOrEmpty(s.Prefab)).ToList();
            var fuels = new HashSet<string>(list.Where(s => !string.IsNullOrEmpty(s.Fuel)).Select(s => s.Fuel));
            var kilns = list.Where(s => string.IsNullOrEmpty(s.Fuel) && s.Inputs.Length > 0 && s.Outputs.Any(fuels.Contains)).ToList();
            var made = new HashSet<string>(kilns.SelectMany(s => s.Outputs));
            var kinds = new Dictionary<string, StationKind>();
            foreach (var s in list)
            {
                var kind = StationKind.Other;
                if (kilns.Contains(s)) kind = StationKind.Kiln;
                else if (!string.IsNullOrEmpty(s.Fuel) && made.Contains(s.Fuel) && s.Inputs.Length > 0) kind = StationKind.Smelter;
                kinds[s.Prefab] = kind;
            }
            return kinds;
        }

        public static FillWhat ParseWhat(string what)
        {
            switch (what)
            {
                case null:
                case "both": return FillWhat.Both;
                case "ore": return FillWhat.Ore;
                case "coal": return FillWhat.Fuel;
                default: throw new ArgumentException("'what' must be ore, both or coal");
            }
        }

        // A kiln gets its first input (wood) up to capacity. It has no fuel.
        public static FillStep Kiln(Station s, int queued)
        {
            if (s.Inputs.Length == 0) return new FillStep { Skip = "rejects" };
            int n = Math.Max(0, s.MaxOre - queued);
            return n == 0 ? new FillStep { Skip = "full" } : new FillStep { Ore = s.Inputs[0], OreCount = n };
        }

        // A smelter gets the chosen ore (or the one at the head of its queue
        // for "current") and/or fuel, each up to capacity. A station that does
        // not take the ore gets nothing at all, not even fuel, so a blast
        // furnace is left alone when the admin picks copper.
        public static FillStep Smelter(Station s, FillWhat what, string ore, string queuedOre, int queued, float fuel)
        {
            var step = new FillStep();
            if (what != FillWhat.Fuel)
            {
                string pick = ore == KeepCurrent ? queuedOre : ore;
                if (ore == KeepCurrent && string.IsNullOrEmpty(pick)) return new FillStep { Skip = "empty" };
                if (string.IsNullOrEmpty(pick) || !s.Inputs.Contains(pick)) return new FillStep { Skip = "rejects" };
                step.Ore = pick;
                step.OreCount = Math.Max(0, s.MaxOre - queued);
            }
            if (what != FillWhat.Ore && !string.IsNullOrEmpty(s.Fuel))
                step.FuelCount = Math.Max(0, (int)Math.Floor(s.MaxFuel - fuel));
            if (step.OreCount == 0 && step.FuelCount == 0) return new FillStep { Skip = "full" };
            return step;
        }
    }
}
