// Browserbase — real-browser research tools for discovery agents
// (residential proxies on). Lifecycle: ONE session per execution chunk,
// created just-in-time and released in the caller's `finally`. Sessions are
// created WITHOUT keepAlive on purpose: if the serverless invocation dies,
// the CDP disconnect terminates the session — no orphaned browser-hours.
// The per-session `timeout` is the second safety net; the run's pessimistic
// minutes budget (charged at claim time, never refunded) is the third.
// Both packages are LAZY-imported inside the functions that use them:
// loading them at module scope crashed every route that transitively
// imports this file on Vercel (500 before the handler ran). Type-only
// imports are erased at compile time, so they're safe here.
import type Browserbase from "@browserbasehq/sdk";
import type { Browser, Page } from "playwright-core";
import {
  BB_SESSION_TIMEOUT_SECONDS,
  TOOL_RESULT_CHAR_CAP,
} from "./config";

/** What a tool executor needs: one page (tab) + the session id. Concurrent
 *  tasks each get their OWN page on the shared browser — a single Page
 *  cannot serve two navigations at once. */
export interface BrowserHandle {
  sessionId: string;
  page: Page;
  /** CDP target id of THIS task's tab — the live view must point at the
   *  agent's page, not the session's default about:blank page. */
  targetId?: string;
}

export interface BrowserSession extends BrowserHandle {
  browser: Browser;
}

async function bbClient(): Promise<Browserbase> {
  const { default: BrowserbaseCtor } = await import("@browserbasehq/sdk");
  return new BrowserbaseCtor({ apiKey: process.env.BROWSERBASE_API_KEY });
}

export async function createBrowserSession(): Promise<BrowserSession> {
  const bb = await bbClient();
  const session = await bb.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID!,
    proxies: true, // managed residential proxies
    timeout: BB_SESSION_TIMEOUT_SECONDS,
  });
  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  await blockHeavyResources(page);
  return { sessionId: session.id, browser, page };
}

/** Residential proxy data bills per GB — don't pull pixels we never read.
 *  Both callbacks reject routinely when a navigation cancels in-flight
 *  requests or the session closes — swallow to avoid unhandled rejections. */
async function blockHeavyResources(page: Page): Promise<void> {
  await page.route("**/*", (route) => {
    const kind = route.request().resourceType();
    if (kind === "image" || kind === "media" || kind === "font") {
      route.abort().catch(() => {});
    } else {
      route.continue().catch(() => {});
    }
  });
}

/** A fresh tab on the shared browser for one task's chunk. */
export async function createTaskPage(
  session: BrowserSession,
): Promise<BrowserHandle> {
  const context =
    session.browser.contexts()[0] ?? (await session.browser.newContext());
  const page = await context.newPage();
  await blockHeavyResources(page);
  let targetId: string | undefined;
  try {
    const cdp = await context.newCDPSession(page);
    const info = (await cdp.send("Target.getTargetInfo")) as {
      targetInfo?: { targetId?: string };
    };
    targetId = info.targetInfo?.targetId;
    await cdp.detach();
  } catch {
    // Live view degrades to the session-level URL.
  }
  return { sessionId: session.sessionId, page, targetId };
}

export async function closeTaskPage(handle: BrowserHandle | null): Promise<void> {
  try {
    await handle?.page.close();
  } catch {
    // Session may already be gone.
  }
}

/** Live-view link for the owner ("watch the agent browse"). The session's
 *  debug endpoint lists every PAGE; we must return the URL for the task's
 *  own tab (matched by CDP target id) — the session-level URL points at the
 *  default page, which sits on about:blank forever. Best-effort. */
export async function pageDebugUrl(
  sessionId: string,
  pageId: string | null,
): Promise<string | null> {
  try {
    const bb = await bbClient();
    const debug = (await bb.sessions.debug(sessionId)) as {
      debuggerFullscreenUrl?: string;
      debuggerUrl?: string;
      pages?: Array<{
        id?: string;
        url?: string;
        debuggerFullscreenUrl?: string;
        debuggerUrl?: string;
      }>;
    };
    const pages = debug.pages ?? [];
    const byId = pageId ? pages.find((p) => p.id === pageId) : undefined;
    // Fallback: any page actually browsing (not the blank default tab).
    const active = byId ?? pages.find((p) => p.url && p.url !== "about:blank");
    return (
      active?.debuggerFullscreenUrl ??
      active?.debuggerUrl ??
      debug.debuggerFullscreenUrl ??
      debug.debuggerUrl ??
      null
    );
  } catch {
    return null;
  }
}

/** Best-effort: sessions also self-terminate on timeout / CDP disconnect. */
export async function releaseBrowserSession(
  s: BrowserSession | null,
): Promise<void> {
  if (!s) return;
  try {
    await s.browser.close();
  } catch {
    // Already gone.
  }
  try {
    const bb = await bbClient();
    await bb.sessions.update(s.sessionId, {
      projectId: process.env.BROWSERBASE_PROJECT_ID!,
      status: "REQUEST_RELEASE",
    });
  } catch {
    // Best-effort — the session timeout is the backstop.
  }
}

/** Cancel-path cleanup: release by id alone (no live CDP handle). */
export async function releaseSessionById(sessionId: string): Promise<void> {
  try {
    const bb = await bbClient();
    await bb.sessions.update(sessionId, {
      projectId: process.env.BROWSERBASE_PROJECT_ID!,
      status: "REQUEST_RELEASE",
    });
  } catch {
    // Session timeout is the backstop.
  }
}

