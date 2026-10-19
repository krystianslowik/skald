import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { Hearth } from "./Hearth";

describe("Hearth", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows two players sharing a name as two shields, without a duplicate key (#23)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const since = new Date().toISOString();
    render(
      <I18nProvider locale="en">
        <Hearth
          players={[
            { id: "Ragnar", name: "Ragnar", since, platform: "xbox" },
            { id: "Ragnar#2", name: "Ragnar", since, platform: "steam" },
          ]}
        />
      </I18nProvider>,
    );
    expect(screen.getAllByRole("figure")).toHaveLength(2);
    expect(error.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("same key"))).toEqual([]);
  });
});
