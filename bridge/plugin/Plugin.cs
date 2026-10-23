// Skald bridge: a server-side BepInEx plugin that exposes a few admin commands
// over HTTP on 127.0.0.1 to the Skald agent sidecar in the same pod.
//
// It calls the operator's own installed game code at runtime through its public
// API and contains no game code.
using System;
using System.Collections.Concurrent;
using System.Reflection;
using System.Threading;
using BepInEx;
using BepInEx.Logging;

namespace Skald.Bridge
{
    [BepInPlugin(Guid, "Skald Bridge", Version)]
    public class SkaldBridgePlugin : BaseUnityPlugin
    {
        public const string Guid = "dev.skald.bridge";
        public const string Version = "0.8.0";
        public const string Prefix = "[SkaldBridge]";

        internal static ManualLogSource Log;
        internal static volatile bool Disabled;
        internal static string DisabledReason = "";
        // Set by /v1/time/freeze: the net time is pinned to this value every frame.
        internal static double? FrozenNetTime;

        static readonly ConcurrentQueue<MainThreadJob> Queue = new ConcurrentQueue<MainThreadJob>();
        HttpServer server;

        void Awake()
        {
            Log = Logger;
            string mode = Env("SKALD_BRIDGE", "on").Trim().ToLowerInvariant();
            if (mode == "off" || mode == "false" || mode == "0")
            {
                Info("loaded, kill switch SKALD_BRIDGE=off: serving nothing");
                return;
            }
            string token = Env("SKALD_BRIDGE_TOKEN", "");
            if (token.Length < 16)
            {
                Info("loaded, SKALD_BRIDGE_TOKEN missing or shorter than 16 characters: serving nothing");
                return;
            }
            if (!int.TryParse(Env("SKALD_BRIDGE_PORT", "9010"), out int port) || port < 1 || port > 65535)
            {
                Info("loaded, SKALD_BRIDGE_PORT invalid: serving nothing");
                return;
            }

            string missing = Binding.Check();
            if (missing != null)
            {
                Disable("game API binding failed (" + missing + "), game build " + SafeGameVersion());
                return;
            }

            try
            {
                server = new HttpServer(port, token);
                server.Start();
                Info("loaded v" + Version + ", listening on 127.0.0.1:" + port + ", game build " + SafeGameVersion());
                // Optional, and before any player connects: without it only
                // the link round trip goes blank.
                Link.Hook();
            }
            catch (Exception e)
            {
                Disable("could not start listener on 127.0.0.1:" + port + ": " + e.Message);
            }
        }

        void Update()
        {
            if (FrozenNetTime.HasValue && !Disabled)
            {
                try
                {
                    var net = ZNet.instance;
                    if (net != null && net.IsServer()) net.SetNetTime(FrozenNetTime.Value);
                }
                catch (Exception e)
                {
                    FrozenNetTime = null;
                    Warn("time freeze dropped: " + e.Message);
                }
            }
            if (!Disabled) Link.Tick();
            // Drain on the Unity main thread. Bound the work per frame so a burst
            // of requests cannot stall the game loop.
            var started = DateTime.UtcNow;
            for (int i = 0; i < 16 && Queue.TryDequeue(out var job); i++)
            {
                job.Run();
                if ((DateTime.UtcNow - started).TotalMilliseconds > 20) break;
            }
        }

        void OnDestroy()
        {
            server?.Stop();
        }

        // Runs fn on the main thread and waits up to timeoutMs for the result.
        internal static object RunOnMainThread(Func<object> fn, int timeoutMs)
        {
            var job = new MainThreadJob(fn);
            Queue.Enqueue(job);
            return job.Wait(timeoutMs);
        }

        internal static new void Info(string msg) { Log?.LogInfo(Prefix + " " + msg); }
        internal static void Warn(string msg) { Log?.LogWarning(Prefix + " " + msg); }

        // Logs exactly one line, then every request answers 503.
        internal static void Disable(string reason)
        {
            if (Disabled) return;
            DisabledReason = reason;
            Disabled = true;
            Log?.LogError(Prefix + " disabled: " + reason);
        }

        internal static string SafeGameVersion()
        {
            try { return global::Version.GetVersionString(); } catch { return "unknown"; }
        }

        static string Env(string k, string d)
        {
            var v = Environment.GetEnvironmentVariable(k);
            return string.IsNullOrEmpty(v) ? d : v;
        }
    }

    sealed class MainThreadJob
    {
        readonly Func<object> fn;
        readonly ManualResetEventSlim done = new ManualResetEventSlim(false);
        int state; // 0 queued, 1 running/finished, 2 abandoned by the caller
        object result;
        System.Runtime.ExceptionServices.ExceptionDispatchInfo error;

        public MainThreadJob(Func<object> fn) { this.fn = fn; }

