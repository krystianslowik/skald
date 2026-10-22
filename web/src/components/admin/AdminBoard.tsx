import { memo } from "react";
import { useLivePositions } from "../../lib/live";
import { useI18n } from "../../i18n";
import { PlatformGlyph } from "../PlatformGlyph";
import { Plank } from "../Plank";
import { preloadAdmin, useAdmin } from "./AdminContext";
import { AdminGlyph } from "./glyphs";
import { useAdminLinks } from "../../lib/adminlinks";
import { LinkLine } from "./LinkInfo";
import { BridgeBanner, HealthBar } from "./parts";

/**
 * The phone's way in to the admin sheet (Settings tab): the bridge's state,
 * the players at the fire, and the button. Hidden when the agent has no bridge.
 */
export const AdminBoard = memo(function AdminBoard() {
  const { t } = useI18n();
  const admin = useAdmin();
  if (!admin?.present) return null;
  return (
    <Plank title={t("admin.title")} id="admin-board" aside={admin.status?.required && !admin.unlocked ? t("admin.you.locked") : undefined}>
      <BridgeBanner compact />
      <button
        type="button"
        onClick={() => admin.open({ kind: "panel" })}
        onPointerDown={preloadAdmin}
        aria-haspopup="dialog"
        className="plaque press mt-2 flex min-h-12 w-full items-center gap-3 px-4 text-left font-bold"
      >
        <AdminGlyph size={20} />
        <span className="flex-1">{t("admin.open")}</span>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 3l5 5-5 5" />
        </svg>
      </button>
      {admin.players.length > 0 && <BoardPlayers />}
    </Plank>
  );
});

/** The players with their health; asks for live positions only while shown. */
function BoardPlayers() {
  const admin = useAdmin()!;
  const live = useLivePositions();
  const links = useAdminLinks(admin.present && admin.unlocked);
  return (
    <ul className="mt-2 divide-y divide-iron/25">
      {admin.players.map((p) => {
        const lp = live.players.find((x) => (x.id ?? x.name) === (p.id ?? p.name));
        return (
          <li key={p.id ?? p.name}>
            <button type="button" onClick={() => admin.open({ kind: "player", name: p.name })} onPointerDown={preloadAdmin} className="press flex min-h-12 w-full flex-wrap items-center gap-x-3 py-1.5 text-left">
              <PlatformGlyph platform={p.platform} size={16} className="text-label" />
              <span className="w-24 shrink-0 truncate font-bold text-bone">{p.name}</span>
              {lp && <HealthBar health={lp.health} max={lp.maxHealth} className="flex-1" />}
              <LinkLine p={links.get(p.id ?? p.name)} className="basis-full pl-7" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
