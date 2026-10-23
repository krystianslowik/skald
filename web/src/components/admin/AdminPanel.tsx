import { motion } from "motion/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { NOTIFY_KINDS, type AdminCatalog, type NotifyChange, type NotifyConfig, type NotifyKind } from "../../types";
import { BROADCAST_MAX, changeNotify, gameClock, getCatalog, getNotify, lockAdmin, storeActorName, storedActorName, testNotify, WORLD_KEYS } from "../../lib/admin";
import { isOriginRefusal } from "../../lib/api";
import { gameVersion } from "../../lib/format";
import { failText, notifyTestText } from "../../lib/refusal";
import { useLivePositions } from "../../lib/live";
import { refreshAdminLinks, useAdminLinks } from "../../lib/adminlinks";
import { handoverText } from "../../lib/simhandover";
import { LinkLine } from "./LinkInfo";
import { modLevel, useI18n, type TextKey } from "../../i18n";
import { ItemIcon } from "../storage/ItemIcon";
import { PlatformGlyph } from "../PlatformGlyph";
import { Sheet } from "../Sheet";
import { pluginBelow, targetBody, useAdmin, type Done, type Target } from "./AdminContext";
import { ADMIN_TABS, adminHash, isAdminHash, PANEL_SECTIONS, rememberedTab, rememberTab, setPageUnderSheet, tabOf, type AdminTab, type PanelSection } from "../../lib/adminTabs";
import { sheetDepth, whenSettled } from "../../lib/sheetHistory";
import { fillResult } from "./FillSheet";
import { AdminGlyph } from "./glyphs";
import { HoldButton } from "./HoldButton";
import { SkaldVersion } from "../SkaldVersion";
import { AdminHead, BridgeBanner, Btn, Chip, HealthBar, Section, TargetChips, useArmed } from "./parts";
import { AccessLists, RestoreSection } from "./WorldTools";
import { SafeRestartSection } from "./SafeRestart";
import { CompatRows } from "../Compat";

type Style = "center" | "topleft" | "narrator";
const STYLES: Style[] = ["center", "topleft", "narrator"];
const PRESETS = ["admin.preset.restart5", "admin.preset.boss21", "admin.preset.saving", "admin.preset.raid", "admin.preset.welcome"] as const;

/**
 * The admin sheet, in four tabs: the players (who is at the fire, a message to
 * all, the admin and ban lists, this session), the world (time, raids,
 * creatures, save, world keys), the base (helpers, items) and the server (safe
 * restart, the compatibility check, Discord, backups, the versions). A view-only session
 * says so first, with the unlock. Bridge controls are off (with the reason on
 * top) while it cannot take commands; without a bridge only the players' lists
 * and the server's tools show.
 *
 * Every tab stays mounted while the sheet is open, so a half-typed message or
 * an armed confirm survives a look at another tab. The address shows the tab
 * (`#admin/world`) on the sheet's own history entry, and the tab is remembered
 * for the next time.
 */
