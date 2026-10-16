import type { AgentSource } from "./agent";
import { applyEvent } from "./apply";
import type { HistoryStore } from "./db";
import { deriveHistory, RANKING_EVENTS, WEEK_MS } from "./history";
import { cause, log as defaultLog, type Logger } from "./log";
import { deriveProfiles } from "./profiles";
import { emptyAgentState, isBridgeRead, UNSTORED_EVENTS, type AgentEvent, type AgentEventType, type AgentState, type History, type LiveMessage, type LivePlayer, type PlayerProfile } from "./types";

/** Live positions go out at most this often, whatever the agent sends. */
const POSITIONS_EVERY_MS = 2_000;
/** How often the agent's positions lease is renewed while someone watches; the agent holds it 30 s. */
const POSITIONS_RENEW_MS = 10_000;
/** Stored events within this window share one history delta (a replay can store hundreds at once). */
const HISTORY_DELTA_MS = 1_000;

/** A boot prune that frees at least this many rows also shrinks the file. */
const VACUUM_AFTER_ROWS = 1_000;

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
  /** How often the history is pruned while running (see `HistoryStore.prune`). */
  pruneEveryMs?: number;
  /** How long stored events are gathered before one history delta goes out. */
  historyDeltaMs?: number;
  /** IANA zone for profile calendar days. */
  timeZone?: string;
  clock?: () => number;
  /** Where lost agent connections are reported; the process-wide logger by default. */
  log?: Logger;
  /** Renewal of the agent's positions lease; tests shorten it. */
  positionsRenewMs?: number;
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
  /** Each listener, and whether it takes "history" messages (browsers that asked; the notifier does not). */
  private listeners = new Map<(m: LiveMessage) => void, boolean>();
  private abort: AbortController | null = null;
  private stopped = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private eventsCache: { at: number; value: AgentEvent[] } | null = null;
  private historyCache: { at: number; value: History } | null = null;
  private positions: Extract<LiveMessage, { type: "positions" }> | null = null;
  private positionsSentAt = 0;
  private positionsTimer: ReturnType<typeof setTimeout> | null = null;
  private positionsWatchers = new Set<(m: LiveMessage) => void>();
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  /** Lease calls go out one after another, so an end never overtakes a later start. */
  private watchChain: Promise<void> = Promise.resolve();
  private profilesCache: { at: number; value: PlayerProfile[] } | null = null;
  /** The agent connection failed and has not come back yet: the next success is logged. */
  private down = false;
  private historyTimer: ReturnType<typeof setTimeout> | null = null;
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
      pruneEveryMs: opts.pruneEveryMs ?? 3_600_000,
      historyDeltaMs: opts.historyDeltaMs ?? HISTORY_DELTA_MS,
      timeZone: opts.timeZone ?? "UTC",
      clock: opts.clock ?? Date.now,
      log: opts.log ?? defaultLog,
      positionsRenewMs: opts.positionsRenewMs ?? POSITIONS_RENEW_MS,
    };
    this.bootPrune();
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

  /**
   * Everything but live positions: state, events, and with `history` the
   * rankings deltas.
   */
  subscribe(fn: (m: LiveMessage) => void, opts: { history?: boolean } = {}): () => void {
    this.listeners.set(fn, opts.history === true);
    return () => this.listeners.delete(fn);
  }

  /**
   * Live positions for one watcher (a socket with the map or a player list
   * open): the latest sample at once, then every new one. The agent polls
   * the game only while there is at least one watcher.
   */
  watchPositions(fn: (m: LiveMessage) => void): () => void {
    if (!this.positionsWatchers.has(fn)) {
      this.positionsWatchers.add(fn);
      const latest = this.latestPositions();
      if (latest) fn(latest);
      if (this.positionsWatchers.size === 1) this.setWatching(true);
    }
    return () => {
      if (this.positionsWatchers.delete(fn) && this.positionsWatchers.size === 0) this.setWatching(false);
    };
  }

  /** Starts or ends the agent's positions lease; renewed while anyone watches. */
  private setWatching(on: boolean): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    if (this.stopped) return;
    if (on) this.watchTimer = setInterval(() => this.tellAgent(true), this.opts.positionsRenewMs);
    this.tellAgent(on);
  }

  private tellAgent(on: boolean): void {
    const watch = this.agent.watchPositions?.bind(this.agent);
    if (!watch) return;
    // An agent older than the lease answers 404 and polls whenever someone plays.
    this.watchChain = this.watchChain.then(() => watch(on)).catch(() => {});
  }

  history(): History {
    const now = this.opts.clock();
    if (this.historyCache && now - this.historyCache.at < this.opts.historyCacheMs) return this.historyCache.value;
    const value = deriveHistory(this.events(now), now);
    this.historyCache = { at: now, value };
    return value;
  }

  profiles(): PlayerProfile[] {
    const now = this.opts.clock();
    if (this.profilesCache && now - this.profilesCache.at < this.opts.historyCacheMs) return this.profilesCache.value;
    const value = deriveProfiles(this.events(now), now, this.opts.timeZone);
    this.profilesCache = { at: now, value };
    return value;
  }

  /** The stored events, loaded and parsed once per cache window for both folds. */
  private events(now: number): AgentEvent[] {
    if (this.eventsCache && now - this.eventsCache.at < this.opts.historyCacheMs) return this.eventsCache.value;
    const value = this.store.all();
    this.eventsCache = { at: now, value };
    return value;
  }

  /** Cleanup is optional: a full disk or a locked file must not stop the panel. */
  private bootPrune(): void {
    try {
      const n = this.store.pruneBridgeReads() + this.prune();
      if (n >= VACUUM_AFTER_ROWS) this.store.vacuum();
    } catch (err) {
      this.opts.log.warn("history prune at startup failed", { cause: cause(err) });
    }
  }

  private prune(): number {
    return this.store.prune(this.opts.clock() - WEEK_MS);
  }

  start(): void {
    void this.loop();
    this.timers.push(setInterval(() => void this.pollState(), this.opts.statePollMs));
    this.timers.push(
      setInterval(() => {
        try {
          this.prune();
        } catch (err) {
          this.opts.log.warn("history prune failed", { cause: cause(err) });
        }
      }, this.opts.pruneEveryMs),
    );
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    for (const t of this.timers) clearInterval(t);
    if (this.positionsTimer) clearTimeout(this.positionsTimer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    if (this.historyTimer) clearTimeout(this.historyTimer);
  }

  /**
   * Sends the rankings and the 7-day series once stored events settle, so the
   * clients never refetch /api/state for them: one derive for everyone.
   */
  private historySoon(): void {
    if (this.historyTimer || this.stopped) return;
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null;
      if (![...this.listeners.values()].includes(true)) return;
      const { players, online7d } = this.history();
      this.emit({ type: "history", players, online7d });
    }, this.opts.historyDeltaMs);
  }

  /**
   * The latest live positions, for a new watcher; null when none. Never too
   * old to hand out: the agent sends only changes while it polls and an empty
   * list when it stops, and a lost stream drops the sample.
   */
  latestPositions(): LiveMessage | null {
    return this.positions;
  }

  /**
   * Live positions: never stored, never part of the replay, and passed on at
   * most every 2 s (a newer sample replaces one still waiting).
   */
  private positionsEvent(ev: AgentEvent): void {
    const players = Array.isArray(ev.data.players) ? (ev.data.players as LivePlayer[]) : [];
    const t = Number(ev.data.t) || Date.parse(ev.ts) || this.opts.clock();
    const now = this.opts.clock();
    this.positions = { type: "positions", t, players };
    if (this.positionsTimer) return;
    const wait = this.positionsSentAt + POSITIONS_EVERY_MS - now;
    const send = () => {
      this.positionsTimer = null;
      this.positionsSentAt = this.opts.clock();
      if (this.positions) this.emitPositions(this.positions);
    };
    if (wait <= 0) send();
    else this.positionsTimer = setTimeout(send, wait);
  }

  /** Persists + broadcasts one agent event. Exposed for tests. */
  ingest(epoch: string, ev: AgentEvent): void {
    // Volatile (seq 0): not part of the sequence the stream resumes from.
    if (ev.type === "positions") return this.positionsEvent(ev);
    if (isBridgeRead(ev)) return;
    if (epoch === this.epoch && ev.seq <= this.lastSeq) return;
    this.epoch = epoch;
    this.lastSeq = ev.seq;
    // Keep the served state as fresh as the stream; replayed events predate the
    // last /state fetch and are already reflected in it.
    if (Date.parse(ev.ts) >= Date.parse(this.state.now)) {
      this.state = applyEvent(this.state, ev);
      if (ev.type === "log") this.state = { ...this.state, agent: { ...this.state.agent, lastLogAt: ev.ts } };
    }
    let stored = false;
    if (!UNSTORED_EVENTS.includes(ev.type)) {
      const key = ON_CHANGE[ev.type]?.(ev.data);
      const changed = key === undefined || this.lastValue.get(ev.type) !== key;
      if (key !== undefined) this.lastValue.set(ev.type, key);
      if (changed && this.store.insert(epoch, ev)) {
        this.store.setMeta("lastSeq", String(ev.seq));
        this.eventsCache = null;
        this.historyCache = null;
        this.profilesCache = null;
        stored = true;
      }
    }
    this.emit({ type: "event", event: ev, stored });
    if (stored && RANKING_EVENTS.includes(ev.type)) this.historySoon();
    // A restart with new settings renames the server; fetch it now, not at the next poll.
    if (ev.type === "settings_apply" && ev.data.state === "applied" && !this.stopped) void this.pollState();
  }

  private emit(m: LiveMessage): void {
    for (const [fn, history] of this.listeners) {
      if (m.type === "history" && !history) continue;
      this.deliver(fn, m);
    }
  }

  private emitPositions(m: LiveMessage): void {
    for (const fn of this.positionsWatchers) this.deliver(fn, m);
  }

  private deliver(fn: (m: LiveMessage) => void, m: LiveMessage): void {
    try {
      fn(m);
    } catch (e) {
      // a broken listener must not stop the others
      this.opts.log.error("live listener failed", { cause: cause(e) });
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
    } catch (e) {
      this.stateOk = false;
      // While the stream is down, the loop already reports the outage.
      if (this.streaming && !this.stopped) this.opts.log.warn("agent state poll failed", { cause: cause(e) });
    }
    this.emit({ type: "state", state: this.state, online: this.online });
  }

  private async loop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      let failure: unknown = "stream ended";
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
        // A restarted agent forgot the lease; do not wait for the renewal.
        if (this.positionsWatchers.size > 0) this.tellAgent(true);
        this.abort = new AbortController();
        this.streaming = true;
        this.emit({ type: "state", state: this.state, online: this.online });
        await this.agent.stream(since, (ev) => {
          attempt = 0;
          // The first event proves the stream works, not just /state.
          if (this.down) {
            this.down = false;
            this.opts.log.info("agent reachable again");
          }
          this.ingest(epoch, ev);
        }, this.abort.signal);
      } catch (e) {
        failure = e;
      }
      const wasOnline = this.online;
      this.streaming = false;
      this.positions = null;
      if (this.stopped) return;
      // Rate-limited by the logger: a dead agent prints about once a minute.
      this.down = true;
      this.opts.log.warn("agent stream lost", { cause: cause(failure), retryMs: Math.min(this.opts.maxBackoffMs, 1000 * 2 ** attempt) });
      if (wasOnline || this.hasState) this.emit({ type: "state", state: this.state, online: false });
      const delay = Math.min(this.opts.maxBackoffMs, 1000 * 2 ** attempt);
      attempt += 1;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
