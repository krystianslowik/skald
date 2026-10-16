import { describe, expect, it } from "vitest";
import { en } from "../i18n/en";
import { pl } from "../i18n/pl";
import { processRows } from "./processes";

describe("processRows", () => {
  it("names the game's processes, counts a finished bootstrap as done and folds the plumbing into one line", () => {
    const rows = processRows({ crond: "RUNNING", syslogd: "RUNNING", "valheim-bootstrap": "EXITED", "valheim-updater": "RUNNING", "valheim-server": "RUNNING", "valheim-backup": "STARTING" });
    expect(rows.map((r) => [r.key, r.state, r.tone])).toEqual([
      ["process.valheim-server", "processState.running", "ok"],
      ["process.valheim-backup", "processState.starting", "busy"],
      ["process.valheim-updater", "processState.running", "ok"],
      ["process.valheim-bootstrap", "processState.done", "ok"],
      ["process.system", "processState.running", "ok"],
    ]);
    expect(rows.at(-1)!.names).toEqual(["crond", "syslogd"]);
  });

  it("flags what did fail, and the system line takes its worst state", () => {
    const rows = processRows({ "valheim-server": "EXITED", "valheim-backup": "FATAL", crond: "RUNNING", syslogd: "BACKOFF", "valheim-odd": "WEIRD" });
    expect(rows.map((r) => [r.key, r.state, r.tone])).toEqual([
      ["process.valheim-server", "processState.exited", "bad"],
      ["process.valheim-backup", "processState.fatal", "bad"],
      ["process.valheim-odd", "processState.unknown", "bad"],
      ["process.system", "processState.backoff", "bad"],
    ]);
    expect(processRows({})).toEqual([]);
  });

  it("pairs every Polish process with every state in the same gender and number", () => {
    // Labels are joined with independent state words, so both sides are masculine singular.
    const labels = ["valheim-server", "valheim-backup", "valheim-updater", "valheim-bootstrap", "system"].map((n) => pl[`process.${n}` as keyof typeof pl]);
    expect(labels).toEqual(["serwer gry", "harmonogram kopii", "aktualizator", "pierwszy start", "system"]);
    const states = ["running", "done", "starting", "stopping", "backoff", "stopped", "exited", "fatal", "unknown"].map((s) => pl[`processState.${s}` as keyof typeof pl]);
    expect(states).toEqual(["działa", "zakończony", "uruchamia się", "zatrzymuje się", "ponawia start", "zatrzymany", "zakończył się", "awaria", "nieznany"]);
  });

  it("has every name and state in both languages", () => {
    const keys = ["process.valheim-server", "process.valheim-backup", "process.valheim-updater", "process.valheim-bootstrap", "process.system", ...["running", "done", "starting", "stopping", "backoff", "stopped", "exited", "fatal", "unknown"].map((s) => `processState.${s}`)];
    for (const k of keys) {
      expect(en).toHaveProperty([k]);
      expect(pl).toHaveProperty([k]);
    }
  });
});