export function AdminPanel({ picked, tab: asked, section, onClose }: { picked?: { x: number; z: number }; tab?: AdminTab; section?: PanelSection; onClose: () => void }) {
  const { t } = useI18n();
  const admin = useAdmin();
  const [catalog, setCatalog] = useState<AdminCatalog | null>(null);
  const [name, setName] = useState(storedActorName);
  const reload = useCallback(() => {
    getCatalog()
      .then((r) => r.data && setCatalog(r.data))
      .catch(() => undefined);
  }, []);
  const canRead = !!admin && admin.unlocked && !admin.blocker;
  useEffect(() => {
    if (canRead) reload();
  }, [canRead, reload]);

  // The section asked for, until another tab is picked. A link always mounts a fresh panel
  // (AdminSheets keys it by the link), so these are read once.
  const [at, setAt] = useState(section);
  const [chosen, setChosen] = useState<AdminTab>(() => (section ? tabOf(section) : (asked ?? rememberedTab() ?? "players")));
  const bridgeOn = admin?.bridgeOn ?? false;
  const tabs = bridgeOn ? ADMIN_TABS : NO_BRIDGE_TABS;
  const tab = tabs.includes(chosen) ? chosen : tabs[0]!;
  const opened = at && tabOf(at) === tab ? at : undefined;
  useScrollToSection(opened);
  useAddress(opened ?? tab);
  const top = useRef<HTMLDivElement>(null);
  // Only a tab picked here is remembered: not where a link opened the sheet, nor the tab
  // shown in place of one that is gone while the bridge is away.
  const pick = (next: AdminTab) => {
    if (next === chosen && next === tab) return;
    rememberTab(next);
    setAt(undefined);
    setChosen(next);
    // Each tab starts at its top.
    if (next === tab) return;
    const scroller = top.current?.closest<HTMLElement>("[data-sheet-body]");
    if (scroller) scroller.scrollTop = 0;
  };

  if (!admin) return null;
  const st = admin.status;
  const pickedTarget: Target | null = picked ? { at: picked, label: "map" } : null;

  return (
    <Sheet
      labelledBy="admin-h"
      onClose={onClose}
      width="sm:w-xl"
      header={(close) => (
        <AdminHead
          id="admin-h"
          kicker={t("admin.kicker")}
          title={t("admin.title")}
          emblem={<AdminGlyph size={34} className="text-flame" />}
          sub={st?.bridge.gameBuild ? t("admin.sub", { plugin: st.bridge.plugin ?? "?", build: gameVersion(st.bridge.gameBuild) }) : admin.bridgeOn ? t("admin.subOff") : t("admin.subFiles")}
          onClose={close}
        />
      )}
      subheader={<AdminTabs tabs={tabs} tab={tab} onPick={pick} />}
    >
      <div ref={top} className="pb-6">
        {st?.required && !st.unlocked && (
          <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-[3px] border border-ember/50 bg-black/35 px-4 py-3 text-sm">
            <div className="min-w-0 flex-1">
              <p className="font-bold text-flame">{t("admin.you.locked")}</p>
              <p className="mt-1 text-xs text-ash">{t("admin.you.lockedBody")}</p>
            </div>
            <Btn primary onClick={() => void admin.unlock()}>
              {t("admin.you.unlock")}
            </Btn>
          </div>
        )}
        {bridgeOn ? <BridgeBanner /> : <p className="mb-4 mt-2 text-sm text-ash">{t("admin.noBridge")}</p>}

        <TabPanel id="players" tab={tab}>
          {bridgeOn && (
            <>
              <Players />
              <Broadcast />
            </>
          )}
          <AccessLists />

          <Section title={t("admin.you")} id="admin-you">
            <label htmlFor="admin-name" className="text-xs text-ash">
              {t("admin.you.name")}
            </label>
            <input
              id="admin-name"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => storeActorName(name)}
              placeholder={t("admin.you.placeholder")}
              className="field mt-1.5 w-full"
              autoComplete="nickname"
            />
            {!st?.required ? (
              <p className="mt-3 text-sm text-ash">{t("admin.you.open")}</p>
            ) : st.unlocked ? (
              <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                <p className="flex-1 text-flame">{t("admin.you.unlocked", { min: Math.round(st.idleMs / 60000) })}</p>
                <Btn onClick={() => void lockAdmin().then(admin.refresh)}>{t("admin.you.lock")}</Btn>
              </div>
            ) : null}
          </Section>
        </TabPanel>

        {bridgeOn && (
          <TabPanel id="world" tab={tab}>
            <TimeSection frozen={st?.bridge.timeFrozen ?? false} />
            <Raids catalog={catalog} picked={pickedTarget} onChange={reload} />
            <Section title={t("admin.creatures.title")} id="admin-creatures">
              <Btn
                className="w-full"
                disabled={!!admin.blocker}
                onClick={() => admin.open({ kind: "creatures", target: pickedTarget ?? (admin.players[0] ? { player: admin.players[0].name } : { at: admin.mainBase ?? { x: 0, z: 0 }, label: "base" }) })}
              >
                {t("admin.creatures.open")}
              </Btn>
            </Section>
            <Section title={t("admin.save.title")} id="admin-save">
              <Btn className="w-full" disabled={!!admin.blocker} onClick={() => void admin.run("save", {}, { done: t("admin.save.done") })}>
                {t("admin.save.now")}
              </Btn>
            </Section>
            <WorldKeys catalog={catalog} onChange={reload} open={opened === "keys"} />
          </TabPanel>
        )}

        {bridgeOn && (
          <TabPanel id="base" tab={tab}>
            <BaseHelpers catalog={catalog} picked={pickedTarget} />
            <Section title={t("admin.items.title")} id="admin-items">
              <p className="mb-2 text-sm text-ash">{t("admin.items.lead")}</p>
              <Btn
                className="w-full"
                disabled={!!admin.blocker}
                onClick={() => admin.open({ kind: "items", target: pickedTarget ?? (admin.players[0] ? { player: admin.players[0].name } : admin.mainBase ? { at: admin.mainBase, label: "base" } : { at: { x: 0, z: 0 }, label: "map" }) })}
              >
                {t("admin.items.open")}
              </Btn>
            </Section>
          </TabPanel>
        )}

        <TabPanel id="server" tab={tab}>
          <SafeRestartSection />
          <CompatSection />
          <Notify />
          <RestoreSection />
          <SkaldVersion web={admin.versions.web} agent={admin.versions.agent} update={st?.update} className="mt-6 border-t border-iron/25 pt-3" />
        </TabPanel>
      </div>
    </Sheet>
  );
}

/** Without a bridge there is nothing to do to the live world or a base. */
const NO_BRIDGE_TABS: readonly AdminTab[] = ["players", "server"];
const TAB_LABEL: Record<AdminTab, TextKey> = { players: "admin.tab.players", world: "admin.tab.world", base: "admin.tab.base", server: "admin.tab.server" };
/** The selected tab's slide: transform only, no bounce. */
const SWAP = { type: "spring" as const, bounce: 0, visualDuration: 0.25 };

/**
 * The tabs as one segmented bar, like the settings' modifier steps: arrows,
 * Home and End move between them. It scrolls sideways if the labels ever
 * outgrow the screen, never the page.
 */
