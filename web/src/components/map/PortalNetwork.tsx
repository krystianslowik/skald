import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { useI18n } from "../../i18n";
import { getLivePositions, subscribeLivePositions, useLivePositions } from "../../lib/live";
import type { Marker } from "../../lib/mapgeo";
import { findRoute, nearestPlace, noWarnings, partners, portalGroups, portalWarnings, type Place, type Route, type Spot } from "../../lib/portalnet";
import { PHONE, useMedia } from "../../lib/useMedia";
import type { ApiMap, LivePlayer, MapPortal } from "../../types";
import { Sheet, SheetClose } from "../Sheet";
import type { MapCanvasHandle } from "./MapCanvas";
import { markerTitle } from "./MapDetails";
import { MapIcon } from "./MapIcon";

type I18n = ReturnType<typeof useI18n>;

/** A route's end: a mark on the map ("base:0", "loc:3", "pin:2"), a player online ("player:<id>") or the tapped point ("spot"). */
interface End {
  key: string;
  label: string;
  x: number;
  z: number;
}

/** Route ends by group, for the two pickers; `from` offers bases, players online and the tapped point, `to` the rest. */
interface Ends {
  bases: End[];
  bosses: End[];
  places: End[];
  pins: End[];
}

function endsOf(markers: readonly Marker[], t: I18n["t"], lookup: I18n["lookup"]): Ends {
  const out: Ends = { bases: [], bosses: [], places: [], pins: [] };
  // An unnamed base goes by the closest named pin or place, else by where it is.
  const named = placesOf(markers.filter((m) => m.data.type !== "base"), t, lookup);
  const bases = markers.filter((m) => m.data.type === "base").sort((a, b) => (b.data as { pieces: number }).pieces - (a.data as { pieces: number }).pieces);
  for (const m of [...bases, ...markers.filter((m) => m.data.type !== "base")]) {
    const d = m.data;
    const end = { key: m.id, label: markerTitle(m, t, lookup), x: m.x, z: m.z };
    if (d.type === "base") {
      const near = d.name ? null : nearestPlace(m, named);
      out.bases.push({ ...end, label: d.name || (near ? t("portals.baseNear", { place: near.name }) : `${t("map.base.title")} ${t("map.coords", { x: m.x, z: m.z })}`) });
    }
    // Only altars someone has found: the server already dropped what the viewer may not see.
    else if (d.type === "location" && d.kind === "boss" && d.explored) out.bosses.push(end);
    else if (d.type === "location" && (d.kind === "trader" || d.kind === "start") && d.explored) out.places.push(end);
    else if (d.type === "pin") out.pins.push(d.name ? end : { ...end, label: `${end.label} ${t("map.coords", { x: m.x, z: m.z })}` });
  }
  for (const list of [out.bosses, out.places, out.pins]) list.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/** Players online as route starts (the picker reads them only while the sheet is open). */
export function playerEnds(players: readonly LivePlayer[]): End[] {
  return players.map((p) => ({ key: `player:${p.id ?? p.name}`, label: p.name, x: p.x, z: p.z }));
}

/**
 * The mark a chosen end stands for in this save. Mark ids are indexes
 * ("pin:2"), so a new save can shift them: the end is found by its kind and
 * place, and is gone (null) when nothing of its kind stands there any more.
 */
function current(e: End | null, ends: Ends): End | null {
  if (!e) return null;
  const kind = e.key.split(":")[0];
  const all = [...ends.bases, ...ends.bosses, ...ends.places, ...ends.pins];
  return all.find((c) => c.key === e.key && c.x === e.x && c.z === e.z) ?? all.find((c) => c.x === e.x && c.z === e.z && c.key.split(":")[0] === kind) ?? null;
}

export interface PortalNet {
  /** The start as chosen (a mark, a player, or "spot"), and as it stands now: null when it is gone or offline. */
  from: End | null;
  start: End | null;
  /** The destination as chosen, and as it stands now. */
  to: End | null;
  end: End | null;
  setFrom: (e: End | null) => void;
  setTo: (e: End | null) => void;
  /** The tapped start point, once there is one. */
  spot: Spot | null;
  /** Waiting for a tap on the map to set the start. */
  picking: boolean;
  setPicking: (on: boolean) => void;
  /** A tap on the map while picking. */
  onTap: (p: Spot) => void;
  ends: Ends;
  route: Route | null;
  clear: () => void;
}

/** Where one player is, as "x,z", "" when they are offline; re-renders only when that player moves. */
function usePlayerAt(key: string | null): string {
  return useSyncExternalStore(subscribeLivePositions, () => {
    if (!key) return "";
    const p = getLivePositions().players.find((q) => `player:${q.id ?? q.name}` === key);
    return p ? `${p.x},${p.z}` : "";
  });
}

/** The route finder's state; it lives with the map so the route stays drawn when the sheet closes. */
export function usePortalNet(map: ApiMap, markers: readonly Marker[]): PortalNet {
  const { t, lookup, number } = useI18n();
  const ends = useMemo(() => endsOf(markers, t, lookup), [markers, t, lookup]);
  const [from, setFromState] = useState<End | null>(() => ends.bases[0] ?? null);
  const [to, setToState] = useState<End | null>(null);
  const [spot, setSpot] = useState<Spot | null>(null);
  const [picking, setPicking] = useState(false);
  const onTap = useCallback((p: Spot) => {
    const at = { x: Math.round(p.x), z: Math.round(p.z) };
    setSpot(at);
    setFromState({ key: "spot", label: "", ...at });
    setPicking(false);
  }, []);
  const setFrom = useCallback(
    (e: End | null) => {
      setFromState(e);
      // A route from a place to itself is no route.
      setToState((cur) => (cur && e && cur.key === e.key ? null : cur));
      if (e?.key === "spot" && !spot) setPicking(true);
    },
    [spot],
  );
  const setTo = useCallback((e: End | null) => setToState(e), []);
  const player = from?.key.startsWith("player:") ? from.key : null;
  const playerAt = usePlayerAt(player);
  let start: End | null;
  if (!from) start = null;
  else if (from.key === "spot") start = spot ? { key: "spot", label: t("portals.spotAt", { x: number(spot.x), z: number(spot.z) }), ...spot } : null;
  else if (player) {
    const [x, z] = playerAt.split(",").map(Number);
    start = playerAt ? { ...from, x: x!, z: z! } : null;
  } else start = current(from, ends);
  const end = current(to, ends);
  const sx = start?.x;
  const sz = start?.z;
  const ex = end?.x;
  const ez = end?.z;
  const route = useMemo(
    () => (sx === undefined || sz === undefined || ex === undefined || ez === undefined ? null : findRoute({ x: sx, z: sz }, { x: ex, z: ez }, map.portals)),
    [sx, sz, ex, ez, map.portals],
  );
  const clear = useCallback(() => {
    setToState(null);
    setPicking(false);
  }, []);
  return { from, start, to, end, setFrom, setTo, spot, picking, setPicking, onTap, ends, route, clear };
}

/** Metres for people: tens of metres up close, kilometres with one decimal further out. */
export function distance(m: number, t: I18n["t"], number: I18n["number"]): string {
  return Math.round(m / 10) * 10 < 1000 ? t("portals.m", { n: number(Math.round(m / 10) * 10) }) : t("portals.km", { n: number(m / 1000, 1) });
}

/** Named places a portal is described by: bases, pins, found locations. */
function placesOf(markers: readonly Marker[], t: I18n["t"], lookup: I18n["lookup"]): Place[] {
  const out: Place[] = [];
  for (const m of markers) {
    const d = m.data;
    // Unnamed bases and pins say nothing about where a portal is.
    if (d.type === "base" || d.type === "pin") out.push({ name: d.name ?? "", x: m.x, z: m.z });
    else if (d.type === "location" && d.explored && d.kind !== "dungeon") out.push({ name: markerTitle(m, t, lookup), x: m.x, z: m.z });
  }
  return out;
}

/**
 * The portal network sheet: the route finder, what is wrong with the
 * portals, and every portal by tag with where it stands. Rows centre the map
 * on what they name; the sheet leaves the map usable behind it.
 */
export function PortalSheet({
  map,
  markers,
  net,
  canvas,
  onRing,
  onClose,
}: {
  map: ApiMap;
  markers: readonly Marker[];
  net: PortalNet;
  canvas: RefObject<MapCanvasHandle | null>;
  /** Mark ids to ring on the map (the portal a row names and its partner). */
  onRing: (ids: readonly string[]) => void;
  onClose: () => void;
}) {
  const { t, tn, lookup, number } = useI18n();
  const phone = useMedia(PHONE);
  const sheetH = useRef(0);
  const showNames = map.meta.showNames;
  const groups = useMemo(() => portalGroups(map.portals, showNames), [map.portals, showNames]);
  const warn = useMemo(() => portalWarnings(map.portals, showNames), [map.portals, showNames]);
  const pair = useMemo(() => partners(map.portals), [map.portals]);
  const places = useMemo(() => placesOf(markers, t, lookup), [markers, t, lookup]);

  const centre = useCallback(
    (x: number, z: number) => {
      if (phone) canvas.current?.reveal(x, z, sheetH.current);
      else canvas.current?.flyTo(x, z, 0.35);
    },
    [phone, canvas],
  );
  const showPortal = useCallback(
    (p: MapPortal) => {
      const q = pair.get(p.id);
      onRing(q ? [`portal:${p.id}`, `portal:${q.id}`] : [`portal:${p.id}`]);
      centre(p.x, p.z);
    },
    [pair, onRing, centre],
  );
  useEffect(() => () => onRing([]), [onRing]);

  const where = (p: { x: number; z: number }) => {
    const near = nearestPlace(p, places);
    return near ? t("portals.near", { place: near.name }) : t("portals.at", { x: number(p.x), z: number(p.z) });
  };
  const portalName = (p: MapPortal) => (p.tag ? t("map.portal.tagged", { tag: p.tag }) : t("map.portal.title"));

  return (
    <Sheet
      labelledBy="portal-net-h"
      onClose={onClose}
      modal={false}
      peek
      onHeight={(px) => {
        sheetH.current = px;
      }}
      header={(close) => (
        <div className="flex items-center gap-3 pl-1">
          <MapIcon icon="portal" size={22} />
          <h2 id="portal-net-h" className="plank-title flex-1 text-lg">
            {t("portals.title")}
          </h2>
          <SheetClose label={t("portals.close")} escLabel={t("key.esc")} onClose={close} />
        </div>
      )}
    >
      <div className="space-y-6 pb-2 text-sm">
        <RouteFinder net={net} map={map} where={where} portalName={portalName} centre={centre} />

        <section aria-labelledby="portal-warn-h">
          <h3 id="portal-warn-h" className="label-caps">
            {t("portals.warnings")}
          </h3>
          {!showNames && <p className="mt-1.5 text-xs text-ash">{t("portals.namesHidden")}</p>}
          {map.portals.length === 0 ? (
            <p className="mt-1.5 text-ash">{t("portals.empty")}</p>
          ) : noWarnings(warn) ? (
            <p className="mt-1.5 text-bone">{t("portals.allGood")}</p>
          ) : (
            <div className="mt-1.5 space-y-3">
              {warn.noPartner.length > 0 && (
                <Warning title={tn("portals.warn.noPartner", warn.noPartner.length)}>
                  {warn.noPartner.map((p) => (
                    <PortalRow key={p.id} name={portalName(p)} where={where(p)} onShow={() => showPortal(p)} />
                  ))}
                </Warning>
              )}
              {warn.crowded.map((g) => (
                <Warning key={g.tag} title={t("portals.warn.crowded", { tag: g.tag, n: number(g.portals.length) })}>
                  {g.portals.map((p) => (
                    <PortalRow key={p.id} name={portalName(p)} where={where(p)} note={pair.has(p.id) ? undefined : t("portals.leadsNowhere")} onShow={() => showPortal(p)} />
                  ))}
                </Warning>
              ))}
              {warn.untagged.length > 0 && (
                <Warning title={tn("portals.warn.untagged", warn.untagged.length)}>
                  {warn.untagged.map((p) => (
                    <PortalRow key={p.id} name={portalName(p)} where={where(p)} onShow={() => showPortal(p)} />
                  ))}
                </Warning>
              )}
            </div>
          )}
        </section>

        {groups.length > 0 && (
          <section aria-labelledby="portal-list-h">
            <h3 id="portal-list-h" className="label-caps">
              {showNames ? t("portals.byTag") : t("portals.pairs")}
            </h3>
            <ul className="mt-1.5 space-y-3">
              {groups.map((g, i) => (
                <li key={g.portals[0]!.id}>
                  <p className="flex items-baseline gap-2 font-bold text-bone">
                    <span className="min-w-0 truncate">{showNames ? g.tag || t("portals.untagged") : g.portals.length > 1 ? t("portals.pair", { n: i + 1 }) : t("portals.lone")}</span>
                    <span className="shrink-0 text-xs font-normal tabular-nums text-ash">{number(g.portals.length)}</span>
                  </p>
                  <ul className="mt-0.5">
                    {g.portals.map((p) => (
                      <PortalRow key={p.id} name={portalName(p)} where={where(p)} note={pair.has(p.id) ? undefined : t("portals.leadsNowhere")} onShow={() => showPortal(p)} />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Sheet>
  );
}

function Warning({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="flex items-start gap-1.5 font-bold text-flame">
        <svg width="14" height="14" viewBox="0 0 16 16" className="mt-0.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden>
          <path d="M8 2l6.5 11.5h-13zM8 6.5v3.5M8 11.8v.2" />
        </svg>
        <span>{title}</span>
      </p>
      <ul className="mt-0.5">{children}</ul>
    </div>
  );
}

function PortalRow({ name, where, note, onShow }: { name: string; where: string; note?: string; onShow: () => void }) {
  return (
    <li>
      <button type="button" onClick={onShow} className="press-soft flex w-full items-center gap-2 rounded-[2px] px-1.5 py-1 text-left hover:bg-black/25 coarse:min-h-11">
        <MapIcon icon="portal" size={18} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-bone">{name}</span>
          <span className="block truncate text-xs text-ash">
            {where}
            {note && <span className="text-flame"> · {note}</span>}
          </span>
        </span>
      </button>
    </li>
  );
}

function RouteFinder({
  net,
  map,
  where,
  portalName,
  centre,
}: {
  net: PortalNet;
  map: ApiMap;
  where: (p: { x: number; z: number }) => string;
  portalName: (p: MapPortal) => string;
  centre: (x: number, z: number) => void;
}) {
  const { t, tn, number } = useI18n();
  const { ends, route, start, end } = net;
  const live = useLivePositions();
  const players = useMemo(() => playerEnds(live.players), [live.players]);
  // A player who logged off stays chosen (with a note) so the route comes back when they do.
  const offline = !!net.from?.key.startsWith("player:") && !start;
  const fromValue = net.from?.key === "spot" ? "spot" : net.from?.key.startsWith("player:") ? net.from.key : (net.start?.key ?? "");
  const fromId = "portal-route-from";
  const toId = "portal-route-to";
  const option = (e: End) => (
    <option key={e.key} value={e.key}>
      {e.label}
    </option>
  );
  const group = (label: string, list: End[]) => list.length > 0 && <optgroup label={label}>{list.map(option)}</optgroup>;
  const stopName = (s: { x: number; z: number; portal?: MapPortal }, last: boolean) => (s.portal ? `${portalName(s.portal)} (${where(s.portal)})` : last ? (end?.label ?? "") : (start?.label ?? ""));

  return (
    <section aria-labelledby="portal-route-h">
      <h3 id="portal-route-h" className="label-caps">
        {t("portals.route")}
      </h3>
      <div className="mt-1.5 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
        <label htmlFor={fromId} className="text-label">
          {t("portals.from")}
        </label>
        <div className="flex min-w-0 gap-2">
          <select
            id={fromId}
            value={fromValue}
            onChange={(e) => {
              const k = e.target.value;
              net.setFrom(k === "spot" ? { key: "spot", label: "", x: net.spot?.x ?? 0, z: net.spot?.z ?? 0 } : ([...ends.bases, ...players].find((c) => c.key === k) ?? null));
            }}
            className="field min-w-0 flex-1 px-2 py-2 text-sm coarse:min-h-11"
          >
            {fromValue === "" && <option value="">{t("portals.chooseFrom")}</option>}
            {group(t("portals.group.bases"), ends.bases)}
            {group(t("portals.group.players"), offline ? [...players, { ...net.from!, label: t("portals.offline", { name: net.from!.label }) }] : players)}
            <option value="spot">{net.spot ? t("portals.spotAt", { x: number(net.spot.x), z: number(net.spot.z) }) : t("portals.spot")}</option>
          </select>
          <button type="button" aria-pressed={net.picking} onClick={() => net.setPicking(!net.picking)} className="plaque press shrink-0 px-2.5 text-xs font-bold coarse:min-h-11">
            {net.picking ? t("portals.cancel") : t("portals.pickSpot")}
          </button>
        </div>
        <label htmlFor={toId} className="text-label">
          {t("portals.to")}
        </label>
        <select
          id={toId}
          value={end?.key ?? ""}
          onChange={(e) => net.setTo([...ends.bases, ...ends.bosses, ...ends.places, ...ends.pins].find((c) => c.key === e.target.value) ?? null)}
          className="field min-w-0 px-2 py-2 text-sm coarse:min-h-11"
        >
          <option value="">{t("portals.chooseTo")}</option>
          {group(t("portals.group.bases"), ends.bases.filter((e) => e.key !== fromValue))}
          {group(t("portals.group.bosses"), ends.bosses)}
          {group(t("portals.group.places"), ends.places)}
          {group(t("portals.group.pins"), ends.pins)}
        </select>
      </div>
      {offline && <p className="mt-2 text-xs text-flame">{t("portals.offlineNote", { name: net.from!.label })}</p>}
      {net.picking && (
        <p role="status" className="mt-2 text-xs text-select-hi">
          {t("portals.picking")}
        </p>
      )}
      {route && start && end && (
        <div className="mt-3" aria-live="polite">
          <p className="font-bold text-bone">
            {t("portals.summary", { walk: distance(route.walk, t, number) })}
            {route.hops > 0 && <>, {tn("portals.hops", route.hops)}</>}
          </p>
          {route.hops > 0 ? <p className="text-xs text-ash">{t("portals.direct", { m: distance(route.direct, t, number) })}</p> : <p className="text-xs text-ash">{t("portals.noHelp")}</p>}
          <ol className="mt-2 space-y-0.5">
            {route.legs.map((leg, i) => {
              const last = i === route.legs.length - 1;
              const text = leg.kind === "walk" ? t("portals.walk", { m: distance(leg.m, t, number), to: stopName(leg.to, last) }) : t("portals.hop", { to: `${portalName(leg.to)} (${where(leg.to)})` });
              return (
                <li key={i}>
                  <button type="button" onClick={() => centre(leg.to.x, leg.to.z)} className="press-soft flex w-full items-start gap-2 rounded-[2px] px-1.5 py-1 text-left hover:bg-black/25 coarse:min-h-11">
                    <span aria-hidden className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[0.6875rem] font-bold tabular-nums ${leg.kind === "hop" ? "bg-select/60 text-bone" : "bg-flame/80 text-coal"}`}>
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 text-bone">{text}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="mt-2 text-xs text-ash">{t("portals.lineNote")}</p>
        </div>
      )}
      {!route && map.portals.length === 0 && <p className="mt-2 text-xs text-ash">{t("portals.empty")}</p>}
    </section>
  );
}

/** A small chip over the map while a route is drawn and the sheet is closed: tap to reopen, x to clear. */
export function RouteChip({ net, onOpen }: { net: PortalNet; onOpen: () => void }) {
  const { t, tn, number } = useI18n();
  if (!net.route) return null;
  return (
    <div role="status" className="material pointer-events-auto flex max-w-full items-center gap-1 rounded-full py-0.5 pl-1 pr-0.5 text-xs font-bold text-bone coarse:text-sm">
      <button type="button" onClick={onOpen} aria-label={t("portals.chipOpen")} className="press flex min-h-8 min-w-0 items-center gap-1.5 rounded-full pl-2.5 pr-1 coarse:min-h-11">
        <MapIcon icon="portal" size={16} />
        <span className="min-w-0 truncate">{t("portals.chip", { walk: distance(net.route.walk, t, number), hops: tn("portals.hops", net.route.hops) })}</span>
      </button>
      <button type="button" onClick={net.clear} aria-label={t("portals.clear")} title={t("portals.clear")} className="press grid h-8 w-8 shrink-0 place-items-center rounded-full text-ash hover:text-bone coarse:h-11 coarse:w-11">
        <svg width="11" height="11" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M3 3l10 10M13 3L3 13" />
        </svg>
      </button>
    </div>
  );
}
