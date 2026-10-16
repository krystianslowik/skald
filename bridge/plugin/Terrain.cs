// Read-only terrain sampling of the running world: the same world generator
// calls the terrain Job (terrain/plugin/SkaldTerrain.cs) makes, against the
// live game's WorldGenerator instead of a second server, so the result is
// always for the running build.
//
// Thread safety: the game itself samples WorldGenerator off the main thread.
// HeightmapBuilder starts its own thread (m_builder) and calls GetBiome and
// GetBiomeHeight from it while the main thread does the same; the only shared
// mutable state on that path, the river cache, is behind m_riverCacheLock.
// The overloads bound here are the ones that thread uses and touch no
// unsynchronised cache (GetBiome(Vector2s) does: it is not used). So tiles are
// sampled on the request's own thread, never on the main thread, one at a
// time and duty-cycled (see TerrainTile.cs).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.Serialization;
using System.Threading;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace Skald.Bridge
{
    static class Terrain
    {
        const float WaterLevel = 30f;
        // How long a tile request waits for the one before it.
        const int QueueWaitMs = 3000;
        // A tile that takes longer than this is abandoned.
        const int TileDeadlineMs = 20000;

        static readonly OneAtATime Gate = new OneAtATime();
        static readonly RateLimit Rate = new RateLimit(EnvInt("SKALD_BRIDGE_TERRAIN_RATE", 4, 1, 50), 8);
        static readonly int Duty = EnvInt("SKALD_BRIDGE_TERRAIN_DUTY", 50, 5, 100);
        static readonly bool Off = IsOff(Environment.GetEnvironmentVariable("SKALD_BRIDGE_TERRAIN"));

        static bool IsOff(string v)
        {
            v = (v ?? "").Trim().ToLowerInvariant();
            return v == "off" || v == "false" || v == "0";
        }

        static int EnvInt(string k, int def, int min, int max)
        {
            string v = Environment.GetEnvironmentVariable(k);
            return int.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out int n) && n >= min && n <= max ? n : def;
        }

        static void Enabled()
        {
            if (Off) throw new CommandError(503, "terrain sampling is off (SKALD_BRIDGE_TERRAIN=off)");
        }

        // ---- GET /v1/terrain/info (request thread) ------------------------

        static JObject palette;

        public static object Info(JObject a)
        {
            Enabled();
            var gen = WorldGenerator.instance;
            if (gen == null) throw new CommandError(503, "world not loaded yet");
            // Binding compiles delegates: off the main thread, once per world.
            var s = Sampler.For(gen);
            // The minimap's colours are Unity objects, so they are read on the
            // main thread, once: prefab data does not change while the process runs.
            if (palette == null) palette = (JObject)SkaldBridgePlugin.RunOnMainThread(ReadPalette, 5000);
            return Commands.Ok(new
            {
                seedHash = s.SeedHash,
                worldGenVersion = s.WorldGenVersion,
                gameBuild = SkaldBridgePlugin.SafeGameVersion(),
                waterLevel = WaterLevel,
                biomes = TerrainTile.BiomeNames,
                forest = s.HasMask ? "mask" : s.HasFactor ? "factor" : "none",
                maxEdge = TerrainTile.MaxEdge,
                minStep = TerrainTile.MinStep,
                palette,
            });
        }

        // The game's minimap colours, by reflection: Minimap.GetPixelColor for
        // every biome and the forest mask colour. The Minimap component is a
        // client object; a dedicated server may hold it only as an inactive
        // prefab, or not at all. {"source":"none"} then, and the web uses its
        // own tuned colours.
        static JObject ReadPalette()
        {
            var o = new JObject { ["source"] = "none" };
            try
            {
                var t = typeof(Minimap);
                object inst = null;
                string source = null;
                var ip = t.GetProperty("instance", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
                if (ip != null) inst = ip.GetValue(null, null);
                if (inst as UnityEngine.Object != null) source = "instance";
                else
                {
                    inst = Resources.FindObjectsOfTypeAll(t).FirstOrDefault();
                    if (inst as UnityEngine.Object != null) source = "prefab";
                }
                if (source == null) return o;
                var pixel = t.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                    .FirstOrDefault(m => m.Name == "GetPixelColor" && m.ReturnType == typeof(Color) && m.GetParameters().Length == 1 && m.GetParameters()[0].ParameterType.IsEnum);
                if (pixel == null) return o;
                var bt = pixel.GetParameters()[0].ParameterType;
                var biomes = new JObject();
                for (int i = 1; i < TerrainTile.BiomeFlags.Length; i++)
                {
                    var c = (Color)pixel.Invoke(inst, new[] { Enum.ToObject(bt, TerrainTile.BiomeFlags[i]) });
                    biomes[TerrainTile.BiomeNames[i]] = Hex(c);
                }
                o["source"] = source;
                o["biomes"] = biomes;
                var f = t.GetField("s_forestColor", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
                if (f != null && f.FieldType == typeof(Color)) o["forestMask"] = Hex((Color)f.GetValue(null));
            }
            catch (Exception e)
            {
                SkaldBridgePlugin.Warn("terrain palette not readable: " + e.GetType().Name + ": " + e.Message);
                o = new JObject { ["source"] = "none" };
            }
            return o;
        }

        static string Hex(Color c)
        {
            Color32 b = c;
            return "#" + b.r.ToString("x2") + b.g.ToString("x2") + b.b.ToString("x2");
        }

        // ---- GET /v1/terrain/tile (request thread) ------------------------

        public static object Tile(JObject a)
        {
            Enabled();
            int n = Commands.Int(a, "n", 256, 1, TerrainTile.MaxEdge);
            float x0 = Commands.Float(a["x"], "x") ?? throw new CommandError(400, "missing 'x'");
            float z0 = Commands.Float(a["z"], "z") ?? throw new CommandError(400, "missing 'z'");
            float step = Commands.Float(a["step"], "step") ?? throw new CommandError(400, "missing 'step'");
            string bad = TerrainTile.Check(n, x0, z0, step);
            if (bad != null) throw new CommandError(400, bad);
            var gen = WorldGenerator.instance;
            if (gen == null) throw new CommandError(503, "world not loaded yet");
            if (!Rate.Take()) throw new CommandError(429, "too many terrain requests");
            if (!Gate.Enter(QueueWaitMs)) throw new CommandError(429, "terrain sampler busy");
            var thread = Thread.CurrentThread;
            var priority = thread.Priority;
            try
            {
                thread.Priority = System.Threading.ThreadPriority.BelowNormal;
                return Sample(Sampler.For(gen), n, x0, z0, step);
            }
            finally
            {
                thread.Priority = priority;
                Gate.Exit();
            }
        }

        static RawBody Sample(Sampler s, int n, float x0, float z0, float step)
        {
            int nn = n * n;
            var biomes = new byte[nn];
            var heights = new ushort[nn];
            var forest = s.HasMask || s.HasFactor ? new byte[nn] : null;
            var duty = new DutyCycle(Duty);
            var row = new Stopwatch();
            duty.Start();
            double busy = 0;
            for (int r = 0; r < n; r++)
            {
                row.Restart();
                float z = z0 - r * step;
                for (int c = 0; c < n; c++)
                {
                    float x = x0 + c * step;
                    int b = s.Biome(x, z);
                    float h = s.Height(b, x, z);
                    int i = r * n + c;
                    biomes[i] = TerrainTile.BiomeIndex(b);
                    heights[i] = TerrainTile.EncodeHeight(h);
                    if (forest != null) forest[i] = (byte)Math.Max(0, Math.Min(255, Math.Round(s.Forest(b, x, z, h) * 255f)));
                }
                busy += row.Elapsed.TotalMilliseconds;
                int rest = duty.Rest(row.Elapsed.TotalMilliseconds);
                if (duty.ElapsedMs + rest > TileDeadlineMs) throw new CommandError(503, "terrain tile took too long");
                if (rest > 0) Thread.Sleep(rest);
            }
            ushort flags = (ushort)((forest != null ? TerrainTile.Forest : 0) | (s.HasMask ? TerrainTile.ForestIsMask : 0));
            var body = TerrainTile.Encode(n, x0, z0, step, flags, biomes, heights, forest);
            var headers = new Dictionary<string, string>
            {
                ["X-Skald-Sample-Ms"] = Math.Round(busy).ToString(CultureInfo.InvariantCulture),
                ["X-Skald-Wall-Ms"] = Math.Round(duty.ElapsedMs).ToString(CultureInfo.InvariantCulture),
                ["X-Skald-Seed-Hash"] = s.SeedHash.ToString(CultureInfo.InvariantCulture),
                ["X-Skald-WorldGen-Version"] = s.WorldGenVersion.ToString(CultureInfo.InvariantCulture),
                ["X-Skald-Game-Build"] = SkaldBridgePlugin.SafeGameVersion(),
            };
            return new RawBody(body, "application/octet-stream", headers);
        }

        // ---- binding ------------------------------------------------------

        // Delegates compiled once per WorldGenerator instance, the way the
        // terrain Job binds them (SkaldTerrain.cs, Game.BiomeSampler and
        // Game.HeightSampler): any overload whose extra parameters have
        // defaults or are out parameters. MethodInfo.Invoke per sample would
        // be far too slow. A missing member raises MissingMemberException,
        // which switches the route off (HttpServer.Handle).
        sealed class Sampler
        {
            const BindingFlags Inst = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
            const BindingFlags Stat = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;

            static readonly object Lock = new object();
            static Sampler current;

            readonly object gen;
            public Func<float, float, int> Biome;
            public Func<int, float, float, float> Height;
            Func<float, float, float, int, float> mask;
            Func<float, float, float> factor;
            public int SeedHash, WorldGenVersion;
            public bool HasMask => mask != null;
            public bool HasFactor => factor != null;

            Sampler(object gen) { this.gen = gen; }

            public float Forest(int biome, float x, float z, float h) =>
                mask != null ? mask(x, z, h, biome) : factor != null ? Mathf.Clamp01(factor(x, z)) : 0f;

            // The sampler for this generator. A world reload replaces the
            // generator; the caller keeps the one it started a tile with.
            public static Sampler For(object gen)
            {
                lock (Lock)
                {
                    if (current != null && ReferenceEquals(current.gen, gen)) return current;
                    var s = new Sampler(gen);
                    s.Bind();
                    current = s;
                    return s;
                }
            }

            static Exception Unbound(string what) => new MissingMemberException("WorldGenerator binding: " + what);

            void Bind()
            {
                var g = gen.GetType();
                Type biomeType = null;
                foreach (var m in g.GetMethods(Inst).Where(m => m.Name == "GetBiome").OrderBy(m => m.GetParameters().Length))
                {
                    var ps = m.GetParameters();
                    if (ps.Length < 2 || ps[0].ParameterType != typeof(float) || ps[1].ParameterType != typeof(float) || !m.ReturnType.IsEnum) continue;
                    var rest = Rest(ps, 2, out var locals);
                    if (rest == null) continue;
                    var x = Expression.Parameter(typeof(float), "x");
                    var z = Expression.Parameter(typeof(float), "z");
                    var call = Expression.Call(Expression.Constant(gen), m, new Expression[] { x, z }.Concat(rest));
                    Biome = Expression.Lambda<Func<float, float, int>>(Expression.Block(typeof(int), locals, Expression.Convert(call, typeof(int))), x, z).Compile();
                    biomeType = m.ReturnType;
                    break;
                }
                if (Biome == null) throw Unbound("GetBiome(float, float, ...)");

                foreach (var m in g.GetMethods(Inst).Where(m => m.Name == "GetBiomeHeight").OrderBy(m => m.GetParameters().Length))
                {
                    var ps = m.GetParameters();
                    if (ps.Length < 3 || ps[0].ParameterType != biomeType || ps[1].ParameterType != typeof(float) || ps[2].ParameterType != typeof(float) || m.ReturnType != typeof(float)) continue;
                    var rest = Rest(ps, 3, out var locals);
                    if (rest == null) continue;
                    var b = Expression.Parameter(typeof(int), "biome");
                    var x = Expression.Parameter(typeof(float), "x");
                    var z = Expression.Parameter(typeof(float), "z");
                    var call = Expression.Call(Expression.Constant(gen), m, new Expression[] { Expression.Convert(b, biomeType), x, z }.Concat(rest));
                    Height = Expression.Lambda<Func<int, float, float, float>>(Expression.Block(typeof(float), locals, call), b, x, z).Compile();
                    break;
                }
                if (Height == null) throw Unbound("GetBiomeHeight(Biome, float, float, ...)");

                var world = g.GetField("m_world", Inst)?.GetValue(gen);
                if (world == null) throw Unbound("WorldGenerator.m_world");
                SeedHash = IntField(world, "m_seed");
                WorldGenVersion = IntField(world, "m_worldGenVersion");

                BindForest(biomeType);
            }

            static int IntField(object o, string name)
            {
                var f = o.GetType().GetField(name, Inst);
                if (f == null || f.FieldType != typeof(int)) throw Unbound("World." + name + " (int)");
                return (int)f.GetValue(o);
            }

            // The minimap's forest mask: Minimap.GetMaskColor(wx, wy, height,
            // biome).r, the exact value the game's map darkens forest with.
            // It reads only statics and the world generator, so an
            // uninitialised Minimap object is enough to call it on (a
            // dedicated server has no live Minimap). Failing that, the raw
            // static WorldGenerator.GetForestFactor(Vector3), and the web
            // applies its own threshold. Optional: no forest is not an error.
            void BindForest(Type biomeType)
            {
                try
                {
                    var mm = typeof(Minimap);
                    var m = mm.GetMethods(Inst).FirstOrDefault(x =>
                    {
                        var ps = x.GetParameters();
                        return x.Name == "GetMaskColor" && ps.Length == 4 && ps[0].ParameterType == typeof(float) && ps[1].ParameterType == typeof(float)
                            && ps[2].ParameterType == typeof(float) && ps[3].ParameterType == biomeType && x.ReturnType == typeof(Color);
                    });
                    if (m != null)
                    {
                        var target = FormatterServices.GetUninitializedObject(mm);
                        var x = Expression.Parameter(typeof(float), "x");
                        var z = Expression.Parameter(typeof(float), "z");
                        var h = Expression.Parameter(typeof(float), "h");
                        var b = Expression.Parameter(typeof(int), "biome");
                        var call = Expression.Call(Expression.Constant(target, mm), m, x, z, h, Expression.Convert(b, biomeType));
                        var fn = Expression.Lambda<Func<float, float, float, int, float>>(Expression.Field(call, "r"), x, z, h, b).Compile();
                        // One trial call: an exception here means the method needs more than statics.
                        fn(0f, 0f, 40f, TerrainTile.BiomeFlags[1]);
                        mask = fn;
                        return;
                    }
                }
                catch (Exception e)
                {
                    SkaldBridgePlugin.Warn("terrain: minimap forest mask not usable (" + e.GetType().Name + "), trying the forest factor");
                }
                try
                {
                    var ff = gen.GetType().GetMethod("GetForestFactor", Stat, null, new[] { typeof(Vector3) }, null);
                    if (ff == null || ff.ReturnType != typeof(float)) return;
                    var fn = (Func<Vector3, float>)Delegate.CreateDelegate(typeof(Func<Vector3, float>), ff);
                    factor = (x, z) => fn(new Vector3(x, 0f, z));
                    factor(0f, 0f);
                }
                catch (Exception e)
                {
                    factor = null;
                    SkaldBridgePlugin.Warn("terrain: no forest factor (" + e.GetType().Name + ")");
                }
            }

            // An argument for every parameter past the ones given: the
            // declared default, or a fresh local for an out parameter. null
            // if one has neither. Same rule as the terrain Job's binder.
            static Expression[] Rest(ParameterInfo[] ps, int from, out ParameterExpression[] locals)
            {
                var args = new Expression[ps.Length - from];
                var vars = new List<ParameterExpression>();
                for (int i = from; i < ps.Length; i++)
                {
                    var p = ps[i];
                    if (p.IsOut && p.ParameterType.IsByRef)
                    {
                        var v = Expression.Variable(p.ParameterType.GetElementType(), p.Name);
                        vars.Add(v);
                        args[i - from] = v;
                    }
                    else if (p.IsOptional && p.DefaultValue != DBNull.Value && p.DefaultValue != Missing.Value)
                    {
                        args[i - from] = Expression.Constant(p.DefaultValue, p.ParameterType);
                    }
                    else
                    {
                        locals = null;
                        return null;
                    }
                }
                locals = vars.ToArray();
                return args;
            }
        }
    }
}
