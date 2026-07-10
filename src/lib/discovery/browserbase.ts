// Browserbase — real-browser research tools for discovery agents
// (residential proxies on). Lifecycle: ONE session per execution chunk,
// created just-in-time and released in the caller's `finally`. Sessions are
// created WITHOUT keepAlive on purpose: if the serverless invocation dies,
// the CDP disconnect terminates the session — no orphaned browser-hours.
// The per-session `timeout` is the second safety net; the run's pessimistic
// minutes budget (charged at claim time, never refunded) is the third.
import Browserbase from "@browserbasehq/sdk";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  BB_SESSION_TIMEOUT_SECONDS,
  TOOL_RESULT_CHAR_CAP,
} from "./config";

export interface BrowserSession {
  sessionId: string;
  browser: Browser;
  page: Page;
}

function bbClient(): Browserbase {
  return new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
}

export async function createBrowserSession(): Promise<BrowserSession> {
  const bb = bbClient();
  const session = await bb.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID!,
    proxies: true, // managed residential proxies
    timeout: BB_SESSION_TIMEOUT_SECONDS,
  });
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  // Residential proxy data bills per GB — don't pull pixels we never read.
  await page.route("**/*", (route) => {
    const kind = route.request().resourceType();
    // Both reject routinely when a navigation cancels in-flight requests or
    // the session closes — swallow to avoid unhandled rejections.
    if (kind === "image" || kind === "media" || kind === "font") {
      route.abort().catch(() => {});
    } else {
      route.continue().catch(() => {});
    }
  });
  return { sessionId: session.id, browser, page };
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
    await bbClient().sessions.update(s.sessionId, {
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
    await bbClient().sessions.update(sessionId, {
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

async function toolWebSearch(page: Page, query: string): Promise<string> {
  await page.goto(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" },
  );
  const blocked = await page.$("form[action*='anomaly'], .anomaly-modal");
  if (blocked) {
    return "Search is temporarily rate-limited — try again in a moment or open a URL you already know.";
  }
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
  if (usable.length === 0) return "No results found for that query.";
  return usable
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join("\n");
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
  session: BrowserSession,
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
