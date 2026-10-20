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

        // A refuel fills to the fire's own maximum.
        public static float Target(Fire f) => f.MaxFuel;
    }
}
