import type { Proxied } from "./agent";
import { SAFE_RESTART_MAX_DEADLINE, SAFE_RESTART_MAX_WARN, SAFE_RESTART_STEPS, type SafeRestartRequest, type SafeRestartRun, type SafeRestartStepName, type SafeRestartStepState } from "./types";

/**
 * What MOCK_RESTART may ask for: a run that goes through, or one whose step
 * fails as the agent's would. A failed save only warns (the stop saves too);
 * a failed backup or verify still starts the game again.
 */
export const MOCK_RESTART_MODES = ["ok", "fail-save", "fail-backup", "fail-verify", "fail-start", "fail-recover"] as const;
export type MockRestartMode = (typeof MOCK_RESTART_MODES)[number];

/** A mock minute: a 5 minute countdown takes 10 s. */
export const MOCK_MINUTE_MS = 2_000;
/** How long the server must stay empty. */
const EMPTY_FOR_MS = 3_000;
const TICK_MS = 250;

/** The parts of the fake agent a run drives. */
export interface MockRestartHost {
  clock(): number;
  players(): string[];
  running(): boolean;
  /** Someone at the fire walks off (the evening winds down while the run waits). */
  leave(name: string): void;
  bridgeOn(): boolean;
  /** An in-game message, audited like an admin's. */
  broadcast(text: string, actor: string): void;
  /** A world save, with its log line. */
  save(): void;
  setStatus(status: "stopping" | "stopped" | "starting"): void;
  /** The game is up again: world loaded, join code, running. */
  boot(code: string | null): void;
  newCode(): string;
  /** The fake agent's action lock. */
  lock(): boolean;
  unlock(): void;
  addBackup(b: { name: string; sizeBytes: number; modifiedAt: string }): void;
  worldBytes(): number;
  emit(type: "restart_run", data: Record<string, unknown>): void;
  after(ms: number, fn: () => void): void;
}

const TEXT = {
  en: { min: "The server restarts in {n} min. Find a safe spot.", sec: "The server restarts in {n} s.", now: "The server restarts now. Back in a few minutes.", cancelled: "The server restart is called off." },
  pl: { min: "Restart serwera za {n} min. Znajdźcie bezpieczne miejsce.", sec: "Restart serwera za {n} s.", now: "Restart serwera teraz. Wracamy za kilka minut.", cancelled: "Restart serwera odwołany." },
};

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
};

/** The agent's safe restart (agent/internal/saferestart), on a mock clock. */
export class MockSafeRestart {
  private run: SafeRestartRun | null = null;
  private cancellable = false;
  private cancelled: string | null = null;

  constructor(
    private readonly host: MockRestartHost,
    private readonly mode: string = "ok",
  ) {}

  view(): SafeRestartRun | null {
    return this.run ? structuredClone(this.run) : null;
  }

  /** A run waits, counts down or restarts: plain restarts, restores and new joins wait. */
  active(): boolean {
    return this.run?.state === "running";
  }

  /** The run holds players back from joining: it is waiting for them to leave. */
  waiting(): boolean {
    return this.active() && this.run!.step === "wait";
  }

  start(body: SafeRestartRequest, actor: string): Proxied {
    const bad = (error: string): Proxied => ({ status: 400, body: { ok: false, error } });
    if (this.active()) return { status: 409, body: { ok: false, error: "a safe restart is already running" } };
    if (body.deadlineMinutes < 0 || body.deadlineMinutes > SAFE_RESTART_MAX_DEADLINE) return bad(`deadlineMinutes must be 0..${SAFE_RESTART_MAX_DEADLINE}`);
    if (body.warnMinutes < 0 || body.warnMinutes > SAFE_RESTART_MAX_WARN) return bad(`warnMinutes must be 0..${SAFE_RESTART_MAX_WARN}`);
    const now = this.host.clock();
    const request: SafeRestartRequest = { whenEmpty: body.whenEmpty, deadlineMinutes: body.whenEmpty ? body.deadlineMinutes : 0, warnMinutes: body.warnMinutes, locale: body.locale === "pl" ? "pl" : "en" };
    this.run = {
      id: stamp(now),
      actor,
      request,
      state: "running",
      step: "",
      steps: SAFE_RESTART_STEPS.map((name) => ({ name, state: "pending" as SafeRestartStepState })),
      startedAt: new Date(now).toISOString(),
      forced: false,
      warned: false,
      ...(request.whenEmpty && request.deadlineMinutes > 0 ? { deadline: new Date(now + request.deadlineMinutes * MOCK_MINUTE_MS).toISOString() } : {}),
    };
    this.cancellable = true;
    this.cancelled = null;
    this.publish("begin", "running");
    this.host.after(50, () => this.waitEmpty());
    return { status: 202, body: { ok: true, data: this.view() } };
  }

