// Skald terrain sampler: a BepInEx 5 plugin that runs the operator's own
// installed Valheim server's world generator for one seed, samples the biome
// and the terrain height on a grid, writes them next to a manifest and quits
// the process. The game is reached only by reflection, so this assembly
// contains, references and copies no game code.
//
// It does nothing unless SKALD_TERRAIN_OUT is set, so a copy left in a real
// server's plugin folder is inert.
//
// Settings (environment):
//   SKALD_TERRAIN_OUT              output directory (required)
//   SKALD_TERRAIN_SEED             the world's seed name (required)
//   SKALD_TERRAIN_SEED_HASH        the save's seed hash; overrides the hash of the name
//   SKALD_TERRAIN_WORLDGEN_VERSION the save's world generator version
//   SKALD_TERRAIN_RES              grid edge in pixels, 64..4096 (default 2048)
//   SKALD_TERRAIN_RADIUS           half the grid's width in metres (default 10500)
//   SKALD_TERRAIN_THREADS          sampling threads (default min(4, cores))
//   SKALD_TERRAIN_STATUS           status file (default OUT/status)
//   SKALD_TERRAIN_QUIT             "false" keeps the process running
//
// Exit codes, also written to the status file as "<code> <word> <detail>":
//   0 written, or already current for this seed, generator and game build
//   10 bad settings   11 the game's API is not what this plugin expects
//   12 sampling failed   13 the output could not be written
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using BepInEx;

namespace Skald.Terrain
{
    [BepInPlugin("dev.skald.terrain", "Skald Terrain", "0.7.0")]
    public class SkaldTerrainPlugin : BaseUnityPlugin
    {
        public const int ExitOk = 0;
        public const int ExitConfig = 10;
        public const int ExitBind = 11;
        public const int ExitSample = 12;
        public const int ExitWrite = 13;

        const int Format = 1;
        const float WaterLevel = 30f;

        // Heightmap.Biome flag values in index order; the index is what biomes.u8 holds.
        static readonly int[] BiomeFlags = { 0, 1, 2, 4, 8, 16, 32, 64, 256, 512 };
        static readonly string[] BiomeNames = { "None", "Meadows", "Swamp", "Mountain", "BlackForest", "Plains", "AshLands", "DeepNorth", "Ocean", "Mistlands" };

        sealed class Failure : Exception
        {
            public readonly int Code;
            public readonly string Word;
            public Failure(int code, string word, string message) : base(message) { Code = code; Word = word; }
        }

        static string Env(string k) { return Environment.GetEnvironmentVariable(k) ?? ""; }

