import { compareVersions, isRelease } from "./version";

export const RELEASES_URL = "https://api.github.com/repos/krystianslowik/skald/releases/latest";

/** A newer Skald release and its notes. */
export interface UpdateInfo {
  version: string;
  url: string;
}

export interface UpdateCheckOptions {
  /** This build's version; a `dev` build never checks. */
  current: string;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  /** How long an answer is kept; 12 h. */
  ttlMs?: number;
  timeoutMs?: number;
  /** Called once, on the first failure; later ones are silent. */
  log?: (msg: string) => void;
}

interface Release {
  tag_name?: unknown;
  html_url?: unknown;
}

/**
 * Asks GitHub for the latest Skald release at most once per TTL, lazily (the
 * first call after the TTL starts a check in the background and answers from
 * what it knows). A plain GET with a `skald/<version>` User-Agent and the last
 * ETag; nothing about the server is sent. Every failure leaves the last answer
 * in place.
 */
export class UpdateChecker {
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private latest: UpdateInfo | null = null;
  private etag: string | null = null;
  private checkedAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | null = null;
  private warned = false;

  constructor(private readonly opt: UpdateCheckOptions) {
    this.fetchImpl = opt.fetchImpl ?? fetch;
    this.clock = opt.clock ?? Date.now;
    this.ttlMs = opt.ttlMs ?? 12 * 60 * 60 * 1000;
    this.timeoutMs = opt.timeoutMs ?? 10_000;
  }

  /** The newer release, if one is known; starts a check when the last one is older than the TTL. */
  get(): UpdateInfo | null {
    if (isRelease(this.opt.current) && this.clock() - this.checkedAt >= this.ttlMs) void this.check();
    return this.newer();
  }

  /** One check now (deduplicated while in flight). Never throws. */
  check(): Promise<void> {
    this.inflight ??= this.run().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private newer(): UpdateInfo | null {
    if (!this.latest) return null;
    const c = compareVersions(this.latest.version, this.opt.current);
    return c !== null && c > 0 ? this.latest : null;
  }

  private async run(): Promise<void> {
    this.checkedAt = this.clock();
    try {
      const headers: Record<string, string> = { "User-Agent": `skald/${this.opt.current}`, Accept: "application/vnd.github+json" };
      if (this.etag) headers["If-None-Match"] = this.etag;
      const res = await this.fetchImpl(RELEASES_URL, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.status === 304) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Release;
      const tag = typeof body.tag_name === "string" ? body.tag_name.replace(/^v/, "") : "";
      if (!isRelease(tag)) throw new Error("no release tag in the answer");
      const url = typeof body.html_url === "string" && body.html_url.startsWith("https://github.com/") ? body.html_url : `https://github.com/krystianslowik/skald/releases/tag/v${tag}`;
      this.latest = { version: tag, url };
      this.etag = res.headers.get("ETag");
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        (this.opt.log ?? console.warn)(`update check failed (${e instanceof Error ? e.message : String(e)}); it stays quiet from now on`);
      }
    }
  }
}