  cancel(actor: string): Proxied {
    if (!this.active()) return { status: 404, body: { ok: false, error: "no safe restart is running" } };
    if (!this.cancellable) return { status: 409, body: { ok: false, error: "the restart is past the point where it can be cancelled" } };
    this.cancelled = actor;
    return { status: 200, body: { ok: true } };
  }

  private publish(step: string, result: string): void {
    this.host.emit("restart_run", { step, result, actor: this.run!.actor, run: this.view() });
  }

  private set(name: SafeRestartStepName, state: SafeRestartStepState, reason = "", error = ""): void {
    const r = this.run!;
    const s = r.steps.find((x) => x.name === name)!;
    s.state = state;
    s.at = new Date(this.host.clock()).toISOString();
    if (reason) s.reason = reason;
    else delete s.reason;
    if (error) s.error = error;
    else delete s.error;
    r.step = name;
    this.publish(name, state);
  }

  private finish(state: "done" | "failed" | "cancelled", error = ""): void {
    const r = this.run!;
    r.state = state;
    r.endedAt = new Date(this.host.clock()).toISOString();
    if (error) r.error = error;
    if (state === "cancelled" && this.cancelled) r.cancelledBy = this.cancelled;
    this.cancellable = false;
    this.publish("end", state);
  }

  private say(key: keyof (typeof TEXT)["en"], n = 0): void {
    if (!this.host.bridgeOn()) return;
    this.host.broadcast(TEXT[this.run!.request.locale ?? "en"][key].replace("{n}", String(n)), this.run!.actor);
    if (key !== "cancelled" && key !== "now") this.run!.warned = true;
  }

  private stop(step: SafeRestartStepName): void {
    this.set(step, "cancelled");
    if (step === "countdown" && this.run!.warned) this.say("cancelled");
    this.finish("cancelled");
  }

  private waitEmpty(): void {
    const r = this.run!;
    if (!r.request.whenEmpty) {
      this.set("wait", "skipped", "now");
      return this.countdown();
    }
    this.set("wait", "running");
    let emptySince: number | null = null;
    let lastLeave = this.host.clock();
    const tick = () => {
      if (this.cancelled) return this.stop("wait");
      const now = this.host.clock();
      const players = this.host.players();
      if (players.length === 0) {
        emptySince ??= now;
        if (now - emptySince >= EMPTY_FOR_MS || !this.host.running()) {
          this.set("wait", "ok", "empty");
          return this.countdown();
        }
      } else {
        emptySince = null;
        if (r.deadline && now >= Date.parse(r.deadline)) {
          r.forced = true;
          this.set("wait", "ok", "deadline");
          return this.countdown();
        }
        // The evening winds down: someone walks off every few seconds.
        if (now - lastLeave >= 2_500) {
          lastLeave = now;
          this.host.leave(players[0]!);
        }
      }
      this.host.after(TICK_MS, tick);
    };
    tick();
  }

