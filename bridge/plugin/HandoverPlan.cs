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
        // An item lying on the ground. A pickup, an auto-stack merge and a
        // partial take all ask the owner (ItemDrop.RPC_RequestOwn) and then
        // write or destroy the drop as the new owner; moving the owner in the
        // middle of that can leave two clients each acting on the same drop,
        // which can duplicate or lose the item. The game's pass hands drops
        // out by itself.
        Loose,
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
        public static HandoverStep Step(bool persistent, bool inArea, long owner, long target, long server, bool ownerConnected, bool inUse, bool itemDrop)
        {
            if (!persistent) return HandoverStep.Transient;
            if (!inArea) return HandoverStep.OutOfArea;
            if (owner == 0) return HandoverStep.Unowned;
            if (owner == target) return HandoverStep.Already;
            if (owner == server || !ownerConnected) return HandoverStep.NotAPlayer;
            if (itemDrop) return HandoverStep.Loose;
            if (inUse) return HandoverStep.InUse;
            return HandoverStep.Take;
        }

        // In use, read from the object's saved values: "user" set (a ship's
        // helm or a saddle, ShipControlls / Sadle), "InUse" 1 (an open chest,
        // Container), "attachJoint" true (a cart in harness, Vagon).
        //
        // "attachJoint" is two values under one hash: Vagon stores a bool
        // (ZDO.Set(hash, bool) goes to the int table), ZSyncTransform stores
        // the name of the joint a character hangs from as a string (the
        // string table). ZDO.GetBool(hash) reads the int table only, so a
        // character's joint name never reads as a cart in harness.
        public static bool InUse(long user, int inUseFlag, bool attached) => user != 0 || inUseFlag == 1 || attached;

        // How far a handover moves an object's data revision ahead.
        //
        // RPC_ZDOData on the server takes a client's object whole, owner
        // included, whenever its data revision is newer than the server's.
        // The old owner keeps sending updates until it hears of the new
        // owner, so one sent just before the handover would put the old owner
        // back on the server, while the old owner itself has already taken
        // the new owner and stopped simulating: nobody simulates the object
        // until the old owner leaves. Moving the server's data revision this
        // far ahead makes those late updates fail the "newer" check (their
        // owner revision is older too, so they are dropped), and the old
        // owner, seeing a newer revision from the server, takes the server's
        // copy and steps down. The cost: the old owner's last round trip of
        // changes to those objects is lost (they rubber-band once). 1024 is
        // far more updates than a client sends for one object in a round
        // trip. The revision is not saved with the world (ZDO.Load starts it
        // at 0) and game code only compares it for "changed since" (!=), so
        // the jump costs one reload of the object on each client.
        public const uint DataRevisionMargin = 1024;

        // The revision to set; saturates instead of wrapping to a small one.
        public static uint BumpedDataRevision(uint rev) => rev > uint.MaxValue - DataRevisionMargin ? uint.MaxValue : rev + DataRevisionMargin;
    }

    // Counts what one handover moved: objects, the zones they lie in, and how
    // many players they came from (a number only, never who).
    sealed class HandoverCounter
    {
        readonly HashSet<(int, int)> zones = new HashSet<(int, int)>();
        readonly HashSet<long> from = new HashSet<long>();
        public int Objects, Already, InUse, Loose, Failed;
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
                case HandoverStep.Loose: Loose++; break;
            }
        }

        public int Zones => zones.Count;
        public int FromPeers => from.Count;
    }
}
