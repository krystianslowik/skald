using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

namespace Skald.Bridge
{
    // The binary answer of GET /v1/terrain/tile and the limits around it. Pure
    // .NET on purpose (no Unity or game types), so it is unit-tested off the
    // game; Terrain.cs does the sampling.
    //
    // Layout, little-endian:
    //   u32 magic "SKT1"   u16 version (1)   u16 flags
    //   i32 n              f32 x0   f32 z0   f32 step
    //   n*n u8   biome index (BiomeFlags order; 255 for a flag not listed)
    //   n*n u16  height, (metres + 500) * 50, 2 cm steps
    //   n*n u8   forest, 0..255 (only when flags has Forest)
    // Sample (col, row) is at x = x0 + col*step, z = z0 - row*step: row 0 is
    // the north edge, column 0 the west edge.
    public static class TerrainTile
    {
        public const uint Magic = 0x31544B53; // "SKT1"
        public const ushort Version = 1;
        public const int HeaderSize = 24;
        // Flags.
        public const ushort Forest = 1;
        // Forest holds the game's own minimap forest mask (Minimap.GetMaskColor
        // red channel), not the raw WorldGenerator.GetForestFactor.
        public const ushort ForestIsMask = 2;

        // 256 px tiles plus a two-sample apron on every side, so a slope at
        // the edge is a centred difference in both neighbouring tiles.
        public const int MaxEdge = 260;
        public const float MinStep = 0.25f, MaxStep = 128f;
        public const float MaxCoord = 12000f;

        // Heightmap.Biome flag values in index order, as the terrain Job writes them.
        public static readonly int[] BiomeFlags = { 0, 1, 2, 4, 8, 16, 32, 64, 256, 512 };
        public static readonly string[] BiomeNames = { "None", "Meadows", "Swamp", "Mountain", "BlackForest", "Plains", "AshLands", "DeepNorth", "Ocean", "Mistlands" };

        public static byte BiomeIndex(int flag)
        {
            for (int i = 0; i < BiomeFlags.Length; i++) if (BiomeFlags[i] == flag) return (byte)i;
            return 255;
        }

        public static ushort EncodeHeight(float h)
        {
            float v = (h + 500f) * 50f;
            if (float.IsNaN(v)) return 0;
            return (ushort)Math.Max(0, Math.Min(65535, Math.Round(v)));
        }

        // Null when the request is acceptable, otherwise why not.
        public static string Check(int n, float x0, float z0, float step)
        {
            if (n < 1 || n > MaxEdge) return "'n' must be between 1 and " + MaxEdge;
            if (float.IsNaN(step) || step < MinStep || step > MaxStep) return "'step' must be between " + MinStep + " and " + MaxStep;
            float x1 = x0 + (n - 1) * step, z1 = z0 - (n - 1) * step;
            if (!Within(x0) || !Within(z0) || !Within(x1) || !Within(z1)) return "the tile must lie within " + MaxCoord + " m of the centre";
            return null;
        }

        static bool Within(float v) => !float.IsNaN(v) && v >= -MaxCoord && v <= MaxCoord;

        public static int Size(int n, ushort flags) => HeaderSize + n * n * ((flags & Forest) != 0 ? 4 : 3);

        public static byte[] Encode(int n, float x0, float z0, float step, ushort flags, byte[] biomes, ushort[] heights, byte[] forest)
        {
            int nn = n * n;
            // The grids may be longer than n*n (pooled buffers); only the first n*n count.
            if (biomes.Length < nn || heights.Length < nn || ((flags & Forest) != 0 && (forest == null || forest.Length < nn)))
                throw new ArgumentException("grids smaller than n*n");
            var buf = new byte[Size(n, flags)];
            using (var w = new BinaryWriter(new MemoryStream(buf)))
            {
                w.Write(Magic);
                w.Write(Version);
                w.Write(flags);
                w.Write(n);
                w.Write(x0);
                w.Write(z0);
                w.Write(step);
                w.Write(biomes, 0, nn);
                // BinaryWriter writes little-endian on every platform.
                for (int i = 0; i < nn; i++) w.Write(heights[i]);
                if ((flags & Forest) != 0) w.Write(forest, 0, nn);
            }
            return buf;
        }
    }

    // Caps the share of one core the sampler may take: after each row the
    // caller asks how long to rest so that busy time stays at or under `duty`
    // of the wall time since Start. The game's own heightmap builder works
    // the same way, one background thread with sleeps between jobs.
    public sealed class DutyCycle
    {
        readonly double duty;
        readonly Stopwatch wall = new Stopwatch();
        double busyMs;

        public DutyCycle(int percent)
        {
            duty = Math.Max(5, Math.Min(100, percent)) / 100.0;
        }

        public void Start() => wall.Restart();

        // Records `ms` of work and returns how long to sleep before the next.
        public int Rest(double ms)
        {
            busyMs += ms;
            double owed = busyMs / duty - wall.Elapsed.TotalMilliseconds;
            return owed >= 1 ? (int)Math.Ceiling(owed) : 0;
        }

        public double ElapsedMs => wall.Elapsed.TotalMilliseconds;
    }

    // A token bucket over tile requests: `rate` per second, at most `burst` at once.
    public sealed class RateLimit
    {
        readonly double rate, burst;
        double tokens;
        long last;
        readonly object gate = new object();
        readonly Func<long> nowMs;

        public RateLimit(double rate, double burst, Func<long> nowMs = null)
        {
            this.rate = rate;
            this.burst = burst;
            tokens = burst;
            this.nowMs = nowMs ?? (() => Stopwatch.GetTimestamp() * 1000 / Stopwatch.Frequency);
            last = this.nowMs();
        }

        // True when a request may go ahead now.
        public bool Take()
        {
            lock (gate)
            {
                long now = nowMs();
                tokens = Math.Min(burst, tokens + (now - last) / 1000.0 * rate);
                last = now;
                if (tokens < 1) return false;
                tokens -= 1;
                return true;
            }
        }
    }

    // Serialises sampling: one tile at a time, like the game's single
    // heightmap builder thread. Waiters give up after `waitMs`.
    public sealed class OneAtATime
    {
        readonly SemaphoreSlim gate = new SemaphoreSlim(1, 1);

        public bool Enter(int waitMs) => gate.Wait(waitMs);
        public void Exit() => gate.Release();
    }
}
