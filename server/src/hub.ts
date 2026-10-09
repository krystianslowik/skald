import type { AgentSource } from "./agent";
import { applyEvent } from "./apply";
import type { HistoryStore } from "./db";
import { deriveHistory } from "./history";
import { deriveProfiles } from "./profiles";
import { emptyAgentState, UNSTORED_EVENTS, type AgentEvent, type AgentEventType, type AgentState, type History, type LiveMessage, type PlayerProfile } from "./types";

/** Types the agent re-emits without a change; stored only when the value moves. */
const ON_CHANGE: Partial<Record<AgentEventType, (d: Record<string, unknown>) => string>> = {
  player_count: (d) => String(d.count),
  join_code: (d) => String(d.code),
  playfab: (d) => String(d.state),
  version: (d) => `${d.version}/${d.networkVersion}`,
  server_state: (d) => String(d.status),
};

export interface HubOptions {
  statePollMs?: number;
  maxBackoffMs?: number;
  historyCacheMs?: number;
  /** IANA zone for profile calendar days. */
  timeZone?: string;
  clock?: () => number;
}

/**
 * Owns the single SSE connection to the agent: reconnects with backoff, resumes
 * with `since`, persists notable events, and fans everything out to listeners.
 */
export class Hub {
  private state: AgentState = emptyAgentState();
  private hasState = false;
  private streaming = false;
  private stateOk = false;
  private lastSeq = 0;
  private epoch = "";
  private lastValue = new Map<AgentEventType, string>();
  private listeners = new Set<(m: LiveMessage) => void>();
  private abort: AbortController | null = null;
  private stopped = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private historyCache: { at: number; value: History } | null = null;
  private profilesCache: { at: number; value: PlayerProfile[] } | null = null;
  private readonly opts: Required<HubOptions>;

  constructor(
    private readonly agent: AgentSource,
    private readonly store: HistoryStore,
    opts: HubOptions = {},
  ) {
    this.opts = {
      statePollMs: opts.statePollMs ?? 15_000,
      maxBackoffMs: opts.maxBackoffMs ?? 30_000,
      historyCacheMs: opts.historyCacheMs ?? 5_000,
      timeZone: opts.timeZone ?? "UTC",
      clock: opts.clock ?? Date.now,
    };
    for (const type of Object.keys(ON_CHANGE) as AgentEventType[]) {
      const ev = store.last(type);
      if (ev) this.lastValue.set(type, ON_CHANGE[type]!(ev.data));
    }
  }

  get online(): boolean {
    return this.streaming && this.stateOk;
  }

  getState(): AgentState {
    return this.state;
  }

  subscribe(fn: (m: LiveMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  history(): History {
    const now = this.opts.clock();
    if (this.historyCache && now - this.historyCache.at < this.opts.historyCacheMs) return this.historyCache.value;
    const value = deriveHistory(this.store.all(), now);
    this.historyCache = { at: now, value };
    return value;
  }

  profiles(): PlayerProfile[] {
    const now = this.opts.clock();
    if (this.profilesCache && now - this.profilesCache.at < this.opts.historyCacheMs) return this.profilesCache.value;
    const value = deriveProfiles(this.store.all(), now, this.opts.timeZone);
    this.profilesCache = { at: now, value };
    return value;
  }

  start(): void {
    void this.loop();
    this.timers.push(setInterval(() => void this.pollState(), this.opts.statePollMs));
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    for (const t of this.timers) clearInterval(t);
  }

  /** Persists + broadcasts one agent event. Exposed for tests. */
  ingest(epoch: string, ev: AgentEvent): void {
    if (epoch === this.epoch && ev.seq <= this.lastSeq) return;
    this.epoch = epoch;
    this.lastSeq = ev.seq;
    // Keep the served state as fresh as the stream; replayed events predate the
    // last /state fetch and are already reflected in it.
    if (Date.parse(ev.ts) >= Date.parse(this.state.now)) {
      this.state = applyEvent(this.state, ev);
      if (ev.type === "log") this.state = { ...this.state, agent: { ...this.state.agent, lastLogAt: ev.ts } };
    }
    if (!UNSTORED_EVENTS.includes(ev.type)) {
      const key = ON_CHANGE[ev.type]?.(ev.data);
      const changed = key === undefined || this.lastValue.get(ev.type) !== key;
      if (key !== undefined) this.lastValue.set(ev.type, key);
      if (changed && this.store.insert(epoch, ev)) {
        this.store.setMeta("lastSeq", String(ev.seq));
        this.historyCache = null;
        this.profilesCache = null;
      }
    }
    this.emit({ type: "event", event: ev });
  }

  private emit(m: LiveMessage): void {
    for (const fn of this.listeners) {
      try {
        fn(m);
      } catch {
        // a broken listener must not stop the others
      }
    }
  }

  private setState(s: AgentState): void {
    this.state = s;
    this.hasState = true;
    this.stateOk = true;
  }

  private async pollState(): Promise<void> {
    try {
      this.setState(await this.agent.getState());
    } catch {
      this.stateOk = false;
    }
    this.emit({ type: "state", state: this.state, online: this.online });
  }

  private async loop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        const st = await this.agent.getState();
        this.setState(st);
        const epoch = st.agent.startedAt;
        let since = 0;
        if (epoch === this.epoch) since = this.lastSeq;
        else if (this.store.getMeta("epoch") === epoch) since = Number(this.store.getMeta("lastSeq") ?? 0) || 0;
        if (epoch !== this.epoch) {
          this.epoch = epoch;
          this.lastSeq = since;
          this.store.setMeta("epoch", epoch);
          this.store.setMeta("lastSeq", String(since));
        }
        this.abort = new AbortController();
        this.streaming = true;
        this.emit({ type: "state", state: this.state, online: this.online });
        await this.agent.stream(since, (ev) => {
          attempt = 0;
          this.ingest(epoch, ev);
        }, this.abort.signal);
      } catch {
        // fall through to backoff
      }
      const wasOnline = this.online;
      this.streaming = false;
      if (this.stopped) return;
      if (wasOnline || this.hasState) this.emit({ type: "state", state: this.state, online: false });
      const delay = Math.min(this.opts.maxBackoffMs, 1000 * 2 ** attempt);
      attempt += 1;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
