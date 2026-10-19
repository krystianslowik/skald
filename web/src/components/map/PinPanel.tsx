import { useState } from "react";
import type { WebPin } from "@server/pintypes";
import { useI18n, type TextKey } from "../../i18n";
import { filterPins, PIN_ICON_MARK, type PinFilter, type PinsLoad } from "../../lib/webpins";
import { MapIcon } from "./MapIcon";

/** Chips in a row, one of them chosen. */
function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { v: T; text: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          onClick={() => onChange(o.v)}
          className={`press-soft flex-1 rounded-full border px-2.5 py-1 text-xs font-bold coarse:min-h-10 coarse:text-sm ${value === o.v ? "border-select bg-select/25 text-bone" : "border-iron/60 text-ash hover:text-bone"}`}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}

function PinRow({ pin, onPick }: { pin: WebPin; onPick: (pin: WebPin) => void }) {
  const { t } = useI18n();
  const who = pin.state === "claimed" ? (pin.claimedBy ?? "") : pin.state === "new" ? pin.author : pin.stateBy;
  return (
    <li>
      <button type="button" onClick={() => onPick(pin)} className="press-soft flex w-full items-center gap-2 rounded-[2px] px-1.5 py-1 text-left hover:bg-black/25 coarse:min-h-11">
        <MapIcon icon={PIN_ICON_MARK[pin.icon]} size={20} dim={pin.archived} />
        <span className="min-w-0 flex-1 truncate text-bone">{pin.note || t(`pins.icon.${pin.icon}` as TextKey)}</span>
        <span className="shrink-0 text-xs text-ash">
          {t(`pins.state.${pin.state}` as TextKey)}
          {who ? ` · ${who}` : ""}
        </span>
      </button>
    </li>
  );
}

/**
 * The web pins' part of the layers panel: shown or not, whose (group or mine),
 * which (open or completed), the matching pins to fly to, and the archive.
 */
export function PinPanel({ pins, load, filter, me, onFilter, onPick }: { pins: readonly WebPin[]; load: PinsLoad; filter: PinFilter; me: string; onFilter: (f: PinFilter) => void; onPick: (pin: WebPin) => void }) {
  const { t, tn } = useI18n();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const shown = filterPins(pins, { ...filter, show: true }, me);
  const archived = pins.filter((p) => p.archived);
  return (
    <div>
      <div className="flex items-center gap-2">
        <h3 className="label-caps flex-1">{t("pins.title")}</h3>
        <button
          type="button"
          aria-pressed={filter.show}
          onClick={() => onFilter({ ...filter, show: !filter.show })}
          aria-label={t("map.layerToggle", { layer: t("pins.title"), state: filter.show ? t("map.on") : t("map.off.state") })}
          className="press-soft grid min-h-8 place-items-center px-1 coarse:min-h-11"
        >
          <span aria-hidden className={`h-3.5 w-6 rounded-full p-[2px] transition-colors coarse:h-7 coarse:w-12 coarse:p-[3px] ${filter.show ? "bg-select" : "bg-black/50"}`}>
            <span className={`block h-2.5 w-2.5 rounded-full bg-bone transition-transform motion-reduce:transition-none coarse:h-5.5 coarse:w-5.5 ${filter.show ? "translate-x-2.5 coarse:translate-x-5" : ""}`} />
          </span>
        </button>
      </div>
      <p className="mt-0.5 text-xs text-ash">{t("pins.howTo")}</p>
      <div className={`mt-2 space-y-1.5 ${filter.show ? "" : "opacity-45"}`}>
        <Choice
          label={t("pins.filter.who")}
          value={filter.who}
          options={[
            { v: "group", text: t("pins.filter.group") },
            { v: "mine", text: t("pins.filter.mine") },
          ]}
          onChange={(who) => onFilter({ ...filter, who, show: true })}
        />
        <Choice
          label={t("pins.filter.status")}
          value={filter.status}
          options={[
            { v: "open", text: t("pins.filter.open") },
            { v: "completed", text: t("pins.filter.completed") },
          ]}
          onChange={(status) => onFilter({ ...filter, status, show: true })}
        />
      </div>
      {filter.who === "mine" && !me && <p className="mt-2 text-xs text-ash">{t("pins.noName")}</p>}
      <ul className="mt-2 max-h-60 space-y-0.5 overflow-y-auto">
        {load === "ready" && shown.length === 0 && <li className="text-xs text-ash">{t("pins.empty")}</li>}
        {shown.map((p) => (
          <PinRow key={p.id} pin={p} onPick={onPick} />
        ))}
      </ul>
      {archived.length > 0 && (
        <div className="mt-2">
          <button type="button" aria-expanded={archiveOpen} onClick={() => setArchiveOpen((o) => !o)} className="press-text text-xs font-bold text-ash hover:text-bone coarse:min-h-10">
            {tn("pins.archived", archived.length)}
          </button>
          {archiveOpen && (
            <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto">
              {archived.map((p) => (
                <PinRow key={p.id} pin={p} onPick={onPick} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
