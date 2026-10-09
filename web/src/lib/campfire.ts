import { useCallback, useEffect, useState } from "react";

/**
 * Procedural campfire: a low brown-noise rumble plus random crackle pops, all
 * synthesized with Web Audio (no files, no network). Quiet by design.
 */

const VOLUME = 0.14;
const PREF_KEY = "skald_campfire_sound";

type AudioCtor = typeof AudioContext;

function audioCtor(): AudioCtor | null {
  if (typeof window === "undefined") return null;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext ?? null;
}

class Campfire {
  readonly ctx: AudioContext;
  private master: GainNode;
  private bedGain: GainNode;
  private crackle: AudioBuffer;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  constructor(Ctor: AudioCtor) {
    const ctx = (this.ctx = new Ctor());
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // Bed: looped brown noise through a low-pass, the hiss and roar of the fire.
    const len = ctx.sampleRate * 4;
    const bed = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = bed.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = bed;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 520;
    this.bedGain = ctx.createGain();
    this.bedGain.gain.value = 0.55;
    src.connect(lp).connect(this.bedGain).connect(this.master);
    src.start();

    // Crackle: a few ms of white noise with a sharp exponential decay.
    const clen = Math.floor(ctx.sampleRate * 0.035);
    this.crackle = ctx.createBuffer(1, clen, ctx.sampleRate);
    const c = this.crackle.getChannelData(0);
    for (let i = 0; i < clen; i++) c[i] = (Math.random() * 2 - 1) * Math.exp(-i / (clen / 7));
  }

  private pop(at: number, strength: number): void {
    const { ctx } = this;
    const src = ctx.createBufferSource();
    src.buffer = this.crackle;
    src.playbackRate.value = 0.5 + Math.random() * 1.6;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 900 + Math.random() * 4200;
    bp.Q.value = 0.7 + Math.random() * 2.5;
    const g = ctx.createGain();
    g.gain.value = strength;
    src.connect(bp).connect(g).connect(this.master);
    src.start(at);
  }

  private tick = (): void => {
    if (!this.running) return;
    const now = this.ctx.currentTime;
    // Mostly single ticks, sometimes a burst, now and then a loud snap.
    const burst = Math.random() < 0.18 ? 2 + Math.floor(Math.random() * 4) : 1;
    for (let i = 0; i < burst; i++) {
      const loud = Math.random() < 0.07;
      this.pop(now + i * (0.012 + Math.random() * 0.05), loud ? 0.9 + Math.random() * 0.5 : 0.12 + Math.random() * 0.45);
    }
    // The fire breathes: drift the bed level a little.
    this.bedGain.gain.setTargetAtTime(0.4 + Math.random() * 0.3, now, 0.8);
    const r = Math.random();
    this.timer = setTimeout(this.tick, 35 + r * r * 650);
  };

  /** One crisp pop now, for a completed action; only when the fire is actually audible. */
  snap(): void {
    if (!this.running || this.ctx.state !== "running") return;
    this.pop(this.ctx.currentTime, 0.75);
  }

  resume(): void {
    void this.ctx.resume().catch(() => undefined);
    this.master.gain.setTargetAtTime(VOLUME, this.ctx.currentTime, 0.6);
    if (!this.running) {
      this.running = true;
      this.tick();
    }
  }

  pause(): void {
    this.running = false;
    clearTimeout(this.timer);
    void this.ctx.suspend().catch(() => undefined);
  }

  close(): void {
    this.running = false;
    clearTimeout(this.timer);
    void this.ctx.close().catch(() => undefined);
  }
}

/** The fire that is currently on, if any (the sound toggle owns its lifetime). */
let active: Campfire | null = null;

/**
 * A single crackle pop in sync with a UI event (a rune that just caught).
 * Silent unless the viewer turned the campfire sound on.
 */
export function crackle(): void {
  active?.snap();
}

function readPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === "1";
  } catch {
    return false;
  }
}

function writePref(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
  } catch {
    // private mode or blocked storage: the toggle still works for this visit
  }
}

/**
 * Optional ambient sound, OFF by default and remembered per browser. Paused
 * while the tab is hidden. A restored "on" waits for the first gesture,
 * because browsers block audio until the user interacts.
 */
export function useCampfireSound(): { on: boolean; supported: boolean; toggle: () => void } {
  const [on, setOn] = useState(readPref);
  const supported = audioCtor() !== null;

  const toggle = useCallback(() => {
    setOn((v) => !v);
  }, []);

  useEffect(() => writePref(on), [on]);

  useEffect(() => {
    const Ctor = audioCtor();
    if (!on || !Ctor) return;
    let f: Campfire;
    try {
      f = new Campfire(Ctor);
    } catch {
      return;
    }
    const wake = () => {
      if (!document.hidden) f.resume();
    };
    const unlock = () => {
      wake();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    const onVisibility = () => (document.hidden ? f.pause() : f.resume());
    active = f;
    wake();
    if (f.ctx.state !== "running") {
      window.addEventListener("pointerdown", unlock);
      window.addEventListener("keydown", unlock);
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      document.removeEventListener("visibilitychange", onVisibility);
      if (active === f) active = null;
      f.close();
    };
  }, [on]);

  return { on, supported, toggle };
}
