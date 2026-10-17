import { describe, expect, it } from "vitest";
import { makeI18n } from "../i18n";
import { failText, refusalReason, refusalText } from "./refusal";

// Node's fs and cwd in the test runner; the web's tsconfig has no Node types.
const fs = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ fs)) as { readFileSync(path: string, enc: "utf8"): string };
const repo = `${(globalThis as unknown as { process: { cwd(): string } }).process.cwd()}/..`;

const en = makeI18n("en");
const pl = makeI18n("pl");

// The bridge's and the agent's refusals, word for word from
// bridge/plugin/{Chests,Extras,Commands}.cs and agent/internal/bridge/bridge.go.
const KNOWN: [string, string, string][] = [
  ["a player has that chest open; try again once it is closed", "Someone has this chest open. Try again once they close it.", "Ktoś ma tę skrzynię otwartą. Spróbuj, gdy ją zamknie."],
  ["Ragnar is standing at that chest; try again once they step away", "Ragnar is standing at this chest. Try again once they step away.", "Ragnar stoi przy skrzyni. Spróbuj, gdy odejdzie."],
  ["Freya of the (North) [*] is standing at that chest; try again once they step away", "Freya of the (North) [*] is standing at this chest. Try again once they step away.", "Freya of the (North) [*] stoi przy skrzyni. Spróbuj, gdy odejdzie."],
  ["only 12 Wood fit in that chest", "Only 12 fit in this chest: Wood. Lower the amount and try again.", "Do tej skrzyni zmieści się tylko 12: Drewno. Zmniejsz liczbę i spróbuj jeszcze raz."],
  ["that chest has no room for Iron", "This chest has no room left for Iron.", "W tej skrzyni nie ma już miejsca na: Żelazo."],
  ["no such chest at 208, -352 any more: it was moved or destroyed after the last save", "This chest is not there any more: it was moved or destroyed after the last save. The map catches up at the next world save.", "Tej skrzyni już tu nie ma: ktoś ją przeniósł albo zniszczył po ostatnim zapisie. Mapa nadrobi to przy następnym zapisie świata."],
  ["two chests sit on that spot; cannot tell which one is meant", "Two chests stand on this spot and the game cannot tell which one is meant. Nothing was added.", "W tym miejscu stoją dwie skrzynie i gra nie wie, o którą chodzi. Nic nie dodano."],
  ["that chest holds items this server does not know; left untouched", "This chest holds items the server does not know, so it was left untouched.", "W tej skrzyni są przedmioty, których serwer nie zna, więc zostawiono ją bez zmian."],
  ["that chest's items do not read back the same; left untouched", "The game could not check this chest's contents safely, so nothing was added. Try again in a moment.", "Gra nie mogła bezpiecznie sprawdzić zawartości skrzyni, więc nic nie dodano. Spróbuj za chwilę."],
  ["the items did not fit as planned; chest left untouched", "The game could not check this chest's contents safely, so nothing was added. Try again in a moment.", "Gra nie mogła bezpiecznie sprawdzić zawartości skrzyni, więc nic nie dodano. Spróbuj za chwilę."],
  ["the new contents do not read back the same; chest left untouched", "The game could not check this chest's contents safely, so nothing was added. Try again in a moment.", "Gra nie mogła bezpiecznie sprawdzić zawartości skrzyni, więc nic nie dodano. Spróbuj za chwilę."],
  ["only chests can take items this way, not carts, ships or graves", "Only chests take items this way, not carts, ships or graves.", "Tak dodaje się przedmioty tylko do skrzyń, nie do wozów, statków ani grobów."],
  ["'piece_workbench' is not a container", "That is not a container, so it cannot take items.", "To nie jest pojemnik, więc nie przyjmie przedmiotów."],
  ["only 40 CopperOre fit in that chest", "Only 40 fit in this chest: Copper Ore. Lower the amount and try again.", "Do tej skrzyni zmieści się tylko 40: Ruda miedzi. Zmniejsz liczbę i spróbuj jeszcze raz."],
  ["unknown item prefab 'Woood' (use the prefab name, e.g. Wood, Iron)", "The game does not know the item Woood.", "Gra nie zna przedmiotu Woood."],
  ["no smelter takes 'Wood'; GET /v1/build/stations lists what each one takes", "No smelter takes this: Wood. Pick another ore.", "Żaden piec tego nie przyjmuje: Drewno. Wybierz inną rudę."],
  ["no fermenter takes 'Honey'; GET /v1/build/stations lists what each one takes", "No fermenter takes this: Honey. Pick another mead base.", "Żaden fermentator tego nie przyjmuje: Plaster miodu. Wybierz inną brzeczkę."],
  ["no connected player 'Ragnar'", "Ragnar is not in the game any more.", "Ragnar nie jest już w grze."],
  ["no connected player 'O'Freya'", "O'Freya is not in the game any more.", "O'Freya nie jest już w grze."],
  ["no connected player 'Ragnar'; to ban an offline player pass a platform id like Steam_<id> or Xbox_<id>", "Ragnar is not in the game. To ban a player who is offline, use their platform id (Steam_... or Xbox_...).", "Ragnar nie ma w grze. Gracza, który jest offline, zbanujesz po identyfikatorze platformy (Steam_... albo Xbox_...)."],
  ["more than one player is called 'Freya', use the uid", "Two players are called Freya, so the bridge cannot tell which one is meant.", "Dwóch graczy nazywa się Freya, więc mostek nie wie, o którego chodzi."],
  ["player has no character yet (still loading or dead)", "That player has no character yet: still loading or dead. Try again in a moment.", "Ten gracz nie ma jeszcze postaci: wczytuje się albo nie żyje. Spróbuj za chwilę."],
  ["player has no platform id to ban", "That player has no platform id, so they cannot be banned.", "Ten gracz nie ma identyfikatora platformy, więc nie da się go zbanować."],
  ["player and toPlayer are the same", "A player cannot be teleported to themselves.", "Nie można przenieść gracza do niego samego."],
  ["no location 'Haldor' in this world; aliases: haldor, hildir", "There is no Haldor in this world.", "W tym świecie nie ma: Haldor."],
  ["already skipping time", "Time is already being skipped.", "Czas już jest przewijany."],
  ["time is already frozen", "Time is already frozen.", "Czas jest już zatrzymany."],
  ["time is not frozen", "Time is not frozen.", "Czas nie jest zatrzymany."],
  ["no random event is running", "No event is running.", "Żadne zdarzenie teraz nie trwa."],
  ["unknown event 'wolfs'; GET /v1/events lists the names", "The game does not know the event wolfs.", "Gra nie zna zdarzenia wolfs."],
  ["global key 'defeated_eikthyr' is not set", "The world key defeated_eikthyr is not set.", "Klucz świata defeated_eikthyr nie jest ustawiony."],
  ["unknown creature prefab 'Bore' (e.g. Boar, Greyling, Troll, Eikthyr)", "The game does not know the creature Bore.", "Gra nie zna stworzenia Bore."],
  ["'Troll' cannot be tamed", "Troll cannot be tamed.", "Nie da się oswoić: Troll."],
  ["no cartography table within 30 m", "No cartography table within 30 m.", "Brak stołu kartograficznego w promieniu 30 m."],
  ["too many stacks in one call (max 60)", "Too many stacks at once (at most 60). Send it in smaller batches.", "Za dużo stosów naraz (najwyżej 60). Wyślij to w mniejszych porcjach."],
  ["not possible server-side: chat lines carry a sender platform user id", "The game does not allow this on a server.", "Gra nie pozwala na to po stronie serwera."],
  ["not on the ban list (reload it)", "That entry is not on the ban list any more. Reload the list.", "Tego wpisu nie ma już na liście banów. Odśwież listę."],
  ["'Steam_***' is not on the ban list", "That entry is not on the ban list any more. Reload the list.", "Tego wpisu nie ma już na liście banów. Odśwież listę."],
  ["world not loaded yet", "The world is still loading. Try again in a moment.", "Świat jeszcze się wczytuje. Spróbuj za chwilę."],
  ["EnvMan not available", "The world is still loading. Try again in a moment.", "Świat jeszcze się wczytuje. Spróbuj za chwilę."],
  ["untested game build l-1.0.18: confirm it in the admin panel first", "Game build l-1.0.18 is not allowed yet. Allow it in the admin panel first.", "Wersja gry l-1.0.18 nie jest jeszcze dozwolona. Najpierw zezwól na nią w panelu admina."],
  ["the bridge did not answer in time", "The bridge did not answer in time. It may have worked anyway: check before you try again.", "Mostek nie odpowiedział na czas. Mogło się jednak udać: sprawdź, zanim spróbujesz jeszcze raz."],
  ["agent unreachable", "No contact with the agent. Try again in a moment.", "Brak kontaktu z agentem. Spróbuj za chwilę."],
];