        void Awake()
        {
            string outDir = Env("SKALD_TERRAIN_OUT");
            if (outDir == "")
            {
                Logger.LogInfo("SKALD_TERRAIN_OUT is not set: nothing to do");
                return;
            }
            string statusPath = Env("SKALD_TERRAIN_STATUS");
            if (statusPath == "") statusPath = Path.Combine(outDir, "status");
            int code = ExitOk;
            string word = "ok", detail;
            try
            {
                detail = Run(outDir, ref word);
            }
            catch (Failure f)
            {
                code = f.Code;
                word = f.Word;
                detail = f.Message;
            }
            catch (SkaldTerrainBindException e)
            {
                code = ExitBind;
                word = "bind";
                detail = e.Message;
            }
            catch (TargetInvocationException e) when (e.InnerException != null)
            {
                code = ExitSample;
                word = "error";
                detail = e.InnerException.ToString();
            }
            catch (Exception e)
            {
                code = ExitSample;
                word = "error";
                detail = e.ToString();
            }
            if (code == ExitOk) Logger.LogInfo("skald-terrain: " + word + ": " + detail);
            else Logger.LogError("skald-terrain: " + word + " (exit " + code + "): " + detail);
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(statusPath)));
                File.WriteAllText(statusPath, code + " " + word + " " + detail.Replace('\n', ' ') + "\n");
            }
            catch (Exception e)
            {
                Logger.LogError("skald-terrain: cannot write the status file: " + e.Message);
            }
            if (Env("SKALD_TERRAIN_QUIT") != "false") UnityEngine.Application.Quit(code);
        }

        static int IntSetting(string name, int def, int min, int max)
        {
            string v = Env(name);
            if (v == "") return def;
            int n;
            if (!int.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out n) || n < min || n > max)
                throw new Failure(ExitConfig, "config", name + " must be an integer in " + min + ".." + max);
            return n;
        }

        string Run(string outDir, ref string word)
        {
            var sw = Stopwatch.StartNew();
            string seed = Env("SKALD_TERRAIN_SEED");
            if (seed == "" || seed.Length > 256) throw new Failure(ExitConfig, "config", "SKALD_TERRAIN_SEED is required");
            int res = IntSetting("SKALD_TERRAIN_RES", 2048, 64, 4096);
            int radius = IntSetting("SKALD_TERRAIN_RADIUS", 10500, 1000, 20000);
            int threads = IntSetting("SKALD_TERRAIN_THREADS", Math.Min(4, Environment.ProcessorCount), 1, 64);
            bool hasHash = Env("SKALD_TERRAIN_SEED_HASH") != "";
            int seedHash = IntSetting("SKALD_TERRAIN_SEED_HASH", 0, int.MinValue, int.MaxValue);
            bool hasVersion = Env("SKALD_TERRAIN_WORLDGEN_VERSION") != "";
            int wgv = IntSetting("SKALD_TERRAIN_WORLDGEN_VERSION", 0, 0, 1000);

            var game = Game.Bind();
            object world = game.NewWorld("skald-terrain", seed);
            game.SetField(world, "m_menu", false, required: false);
            if (hasVersion) game.SetField(world, "m_worldGenVersion", wgv, required: true);
            int nameHash = (int)game.GetField(world, "m_seed");
            if (hasHash && seedHash != nameHash)
            {
                Logger.LogWarning("skald-terrain: the save's seed hash " + seedHash + " differs from the hash of \"" + seed + "\" (" + nameHash + "); using the save's");
                game.SetField(world, "m_seed", seedHash, required: true);
            }
            int finalHash = (int)game.GetField(world, "m_seed");
            int finalVersion = (int)game.GetField(world, "m_worldGenVersion");
            string build = game.VersionString();
            Logger.LogInfo("skald-terrain: seed hash " + finalHash + ", world generator " + finalVersion + ", game " + build + ", " + res + " px, " + threads + " threads");

            if (Current(outDir, finalHash, finalVersion, build, res, radius))
            {
                word = "unchanged";
                return "the grids for this seed, generator and game build are already there";
            }

            game.Initialize(world);
            long initMs = sw.ElapsedMilliseconds;
            var biomeAt = game.BiomeSampler();
            var heightAt = game.HeightSampler();

            var biomes = new byte[res * res];
            var heights = new ushort[res * res];
            float step = 2f * radius / res;
            int next = -1;
            Exception failure = null;
            var workers = new Thread[threads];
            for (int t = 0; t < threads; t++)
            {
                workers[t] = new Thread(() =>
                {
                    try
                    {
                        int row;
                        while ((row = Interlocked.Increment(ref next)) < res && failure == null)
                        {
                            // Row 0 is north (+z), column 0 is west (-x); samples at pixel centres.
                            float z = radius - (row + 0.5f) * step;
                            for (int col = 0; col < res; col++)
                            {
                                float x = -radius + (col + 0.5f) * step;
                                int b = biomeAt(x, z);
                                int i = row * res + col;
                                biomes[i] = BiomeIndex(b);
                                heights[i] = EncodeHeight(heightAt(b, x, z));
                            }
                        }
                    }
                    catch (Exception e)
                    {
                        failure = e;
                    }
                });
                workers[t].Start();
            }
            foreach (var w in workers) w.Join();
            if (failure != null) throw new Failure(ExitSample, "sample", failure.ToString());

            // The generator is called from worker threads by the game itself; re-check a sparse subset on one thread.
            int checkedN = 0, mismatch = 0;
            for (int i = 0; i < res * res; i += 9973)
            {
                int row = i / res, col = i % res;
                float z = radius - (row + 0.5f) * step, x = -radius + (col + 0.5f) * step;
                int b = biomeAt(x, z);
                checkedN++;
                if (BiomeIndex(b) != biomes[i] || EncodeHeight(heightAt(b, x, z)) != heights[i]) mismatch++;
            }
            if (mismatch > 0) throw new Failure(ExitSample, "sample", "single-thread recheck: " + mismatch + "/" + checkedN + " samples differ");
            long sampleMs = sw.ElapsedMilliseconds - initMs;

            var hb = new byte[heights.Length * 2];
            Buffer.BlockCopy(heights, 0, hb, 0, hb.Length);
            var manifest = new StringBuilder();
            manifest.Append("{\"format\":").Append(Format)
                .Append(",\"seed\":").Append(Json(seed))
                .Append(",\"seedHash\":").Append(finalHash)
                .Append(",\"worldGenVersion\":").Append(finalVersion)
                .Append(",\"gameBuild\":").Append(Json(build))
                .Append(",\"resolution\":").Append(res)
                .Append(",\"radius\":").Append(radius)
                .Append(",\"orientation\":\"row 0 north (+z), column 0 west (-x), pixel centres\"")
                .Append(",\"biomes\":{\"file\":\"biomes.u8\",\"index\":[")
                .Append(string.Join(",", BiomeNames.Select(Json).ToArray()))
                .Append("]},\"height\":{\"file\":\"height.u16le\",\"metres\":\"v/50-500\",\"waterLevel\":")
                .Append(WaterLevel.ToString(CultureInfo.InvariantCulture))
                .Append("},\"threads\":").Append(threads)
                .Append(",\"recheck\":").Append(checkedN)
                .Append(",\"initMs\":").Append(initMs)
                .Append(",\"sampleMs\":").Append(sampleMs)
                .Append(",\"plugin\":\"0.7.0\"}");
            try
            {
                Directory.CreateDirectory(outDir);
                // Grids first, the manifest last: a reader that sees the new
                // manifest also sees the grids it describes.
                Publish(Path.Combine(outDir, "biomes.u8"), biomes);
                Publish(Path.Combine(outDir, "height.u16le"), hb);
                Publish(Path.Combine(outDir, "manifest.json"), Encoding.UTF8.GetBytes(manifest.ToString()));
            }
            catch (Exception e)
            {
                throw new Failure(ExitWrite, "write", e.Message);
            }
            game.Deinitialize();
            return res + "x" + res + " in " + sw.ElapsedMilliseconds + " ms (generator " + initMs + " ms, sampling " + sampleMs + " ms) to " + outDir;
        }

        static byte BiomeIndex(int flag)
        {
            for (int i = 0; i < BiomeFlags.Length; i++) if (BiomeFlags[i] == flag) return (byte)i;
            return 255;
        }

        // u16 = (metres + 500) * 50: 2 cm steps from -500 to +810 m.
        static ushort EncodeHeight(float h)
        {
            float v = (h + 500f) * 50f;
            return (ushort)Math.Max(0, Math.Min(65535, Math.Round(v)));
        }

        static void Publish(string path, byte[] data)
        {
            string tmp = path + ".tmp";
            File.WriteAllBytes(tmp, data);
            if (File.Exists(path)) File.Delete(path);
            File.Move(tmp, path);
        }

        static string Json(string s)
        {
            var b = new StringBuilder("\"");
            foreach (char c in s)
            {
                if (c == '"' || c == '\\') b.Append('\\').Append(c);
                else if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
                else b.Append(c);
            }
            return b.Append('"').ToString();
        }

        static readonly Regex NumField = new Regex("\"(seedHash|worldGenVersion|resolution|radius|format)\":(-?[0-9]+)");
        static readonly Regex BuildField = new Regex("\"gameBuild\":\"((?:[^\"\\\\]|\\\\.)*)\"");

        // Whether OUT already holds grids for exactly this request.
        static bool Current(string outDir, int seedHash, int wgv, string build, int res, int radius)
        {
            try
            {
                string m = File.ReadAllText(Path.Combine(outDir, "manifest.json"));
                var got = NumField.Matches(m).Cast<Match>().ToDictionary(x => x.Groups[1].Value, x => long.Parse(x.Groups[2].Value, CultureInfo.InvariantCulture));
                var gb = BuildField.Match(m);
                long v;
                bool same = got.TryGetValue("format", out v) && v == Format
                    && got.TryGetValue("seedHash", out v) && v == seedHash
                    && got.TryGetValue("worldGenVersion", out v) && v == wgv
                    && got.TryGetValue("resolution", out v) && v == res
                    && got.TryGetValue("radius", out v) && v == radius
                    && gb.Success && gb.Groups[1].Value == Json(build).Trim('"');
                return same
                    && new FileInfo(Path.Combine(outDir, "biomes.u8")).Length == (long)res * res
                    && new FileInfo(Path.Combine(outDir, "height.u16le")).Length == 2L * res * res;
            }
            catch (Exception)
            {
                return false;
            }
        }
    }

    // The game, reached by reflection. Every lookup that fails raises a
    // Failure with ExitBind and names what was missing, so a game update that
    // changes the API is reported, not crashed on. The per-sample calls are
    // compiled to delegates once; MethodInfo.Invoke per sample would be far
    // too slow at millions of samples.
    sealed class Game
    {
        const BindingFlags Inst = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
        const BindingFlags Stat = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;

        Type world, generator, version;
        object gen;

        static Exception Bind(string what)
        {
            return new SkaldTerrainBindException(what);
        }

        public static Game Bind()
        {
            var asm = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a => a.GetName().Name == "assembly_valheim");
            if (asm == null) throw Bind("assembly_valheim is not loaded");
            var g = new Game { world = asm.GetType("World"), generator = asm.GetType("WorldGenerator"), version = asm.GetType("Version") };
            if (g.world == null || g.generator == null) throw Bind("types World and WorldGenerator");
            return g;
        }

        public object NewWorld(string name, string seed)
        {
            var ctor = world.GetConstructor(Inst, null, new[] { typeof(string), typeof(string) }, null);
            if (ctor == null) throw Bind("World(string name, string seed)");
            return ctor.Invoke(new object[] { name, seed });
        }

        public void SetField(object o, string name, object value, bool required)
        {
            var f = world.GetField(name, Inst);
            if (f == null || f.FieldType != value.GetType())
            {
                if (required) throw Bind("World." + name + " (" + value.GetType().Name + ")");
                return;
            }
            f.SetValue(o, value);
        }

        public object GetField(object o, string name)
        {
            var f = world.GetField(name, Inst);
            if (f == null || f.FieldType != typeof(int)) throw Bind("World." + name + " (int)");
            return f.GetValue(o);
        }

        // Version.GetVersionString(bool includeMercurialHash = false) in 1.0; any
        // overload whose parameters all have defaults will do.
        public string VersionString()
        {
            if (version == null) return "unknown";
            foreach (var m in version.GetMethods(Stat).Where(m => m.Name == "GetVersionString" && m.ReturnType == typeof(string)).OrderBy(m => m.GetParameters().Length))
            {
                var ps = m.GetParameters();
                if (!ps.All(p => p.IsOptional && p.DefaultValue != DBNull.Value && p.DefaultValue != Missing.Value)) continue;
                var s = m.Invoke(null, ps.Select(p => p.DefaultValue).ToArray()) as string;
                if (!string.IsNullOrEmpty(s)) return s;
            }
            return "unknown";
        }

        public void Initialize(object w)
        {
            var init = generator.GetMethod("Initialize", Stat, null, new[] { world }, null);
            if (init == null) throw Bind("static WorldGenerator.Initialize(World)");
            init.Invoke(null, new[] { w });
            var p = generator.GetProperty("instance", Stat);
            var f = generator.GetField("instance", Stat) ?? generator.GetField("m_instance", Stat);
            gen = p != null ? p.GetValue(null, null) : f != null ? f.GetValue(null) : null;
            if (gen == null) throw Bind("WorldGenerator.instance after Initialize");
        }

        public void Deinitialize()
        {
            var m = generator.GetMethod("Deitialize", Stat, null, Type.EmptyTypes, null) ?? generator.GetMethod("Deinitialize", Stat, null, Type.EmptyTypes, null);
            if (m != null) m.Invoke(null, null);
        }

        // An argument for every parameter past the ones given: the declared
        // default, or a fresh local for an out parameter. null if one has neither.
        static Expression[] Rest(ParameterInfo[] ps, int from, out ParameterExpression[] locals)
        {
            var args = new Expression[ps.Length - from];
            var vars = new System.Collections.Generic.List<ParameterExpression>();
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

        Type biomeType;

        // GetBiome(float wx, float wz, [defaults...]) -> Heightmap.Biome, as (x, z) => int.
        public Func<float, float, int> BiomeSampler()
        {
            foreach (var m in generator.GetMethods(Inst).Where(m => m.Name == "GetBiome").OrderBy(m => m.GetParameters().Length))
            {
                var ps = m.GetParameters();
                if (ps.Length < 2 || ps[0].ParameterType != typeof(float) || ps[1].ParameterType != typeof(float) || !m.ReturnType.IsEnum) continue;
                ParameterExpression[] locals;
                var rest = Rest(ps, 2, out locals);
                if (rest == null) continue;
                var x = Expression.Parameter(typeof(float), "x");
                var z = Expression.Parameter(typeof(float), "z");
                var call = Expression.Call(Expression.Constant(gen), m, new Expression[] { x, z }.Concat(rest));
                var body = Expression.Block(typeof(int), locals, Expression.Convert(call, typeof(int)));
                biomeType = m.ReturnType;
                return Expression.Lambda<Func<float, float, int>>(body, x, z).Compile();
            }
            throw Bind("WorldGenerator.GetBiome(float, float, ...)");
        }

        // GetBiomeHeight(Biome, float wx, float wz, [out Color mask], [defaults...]) -> float, as (biome, x, z) => metres.
        public Func<int, float, float, float> HeightSampler()
        {
            foreach (var m in generator.GetMethods(Inst).Where(m => m.Name == "GetBiomeHeight").OrderBy(m => m.GetParameters().Length))
            {
                var ps = m.GetParameters();
                if (ps.Length < 3 || ps[0].ParameterType != biomeType || ps[1].ParameterType != typeof(float) || ps[2].ParameterType != typeof(float) || m.ReturnType != typeof(float)) continue;
                ParameterExpression[] locals;
                var rest = Rest(ps, 3, out locals);
                if (rest == null) continue;
                var b = Expression.Parameter(typeof(int), "biome");
                var x = Expression.Parameter(typeof(float), "x");
                var z = Expression.Parameter(typeof(float), "z");
                var call = Expression.Call(Expression.Constant(gen), m, new Expression[] { Expression.Convert(b, biomeType), x, z }.Concat(rest));
                var body = Expression.Block(typeof(float), locals, call);
                return Expression.Lambda<Func<int, float, float, float>>(body, b, x, z).Compile();
            }
            throw Bind("WorldGenerator.GetBiomeHeight(Biome, float, float, ...)");
        }
    }

    sealed class SkaldTerrainBindException : Exception
    {
        public SkaldTerrainBindException(string what) : base("not found in this game build: " + what) { }
    }
}