        public void Run()
        {
            if (Interlocked.CompareExchange(ref state, 1, 0) != 0) return;
            try { result = fn(); }
            catch (Exception e) { error = System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(e); }
            finally { done.Set(); }
        }

        public object Wait(int timeoutMs)
        {
            if (!done.Wait(timeoutMs))
            {
                // Not started yet: drop it so it never runs late. Already running:
                // let it finish, the caller just stops waiting.
                if (Interlocked.CompareExchange(ref state, 2, 0) == 0)
                    throw new TimeoutException("game main thread did not pick up the command in time");
                if (!done.Wait(timeoutMs))
                    throw new TimeoutException("command did not finish in time");
            }
            error?.Throw();
            return result;
        }
    }

    // Startup probe of every game member the commands touch. Code compiled
    // against the game DLLs only fails lazily at JIT time, so this runs first and
    // the dispatcher also catches MissingMember/TypeLoad exceptions.
    static class Binding
    {
        const BindingFlags Pub = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static;

        // Built inside Check so a missing game type surfaces in its try/catch
        // rather than as a TypeInitializationException.
        static (Type type, string member)[] Required() => new (Type, string)[]
        {
            (typeof(ZNet), "Save"), (typeof(ZNet), "Kick"), (typeof(ZNet), "Ban"), (typeof(ZNet), "Unban"),
            (typeof(ZNet), "get_Banned"), (typeof(ZNet), "GetPeers"), (typeof(ZNet), "GetPlayerList"),
            (typeof(ZNet), "SetNetTime"), (typeof(ZNet), "GetTimeSeconds"), (typeof(ZNet), "IsServer"),
            (typeof(ZNetPeer), "m_uid"), (typeof(ZNetPeer), "m_playerName"), (typeof(ZNetPeer), "m_refPos"),
            (typeof(ZNetPeer), "m_characterID"), (typeof(ZNetPeer), "m_socket"),
            (typeof(ZRoutedRpc), "InvokeRoutedRPC"),
            (typeof(EnvMan), "SkipToMorning"), (typeof(EnvMan), "GetDay"), (typeof(EnvMan), "GetDayFraction"),
            (typeof(EnvMan), "m_dayLengthSec"),
            (typeof(RandEventSystem), "SetRandomEventByName"), (typeof(RandEventSystem), "ResetRandomEvent"),
            (typeof(RandEventSystem), "GetCurrentRandomEvent"), (typeof(RandEventSystem), "m_events"),
            (typeof(RandomEvent), "m_name"),
            (typeof(ZoneSystem), "GetGlobalKeys"), (typeof(ZoneSystem), "SetGlobalKey"), (typeof(ZoneSystem), "RemoveGlobalKey"),
            (typeof(ObjectDB), "GetItemPrefab"), (typeof(ItemDrop), "SetStack"), (typeof(ItemDrop), "SetQuality"),
            (typeof(ItemDrop), "m_itemData"),
            (typeof(ZDOMan), "GetZDO"), (typeof(ZDO), "GetFloat"), (typeof(ZDO), "GetPosition"),
            (typeof(ZDOVars), "s_health"), (typeof(ZDOVars), "s_maxHealth"), (typeof(ZDOVars), "s_content"),
            (typeof(Fermenter), "m_conversion"),
            (typeof(WorldGenerator), "GetHeight"),
            // POST /v1/containers/add (Chests.cs).
            (typeof(ZDOVars), "s_items"), (typeof(ZDOVars), "s_inUse"), (typeof(ZDO), "GetByteArray"), (typeof(ZDO), "GetInt"),
            (typeof(ZDO), "SetOwner"), (typeof(ZDO), "GetPrefab"), (typeof(ZDOMan), "ForceSendZDO"), (typeof(ZDOMan), "GetSessionID"),
            (typeof(Inventory), "Load"), (typeof(Inventory), "Save"), (typeof(Inventory), "AddItem"), (typeof(Inventory), "GetAllItems"),
            (typeof(Inventory), "NrOfItems"), (typeof(Inventory), "SetHeight"), (typeof(Inventory), "GetWidth"), (typeof(Inventory), "GetHeight"),
            (typeof(Container), "m_width"), (typeof(Container), "m_height"), (typeof(Container), "m_wagon"), (typeof(Container), "m_name"),
            (typeof(ZPackage), "GetArray"), (typeof(Game), "m_worldLevel"),
        };

        // Returns null when everything binds, otherwise "Type.member".
        public static string Check()
        {
            try
            {
                foreach (var (type, member) in Required())
                    if (type.GetMember(member, Pub).Length == 0) return type.Name + "." + member;
                return null;
            }
            catch (Exception e)
            {
                return e.GetType().Name + ": " + e.Message;
            }
        }
    }
}