describe("bridge refusals", () => {
  it.each(KNOWN)("%s", (raw, english, polish) => {
    expect(refusalText(en, raw)).toBe(english);
    expect(refusalText(pl, raw)).toBe(polish);
  });

  it("leaves an unknown refusal alone", () => {
    expect(refusalText(en, "the chest is haunted")).toBeNull();
    expect(refusalText(en, "")).toBeNull();
    expect(refusalText(en, undefined)).toBeNull();
    // Only a whole known message counts, not one inside another.
    expect(refusalText(en, "bridge says: world not loaded yet")).toBeNull();
  });

  it("keeps to the bridge's and the agent's own wording", () => {
    // A reworded refusal falls back to English silently, so the literals are pinned to their source.
    const src = ["Chests.cs", "Extras.cs", "Commands.cs"].map((f) => readFileSync(`${repo}/bridge/plugin/${f}`, "utf8")).join("\n") + readFileSync(`${repo}/agent/internal/bridge/bridge.go`, "utf8");
    for (const literal of [
      "a player has that chest open; try again once it is closed",
      " is standing at that chest; try again once they step away",
      " fit in that chest",
      "that chest has no room for ",
      " any more: it was moved or destroyed after the last save",
      "two chests sit on that spot; cannot tell which one is meant",
      "that chest holds items this server does not know; left untouched",
      "that chest's items do not read back the same; left untouched",
      "the items did not fit as planned; chest left untouched",
      "the new contents do not read back the same; chest left untouched",
      "only chests can take items this way, not carts, ships or graves",
      "' is not a container",
      "unknown item prefab '",
      "'; GET /v1/build/stations lists what each one takes",
      "no connected player '",
      "'; to ban an offline player pass a platform id",
      "more than one player is called '",
      "', use the uid",
      "player has no character yet",
      "player has no platform id to ban",
      "player and toPlayer are the same",
      "' in this world; aliases: ",
      "already skipping time",
      "time is already frozen",
      "time is not frozen",
      "no random event is running",
      "'; GET /v1/events lists the names",
      "' is not set",
      "unknown creature prefab '",
      "' cannot be tamed",
      "no cartography table within ",
      "too many stacks in one call",
      "not possible server-side",
      "not on the ban list (reload it)",
      "' is not on the ban list",
      "world not loaded yet",
      "untested game build ",
      ": confirm it in the admin panel first",
      "the bridge did not answer in time",
    ]) expect(src, literal).toContain(literal);
  });

  it("gives the Saga the reason without the advice", () => {
    expect(refusalReason(en, "Ragnar is standing at that chest; try again once they step away")).toBe("Ragnar is standing at this chest");
    expect(refusalReason(pl, "only 12 Wood fit in that chest")).toBe("Do tej skrzyni zmieści się tylko 12: Drewno");
    expect(refusalReason(en, "time is already frozen")).toBe("Time is already frozen");
    expect(refusalReason(en, "something new")).toBeNull();
  });

  it("picks the line for a failed call", () => {
    expect(failText(pl, { status: 409, error: "Ragnar is standing at that chest; try again once they step away" })).toBe("Ragnar stoi przy skrzyni. Spróbuj, gdy odejdzie.");
    expect(failText(en, { status: 409, error: "the chest is haunted" })).toBe("the chest is haunted");
    expect(failText(en, { status: 409 })).toBe("That did not work.");
    expect(failText(en, { status: 0, error: "offline" })).toBe("The bridge did not answer. Try again in a moment.");
    expect(failText(en, { status: 502, error: "bridge unavailable" })).toBe("The bridge did not answer. Try again in a moment.");
    // A plugin older than the command (bridge/plugin/HttpServer.cs answers 404).
    expect(failText(en, { status: 404, error: "unknown command POST /v1/build/fill-smelters" })).toBe("This needs a newer bridge plugin.");
    expect(failText(pl, { status: 404, error: "unknown command POST /v1/build/fill-kilns" })).toBe("To wymaga nowszej wersji mostka.");
    // The agent's own allow-list says it without a method and path: the agent is the one to update.
    expect(failText(en, { status: 404, error: "unknown command fill-fermenters" })).toBe("This needs a newer Skald agent.");
  });
});
