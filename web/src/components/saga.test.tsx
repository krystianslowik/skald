import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { I18nProvider, makeI18n } from "../i18n";
import type { AgentEvent, AgentEventType } from "../types";
import { Saga } from "./Saga";

const T0 = Date.parse("2026-10-09T10:00:00Z");
const NOW = T0 + 3 * 60 * 60_000;
let seq = 0;
const ev = (min: number, type: AgentEventType, data: Record<string, unknown> = {}): AgentEvent => ({
  seq: ++seq,
  ts: new Date(T0 + min * 60_000).toISOString(),
  type,
  data,
});
const feed = (...events: AgentEvent[]) => [...events].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
const inLocale = (ui: ReactElement, locale: "en" | "pl" = "en") => render(<I18nProvider locale={locale}>{ui}</I18nProvider>);
const at = (min: number) => makeI18n("en").clock(T0 + min * 60_000);

describe("Saga", () => {
  it("folds routine saves into one quiet row that opens into each line", () => {
    const events = feed(ev(0, "world_saved", { ms: 90 }), ev(30, "world_saved", { ms: 80 }), ev(31, "world_backup", { ms: 30 }), ev(60, "world_saved", { ms: 70 }));
    inLocale(<Saga events={events} now={NOW} />);
    const fold = screen.getByRole("button", { name: `World saved 3×, 1 backup · last ${at(60)}` });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("World saved in 80 ms")).not.toBeInTheDocument();
    fireEvent.click(fold);
    expect(fold).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("World saved in 80 ms")).toBeInTheDocument();
    expect(screen.getByText("The game set aside a world backup")).toBeInTheDocument();
  });

  it("says it in Polish with the right forms", () => {
    const events = feed(ev(0, "world_saved", { ms: 90 }), ev(1, "world_backup"), ev(2, "world_backup"), ev(30, "world_saved", { ms: 80 }), ev(60, "world_backup"), ev(61, "world_backup"));
    inLocale(<Saga events={events} now={NOW} />, "pl");
    expect(screen.getByRole("button", { name: `Świat zapisany 2×, kopie 4× · ostatnio ${at(61)}` })).toBeInTheDocument();
  });

  it("keeps a slow save visible", () => {
    inLocale(<Saga events={feed(ev(0, "world_saved", { ms: 90 }), ev(30, "world_saved", { ms: 2400 }), ev(60, "world_saved", { ms: 80 }))} now={NOW} />);
    expect(screen.getByText("World saved in 2400 ms")).toHaveClass("text-gold");
  });

  it("tells a visit as one line, and one still on", () => {
    const events = feed(ev(0, "player_join", { name: "Ragnar" }), ev(64, "player_leave", { name: "Ragnar" }), ev(90, "player_join", { name: "Freya" }));
    inLocale(<Saga events={events} now={NOW} online={[{ name: "Freya" }]} />);
    const line = (name: string) => screen.getByText(name, { selector: "span" }).parentElement;
    expect(line("Ragnar")).toHaveTextContent(`Ragnar ${at(0)}–${at(64)} · 1 h 4 min`);
    expect(line("Freya")).toHaveTextContent(`Freya playing since ${at(90)}`);
    expect(screen.queryByText(/arrives at the fire/)).not.toBeInTheDocument();
  });

  it("says the game was updated when the version changes", () => {
    const events = feed(ev(0, "version", { version: "l-1.0.19" }), ev(60, "version", { version: "l-1.0.20" }));
    inLocale(<Saga events={events} now={NOW} />, "pl");
    expect(screen.getByText("Gra zaktualizowana do 1.0.20")).toBeInTheDocument();
    expect(screen.getByText("Wersja serwera 1.0.19")).toBeInTheDocument();
  });
});
