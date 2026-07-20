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
  /** Vision-capable driver: resources unblocked + view_page available. */
  vision?: boolean;
}

export interface BrowserSession extends BrowserHandle {
  browser: Browser;
}

/** BYOK: the run owner's Browserbase creds, or the deployment's. */
export interface BrowserbaseCreds {
  key: string | undefined;
  project: string | undefined;
}

async function bbClient(creds?: BrowserbaseCreds): Promise<Browserbase> {
  const { default: BrowserbaseCtor } = await import("@browserbasehq/sdk");
  return new BrowserbaseCtor({
    apiKey: creds?.key ?? process.env.BROWSERBASE_API_KEY,
  });
}

export async function createBrowserSession(
  creds?: BrowserbaseCreds,
): Promise<BrowserSession> {
  const bb = await bbClient(creds);
  const session = await bb.sessions.create({
    projectId: creds?.project ?? process.env.BROWSERBASE_PROJECT_ID!,
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

/** A fresh tab on the shared browser for one task's chunk. Vision-capable
 *  drivers browse with images/media/fonts UNBLOCKED (the owner's explicit
 *  call: visual models should see pages as pages) and get view_page. */
export async function createTaskPage(
  session: BrowserSession,
  vision = false,
): Promise<BrowserHandle> {
  const context =
    session.browser.contexts()[0] ?? (await session.browser.newContext());
  const page = await context.newPage();
  // Explicit desktop viewport: consistent layouts for screenshots and
  // predictable viewport-height scrolling (CDP-attached pages default tiny).
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  if (!vision) await blockHeavyResources(page);
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
  return { sessionId: session.sessionId, page, targetId, vision };
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
// The research tools models see. Schemas stay lean (invariant #4 habit) but
// may carry OPTIONAL properties — strict-mode reconciliation happens at the
// call sites that map these defs into each provider's tool format.
// ---------------------------------------------------------------------------
const VIEW_PAGE_TOOL = {
  name: "view_page",
  description:
    "Take a screenshot of the page currently open in your browser and SEE it. Use after open_page when the key content is visual: charts, pricing tables, dashboards, product UIs. Set full_page: true to capture the whole page instead of just the viewport.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      full_page: {
        type: "boolean",
        description:
          "Capture the entire page height instead of just the current viewport.",
      },
    },
    required: [],
  },
} as const;

export function browserToolDefs(vision: boolean) {
  return vision ? [...BROWSER_TOOL_DEFS, VIEW_PAGE_TOOL] : BROWSER_TOOL_DEFS;
}

export const BROWSER_TOOL_DEFS = [
  {
    name: "web_search",
    description:
      "Search the web (Google, with a DuckDuckGo fallback). Returns titles, URLs, and snippets, paginating automatically until num_results is met. Optional: vertical ('news' for recent coverage, 'scholar' for academic papers, 'patents' for prior art), a recency window, and a country code. Ask for as many results as your research needs (10 for a quick look, 50-100 to map a whole space).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "The search query." },
        num_results: {
          type: "integer",
          description: "How many results to return, 10-100.",
        },
        vertical: {
          type: "string",
          enum: ["web", "news", "scholar", "patents"],
          description: "Search vertical. Default 'web'.",
        },
        recency: {
          type: "string",
          enum: ["week", "month", "year"],
          description:
            "Only results from the last week/month/year (web and news only).",
        },
        country: {
          type: "string",
          description:
            "2-letter country code to localize results, e.g. 'de' or 'jp' (web and news only).",
        },
      },
      required: ["query", "num_results"],
    },
  },
  {
    name: "open_page",
    description:
      "Open a URL in the browser and return the page's readable text (tables arrive as pipe-delimited rows; PDFs are text-extracted). Long documents return a window plus a footer telling you the from_char offset to continue from. For PDFs, pdf_pages like '26-50' reads a specific 1-indexed page range.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to open." },
        from_char: {
          type: "integer",
          description:
            "Continue a long page from this character offset (use the value a previous open_page footer gave you).",
        },
        pdf_pages: {
          type: "string",
          description:
            "PDFs only: 1-indexed page range to extract, e.g. '26-50'.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "scroll_page",
    description:
      "Scroll the page currently open in your browser down N viewport-heights and return only the NEWLY revealed text. Use on infinite feeds, lazy-loaded reviews, and long tables; call repeatedly to keep loading more.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        pages: {
          type: "integer",
          description: "How many viewport-heights to scroll down, 1-10.",
        },
      },
      required: ["pages"],
    },
  },
  {
    name: "click_element",
    description:
      "Click the first visible element on the current page whose text matches (button, link, tab, 'Load more', accordion header), then return the page's text after the click settles. Use to open pricing tabs, expand sections, or trigger 'load more'.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: {
          type: "string",
          description:
            "Visible text of the element to click (case-insensitive substring match).",
        },
      },
      required: ["text"],
    },
  },
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_DEFS)[number]["name"];

