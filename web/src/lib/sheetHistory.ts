// Sheets and the Back button. Every open sheet holds one history entry on top
// of the page's own (same URL, so the hash tabs do not see it), and Back closes
// the top sheet instead of changing the tab underneath or leaving the panel. A
// sheet closed any other way releases its entry, which is stepped back over.
//
// Entries are counted, not owned: a sheet that replaces another in the same
// render (the admin panel handing over to a fill, a profile re-keyed to another
// name) inherits its entry, because pushes and pops are reconciled once, after
// the render, and never in the middle of one. Our own traversals are tracked so
// their popstate is not mistaken for the user's Back.

const KEY = "skaldSheet";
/** A traversal that never arrives (out of range, a blocked navigation) stops blocking after this. */
const WATCHDOG_MS = 1000;

export interface SheetHandle {
  /** Close the sheet now: its history entry is already gone. */
  close: () => void;
}
// Known gaps: a Back pressed while one of our own traversals is still on its way
// is taken for that traversal, and after a reload with a sheet open its old
// entry stays behind as a same-URL step.

/** Sheets that hold, or are about to hold, an entry; bottom first. */
const stack: SheetHandle[] = [];
/** Sheet entries on top of the page's history right now. */
let depth = 0;
/** One of our own traversals is on its way; history is settled once its popstate arrives. */
let pending = false;
let watchdog: ReturnType<typeof setTimeout> | undefined;
let after: (() => void)[] = [];
/** Waiting for history to settle: every push and step of ours has landed. */
let settled: (() => void)[] = [];
/** history.length after the last entry we know of: the page's own pushes and links handled. */
let known = 0;
let scheduled = false;
let ready = false;

type Entry = Record<string, unknown> | null;
const stateDepth = (): number => {
  const n = (history.state as Entry)?.[KEY];
  return typeof n === "number" && n > 0 ? n : 0;
};

function init() {
  if (ready || typeof window === "undefined") return;
  ready = true;
  known = history.length;
  // A reload keeps history.state: an entry left by a sheet that is gone now is a plain entry.
  if (stateDepth() > 0) {
    const rest: Record<string, unknown> = { ...(history.state as Record<string, unknown>) };
    delete rest[KEY];
    history.replaceState(Object.keys(rest).length ? rest : null, "");
  }
  window.addEventListener("popstate", onPop);
}

function arrived() {
  pending = false;
  clearTimeout(watchdog);
  depth = stateDepth();
  const fns = after;
  after = [];
  for (const f of fns) f();
  schedule();
}

function onPop() {
  if (pending) return arrived();
  const d = stateDepth();
  if (d < depth) {
    // Back: every sheet above the entry it landed on closes, the top one first.
    const gone = stack.splice(d);
    depth = d;
    for (const s of gone.reverse()) s.close();
  } else depth = d;
  schedule();
}

/** Moves through history and holds every reconcile until it lands; `then` runs on arrival. */
export function traverse(delta: number, then?: () => void) {
  init();
  if (then) after.push(then);
  if (delta === 0) {
    if (!pending) arrived();
    return;
  }
  pending = true;
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    if (pending) arrived();
  }, WATCHDOG_MS);
  history.go(delta);
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(flush);
}

function flush() {
  scheduled = false;
  if (pending) return;
  const want = stack.length;
  if (want > depth) {
    for (let i = depth; i < want; i++) history.pushState({ ...((history.state as Entry) ?? {}), [KEY]: i + 1 }, "");
    depth = want;
    noteEntries();
  } else if (want < depth) traverse(want - depth);
  // A step back is on its way: its arrival reconciles again and lands here.
  if (pending) return;
  const fns = settled;
  settled = [];
  for (const f of fns) f();
}

/**
 * Runs `then` once every sheet entry is in place, so it can change the top
 * entry (an open sheet's own address) and not the page's beneath it.
 */
export function whenSettled(then: () => void) {
  init();
  settled.push(then);
  schedule();
}

/**
 * A sheet is open: it holds an entry (or inherits the one a sheet closing in
 * the same render leaves). Idempotent, so a sheet grabbed back while leaving
 * can hold one again.
 */
export function holdSheet(h: SheetHandle) {
  init();
  if (stack.includes(h)) return;
  stack.push(h);
  schedule();
}

/** A sheet is gone (closed by its owner, or unmounted): its entry goes too, unless another sheet takes it. */
export function releaseSheet(h: SheetHandle) {
  const i = stack.indexOf(h);
  if (i < 0) return;
  stack.splice(i, 1);
  schedule();
}

/**
 * The hash tabs move only from the page's own entry: with sheets open, step
 * back over their entries first and run `then` once there. Sheets that stay
 * open get fresh entries on top afterwards. False when there is nothing to
 * step over (the caller goes ahead at once).
 */
export function leaveSheets(then: () => void): boolean {
  init();
  if (pending) {
    after.push(() => {
      if (!leaveSheets(then)) then();
    });
    return true;
  }
  if (depth === 0) return false;
  traverse(-depth, then);
  return true;
}

/** Every entry so far is accounted for: the page pushed one itself, or a link was handled. */
export function noteEntries() {
  init();
  known = history.length;
}

/**
 * Whether the browser stacked an entry we did not (a link followed as a new entry), as
 * opposed to replacing the current one or moving through history. Without the Navigation
 * API this is a count, so an entry stacked over pruned forward entries reads as a
 * replacement: the safe side, since only a stacked entry may be stepped back over.
 */
export function entryAdded(): boolean {
  init();
  return history.length > known;
}

/** Whether no other open sheet sits above this one (Escape closes only the top sheet). */
export const isTopSheet = (h: SheetHandle) => !stack.includes(h) || stack.at(-1) === h;

/** Sheet entries on top of history (tests). */
export const sheetDepth = () => depth;
/** Whether a traversal of ours is still on its way, or a reconcile about to start one. */
export const sheetPending = () => pending || scheduled;
