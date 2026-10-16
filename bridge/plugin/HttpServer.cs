using System;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Skald.Bridge
{
    // Loopback-only HTTP/JSON transport. Every request needs the shared token in
    // X-Skald-Token. The game work itself runs on the Unity main thread.
    sealed class HttpServer
    {
        const int MaxBody = 64 * 1024;
        const int CommandTimeoutMs = 5000;

        readonly HttpListener listener = new HttpListener();
        readonly byte[] tokenHash;
        Thread thread;
        volatile bool running;

        public HttpServer(int port, string token)
        {
            // Literal loopback address: never a wildcard, never another interface.
            listener.Prefixes.Add("http://127.0.0.1:" + port + "/");
            tokenHash = Sha256(token);
        }

        public void Start()
        {
            listener.Start();
            running = true;
            thread = new Thread(Loop) { IsBackground = true, Name = "SkaldBridgeHttp" };
            thread.Start();
        }

        public void Stop()
        {
            running = false;
            try { listener.Stop(); listener.Close(); } catch { }
        }

        void Loop()
        {
            while (running)
            {
                HttpListenerContext ctx;
                try { ctx = listener.GetContext(); }
                catch { if (!running) return; continue; }
                // One short-lived worker per request: the request thread only
                // parses and waits, the game work is serialised on the main thread.
                ThreadPool.QueueUserWorkItem(_ => Handle(ctx));
            }
        }

        void Handle(HttpListenerContext ctx)
        {
            var req = ctx.Request;
            int status = 200;
            object body;
            string actor = Clean(req.Headers["X-Skald-Actor"], 64);
            if (actor == "") actor = "unknown";
            string path = req.Url.AbsolutePath.TrimEnd('/');
            string cmd = req.HttpMethod + " " + path;
            Route route = null;
            try
            {
                if (!Authorised(req.Headers["X-Skald-Token"]))
                {
                    status = 401; body = Error("unauthorised");
                }
                else if (SkaldBridgePlugin.Disabled)
                {
                    status = 503; body = Error("bridge disabled: " + SkaldBridgePlugin.DisabledReason);
                }
                else
                {
                    JObject args = ReadBody(req);
                    route = Router.Find(req.HttpMethod, path);
                    if (route == null)
                    {
                        status = 404; body = Error("unknown command " + cmd);
                    }
                    else if (route.Broken != null)
                    {
                        status = 503; body = Error("command disabled: " + route.Broken);
                    }
                    else
                    {
                        if (route.Mutating)
                            SkaldBridgePlugin.Info("audit actor=" + actor + " cmd=" + cmd + " args=" + Compact(args));
                        body = route.OffThread ? route.Handler(args) : SkaldBridgePlugin.RunOnMainThread(() => route.Handler(args), CommandTimeoutMs);
                        if (route.Mutating)
                            SkaldBridgePlugin.Info("audit actor=" + actor + " cmd=" + cmd + " result=ok " + Compact(body));
                    }
                }
            }
            catch (CommandError e)
            {
                status = e.Status; body = Error(e.Message);
                SkaldBridgePlugin.Info("audit actor=" + actor + " cmd=" + cmd + " result=error " + e.Message);
            }
            catch (TimeoutException e)
            {
                status = 504; body = Error(e.Message);
                SkaldBridgePlugin.Warn("audit actor=" + actor + " cmd=" + cmd + " result=timeout");
            }
            catch (Exception e) when (e is MissingMemberException || e is TypeLoadException || e is TypeInitializationException)
            {
                // A game patch changed an API under this command: switch off just
                // this command, log one line, keep the server and the rest running.
                string why = e.GetType().Name + ": " + e.Message + " (game build " + SkaldBridgePlugin.SafeGameVersion() + ")";
                if (route != null && route.Broken == null)
                {
                    route.Broken = why;
                    SkaldBridgePlugin.Log?.LogError(SkaldBridgePlugin.Prefix + " command " + cmd + " disabled: " + why);
                }
                status = 503; body = Error("command disabled: " + why);
            }
            catch (Exception e)
            {
                status = 500; body = Error(e.GetType().Name + ": " + e.Message);
                SkaldBridgePlugin.Warn("audit actor=" + actor + " cmd=" + cmd + " result=exception " + e);
            }
            Write(ctx, status, body);
        }

        bool Authorised(string presented)
        {
            if (string.IsNullOrEmpty(presented)) return false;
            // Compare fixed-length hashes in constant time.
            var h = Sha256(presented);
            int diff = 0;
            for (int i = 0; i < h.Length; i++) diff |= h[i] ^ tokenHash[i];
            return diff == 0;
        }

        static JObject ReadBody(HttpListenerRequest req)
        {
            var args = new JObject();
            foreach (string k in req.QueryString.AllKeys)
                if (k != null) args[k] = req.QueryString[k];
            if (!req.HasEntityBody) return args;
            if (req.ContentLength64 > MaxBody) throw new CommandError(413, "body too large");
            string text;
            using (var r = new StreamReader(req.InputStream, Encoding.UTF8))
            {
                var buf = new char[MaxBody + 1];
                int n = r.ReadBlock(buf, 0, buf.Length);
                if (n > MaxBody) throw new CommandError(413, "body too large");
                text = new string(buf, 0, n);
            }
            if (string.IsNullOrWhiteSpace(text)) return args;
            JObject parsed;
            try { parsed = JObject.Parse(text); }
            catch (JsonException) { throw new CommandError(400, "body is not a JSON object"); }
            args.Merge(parsed);
            return args;
        }

        static void Write(HttpListenerContext ctx, int status, object body)
        {
            try
            {
                var raw = body as RawBody;
                var bytes = raw != null ? raw.Bytes : Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(body));
                ctx.Response.StatusCode = status;
                ctx.Response.ContentType = raw != null ? raw.ContentType : "application/json";
                ctx.Response.Headers["Cache-Control"] = "no-store";
                if (raw?.Headers != null)
                    foreach (var h in raw.Headers) ctx.Response.Headers[h.Key] = h.Value;
                ctx.Response.ContentLength64 = bytes.Length;
                ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
                ctx.Response.OutputStream.Close();
            }
            catch { }
        }

        static object Error(string msg) => new { ok = false, error = msg };

        static string Compact(object o)
        {
            string s = o is JToken t ? t.ToString(Formatting.None) : JsonConvert.SerializeObject(o);
            return s.Length > 400 ? s.Substring(0, 400) + "..." : s;
        }

        static string Clean(string s, int max)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new StringBuilder();
            foreach (char c in s)
            {
                if (sb.Length >= max) break;
                if (char.IsLetterOrDigit(c) || c == '-' || c == '_' || c == '.' || c == '@') sb.Append(c);
            }
            return sb.ToString();
        }

        static byte[] Sha256(string s)
        {
            using (var sha = SHA256.Create()) return sha.ComputeHash(Encoding.UTF8.GetBytes(s));
        }
    }

    // A non-JSON answer (a terrain tile), written as it is.
    sealed class RawBody
    {
        public readonly byte[] Bytes;
        public readonly string ContentType;
        public readonly System.Collections.Generic.IDictionary<string, string> Headers;
        public RawBody(byte[] bytes, string contentType, System.Collections.Generic.IDictionary<string, string> headers)
        {
            Bytes = bytes; ContentType = contentType; Headers = headers;
        }
    }

    sealed class CommandError : Exception
    {
        public readonly int Status;
        public CommandError(int status, string message) : base(message) { Status = status; }
    }
}