const NAV_TIMEOUT_MS = 60_000;
const PDF_MAX_PAGES = 200;
const PDF_FETCH_TIMEOUT_MS = 60_000;

/** Chars of page text already handed to the model, per live Page —
 *  scroll_page returns only the tail beyond this watermark. */
const extractedLenByPage = new WeakMap<Page, number>();

/** Small LRU of cacheKey (url, or url+pdf range) → full extracted text so
 *  from_char continuations don't re-navigate (and PDFs don't re-download).
 *  Warm-lambda lifetime only — a miss simply re-extracts. */
const PAGE_TEXT_CACHE_MAX = 20;
const pageTextCache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const hit = pageTextCache.get(key);
  if (hit !== undefined) {
    // Refresh recency — Map iterates in insertion order.
    pageTextCache.delete(key);
    pageTextCache.set(key, hit);
  }
  return hit;
}

function cachePut(key: string, text: string): void {
  pageTextCache.delete(key);
  pageTextCache.set(key, text);
  while (pageTextCache.size > PAGE_TEXT_CACHE_MAX) {
    const oldest = pageTextCache.keys().next().value;
    if (oldest === undefined) break;
    pageTextCache.delete(oldest);
  }
}

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

type SearchVertical = "web" | "news" | "scholar" | "patents";

interface SearchOpts {
  vertical: SearchVertical;
  recency?: "week" | "month" | "year";
  country?: string;
}

/** Google first — we're on a real browser with residential proxies, so we
 *  look like a real user and get Google-quality results. Returns null when
 *  Google interferes (captcha/consent/unparseable), so the caller can fall
 *  back to DuckDuckGo instead of surfacing an error to the agent. One SERP
 *  per call; the paginator drives `start`. */
