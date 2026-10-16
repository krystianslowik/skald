// The game container's processes as supervisord reports them, made readable:
// the ones that matter by what they do, a one-shot that finished as done
// rather than a red "exited", and the container's plumbing (cron, syslog)
// folded into one "system" line.

/** How a state reads: fine, busy (on its way), idle (stopped on purpose) or a problem. */
export type ProcessTone = "ok" | "busy" | "idle" | "bad";

export interface ProcessRow {
  /** i18n key of the name: `process.<name>`, or `process.system` for the plumbing. */
  key: string;
  /** The supervisord name(s) behind it, for the tooltip. */
  names: string[];
  /** i18n key of the state: `processState.<state>`. */
  state: string;
  tone: ProcessTone;
}

/** Processes the panel names; the rest of `valheim-*` keep their own name. */
const KNOWN = ["valheim-server", "valheim-backup", "valheim-updater", "valheim-bootstrap"];

/** Run once at start and expected to exit: EXITED is their success. */
const ONE_SHOT = new Set(["valheim-bootstrap"]);

const TONE: Record<string, ProcessTone> = {
  running: "ok",
  done: "ok",
  starting: "busy",
  stopping: "busy",
  backoff: "bad",
  stopped: "idle",
  exited: "bad",
  fatal: "bad",
  unknown: "bad",
};

function stateOf(name: string, raw: string): string {
  const s = raw.toLowerCase();
  if (s === "exited" && ONE_SHOT.has(name)) return "done";
  return s in TONE ? s : "unknown";
}

/**
 * The rows to show, game first: the known processes in a fixed order, other
 * `valheim-*` ones after them, and everything else as one system row that is
 * fine while all of it runs and otherwise takes its worst state.
 */
export function processRows(processes: Readonly<Record<string, string>>): ProcessRow[] {
  const rows: ProcessRow[] = [];
  const plumbing: string[] = [];
  const names = Object.keys(processes).sort((a, b) => {
    const ia = KNOWN.indexOf(a);
    const ib = KNOWN.indexOf(b);
    return (ia < 0 ? KNOWN.length : ia) - (ib < 0 ? KNOWN.length : ib) || a.localeCompare(b);
  });
  for (const name of names) {
    if (!name.startsWith("valheim-")) {
      plumbing.push(name);
      continue;
    }
    const state = stateOf(name, processes[name]!);
    rows.push({ key: `process.${name}`, names: [name], state: `processState.${state}`, tone: TONE[state]! });
  }
  if (plumbing.length) {
    const states = plumbing.map((n) => stateOf(n, processes[n]!));
    const order: ProcessTone[] = ["bad", "busy", "idle", "ok"];
    const worst = states.reduce((w, s) => (order.indexOf(TONE[s]!) < order.indexOf(TONE[w]!) ? s : w), "running");
    rows.push({ key: "process.system", names: plumbing, state: `processState.${worst}`, tone: TONE[worst]! });
  }
  return rows;
}
