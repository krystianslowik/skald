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
        // It holds or works items for players: chests (graves, cart and ship
        // storage too), smelters and kilns, fermenters, beehives, cooking
        // stations, item and armor stands, pickables, sap collectors, fires,
        // shield generators, turrets, catapults, feasts, fish, ore deposits.
        // Their owner records an item going in or out only in the object's
        // data (a bar spawned and the queue shortened, ore taken from the
        // player and then queued, a pick, a take-all). The data revision
        // jump below drops the old owner's last writes, so such a move could
        // be undone after the item already appeared or vanished: a duplicate
        // or a loss. They stay with their owner.
        Keeps,
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
        public static HandoverStep Step(bool persistent, bool inArea, long owner, long target, long server, bool ownerConnected, bool inUse, bool itemDrop, bool holdsItems)
        {
            if (!persistent) return HandoverStep.Transient;
            if (!inArea) return HandoverStep.OutOfArea;
            if (owner == 0) return HandoverStep.Unowned;
            if (owner == target) return HandoverStep.Already;
            if (owner == server || !ownerConnected) return HandoverStep.NotAPlayer;
            if (itemDrop) return HandoverStep.Loose;
            if (holdsItems) return HandoverStep.Keeps;
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
        // copy and steps down. The cost: the old owner's last changes to
        // those objects are lost (a moving creature or cart snaps back once),
        // which is why objects that hold items are not moved at all (Keeps).
        // The margin covers the old owner's window: its send backlog plus a
        // round trip, seconds on a bad line, while a moving object's sync
        // writes several revisions a frame (hundreds a second). 2^20 is
        // about an hour of that and still leaves 4000 handovers of room
        // before the 32-bit revision saturates. The revision is not saved
        // with the world (ZDO.Load starts it at 0) and game code only
        // compares it for "changed since" (!=), so the jump costs one reload
        // of the object on each client.
        public const uint DataRevisionMargin = 1u << 20;

        // The revision to set; saturates instead of wrapping to a small one.
        public static uint BumpedDataRevision(uint rev) => rev > uint.MaxValue - DataRevisionMargin ? uint.MaxValue : rev + DataRevisionMargin;

        // Whether the jump still leaves the new owner a margin of room. Near
        // the top a saturated revision would wrap on the new owner's next
        // write, and the server would then take its updates as old; such an
        // object is left with its owner instead (counted as kept).
        public static bool RoomToBump(uint rev) => rev <= uint.MaxValue - 2 * DataRevisionMargin;
    }

    // Counts what one handover moved: objects, the zones they lie in, and how
    // many players they came from (a number only, never who).
    sealed class HandoverCounter
    {
        readonly HashSet<(int, int)> zones = new HashSet<(int, int)>();
        readonly HashSet<long> from = new HashSet<long>();
        public int Objects, Already, InUse, Loose, Kept, Failed;
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
                case HandoverStep.Keeps: Kept++; break;
            }
        }

        public int Zones => zones.Count;
        public int FromPeers => from.Count;
    }
}