async function googleSerp(
  page: Page,
  query: string,
  num: number,
  opts: SearchOpts,
  start: number,
): Promise<SearchResult[] | null> {
  try {
    let url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${Math.min(100, num)}&hl=en`;
    if (opts.vertical === "news") url += "&tbm=nws";
    if (opts.recency) url += `&tbs=qdr:${opts.recency.charAt(0)}`;
    if (opts.country) url += `&gl=${opts.country}`;
    if (start > 0) url += `&start=${start}`;
    await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    if (page.url().includes("/sorry/")) return null; // rate-limit interstitial
    // EU-style consent wall (rare on US residential IPs, cheap to handle).
    const consent = await page.$("#L2AGLb, button[aria-label*='Accept']");
    if (consent) {
      await consent.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }
    if (await page.$("#captcha-form, form[action*='sorry']")) return null;
    const results =
      opts.vertical === "news"
        ? await page.$$eval(
            "#search a[href^='http'], #rso a[href^='http']",
            (anchors) =>
              anchors.flatMap((a) => {
                // News results are anchor cards with a heading inside.
                const heading = a.querySelector("div[role='heading'], h3");
                if (!heading) return [];
                const container = a.closest("div[data-hveid]") ?? a;
                const snippetEl = container.querySelector(
                  ".GI74Re, div[style*='-webkit-line-clamp'], div[data-sncf]",
                );
                return [
                  {
                    title: heading.textContent?.trim() ?? "",
                    url: (a as HTMLAnchorElement).href,
                    snippet: snippetEl?.textContent?.trim() ?? "",
                  },
                ];
              }),
          )
        : await page.$$eval("#search h3", (headings) =>
            headings.map((h) => {
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
    return results.filter(
      (r) => r.title && /^https?:\/\//i.test(r.url) && !r.url.includes("google."),
    );
  } catch {
    return null;
  }
}

/** Google Scholar — .gs_rt titles/links + .gs_rs snippets. It rate-limits
 *  aggressively; best-effort, null on interference. */
async function scholarSerp(
  page: Page,
  query: string,
  start: number,
): Promise<SearchResult[] | null> {
  try {
    let url = `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}&hl=en`;
    if (start > 0) url += `&start=${start}`;
    await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    if (page.url().includes("/sorry/")) return null;
    if (await page.$("#gs_captcha_f, form[action*='sorry']")) return null;
    const results = await page.$$eval(".gs_r", (nodes) =>
      nodes.map((n) => {
        const a = n.querySelector<HTMLAnchorElement>(".gs_rt a");
        const s = n.querySelector(".gs_rs");
        return {
          title: a?.textContent?.trim() ?? "",
          url: a?.href ?? "",
          snippet: s?.textContent?.trim() ?? "",
        };
      }),
    );
    // No google.-domain exclusion here: [CITATION]-only rows simply have no
    // link and fall out on the URL check.
    return results.filter((r) => r.title && /^https?:\/\//i.test(r.url));
  } catch {
    return null;
  }
}

/** Google Patents is a JS-heavy SPA — load it, give its XHRs a beat, then
 *  parse whatever result items rendered. Best-effort by design; single
 *  SERP (no reliable pagination params). */
async function patentsSearch(
  page: Page,
  query: string,
  num: number,
): Promise<SearchResult[] | null> {
  try {
    await page.goto(
      `https://patents.google.com/?q=${encodeURIComponent(query)}`,
      { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" },
    );
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    const results = await page.$$eval(
      "search-result-item, article.result, article",
      (nodes) =>
        nodes.flatMap((n) => {
          const a =
            n.querySelector<HTMLAnchorElement>("a[href*='/patent/']") ??
            n.querySelector<HTMLAnchorElement>("a[href]");
          if (!a) return [];
          const title = (
            n.querySelector("h3, h4, .result-title")?.textContent ??
            a.textContent ??
            ""
          )
            .replace(/\s+/g, " ")
            .trim();
          const snippet = (
            n.querySelector(".abstract, .snippet, .htmlContent")?.textContent ??
            ""
          )
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 300);
          return [{ title, url: a.href, snippet }];
        }),
    );
    const seen = new Set<string>();
    const usable = results.filter((r) => {
      if (!r.title || !/^https?:\/\//i.test(r.url) || seen.has(r.url)) {
        return false;
      }
      seen.add(r.url);
      return true;
    });
    return usable.length > 0 ? usable.slice(0, num) : null;
  } catch {
    return null;
  }
}

/** Google usually serves ~10 organic results per SERP no matter what num=
 *  asks for. Make num REAL: keep fetching &start=10,20,… (dedupe by URL)
 *  until we have `num` results, the SERPs run dry, or 5 extra pages —
 *  whichever comes first. Null when the FIRST page yields nothing, so the
 *  caller can fall back. */
async function paginateSerps(
  num: number,
  fetchSerp: (start: number) => Promise<SearchResult[] | null>,
): Promise<SearchResult[] | null> {
  const seen = new Set<string>();
  const acc: SearchResult[] = [];
  for (let serp = 0; serp <= 5 && acc.length < num; serp++) {
    const batch = await fetchSerp(serp * 10);
    if (!batch || batch.length === 0) {
      if (serp === 0) return null; // blocked or empty — caller may fall back
      break;
    }
    let added = 0;
    for (const r of batch) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      acc.push(r);
      added += 1;
      if (acc.length >= num) break;
    }
    if (added === 0) break; // pure repeats — deeper pages won't help
  }
  return acc.length > 0 ? acc : null;
}

