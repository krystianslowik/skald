using System;

namespace Skald.Bridge
{
    // A fire as the game defines it, read at runtime from the prefab's
    // Fireplace component (Extras.RefuelFires): torches, sconces, campfires,
    // hearths, braziers, lanterns. No game data is kept in the plugin itself.
    sealed class Fire
    {
        public string Prefab;
        // m_fuelItem, null when the fire takes no fuel.
        public string Fuel;
        public float MaxFuel;
        // m_infiniteFuel: burns forever, never needs fuel.
        public bool Infinite;
        // m_canRefill: false when the game refuses fuel for it.
        public bool CanRefill = true;
    }

    // What a refuel does with one fire in range.
    enum RefuelStep { Refuel, World, Unloaded, Off, Full }

    // The game-independent half of POST /v1/build/refuel-fires, unit-tested
    // in bridge/tests.
    static class RefuelPlan
    {
        // Only a fire a player could feed by hand: it has a fuel item, does
        // not burn forever and the game lets it be refilled (Fireplace.UseItem).
        public static bool Takes(Fire f) => f != null && !string.IsNullOrEmpty(f.Fuel) && !f.Infinite && f.CanRefill && f.MaxFuel > 0;

        // Full the way the game judges it: the level rounded up has reached
        // the maximum, so a fire at 9.3 of 10 takes no more wood in game.
        public static bool Full(Fire f, float fuel) => Math.Ceiling(fuel) >= f.MaxFuel;

        // At most this many fires get fuel in one call; the rest wait for the next.
        public const int MaxFires = 500;

        // What happens to one fire a player could feed (Takes), in this
        // order: one no player built (creator 0: Fuling camps, abandoned
        // houses, dungeons) is never touched; one nobody has loaded cannot
        // take the RPC; one turned off (state other than 1) would not burn
        // anyway, so it is not counted as lit; a full one needs nothing.
        public static RefuelStep Step(Fire f, long creator, bool loaded, int state, float fuel)
        {
            if (creator == 0) return RefuelStep.World;
            if (!loaded) return RefuelStep.Unloaded;
            if (state != 1) return RefuelStep.Off;
            if (Full(f, fuel)) return RefuelStep.Full;
            return RefuelStep.Refuel;
        }

        // A refuel fills to the fire's own maximum.
        public static float Target(Fire f) => f.MaxFuel;
    }
}