// ---------------------------------------------------------------------------
// The two research tools models see. Schemas stay lean (invariant #4 habit).
// ---------------------------------------------------------------------------
export const BROWSER_TOOL_DEFS = [
  {
    name: "web_search",
    description:
      "Search the web. Returns the top results as titles, URLs, and snippets.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "The search query." },
      },
      required: ["query"],
    },
  },
  {
    name: "open_page",
    description:
      "Open a URL in the browser and return the page's readable text (trimmed).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to open." },
      },
      required: ["url"],
    },
  },
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_DEFS)[number]["name"];

const NAV_TIMEOUT_MS = 30_000;

/** DDG SERP anchors are /l/?uddg=<encoded> redirects — decode to hand the
 *  model real URLs (saves an open_page hop through the redirect). */
function decodeDdgUrl(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : href;
  } catch {
    return href;
  }
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function formatResults(results: SearchResult[], engine: string): string {
  return (
    results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join("\n") + `\n(results via ${engine})`
  );
}

/** Google first — we're on a real browser with residential proxies, so we
 *  look like a real user and get Google-quality results. Returns null when
 *  Google interferes (captcha/consent/unparseable), so the caller can fall
 *  back to DuckDuckGo instead of surfacing an error to the agent. */
async function googleSearch(
  page: Page,
  query: string,
): Promise<SearchResult[] | null> {
  try {
    await page.goto(
      `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&hl=en`,
      { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" },
    );
    if (page.url().includes("/sorry/")) return null; // rate-limit interstitial
    // EU-style consent wall (rare on US residential IPs, cheap to handle).
    const consent = await page.$("#L2AGLb, button[aria-label*='Accept']");
    if (consent) {
      await consent.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }
    if (await page.$("#captcha-form, form[action*='sorry']")) return null;
    const results = await page.$$eval("#search h3", (headings) =>
      headings.slice(0, 12).map((h) => {
        const a = h.closest("a") as HTMLAnchorElement | null;
        // Snippet: the nearest result container's descriptive text block.
        const container = h.closest("div[data-hveid], div.g");
        const snippetEl = container?.querySelector(
          "div[data-sncf], .VwiC3b, div[style*='-webkit-line-clamp']",
        );
        return {
          title: h.textContent?.trim() ?? "",
          url: a?.href ?? "",
          snippet: snippetEl?.textContent?.trim() ?? "",
        };
      }),
    );
    const usable = results.filter(
      (r) => r.title && /^https?:\/\//i.test(r.url) && !r.url.includes("google."),
    );
    return usable.length > 0 ? usable.slice(0, 8) : null;
  } catch {
    return null;
  }
}

async function ddgSearch(
  page: Page,
  query: string,
): Promise<SearchResult[] | null> {
  try {
    await page.goto(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" },
    );
    if (await page.$("form[action*='anomaly'], .anomaly-modal")) return null;
    const results = await page.$$eval(".result", (nodes) =>
      nodes.slice(0, 8).map((n) => {
        const a = n.querySelector<HTMLAnchorElement>(".result__a");
        const s = n.querySelector(".result__snippet");
        return {
          title: a?.textContent?.trim() ?? "",
          url: a?.href ?? "",
          snippet: s?.textContent?.trim() ?? "",
        };
      }),
    );
    const usable = results
      .filter((r) => r.title && r.url)
      .map((r) => ({ ...r, url: decodeDdgUrl(r.url) }));
    return usable.length > 0 ? usable : null;
  } catch {
    return null;
  }
}

async function toolWebSearch(page: Page, query: string): Promise<string> {
  const google = await googleSearch(page, query);
  if (google) return formatResults(google, "Google");
  const ddg = await ddgSearch(page, query);
  if (ddg) return formatResults(ddg, "DuckDuckGo — Google was unavailable");
  return "Search is temporarily unavailable — try again in a moment or open a URL you already know.";
}

async function toolOpenPage(page: Page, url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) {
    return "Error: only absolute http(s) URLs can be opened.";
  }
  await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
  const text = await page.evaluate(() => {
    for (const sel of ["script", "style", "noscript", "svg", "nav", "footer"]) {
      document.querySelectorAll(sel).forEach((el) => el.remove());
    }
    return document.body?.innerText ?? "";
  });
  const cleaned = text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  if (!cleaned) return "The page rendered no readable text.";
  return cleaned.length > TOOL_RESULT_CHAR_CAP
    ? `${cleaned.slice(0, TOOL_RESULT_CHAR_CAP)}\n\n[truncated at ${TOOL_RESULT_CHAR_CAP} chars]`
    : cleaned;
}

/**
 * Execute one tool call. NEVER throws for content-level failures — the
 * model sees the error text and adapts (a dead page or expired session is
 * research friction, not a phase failure).
 */
export async function execBrowserTool(
  session: BrowserHandle,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    if (name === "web_search") {
      const q = typeof args.query === "string" ? args.query.slice(0, 400) : "";
      if (!q) return "Error: web_search needs a non-empty query string.";
      return await toolWebSearch(session.page, q);
    }
    if (name === "open_page") {
      const url = typeof args.url === "string" ? args.url.slice(0, 2000) : "";
      return await toolOpenPage(session.page, url);
    }
    return `Error: unknown tool "${name}".`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: the browser action failed (${msg.slice(0, 200)}). Try a different query or URL.`;
  }
}
