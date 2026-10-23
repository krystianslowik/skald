using System.Collections.Generic;

namespace Skald.Bridge
{
    // What a simulation handover does with one object in the target's area.
    enum HandoverStep
    {
        // Give it to the target.
        Take,
        // Not saved with the world (player characters, projectiles, ragdolls):
        // the game's own ownership pass never moves these either, and they
        // live only as long as their owner stays connected.
        Transient,
        // Outside the target's active area: the target's own pass would let
        // go of it again within two seconds.
        OutOfArea,
        // Nobody simulates it: the game's pass hands it out by itself.
        Unowned,
        // The target simulates it already.
        Already,
        // The server itself, or a peer that is gone: the game's pass hands it
        // out by itself.
        NotAPlayer,
        // Someone is using it right now: a ship being steered, a mount being
        // ridden, an open chest, a cart in harness. The game moves these only
        // from the owner's own client, to the player using them.
        InUse,
    }

    // The game-independent half of POST /v1/sim/handover (Link.Handover),
    // unit-tested in bridge/tests.
    //
    // The dedicated server hands out ownership every 2 s (ZDOMan.ReleaseZDOS ->
    // ReleaseNearbyZDOS, once for the server and once per peer): a saved
    // object goes to a peer whose active area holds it only when it has no
    // owner or its owner's active area does not hold it; a peer lets go of its
    // own objects once they leave its active area. So an object given to a
    // target that has it in its active area is not taken back by that pass
    // while the target stays near, and falls back to the game's rules once
    // the target walks away. The plan only picks objects the pass would then
    // leave alone.
    static class HandoverPlan
    {
        // At most this many objects move in one call: every one is sent again
        // to each player in range. A second call takes the rest.
        public const int MaxObjects = 5000;

        // One object: its saved flag, whether it lies in the target's active
        // area, its current owner, whether that owner is a connected player,
        // and whether someone is using it.
        public static HandoverStep Step(bool persistent, bool inArea, long owner, long target, long server, bool ownerConnected, bool inUse)
        {
            if (!persistent) return HandoverStep.Transient;
            if (!inArea) return HandoverStep.OutOfArea;
            if (owner == 0) return HandoverStep.Unowned;
            if (owner == target) return HandoverStep.Already;
            if (owner == server || !ownerConnected) return HandoverStep.NotAPlayer;
            if (inUse) return HandoverStep.InUse;
            return HandoverStep.Take;
        }

        // In use, read from the object's saved values: "user" set (a ship's
        // helm or a saddle, ShipControlls / Sadle), "InUse" 1 (an open chest,
        // Container), "attachJoint" true (a cart in harness, Vagon).
        public static bool InUse(long user, int inUseFlag, bool attached) => user != 0 || inUseFlag == 1 || attached;
    }

    // Counts what one handover moved: objects, the zones they lie in, and how
    // many players they came from (a number only, never who).
    sealed class HandoverCounter
    {
        readonly HashSet<(int, int)> zones = new HashSet<(int, int)>();
        readonly HashSet<long> from = new HashSet<long>();
        public int Objects, Already, InUse;
        public bool Capped;

        // Whether there is room for one more object; false sets Capped.
        public bool Room()
        {
            if (Objects < HandoverPlan.MaxObjects) return true;
            Capped = true;
            return false;
        }

        // One object seen: its step, its owner before the call, its zone.
        public void Add(HandoverStep step, long owner, int zoneX, int zoneY)
        {
            switch (step)
            {
                case HandoverStep.Take:
                    Objects++;
                    zones.Add((zoneX, zoneY));
                    from.Add(owner);
                    break;
                case HandoverStep.Already: Already++; break;
                case HandoverStep.InUse: InUse++; break;
            }
        }

        public int Zones => zones.Count;
        public int FromPeers => from.Count;
    }
}
