import type { I18n } from "../../i18n";
import type { Task } from "../../lib/tasks";

/** The task's place in the world, in words: a boss or a base. */
export function targetLabel(i: Pick<I18n, "t" | "lookup">, task: Pick<Task, "target">): string | null {
  const tg = task.target;
  if (!tg) return null;
  if (tg.kind === "boss") return i.t("tasks.target.bossNamed", { boss: i.lookup(`boss.${tg.key}`) ?? tg.key });
  return i.t("tasks.target.baseNamed", { base: tg.name });
}

/** Own marks for the three states: an empty ring, a half-filled one, a ring with a tick. */
export function StatusMark({ status, size = 18 }: { status: Task["status"]; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {status === "todo" && <circle cx="10" cy="10" r="7" stroke="#b3a596" />}
      {status === "doing" && (
        <>
          <circle cx="10" cy="10" r="7" stroke="#f3b867" />
          <path d="M10 3a7 7 0 0 1 0 14z" fill="#f3b867" stroke="none" />
        </>
      )}
      {status === "done" && (
        <>
          <circle cx="10" cy="10" r="7" stroke="#8cbce6" />
          <path d="M6.5 10.2l2.4 2.4 4.6-5" stroke="#8cbce6" />
        </>
      )}
    </svg>
  );
}
