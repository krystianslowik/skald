import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { SkaldVersion } from "./SkaldVersion";

const inLocale = (ui: ReactElement, locale: "en" | "pl" = "en") => render(<I18nProvider locale={locale}>{ui}</I18nProvider>);

describe("SkaldVersion", () => {
  it("shows the version and nothing else when agent and panel match", () => {
    inLocale(<SkaldVersion web="2026.10.0" agent="2026.10.0" />);
    expect(screen.getByText("Skald 2026.10.0")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("names both versions when they differ", () => {
    inLocale(<SkaldVersion web="2026.11.0" agent="2026.10.0" />);
    expect(screen.getByRole("status")).toHaveTextContent("Agent 2026.10.0, panel 2026.11.0: update the other part");
  });

  it("never warns for dev builds or agents too old to report a version", () => {
    const { rerender } = inLocale(<SkaldVersion web="dev" agent="2026.10.0" />);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(
      <I18nProvider locale="en">
        <SkaldVersion web="2026.10.0" agent="dev" />
      </I18nProvider>,
    );
    expect(screen.queryByRole("status")).toBeNull();
    rerender(
      <I18nProvider locale="en">
        <SkaldVersion web="2026.10.0" />
      </I18nProvider>,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("links a newer release to its notes, in both languages", () => {
    const update = { version: "2026.11.0", url: "https://github.com/krystianslowik/skald/releases/tag/v2026.11.0" };
    const { unmount } = inLocale(<SkaldVersion web="2026.10.0" agent="2026.10.0" update={update} />);
    expect(screen.getByRole("link", { name: "New version 2026.11.0" })).toHaveAttribute("href", update.url);
    unmount();
    inLocale(<SkaldVersion web="2026.10.0" agent="2026.10.0" update={update} />, "pl");
    expect(screen.getByRole("link", { name: "Nowa wersja 2026.11.0" })).toHaveAttribute("rel", "noopener noreferrer");
  });
});
