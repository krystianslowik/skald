import { SseParser } from "./sse";
import type { ActionName, ActionResult, AgentEvent, AgentState, LogLine, SettingsRequest } from "./types";

export interface ActionResponse {
  status: number;
  body: ActionResult;
}

/** An agent answer passed through as is: status and JSON body. */
export interface Proxied {
  status: number;
  body: unknown;
}

/** Everything the web tier needs from the agent; implemented over HTTP and by the mock. */
export interface AgentSource {
  getState(): Promise<AgentState>;
  getLogs(limit: number): Promise<LogLine[]>;
  action(name: ActionName): Promise<ActionResponse>;
  /** Raw `GET /backups/{name}` response (streamed zip); the caller owns the body. */
  backup(name: string, signal: AbortSignal): Promise<Response>;
  /** Streams events with seq > since until the stream ends, errors, or `signal` aborts. */
  stream(since: number, onEvent: (e: AgentEvent) => void, signal: AbortSignal): Promise<void>;
  /** Server settings: 404 when the agent has the feature off. */
  settings(req: SettingsRequest): Promise<Proxied>;
}

const SETTINGS_ROUTE: Record<SettingsRequest["op"], [method: string, path: string]> = {
  get: ["GET", "/settings"],
  password: ["GET", "/settings/password"],
  put: ["PUT", "/settings"],
  apply: ["POST", "/settings/apply"],
  cancel: ["DELETE", "/settings/apply"],
};

const TIMEOUT_MS = 10_000;

export class HttpAgent implements AgentSource {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return { "X-Agent-Token": this.token };
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`agent ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  getState(): Promise<AgentState> {
    return this.getJson<AgentState>("/state");
  }

  async getLogs(limit: number): Promise<LogLine[]> {
    const body = await this.getJson<{ lines: LogLine[] }>(`/logs?limit=${limit}`);
    return body.lines ?? [];
  }

  async action(name: ActionName): Promise<ActionResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/action/${name}`, {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let body: ActionResult;
    try {
      body = (await res.json()) as ActionResult;
    } catch {
      body = { ok: res.ok, message: `HTTP ${res.status}` };
    }
    return { status: res.status, body };
  }

  async settings(req: SettingsRequest): Promise<Proxied> {
    const [method, path] = SETTINGS_ROUTE[req.op];
    const body = req.op === "put" ? JSON.stringify(req.body) : req.op === "apply" ? JSON.stringify({ mode: req.mode }) : undefined;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { ...this.headers(), "Content-Type": "application/json" } : this.headers(),
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = { ok: res.ok, message: `HTTP ${res.status}` };
    }
    return { status: res.status, body: json };
  }

  backup(name: string, signal: AbortSignal): Promise<Response> {
    // No timeout: a large zip to a slow client takes as long as it takes; the
    // client's disconnect aborts the upstream through `signal`.
    return this.fetchImpl(`${this.baseUrl}/backups/${encodeURIComponent(name)}`, { headers: this.headers(), signal });
  }

  async stream(since: number, onEvent: (e: AgentEvent) => void, signal: AbortSignal): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/events?since=${since}`, {
      headers: { ...this.headers(), Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`agent /events: HTTP ${res.status}`);
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    // The agent pings every 15 s; 45 s of silence means a dead connection.
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => void reader.cancel("idle timeout"), 45_000);
    };
    arm();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        arm();
        for (const data of parser.push(decoder.decode(value, { stream: true }))) {
          try {
            onEvent(JSON.parse(data) as AgentEvent);
          } catch {
            // malformed frame; skip
          }
        }
      }
    } finally {
      clearTimeout(idle);
    }
  }
}
