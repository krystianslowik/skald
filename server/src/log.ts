/**
 * One JSON line per event on stderr, shaped like the agent's slog output
 * (`time`, `level`, `msg`, then fields). Callers pass only what is safe to
 * print: a route pattern, a status, an error cause. Never a password, cookie,
 * token, webhook URL, request body or player id.
 */

export type Level = "INFO" | "WARN" | "ERROR";
export type Fields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

export interface LoggerOptions {
  /** Where a finished line goes; stderr by default. */
  write?: (line: string) => void;
  clock?: () => number;
  /**
   * The same message for the same route (and client address, when there is
   * one) is printed at most once per window; the next line printed for it
   * says how many were dropped in between.
   */
  windowMs?: number;
}

const MAX_CAUSE = 200;

/**
 * The text of a thrown value, short, with any `user:password@` and query
 * string in a URL removed, so a credential in PROM_URL or AGENT_URL never
 * reaches the log.
 */
export function cause(e: unknown): string {
  const text = e instanceof Error ? e.message || e.name : String(e);
  const clean = text
    .replace(/([a-z][\w+.-]*:\/\/)[^\s@]*@/gi, "$1")
    .replace(/(:\/\/[^\s?]*)\?\S*/g, "$1?...")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > MAX_CAUSE ? `${clean.slice(0, MAX_CAUSE)}...` : clean;
}

export function createLogger(o: LoggerOptions = {}): Logger {
  const write = o.write ?? ((line: string) => console.error(line));
  const clock = o.clock ?? Date.now;
  const windowMs = o.windowMs ?? 60_000;
  // key -> when it was last printed and how many were dropped since.
  const seen = new Map<string, { at: number; dropped: number }>();

  const emit = (level: Level, msg: string, fields: Fields = {}) => {
    const now = clock();
    const key = `${level}|${msg}|${fields.route ?? ""}|${fields.ip ?? ""}`;
    const last = seen.get(key);
    if (last && now - last.at < windowMs) {
      last.dropped += 1;
      return;
    }
    const line: Record<string, unknown> = { time: new Date(now).toISOString(), level, msg };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) line[k] = v;
    if (last?.dropped) line.suppressed = last.dropped;
    seen.set(key, { at: now, dropped: 0 });
    if (seen.size > 500) {
      for (const [k, s] of seen) if (now - s.at >= windowMs && !s.dropped) seen.delete(k);
    }
    write(JSON.stringify(line));
  };

  return {
    info: (msg, fields) => emit("INFO", msg, fields),
    warn: (msg, fields) => emit("WARN", msg, fields),
    error: (msg, fields) => emit("ERROR", msg, fields),
  };
}

/** The process-wide logger, for code that is not handed one. */
export const log: Logger = createLogger();

/** For tests: drops everything. */
export const silentLog: Logger = { info() {}, warn() {}, error() {} };