async function ddgSearch(
  page: Page,
  query: string,
  num: number,
): Promise<SearchResult[] | null> {
  try {
    await page.goto(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" },
    );
    if (await page.$("form[action*='anomaly'], .anomaly-modal")) return null;
    const results = await page.$$eval(".result", (nodes) =>
      nodes.map((n) => {
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
    return usable.length > 0 ? usable.slice(0, num) : null;
  } catch {
    return null;
  }
}

async function toolWebSearch(
  page: Page,
  query: string,
  num: number,
  opts: SearchOpts,
): Promise<string> {
  if (opts.vertical === "patents") {
    const patents = await patentsSearch(page, query, num);
    if (patents) return capResult(formatResults(patents, "Google Patents"));
    return 'Google Patents returned nothing usable for that query — rephrase it or fall back to vertical "web".';
  }
  if (opts.vertical === "scholar") {
    const scholar = await paginateSerps(num, (start) =>
      scholarSerp(page, query, start),
    );
    if (scholar) return capResult(formatResults(scholar, "Google Scholar"));
    return 'Google Scholar is blocking or empty right now — try again shortly or fall back to vertical "web".';
  }
  const google = await paginateSerps(num, (start) =>
    googleSerp(page, query, num, opts, start),
  );
  if (google) {
    return capResult(
      formatResults(google, opts.vertical === "news" ? "Google News" : "Google"),
    );
  }
  // DuckDuckGo can only stand in for plain web search.
  if (opts.vertical === "web") {
    const ddg = await ddgSearch(page, query, num);
    if (ddg) {
      return capResult(formatResults(ddg, "DuckDuckGo — Google was unavailable"));
    }
  }
  return "Search is temporarily unavailable — try again in a moment or open a URL you already know.";
}

/** "26-50" or "26" → 1-indexed inclusive range. Null when malformed. */
function parsePdfPageRange(spec: string): { from: number; to: number } | null {
  const m = /^(\d{1,4})(?:\s*-\s*(\d{1,4}))?$/.exec(spec.trim());
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  return from >= 1 && to >= from ? { from, to } : null;
}

/** Fetch PDF bytes THROUGH the browser first — page.context().request rides
 *  the residential proxy and the session's cookies (paywalled/geo-fenced
 *  reports often need both) — falling back to a plain server-side fetch. */
async function fetchPdfBytes(
  page: Page,
  url: string,
): Promise<{ data: Uint8Array; contentType: string } | null> {
  try {
    const res = await page
      .context()
      .request.get(url, { timeout: PDF_FETCH_TIMEOUT_MS });
    if (res.ok()) {
      return {
        data: new Uint8Array(await res.body()),
        contentType: res.headers()["content-type"] ?? "",
      };
    }
  } catch {
    // Fall through to the plain fetch.
  }
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PDF_FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "Mozilla/5.0 (research agent)" },
    });
    if (!res.ok) return null;
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "",
    };
  } catch {
    return null;
  }
}

/** Industry reports live in PDFs — extract text server-side (pdfjs, same
 *  dependency the CV upload uses client-side) instead of returning the
 *  empty innerText of Chrome's PDF viewer. */
async function extractPdfText(
  page: Page,
  url: string,
  range: { from: number; to: number } | null,
): Promise<string | null> {
  try {
    const fetched = await fetchPdfBytes(page, url);
    if (!fetched) return null;
    if (
      !fetched.contentType.includes("pdf") &&
      !url.toLowerCase().split("?")[0].endsWith(".pdf")
    ) {
      return null;
    }
    const pdfjs = (await import(
      "pdfjs-dist/legacy/build/pdf.mjs"
    )) as unknown as {
      getDocument: (opts: object) => { promise: Promise<PdfDoc> };
    };
    const doc = await pdfjs.getDocument({
      data: fetched.data,
      isEvalSupported: false,
    }).promise;
    const first = Math.max(1, range?.from ?? 1);
    if (first > doc.numPages) {
      return `[this PDF has only ${doc.numPages} pages — the requested pdf_pages range starts beyond the end]`;
    }
    const last = Math.min(
      doc.numPages,
      range?.to ?? doc.numPages,
      first + PDF_MAX_PAGES - 1,
    );
    const pages: string[] = [];
    for (let i = first; i <= last; i++) {
      const pdfPage = await doc.getPage(i);
      const content = await pdfPage.getTextContent();
      pages.push(
        (content.items as Array<{ str?: string }>)
          .map((item) => item.str ?? "")
          .join(" "),
      );
    }
    if (last < doc.numPages) {
      pages.push(
        `[extracted pages ${first}-${last} of ${doc.numPages} — call open_page again with pdf_pages (e.g. "${last + 1}-${Math.min(doc.numPages, last + 25)}") for the rest]`,
      );
    }
    const text = pages.join("\n\n").trim();
    return text || null;
  } catch {
    return null;
  }
}