  private countdown(): void {
    const r = this.run!;
    if (r.request.warnMinutes === 0) {
      this.set("countdown", "skipped", "none");
      return this.save();
    }
    if (this.host.players().length === 0) {
      this.set("countdown", "skipped", "empty");
      return this.save();
    }
    const total = r.request.warnMinutes * MOCK_MINUTE_MS;
    const end = this.host.clock() + total;
    r.restartAt = new Date(end).toISOString();
    const reason = this.host.bridgeOn() ? "" : "nobridge";
    this.set("countdown", "running", reason);
    const marks = [total, ...[10, 5, 2, 1, 1 / 2, 1 / 6].map((m) => m * MOCK_MINUTE_MS).filter((m) => m < total)];
    const tick = () => {
      if (this.cancelled) return this.stop("countdown");
      const left = end - this.host.clock();
      if (left <= 0) {
        this.set("countdown", "ok", reason);
        return this.save();
      }
      if (this.host.players().length === 0) {
        this.set("countdown", "ok", "emptied");
        return this.save();
      }
      let due: number | null = null;
      while (marks.length > 0 && marks[0]! >= left) due = marks.shift()!;
      if (due !== null) this.say(due >= MOCK_MINUTE_MS ? "min" : "sec", due >= MOCK_MINUTE_MS ? Math.round(due / MOCK_MINUTE_MS) : Math.max(1, Math.round((due * 60) / MOCK_MINUTE_MS)));
      this.host.after(Math.min(TICK_MS, left), tick);
    };
    tick();
  }

  private save(): void {
    this.cancellable = false;
    if (this.cancelled) return this.stop("countdown");
    if (!this.host.lock()) {
      this.set("save", "error", "busy", "another action is in progress");
      return this.finish("failed", "another action is in progress");
    }
    if (!this.host.bridgeOn()) {
      this.set("save", "skipped", "nobridge");
      return this.stopGame();
    }
    this.set("save", "running");
    if (this.host.players().length > 0) this.say("now");
    this.host.after(1_200, () => {
      if (this.mode === "fail-save") this.set("save", "warn", "failed", "bridge 503: the world is saving already");
      else {
        this.host.save();
        this.set("save", "ok");
      }
      this.stopGame();
    });
  }

  private stopGame(): void {
    this.set("stop", "running");
    this.host.setStatus("stopping");
    this.host.after(1_500, () => {
      for (const p of this.host.players()) this.host.leave(p);
      this.host.setStatus("stopped");
      this.set("stop", "ok");
      this.backup();
    });
  }

  private backup(): void {
    const r = this.run!;
    this.set("backup", "running");
    this.host.after(1_500, () => {
      let failure = "";
      if (this.mode === "fail-backup") {
        failure = "backup: write copy: no space left on device";
        this.set("backup", "error", "", "write copy: no space left on device");
        this.set("verify", "skipped", "nobackup");
        return this.startGame(failure);
      }
      const name = `pre-restart-${stamp(this.host.clock())}.zip`;
      const size = Math.round(this.host.worldBytes() * 0.62);
      r.archive = name;
      r.archiveSha256 = "9f2c4e1a7b3d5f60812a4c6e8b0d2f4618a3c5e7092b4d6f81a3c5e7f9b1d3e5";
      this.host.addBackup({ name, sizeBytes: size, modifiedAt: new Date(this.host.clock()).toISOString() });
      this.set("backup", "ok");
      this.set("verify", "running");
      this.host.after(1_200, () => {
        if (this.mode === "fail-verify") {
          failure = "verify: the newest finished save (41) lacks its .db2 or .fwl2";
          this.set("verify", "error", "", "the newest finished save (41) lacks its .db2 or .fwl2");
        } else {
          r.archiveBytes = size;
          this.set("verify", "ok");
        }
        this.startGame(failure);
      });
    });
  }

  private startGame(failure: string): void {
    this.set("start", "running");
    this.host.setStatus("starting");
    this.host.after(2_000, () => {
      if (this.mode === "fail-start") {
        this.set("start", "error", "", "SPAWN_ERROR: valheim-server");
        this.host.unlock();
        return this.finish("failed", [failure, "start: SPAWN_ERROR: valheim-server"].filter(Boolean).join("\n"));
      }
      this.host.unlock();
      this.set("start", "ok");
      this.set("recover", "running");
      this.host.after(2_500, () => {
        if (this.mode === "fail-recover") {
          this.host.boot(null);
          this.set("recover", "error", "join_code_missing", "no join code in time");
          return this.finish("failed", [failure, "no join code in time"].filter(Boolean).join("\n"));
        }
        const code = this.host.newCode();
        this.host.boot(code);
        this.run!.joinCode = code;
        this.set("recover", "ok");
        if (failure) this.finish("failed", failure);
        else this.finish("done");
      });
    });
  }
}