function AdminTabs({ tabs, tab, onPick }: { tabs: readonly AdminTab[]; tab: AdminTab; onPick: (t: AdminTab) => void }) {
  const { t } = useI18n();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const last = tabs.length - 1;
    const next = e.key === "ArrowRight" ? Math.min(last, i + 1) : e.key === "ArrowLeft" ? Math.max(0, i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    onPick(tabs[next]!);
    buttons.current[next]?.focus();
  };
  return (
    <div className="scroll-quiet -mx-1 overflow-x-auto px-1 pt-1">
      <div role="tablist" aria-label={t("admin.tabs")} className="slot grid min-w-full auto-cols-[minmax(max-content,1fr)] grid-flow-col gap-0.5 p-[3px]">
        {tabs.map((id, i) => {
          const on = id === tab;
          return (
            <button
              key={id}
              ref={(el) => void (buttons.current[i] = el)}
              id={`admin-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls={`admin-panel-${id}`}
              tabIndex={on ? 0 : -1}
              onClick={() => onPick(id)}
              onKeyDown={(e) => onKey(e, i)}
              className={`press-soft relative min-h-10 whitespace-nowrap rounded-[2px] px-3 text-sm font-bold coarse:min-h-11 ${on ? "text-[#10161d]" : "text-label hover:text-flame"}`}
            >
              {on && <motion.span layoutId="admin-tab" transition={SWAP} className="slot-selected absolute inset-0 rounded-[2px]" />}
              <span className="relative">{t(TAB_LABEL[id])}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** One tab's content; kept mounted and hidden while another tab shows. */
function TabPanel({ id, tab, children }: { id: AdminTab; tab: AdminTab; children: ReactNode }) {
  return (
    <div role="tabpanel" tabIndex={0} id={`admin-panel-${id}`} aria-labelledby={`admin-tab-${id}`} hidden={id !== tab} className="outline-none focus-visible:ring-2 focus-visible:ring-flame/60">
      {children}
    </div>
  );
}

/**
 * Shows where the sheet is in the address bar, on the sheet's own history
 * entry once it is in place: Back and every other close step back to the
 * page's address, untouched. Handing the entry to another sheet (a player, a
 * fill) gives it the page's address back, so a reload or a shared link does
 * not open the admin sheet in its place.
 */
function useAddress(part: AdminTab | PanelSection) {
  // The page's address, as the sheet's entry had it before the first write.
  const page = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    whenSettled(() => {
      if (!live || sheetDepth() === 0) return;
      if (page.current === null) {
        page.current = location.pathname + location.search + (isAdminHash(location.hash) ? "" : location.hash);
        setPageUnderSheet(page.current);
      }
      if (location.hash !== adminHash(part)) history.replaceState(history.state, "", adminHash(part));
    });
    return () => {
      live = false;
    };
  }, [part]);
  useEffect(
    () => () => {
      const back = page.current;
      if (back === null) return;
      setPageUnderSheet(null, back);
      whenSettled(() => {
        // Closed: the step back already landed on the page's entry. Handed over: the entry is still ours.
        if (sheetDepth() > 0 && isAdminHash(location.hash)) history.replaceState(history.state, "", back);
      });
    },
    [],
  );
}

/** Content above a section still loads (the catalog) for about this long; the section is kept in place meanwhile. */
const ANCHOR_MS = 2000;

/**
 * Opens the sheet scrolled to `section`, and keeps it there while the content
 * above it is still settling, until the reader scrolls on their own.
 */
function useScrollToSection(section: PanelSection | undefined) {
  useEffect(() => {
    if (!section) return;
    const heading = document.getElementById(PANEL_SECTIONS[section].heading);
    const scroller = heading?.closest<HTMLElement>("[data-sheet-body]");
    if (!heading || !scroller) return;
    const align = () => {
      scroller.scrollTop += heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
    };
    align();
    const content = scroller.firstElementChild;
    const ro = typeof ResizeObserver === "undefined" || !content ? null : new ResizeObserver(align);
    if (content) ro?.observe(content);
    // Any scrolling of their own (wheel, finger, scrollbar, keys) lets go.
    const own = ["wheel", "touchstart", "pointerdown"] as const;
    const stop = () => {
      ro?.disconnect();
      clearTimeout(timer);
      for (const e of own) scroller.removeEventListener(e, stop);
      document.removeEventListener("keydown", stop);
    };
    const timer = setTimeout(stop, ANCHOR_MS);
    for (const e of own) scroller.addEventListener(e, stop, { passive: true });
    document.addEventListener("keydown", stop);
    return stop;
  }, [section]);
}

/**
 * The compatibility check with the game build: every part with what it found,
 * for everyone who can open the sheet; running it again is an admin's.
 * Missing with an agent older than the check.
 */
function CompatSection() {
  const { t } = useI18n();
  const admin = useAdmin()!;
  const view = admin.compat;
  if (!view) return null;
  const r = view.result;
  const aside = view.running ? t("compat.aside.running") : r ? t(`compat.aside.${r.status}`) : undefined;
  return (
    <Section title={t("compat.title")} aside={aside} id="admin-compat">
      <CompatRows view={view} />
      <Btn className="mt-3" disabled={view.running} onClick={() => void admin.post("/api/admin/compat/run", {}, { done: t("compat.rerun.started") })}>
        {t("compat.rerun")}
      </Btn>
    </Section>
  );
}

/**
 * Discord notifications: the webhook, on or off, which kinds go out, and a
 * test message. Works without the bridge, so its blocker disables nothing
 * here. The webhook URL is typed in once and never comes back from the
 * server, only a masked form; with DISCORD_WEBHOOK_URL set it is read-only.
 */
function Notify() {
  const i18n = useI18n();
  const { t } = i18n;
  const admin = useAdmin()!;
  const [cfg, setCfg] = useState<NotifyConfig | null>(null);
  const [failed, setFailed] = useState(false);
  const [url, setUrl] = useState("");
  const [editing, setEditing] = useState(false);
  const [badUrl, setBadUrl] = useState(false);
  const [busy, setBusy] = useState(false);
  // Read and set at once: two quick taps must not both start a save.
  const busyRef = useRef(false);
  const on = admin.status?.notifyConfigured ?? false;
  const canRead = admin.unlocked;
  const reload = useCallback(() => {
    getNotify()
      .then((r) => {
        setCfg(r.data && pickNotify(r.data));
        setFailed(!r.data);
      })
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    if (canRead) reload();
    else {
      // Locked again: the settings and their controls go with the session.
      setCfg(null);
      setEditing(false);
      setUrl("");
    }
  }, [canRead, reload]);

  /** Saves a change (null removes the webhook); true when it took. */
  const change = async (body: NotifyChange | null, done?: string) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      let r = await changeNotify(body);
      if (r.needsAdmin && (await admin.unlock())) r = await changeNotify(body);
      if (r.ok) {
        setCfg(pickNotify(r as NotifyConfig));
        admin.refresh();
        if (done) admin.toast(true, done);
        return true;
      }
      if (r.status === 400 && r.error === "bad_url") setBadUrl(true);
      else if (r.status === 409) {
        admin.toast(false, t("admin.notify.env"));
        reload();
      }
      else if (!r.needsAdmin) admin.toast(false, r.status === 0 ? t("admin.notify.offline") : isOriginRefusal(r.status, r) ? t("login.refused") : t("admin.notify.saveFailed", { error: failText(i18n, r) }));
      return false;
    } catch {
      // signed out; the next poll takes the panel back to the login screen
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const saveUrl = async () => {
    if (!url.trim()) return;
    setBadUrl(false);
    if (await change({ url: url.trim() }, t("admin.notify.saved"))) {
      // Not kept in the page once saved.
      setUrl("");
      setEditing(false);
    }
  };

  const send = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      let r = await testNotify();
      if (r.needsAdmin && (await admin.unlock())) r = await testNotify();
      if (r.ok) admin.toast(true, t("admin.notify.sent"));
      else if (!r.needsAdmin) admin.toast(false, notifyTestText(i18n, r));
    } catch {
      // signed out; the next poll takes the panel back to the login screen
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const env = cfg?.source === "env";
  const hasHook = cfg ? cfg.masked !== null : on;
  const toggleKind = (k: NotifyKind) => {
    if (!cfg) return;
    const kinds = cfg.kinds.includes(k) ? cfg.kinds.filter((x) => x !== k) : [...cfg.kinds, k];
    void change({ kinds });
  };

  return (
    <Section title={t("admin.notify.title")} id="admin-discord" aside={on ? t("admin.notify.aside.on") : t("admin.notify.aside.off")}>
      <p className="mb-2 text-sm text-ash">{on ? t("admin.notify.on") : !cfg ? t("admin.notify.idle") : !cfg.masked ? t("admin.notify.off") : !cfg.enabled ? t("admin.notify.paused") : t("admin.notify.noKinds")}</p>
      {!cfg ? (
        <p className="mb-2 text-sm text-ash">{canRead ? (failed ? t("admin.notify.loadFailed") : t("admin.notify.loading")) : t("admin.notify.locked")}</p>
      ) : (
        <>
          {env && (
            <p role="status" className="mb-3 rounded-[3px] border border-iron/50 bg-black/35 px-3 py-2 text-sm text-bone">
              {t("admin.notify.env")}
            </p>
          )}
          {cfg.masked && !editing ? (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1">
                <span className="label-caps block">{t("admin.notify.webhook")}</span>
                <span className="block break-all font-mono text-xs text-bone" translate="no">
                  {cfg.masked}
                </span>
              </p>
              {!env && (
                <>
                  <Btn disabled={busy} onClick={() => setEditing(true)}>
                    {t("admin.notify.replace")}
                  </Btn>
                  <Btn disabled={busy} onClick={() => void change(null, t("admin.notify.removed"))}>
                    {t("admin.notify.remove")}
                  </Btn>
                </>
              )}
            </div>
          ) : (
            !env && (
              <div className="mb-3">
                <label htmlFor="notify-url" className="label-caps mb-1.5 block">
                  {t("admin.notify.url")}
                </label>
                <input
                  id="notify-url"
                  type="url"
                  inputMode="url"
                  value={url}
                  maxLength={512}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setBadUrl(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveUrl();
                  }}
                  placeholder="https://discord.com/api/webhooks/…"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  aria-invalid={badUrl}
                  aria-describedby="notify-url-help"
                  className={`field w-full font-mono ${badUrl ? "field-bad" : ""}`}
                />
                <p id="notify-url-help" className={`mt-1.5 text-xs ${badUrl ? "text-blood" : "text-ash"}`} role={badUrl ? "alert" : undefined}>
                  {badUrl ? t("admin.notify.badUrl") : t("admin.notify.urlHelp")}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Btn primary disabled={busy || !url.trim()} onClick={() => void saveUrl()}>
                    {t("admin.notify.save")}
                  </Btn>
                  {editing && (
                    <Btn
                      disabled={busy}
                      onClick={() => {
                        setEditing(false);
                        setUrl("");
                        setBadUrl(false);
                      }}
                    >
                      {t("admin.notify.cancel")}
                    </Btn>
                  )}
                </div>
              </div>
            )
          )}
          {cfg.masked && (
            <>
              {!env && (
                <div className="mb-3">
                  <Chip on={cfg.enabled} disabled={busy} onClick={() => void change({ enabled: !cfg.enabled })}>
                    {t("admin.notify.enabled")}
                  </Chip>
                </div>
              )}
              <p className="label-caps mb-1.5">{t("admin.notify.kinds")}</p>
              <div className="mb-3 flex flex-wrap gap-2">
                {NOTIFY_KINDS.map((k) => (
                  <Chip key={k} on={cfg.kinds.includes(k)} disabled={env || busy || !cfg.enabled} onClick={() => toggleKind(k)}>
                    {t(`admin.notify.kind.${k}`)}
                  </Chip>
                ))}
              </div>
            </>
          )}
        </>
      )}
      {hasHook && (
        <Btn className="w-full" disabled={busy} onClick={() => void send()}>
          {t("admin.notify.test")}
        </Btn>
      )}
    </Section>
  );
}

/** Only the settings, whatever else the answer carried. */
function pickNotify(r: NotifyConfig): NotifyConfig {
  return { source: r.source, masked: r.masked ?? null, enabled: r.enabled, kinds: r.kinds ?? [] };
}

/**
 * Everyone at the fire, live: tap for their sheet. With two or more players
 * each row can hand the simulation of the area around that player to them
 * (bridge 0.7.0+): the first tap arms, the second hands over.
 */
function Players() {
  const i18n = useI18n();
  const { t } = i18n;
  const admin = useAdmin()!;
  const live = useLivePositions();
  const links = useAdminLinks(admin.present && admin.unlocked);
  const [armed, setArmed] = useArmed<string | null>(null);
  const whyId = useId();
  const bridge = admin.status?.bridge;
  const oldPlugin = pluginBelow(admin.status, "0.7.0");
  const agentLacks = !!bridge && bridge.commands.length > 0 && !bridge.commands.includes("sim-handover");
  // Handing over needs someone to take it from.
  const handover = admin.bridgeOn && admin.players.length >= 2;
  const reason = oldPlugin ? t("admin.handover.old", { plugin: bridge?.plugin ?? "?" }) : agentLacks ? t("admin.handover.oldAgent") : null;
  const off = !!admin.blocker || !!reason;
  const handOver = (name: string) => {
    if (armed !== name) return setArmed(name);
    setArmed(null);
    void admin.run("sim-handover", { player: name }, { done: (data) => handoverText(i18n, name, data) }).then((r) => r.ok && refreshAdminLinks());
  };
  return (
    <Section title={t("admin.players.title")} id="admin-players" aside={String(admin.players.length)}>
      {admin.players.length === 0 ? (
        <p className="text-sm text-ash">{t("admin.players.none")}</p>
      ) : (
        <ul className="divide-y divide-iron/25">
          {admin.players.map((p) => {
            const lp = live.players.find((x) => (x.id ?? x.name) === (p.id ?? p.name));
            const on = armed === p.name;
            return (
              <li key={p.id ?? p.name}>
                <button type="button" onClick={() => admin.open({ kind: "player", name: p.name })} className="press flex min-h-12 w-full flex-wrap items-center gap-x-3 py-1.5 text-left">
                  <PlatformGlyph platform={p.platform} size={16} className="text-label" />
                  <span className="w-28 shrink-0 truncate font-bold text-bone">{p.name}</span>
                  {lp ? <HealthBar health={lp.health} max={lp.maxHealth} className="flex-1" /> : <span className="flex-1 text-xs text-ash">{t("admin.players.noPos")}</span>}
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="shrink-0 text-ash" aria-hidden>
                    <path d="M6 3l5 5-5 5" />
                  </svg>
                  <LinkLine p={links.get(p.id ?? p.name)} className="basis-full pl-7" />
                </button>
                {handover && (
                  <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5 pb-2 pl-7">
                    {on && (
                      <p role="status" className="basis-full text-xs text-flame">
                        {t("admin.handover.hint", { player: p.name })}
                      </p>
                    )}
                    <button
                      type="button"
                      disabled={off}
                      // The visible words first, then whose row it is.
                      aria-label={on ? undefined : `${t("admin.handover.button")}: ${p.name}`}
                      aria-describedby={reason ? whyId : undefined}
                      onClick={() => handOver(p.name)}
                      className={`press inline-flex min-h-9 shrink-0 items-center rounded-[3px] border px-3 text-xs font-bold coarse:min-h-11 disabled:cursor-not-allowed disabled:opacity-40 ${on ? "border-flame bg-ember/30 text-bone ring-2 ring-flame" : "border-iron/60 bg-black/30 text-label"}`}
                    >
                      {on ? t("admin.handover.confirm", { player: p.name }) : t("admin.handover.button")}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {handover && reason && (
        <p id={whyId} className="mt-2 text-xs text-flame">
          {reason}
        </p>
      )}
    </Section>
  );
}

/** A message on every screen: centre, top-left corner, or the narrator's gold italics. */
function Broadcast() {
  const { t } = useI18n();
  const admin = useAdmin()!;
  const [text, setText] = useState("");
  const [style, setStyle] = useState<Style>("center");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const r = await admin.run("broadcast", { text: text.trim(), type: style }, { done: t("admin.broadcast.sent") });
    setBusy(false);
    if (r.ok) setText("");
  };
  return (
    <Section title={t("admin.broadcast.title")} id="admin-broadcast">
      <div className="relative">
        <textarea
          value={text}
          maxLength={BROADCAST_MAX}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("admin.broadcast.placeholder")}
          aria-label={t("admin.broadcast.title")}
          className={`field w-full resize-none ${style === "narrator" ? "italic text-[#E8C170]" : ""}`}
        />
        <span className="pointer-events-none absolute bottom-2 right-3 text-[0.6875rem] tabular-nums text-ash">{BROADCAST_MAX - text.length}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {PRESETS.map((k) => (
          <Chip key={k} on={false} onClick={() => setText(t(k))} title={t(k)}>
            {t(`${k}.label`)}
          </Chip>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label={t("admin.broadcast.style")} className="flex flex-1 flex-wrap gap-2">
          {STYLES.map((s) => (
            <Chip key={s} on={style === s} onClick={() => setStyle(s)}>
              {t(`admin.broadcast.${s}`)}
            </Chip>
          ))}
        </div>
        <Btn primary disabled={!text.trim() || busy || !!admin.blocker} onClick={() => void send()}>
          {t("admin.broadcast.send")}
        </Btn>
      </div>
      <p className="mt-2 text-xs text-ash">{t("admin.broadcast.noChat")}</p>
    </Section>
  );
}

/** Sun or moon on an arc over the horizon, for a time of day. */
export function SkyDial({ fraction, size = 132 }: { fraction: number; size?: number }) {
  const day = fraction >= 0.25 && fraction < 0.75;
  const th = (fraction - 0.25) * 2 * Math.PI + (day ? 0 : Math.PI);
  const x = 60 - 45 * Math.cos(th);
  const y = 55 - 45 * Math.sin(th);
  const glow = day ? Math.sin(((fraction - 0.25) / 0.5) * Math.PI) : 0;
  return (
    <svg width={size} height={(size * 64) / 120} viewBox="0 0 120 64" aria-hidden className="shrink-0">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={day ? `rgba(94,151,204,${0.25 + glow * 0.5})` : "rgba(20,26,48,0.9)"} />
          <stop offset="1" stopColor={day ? `rgba(243,184,103,${0.15 + (1 - glow) * 0.35})` : "rgba(46,31,21,0.9)"} />
        </linearGradient>
      </defs>
      <path d="M8 55a52 52 0 0 1 104 0z" fill="url(#sky)" stroke="#6b5745" strokeWidth="1" />
      <path d="M15 55a45 45 0 0 1 90 0" fill="none" stroke="#6b5745" strokeWidth="1" strokeDasharray="2 3" />
      <line x1="2" y1="55" x2="118" y2="55" stroke="#644631" strokeWidth="2" />
      {day ? (
        <circle cx={x} cy={y} r="6" fill="#ecc212" stroke="#ffe58a" strokeWidth="1.5" />
      ) : (
        <path d={`M${x + 4} ${y - 5}a6 6 0 1 0 0 10a5 5 0 1 1 0-10z`} fill="#e6d7b4" />
      )}
    </svg>
  );
}

/** Skip to morning, set a time of day, freeze it. */
function TimeSection({ frozen }: { frozen: boolean }) {
  const { t } = useI18n();
  const admin = useAdmin()!;
  const [fraction, setFraction] = useState(0.5);
  const off = !!admin.blocker;
  return (
    <Section title={t("admin.time.title")} id="admin-time" aside={frozen ? t("admin.time.frozen") : undefined}>
      <div className="flex items-center gap-4">
        <SkyDial fraction={fraction} />
        <div className="min-w-0 flex-1">
          <p className="text-2xl font-bold tabular-nums text-bone">{gameClock(fraction)}</p>
          <input
            type="range"
            min={0}
            max={0.999}
            step={1 / 96}
            value={fraction}
            onChange={(e) => setFraction(Number(e.target.value))}
            aria-label={t("admin.time.slider")}
            aria-valuetext={gameClock(fraction)}
            className="range mt-1 w-full"
          />
          <div className="mt-1 flex justify-between text-[0.6875rem] text-ash">
            {[0, 0.25, 0.5, 0.75].map((f) => (
              <button key={f} type="button" onClick={() => setFraction(f)} className="press min-h-8 px-1 tabular-nums hover:text-bone">
                {gameClock(f)}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Btn primary disabled={off} onClick={() => void admin.run("time", { dayFraction: Math.round(fraction * 1000) / 1000 }, { done: t("admin.time.setDone", { clock: gameClock(fraction) }) })}>
          {t("admin.time.set", { clock: gameClock(fraction) })}
        </Btn>
        <Btn disabled={off} onClick={() => void admin.run("skip-to-morning", {}, { done: t("admin.time.morningDone") })}>
          {t("admin.time.morning")}
        </Btn>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <Btn disabled={off} onClick={() => void admin.run(frozen ? "time-resume" : "time-freeze", {}, { done: frozen ? t("admin.time.resumed") : t("admin.time.frozenDone") }).then(admin.refresh)}>
          {frozen ? t("admin.time.resume") : t("admin.time.freeze")}
        </Btn>
        <p className="flex-1 text-xs text-ash">{t("admin.time.freezeNote")}</p>
      </div>
      <p className="mt-2 text-xs text-ash">{t("admin.time.forward")}</p>
    </Section>
  );
}

/** The running raid with Stop, or start one by its friendly name. */
function Raids({ catalog, picked, onChange }: { catalog: AdminCatalog | null; picked: Target | null; onChange: () => void }) {
  const { t, raidLabel } = useI18n();
  const admin = useAdmin()!;
  const [raid, setRaid] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(picked ?? (admin.players[0] ? { player: admin.players[0].name } : null));
  // A raid hits everyone near the target at once: the first tap arms, the second starts (like a boss spawn).
  const [confirm, setConfirm] = useArmed(false);
  const off = !!admin.blocker;
  const start = () => {
    if (!raid || !target) return;
    if (!confirm) return setConfirm(true);
    setConfirm(false);
    void admin.run("event-start", { name: raid, ...targetBody(target) }, { done: t("admin.raids.started", { raid: raidLabel(raid) }) }).then(onChange);
  };
  const events = catalog?.events ?? [];
  const cur = catalog?.currentEvent;
  return (
    <Section title={t("admin.raids.title")} id="admin-raids">
      {cur ? (
        <div className="mb-3 flex items-center gap-3 rounded-[3px] border border-gold/40 bg-black/30 px-3 py-2">
          <span className="raid-cry flex-1 text-base">{raidLabel(cur.name)}</span>
          <HoldButton disabled={off} onConfirm={() => void admin.run("event-stop", {}, { done: t("admin.raids.stopped") }).then(onChange)}>
            {t("admin.raids.stop")}
          </HoldButton>
        </div>
      ) : (
        <p className="mb-2 text-sm text-ash">{catalog ? t("admin.raids.none") : t("admin.raids.unknown")}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {events.map((e) => (
          <Chip key={e} on={raid === e} onClick={() => (setRaid(e), setConfirm(false))}>
            {raidLabel(e)}
          </Chip>
        ))}
      </div>
      <p className="label-caps mb-2 mt-3">{t("admin.raids.near")}</p>
      <TargetChips value={target} onChange={(v) => (setTarget(v), setConfirm(false))} />
      {confirm && (
        <p role="status" className="mt-3 text-sm text-flame">
          {t("admin.raids.warn")}
        </p>
      )}
      <Btn primary className={`mt-3 w-full ${confirm ? "ring-2 ring-flame" : ""}`} disabled={off || !raid || !target} onClick={start}>
        {raid ? (confirm ? t("admin.raids.confirm", { raid: raidLabel(raid) }) : t("admin.raids.start", { raid: raidLabel(raid) })) : t("admin.raids.pick")}
      </Btn>
    </Section>
  );
}

/**
 * A key the switch list does not know, in words. The game stores a world's
 * creation modifiers as one key, "preset combat_default:resources_muchmore:...",
 * which would otherwise run off the screen as a single unbroken string.
 */
export function describeKey(key: string, t: (k: TextKey, v?: Record<string, string | number>) => string, lookup: (k: string) => string | undefined): { title: string; detail: string } {
  const space = key.indexOf(" ");
  const name = space < 0 ? key : key.slice(0, space);
  const value = space < 0 ? "" : key.slice(space + 1);
  if (name === "preset" && value) {
    const parts = value.split(":").flatMap((pair) => {
      const cut = pair.lastIndexOf("_");
      if (cut < 0) return [];
      const mod = pair.slice(0, cut);
      const level = pair.slice(cut + 1);
      if (level === "default") return [];
      return [`${lookup(`mod.${mod}`) ?? mod}: ${modLevel(lookup, mod, level)}`];
    });
    return { title: t("admin.keys.preset"), detail: parts.length ? parts.join(", ") : t("admin.keys.presetDefault") };
  }
  return { title: lookup(`gkey.${name}`) ?? name, detail: value };
}

/**
 * Global keys as switches, explained. Each one changes the live game for
 * everyone at once, so every switch takes a second tap; boss keys are held to
 * remove. Rarely needed, so the list stays folded under "Advanced" with a count
 * of what is on, unless a link asked for it.
 */
function WorldKeys({ catalog, onChange, open: asked }: { catalog: AdminCatalog | null; onChange: () => void; open: boolean }) {
  const { t, lookup } = useI18n();
  const admin = useAdmin()!;
  const [confirm, setConfirm] = useArmed<string | null>(null);
  const [open, setOpen] = useState(asked);
  useEffect(() => {
    if (asked) setOpen(true);
  }, [asked]);
  const listId = useId();
  const keys = useMemo(() => new Set((catalog?.globalKeys ?? []).map((k) => k.toLowerCase())), [catalog]);
  const off = !!admin.blocker || !catalog;
  const set = (key: string, on: boolean) => void admin.run(on ? "globalkey-set" : "globalkey-remove", { key }, { done: t(on ? "admin.keys.setDone" : "admin.keys.removed", { key }) }).then(onChange);
  const extra = [...keys].filter((k) => !WORLD_KEYS.some((w) => w.key === k) && !/^activebosses/.test(k));
  const known = WORLD_KEYS.filter(({ key }) => keys.has(key)).length;
  return (
    <Section title={t("admin.keys.title")} id="admin-keys" aside={catalog ? t("admin.keys.on", { n: known + extra.length }) : undefined}>
      <p className="mb-2 text-sm text-ash">{t("admin.keys.lead")}</p>
      <button type="button" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)} className="plaque press flex min-h-11 w-full items-center gap-3 rounded-[3px] px-4 text-left text-sm font-bold">
        <span className="flex-1">{t("admin.keys.advanced", { n: WORLD_KEYS.length + extra.length })}</span>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className={`shrink-0 text-ash ${open ? "rotate-90" : ""}`} aria-hidden>
          <path d="M6 3l5 5-5 5" />
        </svg>
      </button>
      <ul id={listId} hidden={!open} className="mt-1 divide-y divide-iron/25">
        {WORLD_KEYS.map(({ key, boss }) => {
          const on = keys.has(key);
          const label = boss ? (lookup(`boss.${key}`) ?? key) : (lookup(`gkey.${key}`) ?? key);
          const why = lookup(`gkey.${key}.why`) ?? (boss ? t("admin.keys.bossWhy", { boss: label }) : "");
          return (
            <li key={key} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-bone">
                  {label} <span className="font-mono text-[0.6875rem] font-normal text-ash">{key}</span>
                </p>
                {why && <p className="text-xs leading-snug text-ash">{why}</p>}
                {confirm === key && <p role="status" className="mt-1 text-xs font-bold text-flame">{t("admin.keys.riskyConfirm")}</p>}
              </div>
              {on && boss ? (
                <HoldButton disabled={off} onConfirm={() => set(key, false)}>
                  {t("admin.keys.remove")}
                </HoldButton>
              ) : (
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={label}
                  disabled={off}
                  onClick={() => {
                    if (confirm !== key) return setConfirm(key);
                    setConfirm(null);
                    set(key, !on);
                  }}
                  className={`press relative h-8 w-14 shrink-0 rounded-full border transition-colors disabled:opacity-40 coarse:h-11 coarse:w-18 ${confirm === key ? "ring-2 ring-flame" : ""} ${on ? "border-select-hi/70 bg-select/50" : confirm === key ? "border-flame bg-ember/30" : "border-iron/60 bg-black/40"}`}
                >
                  <span className={`absolute top-1/2 h-6 w-6 -translate-y-1/2 rounded-full bg-bone shadow-sm transition-[left] coarse:h-8 coarse:w-8 ${on ? "left-[calc(100%-1.75rem)] coarse:left-[calc(100%-2.25rem)]" : "left-1"}`} />
                </button>
              )}
            </li>
          );
        })}
        {extra.map((key) => {
          const { title, detail } = describeKey(key, t, lookup);
          return (
          <li key={key} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-bone [overflow-wrap:anywhere]">{title}</p>
              {detail && <p className="text-xs leading-snug text-ash [overflow-wrap:anywhere]">{detail}</p>}
            </div>
            <HoldButton danger={false} disabled={off} onConfirm={() => set(key, false)}>
              {t("admin.keys.remove")}
            </HoldButton>
          </li>
          );
        })}
      </ul>
    </Section>
  );
}

/**
 * Repair, fill, refuel, grow, reveal the map: around a base or a player
 * (50 m; refuelling 20 to 100 m, the map 60 m). Kilns only ever take wood, so they fill in one tap; smelters
 * and fermenters open a short flow to pick what goes in, and refuelling fires
 * one to pick how far.
 */
function BaseHelpers({ catalog, picked }: { catalog: AdminCatalog | null; picked: Target | null }) {
  const i18n = useI18n();
  const { t } = i18n;
  const admin = useAdmin()!;
  const [target, setTarget] = useState<Target | null>(picked ?? (admin.mainBase ? { at: admin.mainBase, label: "base" } : admin.players[0] ? { player: admin.players[0].name } : null));
  const off = !!admin.blocker || !target;
  // Kilns and smelters fill from bridge 0.3.0, fermenters from 0.4.0; an older plugin answers "unknown command".
  const bridge = admin.status?.bridge;
  const oldFill = pluginBelow(admin.status, "0.3.0");
  const oldFerment = pluginBelow(admin.status, "0.4.0");
  // An agent that lists its commands but not these predates them (a web update ahead of the agent).
  const agentLacks = (c: string) => !!bridge && bridge.commands.length > 0 && !bridge.commands.includes(c);
  const noKilns = oldFill || agentLacks("fill-kilns");
  const noSmelters = oldFill || agentLacks("fill-smelters");
  const noFermenters = oldFerment || agentLacks("fill-fermenters");
  const whyId = useId();
  const reason = oldFerment ? t(oldFill ? "admin.base.oldFill" : "admin.base.oldFerment", { plugin: bridge?.plugin ?? "?" }) : noKilns || noSmelters || noFermenters ? t("admin.base.oldAgent") : null;
  // Fires refuel from bridge 0.5.0.
  const oldRefuel = pluginBelow(admin.status, "0.5.0");
  const noRefuel = oldRefuel || agentLacks("refuel-fires");
  const refuelReason = oldRefuel ? t("admin.base.oldRefuel", { plugin: bridge?.plugin ?? "?" }) : noRefuel ? t("admin.base.oldAgentRefuel") : null;
  const refuelWhyId = useId();
  const refuelOwnLine = !!refuelReason && refuelReason !== reason;
  const go = (command: "repair" | "fill-kilns" | "grow" | "map-reveal", done: Done) => target && void admin.run(command, { radius: command === "map-reveal" ? 60 : 50, ...targetBody(target) }, { done });
  const fill = (station: "smelters" | "fermenters") => target && admin.open({ kind: "fill", station, target, catalog });
  return (
    <Section title={t("admin.base.title")} id="admin-base">
      <TargetChips value={target} onChange={setTarget} />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Btn disabled={off || noKilns} describedBy={noKilns ? whyId : undefined} onClick={() => go("fill-kilns", (data) => fillResult(i18n, "fill-kilns", data))} className="justify-start pl-2.5 text-left">
          <ItemIcon name="Wood" size={20} iconSize={28} className="text-label" />
          {t("admin.base.fillKilns")}
        </Btn>
        <Btn disabled={off || noSmelters} describedBy={noSmelters ? whyId : undefined} onClick={() => fill("smelters")} className="justify-start pl-2.5 text-left">
          <ItemIcon name="CopperOre" size={20} iconSize={28} className="text-label" />
          {t("admin.fill.title")}
        </Btn>
        <Btn disabled={off || noFermenters} describedBy={noFermenters ? whyId : undefined} onClick={() => fill("fermenters")} className="justify-start pl-2.5 text-left">
          <ItemIcon name="MeadBaseTasty" size={20} iconSize={28} className="text-label" />
          {t("admin.ferment.title")}
        </Btn>
        <Btn disabled={off || noRefuel} describedBy={noRefuel ? (refuelOwnLine ? refuelWhyId : whyId) : undefined} onClick={() => target && admin.open({ kind: "refuel", target })} className="justify-start pl-2.5 text-left">
          <ItemIcon name="Torch" size={20} iconSize={28} className="text-label" />
          {t("admin.refuel.title")}
        </Btn>
        <Btn disabled={off} onClick={() => go("repair", t("admin.base.repaired"))}>
          {t("admin.base.repair")}
        </Btn>
        <Btn disabled={off} onClick={() => go("grow", t("admin.base.grown"))}>
          {t("admin.base.grow")}
        </Btn>
        <Btn disabled={off} onClick={() => go("map-reveal", t("admin.base.revealed"))}>
          {t("admin.base.reveal")}
        </Btn>
      </div>
      {reason && (
        <p id={whyId} className="mt-2 text-xs text-flame">
          {reason}
        </p>
      )}
      {refuelOwnLine && (
        <p id={refuelWhyId} className="mt-2 text-xs text-flame">
          {refuelReason}
        </p>
      )}
      <p className="mt-2 text-xs text-ash">{t("admin.base.note")}</p>
    </Section>
  );
}