interface PdfDoc {
  numPages: number;
  getPage: (n: number) => Promise<{
    getTextContent: () => Promise<{ items: unknown[] }>;
  }>;
}

function readableText(raw: string): string {
  return raw.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

async function extractPageText(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (const sel of ["script", "style", "noscript", "svg", "nav", "footer"]) {
      document.querySelectorAll(sel).forEach((el) => el.remove());
    }
    // Serialize data tables to pipe-delimited markdown IN PLACE (each
    // <table> becomes a <pre>), so rows/columns survive innerText
    // flattening and land in document order. Idempotent across calls:
    // replaced tables are no longer <table> elements.
    const tables = Array.from(document.querySelectorAll("table")).slice(0, 20);
    for (const table of tables) {
      if (!table.isConnected) continue; // was nested in a replaced table
      const rows = Array.from(
        table.querySelectorAll(
          ":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr",
        ),
      ).slice(0, 200);
      const lines: string[] = [];
      for (const tr of rows) {
        const cells = Array.from(
          tr.querySelectorAll(":scope > th, :scope > td"),
        ).map((cell) => {
          const el = cell as HTMLElement;
          return (el.innerText || el.textContent || "")
            .replace(/\s+/g, " ")
            .replace(/\|/g, "/")
            .trim();
        });
        if (cells.length === 0) continue;
        lines.push(`| ${cells.join(" | ")} |`);
        if (lines.length === 1) {
          // Header separator (header row = th cells / first tr).
          lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
        }
      }
      if (lines.length < 2) continue; // empty table — leave it alone
      const pre = document.createElement("pre");
      pre.textContent = `\n${lines.join("\n")}\n`;
      table.replaceWith(pre);
    }
    // Prefer the page's main content over its chrome (menus, cookie
    // banners, related-article rails all count against the result cap).
    const main = document.querySelector("article, main, [role='main']");
    const mainText = (main as HTMLElement | null)?.innerText ?? "";
    if (mainText.trim().length >= 500) return mainText;
    return document.body?.innerText ?? "";
  });
}

async function toolOpenPage(
  page: Page,
  url: string,
  fromChar: number,
  pdfPages?: string,
): Promise<string> {
  if (!/^https?:\/\//i.test(url)) {
    return "Error: only absolute http(s) URLs can be opened.";
  }
  let range: { from: number; to: number } | null = null;
  if (pdfPages) {
    range = parsePdfPageRange(pdfPages);
    if (!range) return 'Error: pdf_pages must be a 1-indexed range like "26-50".';
  }
  const cacheKey = range ? `${url} pages=${pdfPages}` : url;
  // Continuation reads serve from the LRU without re-navigating (which
  // would also lose any scroll/click state the agent built up).
  if (fromChar > 0) {
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return windowResult(cached, fromChar);
  }
  // PDFs first — Chrome's viewer renders no extractable innerText.
  if (range || url.toLowerCase().split("?")[0].endsWith(".pdf")) {
    const pdfText = await extractPdfText(page, url, range);
    if (pdfText) {
      const clean = readableText(pdfText);
      cachePut(cacheKey, clean);
      return windowResult(clean, fromChar);
    }
    return "This PDF couldn't be read — try a different source for the same data.";
  }
  let contentType = "";
  let timedOut = false;
  try {
    const response = await page.goto(url, {
      timeout: NAV_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    contentType = response?.headers()["content-type"] ?? "";
  } catch (err) {
    // Slow page ≠ dead page: salvage whatever DOM already exists.
    if (err instanceof Error && err.name === "TimeoutError") timedOut = true;
    else throw err;
  }
  if (contentType.includes("pdf")) {
    const pdfText = await extractPdfText(page, url, range);
    if (pdfText) {
      const clean = readableText(pdfText);
      cachePut(cacheKey, clean);
      return windowResult(clean, fromChar);
    }
    return "This PDF couldn't be read — try a different source for the same data.";
  }
  let cleaned = readableText(await extractPageText(page));
  if (cleaned.length < 200 && !timedOut) {
    // JS-rendered page: give the app a moment to paint, then re-extract.
    await page
      .waitForLoadState("networkidle", { timeout: 6_000 })
      .catch(() => {});
    cleaned = readableText(await extractPageText(page));
  }
  if (!cleaned) {
    return timedOut
      ? "Error: the page took too long to load and rendered no readable text — try a different source."
      : "The page rendered no readable text.";
  }
  extractedLenByPage.set(page, cleaned.length);
  cachePut(cacheKey, cleaned);
  const body = windowResult(cleaned, fromChar);
  return timedOut ? `[page load timed out — partial content]\n\n${body}` : body;
}

/** Scroll N viewport-heights, let lazy loaders settle, and return only the
 *  text revealed since this page's last extraction watermark. */
async function toolScrollPage(page: Page, pages: number): Promise<string> {
  if (page.url() === "about:blank") {
    return "Error: no page is open yet — call open_page first.";
  }
  for (let i = 0; i < pages; i++) {
    await page
      .evaluate(() => window.scrollBy(0, window.innerHeight))
      .catch(() => {});
    await page.waitForTimeout(700); // lazy loaders fire on scroll — let them land
  }
  const cleaned = readableText(await extractPageText(page));
  const prev = extractedLenByPage.get(page) ?? 0;
  const plural = pages === 1 ? "page" : "pages";
  if (cleaned.length <= prev) {
    extractedLenByPage.set(page, cleaned.length); // page shrank/rerendered — reset
    return `[scrolled ${pages} ${plural} — no new text revealed; the page may already be fully loaded]`;
  }
  const tail = cleaned.slice(prev);
  const out = tail.slice(0, TOOL_RESULT_CHAR_CAP);
  extractedLenByPage.set(page, prev + out.length);
  cachePut(page.url(), cleaned);
  const more = tail.length > out.length ? "; scroll again for more" : "";
  return `${out}\n\n[scrolled ${pages} ${plural} — ${out.length} new chars${more}]`;
}

/** Click the first VISIBLE element matching `text` (raw text match first,
 *  then button/link accessible names), wait for the page to settle, and
 *  return the fresh page text. Content failures return error text. */
async function toolClickElement(page: Page, text: string): Promise<string> {
  if (page.url() === "about:blank") {
    return "Error: no page is open yet — call open_page first.";
  }
  const candidates = [
    page.getByText(text, { exact: false }).filter({ visible: true }).first(),
    page.getByRole("button", { name: text, exact: false }).first(),
    page.getByRole("link", { name: text, exact: false }).first(),
  ];
  let clicked = false;
  let lastErr = "no match";
  for (const candidate of candidates) {
    try {
      await candidate.click({ timeout: 8_000 });
      clicked = true;
      break;
    } catch (err) {
      lastErr = (err instanceof Error ? err.message : String(err)).split("\n")[0];
    }
  }
  if (!clicked) {
    return `Error: couldn't click an element matching "${text}" (${lastErr.slice(0, 160)}). Try the element's exact visible text, or scroll_page to bring it into view.`;
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(800); // SPA transitions keep painting after "loaded"
  const cleaned = readableText(await extractPageText(page));
  if (!cleaned) return "Clicked — but the page now renders no readable text.";
  extractedLenByPage.set(page, cleaned.length);
  cachePut(page.url(), cleaned);
  return windowResult(cleaned, 0);
}

/** Return the [from, from+CAP) window of a long text with a continuation
 *  footer — never a dead-end truncation notice. */
function windowResult(full: string, from: number): string {
  const total = full.length;
  if (total === 0) return full;
  const start = Math.min(Math.max(0, from), total);
  if (start >= total && start > 0) {
    return `[from_char ${from} is past the end — the page text is ${total} chars long]`;
  }
  const end = Math.min(total, start + TOOL_RESULT_CHAR_CAP);
  const slice = full.slice(start, end);
  if (end < total) {
    return `${slice}\n\n[chars ${start}-${end} of ${total} — call open_page with the same url and from_char: ${end} to continue]`;
  }
  return start > 0
    ? `${slice}\n\n[chars ${start}-${end} of ${total} — end of page text]`
    : slice;
}

/** Hard per-result cap for outputs with no continuation mechanism
 *  (search-result lists). */
function capResult(text: string): string {
  return text.length > TOOL_RESULT_CHAR_CAP
    ? `${text.slice(0, TOOL_RESULT_CHAR_CAP)}\n\n[truncated at ${TOOL_RESULT_CHAR_CAP} chars]`
    : text;
}

export type ToolOutcome =
  | { kind: "text"; text: string }
  | { kind: "image"; dataB64: string; note: string };

/**
 * Execute one tool call. NEVER throws for content-level failures — the
 * model sees the error text and adapts (a dead page or expired session is
 * research friction, not a phase failure).
 */
export async function execBrowserTool(
  session: BrowserHandle,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  try {
    if (name === "web_search") {
      const q = typeof args.query === "string" ? args.query.slice(0, 400) : "";
      if (!q) {
        return { kind: "text", text: "Error: web_search needs a non-empty query string." };
      }
      const rawNum = Number(args.num_results);
      const num = Number.isFinite(rawNum)
        ? Math.min(100, Math.max(10, Math.round(rawNum)))
        : 10;
      const vertical: SearchVertical =
        args.vertical === "news" ||
        args.vertical === "scholar" ||
        args.vertical === "patents"
          ? args.vertical
          : "web";
      const recency =
        args.recency === "week" ||
        args.recency === "month" ||
        args.recency === "year"
          ? args.recency
          : undefined;
      const country =
        typeof args.country === "string" && /^[a-zA-Z]{2}$/.test(args.country.trim())
          ? args.country.trim().toLowerCase()
          : undefined;
      return {
        kind: "text",
        text: await toolWebSearch(session.page, q, num, {
          vertical,
          recency,
          country,
        }),
      };
    }
    if (name === "open_page") {
      const url = typeof args.url === "string" ? args.url.slice(0, 2000) : "";
      const rawFrom = Number(args.from_char);
      const fromChar =
        Number.isFinite(rawFrom) && rawFrom > 0 ? Math.floor(rawFrom) : 0;
      const pdfPages =
        typeof args.pdf_pages === "string" && args.pdf_pages.trim()
          ? args.pdf_pages.trim().slice(0, 20)
          : undefined;
      return {
        kind: "text",
        text: await toolOpenPage(session.page, url, fromChar, pdfPages),
      };
    }
    if (name === "scroll_page") {
      const rawPages = Number(args.pages);
      const pages = Number.isFinite(rawPages)
        ? Math.min(10, Math.max(1, Math.round(rawPages)))
        : 1;
      return { kind: "text", text: await toolScrollPage(session.page, pages) };
    }
    if (name === "click_element") {
      const text =
        typeof args.text === "string" ? args.text.trim().slice(0, 300) : "";
      if (!text) {
        return {
          kind: "text",
          text: "Error: click_element needs the visible text of the element to click.",
        };
      }
      return { kind: "text", text: await toolClickElement(session.page, text) };
    }
    if (name === "view_page") {
      if (!session.vision) {
        return { kind: "text", text: "Error: view_page isn't available to this agent." };
      }
      const fullPage = args.full_page === true;
      const shot = await session.page.screenshot({
        type: "jpeg",
        quality: 80,
        fullPage,
      });
      return {
        kind: "image",
        dataB64: shot.toString("base64"),
        note: `Screenshot of ${session.page.url()}${fullPage ? " (full page)" : ""}`,
      };
    }
    return { kind: "text", text: `Error: unknown tool "${name}".` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: "text",
      text: `Error: the browser action failed (${msg.slice(0, 200)}). Try a different query or URL.`,
    };
  }
}
