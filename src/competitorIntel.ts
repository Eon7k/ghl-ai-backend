/**
 * Competitor watch scan: SSRF-safe website snapshot, optional Meta Ad Library,
 * and OpenAI-structured insight (themes, counter-angles) when API key is set.
 */

import OpenAI from "openai";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { getHarvestLearningPromptAddition } from "./harvestRankingLearning";

const GRAPH_VERSION = (process.env.META_GRAPH_API_VERSION || "v25.0").replace(/^v?/, "v");
const MAX_HTML_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 14_000;

function openaiClient(): OpenAI | null {
  const k = (process.env.OPENAI_API_KEY || "").trim();
  if (!k || k.length < 20) return null;
  return new OpenAI({ apiKey: k });
}

/**
 * Ad Library / Graph calls for competitor Intel:
 * - If **`META_AD_LIBRARY_TOKEN`** is set → use it (long-lived user/system token you paste from Meta — handy while app-access hits permission errors).
 * - Else **`META_APP_ID|META_APP_SECRET`** (app access token).
 */
function metaAdLibraryToken(): string | null {
  const direct = (process.env.META_AD_LIBRARY_TOKEN || "").trim();
  if (direct) return direct;
  const id = (process.env.META_APP_ID || "").trim();
  const secret = (process.env.META_APP_SECRET || "").trim();
  if (id && secret) return `${id}|${secret}`;
  return null;
}

/** ISO-3166 alpha-2 codes for ads_archive. Meta requires a JSON array string, e.g. ["US"], not "US" alone. */
const DEFAULT_AD_REACHED_COUNTRIES = ["US", "GB", "CA", "AU", "IE", "NZ"] as const;
/** Broader second attempt if the first call returns 0 rows (competitor may only target other regions). */
const FALLBACK_AD_REACHED_COUNTRIES: readonly string[] = [
  "US", "GB", "CA", "AU", "IE", "NZ", "DE", "FR", "ES", "IT", "NL", "SE", "NO", "DK", "IN", "BR", "MX", "PL", "PH", "SG", "HK", "JP", "KR", "AR", "CL", "CO", "CZ", "AT", "CH", "BE", "PT",
];

function adReachedCountriesTiers(): { primary: string[]; wide: string[] } {
  const raw = (process.env.META_AD_LIBRARY_COUNTRIES || "").trim();
  if (raw) {
    const codes = raw
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z]{2}$/.test(s));
    if (codes.length) {
      const unique = [...new Set(codes)];
      const wide = [...new Set([...unique, ...FALLBACK_AD_REACHED_COUNTRIES])];
      return { primary: unique, wide };
    }
  }
  return { primary: [...DEFAULT_AD_REACHED_COUNTRIES], wide: [...FALLBACK_AD_REACHED_COUNTRIES] };
}

const FB_PATH_RESERVED = new Set(
  "share,sharer,watch,groups,events,marketplace,profile.php,pages,people,login,help,news,photo.php,story.php,reel,posts,videos,photos,permalink,live,notes".split(
    ","
  )
);

export type FacebookPageParse =
  | { type: "numericId"; id: string; fromAdLibrary?: true }
  | { type: "graphHandle"; handle: string }
  | { type: "empty" };

/**
 * From a pasted Page id, @handle, or facebook.com/... URL, extract a numeric id or a Graph "username" to resolve.
 * Recognizes Ad Library "View all" URLs with view_all_page_id=… (reliable for competitor scans; no Graph call).
 */
export function parseFacebookPageInput(raw: string): FacebookPageParse {
  const t = raw.trim();
  if (!t) return { type: "empty" };

  if (/^\d{4,22}$/.test(t)) {
    return { type: "numericId", id: t };
  }

  let toParse = t;
  if (!/^https?:\/\//i.test(toParse) && /facebook\.com|fb\.com/i.test(toParse)) {
    toParse = `https://${toParse}`;
  }
  if (/^https?:\/\//i.test(toParse)) {
    let u: URL;
    try {
      u = new URL(toParse);
    } catch {
      return t.length < 1 || /\s/.test(t) ? { type: "empty" } : { type: "graphHandle", handle: t.replace(/^@/, "") };
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "fb.com" || host === "facebook.com" || host === "m.facebook.com" || host === "web.facebook.com" || host === "business.facebook.com" || host === "mbasic.facebook.com" || host === "l.facebook.com") {
      /** Meta Ad Library: open any brand → "View all" → copy URL; `view_all_page_id` is the Facebook Page id for ads_archive. */
      const fromLibrary = u.searchParams.get("view_all_page_id");
      if (fromLibrary && /^\d{4,22}$/.test(fromLibrary.trim())) {
        return { type: "numericId", id: fromLibrary.trim(), fromAdLibrary: true };
      }
      const idParam = u.searchParams.get("id") || u.searchParams.get("page_id");
      if (idParam && /^\d{4,22}$/.test(idParam)) {
        return { type: "numericId", id: idParam };
      }
      if (u.pathname.toLowerCase().includes("profile.php") && u.searchParams.get("id") && /^\d{4,22}$/.test(String(u.searchParams.get("id")))) {
        return { type: "numericId", id: String(u.searchParams.get("id")) };
      }
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts[0] === "pages" && parts.length >= 2) {
        const last = parts[parts.length - 1]!.split("?")[0]!.split("#")[0]!;
        if (/^\d{4,22}$/.test(last)) {
          return { type: "numericId", id: last };
        }
        if (last && !FB_PATH_RESERVED.has(last.toLowerCase())) {
          return { type: "graphHandle", handle: last };
        }
      } else if (parts.length > 0) {
        let i = 0;
        if (parts[0] && /^[a-z]{2}(-[a-z]{2,})?$/i.test(parts[0]!) && parts.length > 1) {
          i = 1;
        }
        const seg = (parts[i] || "").split("?")[0]!.split("#")[0]!;
        if (seg) {
          if (/^\d{4,22}$/.test(seg)) return { type: "numericId", id: seg };
          if (seg.toLowerCase().endsWith(".php")) {
            return { type: "empty" };
          }
          if (FB_PATH_RESERVED.has(seg.toLowerCase())) {
            return { type: "empty" };
          }
          return { type: "graphHandle", handle: seg };
        }
      }
    }
  }

  if (!/[\s/]/.test(t) && t.length <= 200) {
    return { type: "graphHandle", handle: t.replace(/^@/, "").replace(/^fb\.com\//i, "") };
  }
  return { type: "empty" };
}

const GRAPH_RESOLVE_USER_HINT =
  "If this keeps failing: paste the numeric **Page ID** (only digits) from the Page’s About/Transparency, or set your **Meta app to Live** in developers.facebook.com — **Development** mode often can’t look up other brands’ pages with an app token. Use a real **Page** (not a personal profile or group).";

/**
 * Read numeric Page id from a Graph JSON blob (object node or "ids" style map).
 */
function pickNumericIdFromGraphPayload(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const o = data as { id?: unknown; error?: unknown } & Record<string, unknown>;
  if (o.error) return null;
  if (typeof o.id === "string" && /^\d{4,22}$/.test(o.id)) return o.id;
  for (const v of Object.values(o)) {
    if (v && typeof v === "object" && "id" in (v as object)) {
      const id = (v as { id?: string }).id;
      if (typeof id === "string" && /^\d{4,22}$/.test(id)) return id;
    }
  }
  return null;
}

/**
 * GET /vX/{node}?fields=id — works for many numeric ids; can fail for vanity URLs with an app token.
 */
async function tryGraphGetNode(node: string): Promise<string | null> {
  const token = metaAdLibraryToken();
  if (!token) return null;
  const sp = new URLSearchParams();
  sp.set("fields", "id");
  sp.set("access_token", token);
  const pathPart = `/${GRAPH_VERSION}/${encodeURIComponent(node)}`;
  const url = `https://graph.facebook.com${pathPart}?${sp.toString()}`;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(to);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok || data.error) return null;
  return pickNumericIdFromGraphPayload(data);
}

/**
 * GET /vX/?id={full page URL}&fields=id — different code path; often works when /{vanity} fails.
 */
async function tryGraphGetByFullPageUrl(pageUrl: string): Promise<string | null> {
  const token = metaAdLibraryToken();
  if (!token) return null;
  const sp = new URLSearchParams();
  sp.set("fields", "id");
  sp.set("access_token", token);
  sp.set("id", pageUrl);
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/?${sp.toString()}`;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(to);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok || data.error) return null;
  return pickNumericIdFromGraphPayload(data);
}

/**
 * Public Page HTML can embed pageID; used only for simple vanity handles (SSRF-safe).
 */
async function tryExtractPageIdFromPublicFacebookPageHtml(vanityHandle: string): Promise<string | null> {
  if (!/^[A-Za-z0-9.]{1,200}$/.test(vanityHandle)) return null;
  const pageUrl = `https://www.facebook.com/${vanityHandle}`;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 14_000);
  let res: Response;
  try {
    res = await fetch(pageUrl, {
      signal: ac.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch {
    clearTimeout(to);
    return null;
  } finally {
    clearTimeout(to);
  }
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 2_000_000) return null;
  const html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const patterns: RegExp[] = [
    /"pageID":"(\d{4,20})"/,
    /"pageID":(\d{4,20})/,
    /"page_id":(\d{4,20})/,
    /"userID":(\d{4,20})/, // some Page contexts
    /"profile_id":(\d{4,20})/,
    /data-pageid="(\d{4,20})"/i,
    /"pageid":"(\d{4,20})"/i,
    /"PageID":\s*"(\d{4,20})"/,
    /"pageId":\s*"(\d{4,20})"/,
    /"page_id":\s*"(\d{4,20})"/,
    /"entity_id":\s*"(\d{4,20})"/,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1] && /^\d{4,20}$/.test(m[1])) return m[1]!;
  }
  return null;
}

/**
 * Pasted @handle, vanity segment, or full facebook.com URL → numeric Page id.
 */
async function graphResolvePageHandleToNumericId(raw: string, handle: string): Promise<string> {
  const token = metaAdLibraryToken();
  if (!token) {
    throw new Error(
      "Set META_AD_LIBRARY_TOKEN or both META_APP_ID and META_APP_SECRET on the API host for Ad Library."
    );
  }

  const clean = handle.replace(/^@/, "").trim();
  if (!clean) {
    throw new Error("Empty Facebook handle.");
  }

  const pageUrlCandidates: string[] = [];
  const rawT = raw.trim();
  if (/^https?:\/\//i.test(rawT)) {
    let u: URL;
    try {
      u = new URL(rawT);
    } catch {
      u = new URL("https://invalid");
    }
    const h = u.hostname.toLowerCase().replace(/^www\./, "");
    if (
      h === "facebook.com" ||
      h === "m.facebook.com" ||
      h === "mbasic.facebook.com" ||
      h === "web.facebook.com" ||
      h === "fb.com" ||
      h === "business.facebook.com"
    ) {
      u.hash = "";
      pageUrlCandidates.push(u.toString());
    }
  }
  pageUrlCandidates.push(`https://www.facebook.com/${encodeURIComponent(clean)}`);
  pageUrlCandidates.push(`https://m.facebook.com/${encodeURIComponent(clean)}/`);

  const seen = new Set<string>();
  const uniqUrls = pageUrlCandidates.filter((u) => (seen.has(u) ? false : (seen.add(u), true)));

  for (const u of uniqUrls) {
    const id = await tryGraphGetByFullPageUrl(u);
    if (id) return id;
  }

  const byNode = await tryGraphGetNode(clean);
  if (byNode) return byNode;

  const fromHtml = await tryExtractPageIdFromPublicFacebookPageHtml(clean);
  if (fromHtml) return fromHtml;

  const probe = await (async () => {
    const sp = new URLSearchParams();
    sp.set("fields", "id");
    sp.set("access_token", token);
    const pathPart = `/${GRAPH_VERSION}/${encodeURIComponent(clean)}`;
    const r = await fetch(`https://graph.facebook.com${pathPart}?${sp.toString()}`);
    const d = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
    return d.error?.message || null;
  })();

  const detail = probe ? ` Facebook said: ${probe}` : "";
  throw new Error(
    `Could not resolve that Facebook Page to a numeric id (${clean}).${detail} ${GRAPH_RESOLVE_USER_HINT}`
  );
}

/**
 * Turn user input (id, @handle, or full facebook.com/ URL) into a stored numeric Page id. Null if empty.
 * Throws on invalid input (caller maps to 400).
 */
export async function resolveCompetitorFacebookPageInput(raw: string | null | undefined): Promise<string | null> {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (!t) return null;
  const parsed = parseFacebookPageInput(t);
  if (parsed.type === "empty") {
    if (t.length > 0) {
      throw new Error(
        "Could not read a Facebook Page from that text. Paste the full Page URL from your browser, or a numeric id (Digits only, from Page info), or a single @PageUsername."
      );
    }
    return null;
  }
  if (parsed.type === "numericId") {
    return parsed.id;
  }
  return await graphResolvePageHandleToNumericId(t, parsed.handle);
}

/**
 * Resolves a Page id and labels how it was obtained (for UI: Ad Library URL vs manual id vs Graph/HTML lookup).
 */
export async function resolveCompetitorFacebookPageInputEx(
  raw: string | null | undefined
): Promise<null | { pageId: string; source: "ad_library" | "direct" | "graph" }> {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (!t) return null;
  const pre = parseFacebookPageInput(t);
  if (pre.type === "numericId" && pre.fromAdLibrary) {
    return { pageId: pre.id, source: "ad_library" };
  }
  if (pre.type === "numericId") {
    return { pageId: pre.id, source: "direct" };
  }
  const pageId = await resolveCompetitorFacebookPageInput(t);
  if (!pageId) return null;
  return { pageId, source: "graph" };
}

/**
 * If `GET /{id}` as Archived Ad fails, try the same id as a Facebook Page (common mistake: pasting a Page id in the "ad id" field).
 * User nodes return an error for `fan_count`, so a successful `id,name,fan_count` read strongly indicates a Page.
 */
async function tryResolveGraphNumericIdAsPage(
  numericId: string,
  token: string
): Promise<{ pageId: string; pageName: string | null } | null> {
  const sp = new URLSearchParams();
  sp.set("access_token", token);
  sp.set("fields", "id,name,fan_count");
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(numericId)}?${sp.toString()}`;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 18_000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const d = (await res.json().catch(() => ({}))) as {
      id?: string;
      name?: string;
      fan_count?: number;
      error?: { message?: string };
    };
    if (d.error || !res.ok) return null;
    if (d.id !== numericId || typeof d.fan_count !== "number") return null;
    return { pageId: d.id, pageName: typeof d.name === "string" && d.name.trim() ? d.name.trim() : null };
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

/**
 * Graph “Archived ad” node: the Ad Library `id` from `ads_archive` is the same object id.
 * `GET /{id}?fields=page_id,page_name` — then use `page_id` in `search_page_ids` to list that Page’s ads.
 * @see https://developers.facebook.com/docs/graph-api/reference/archived-ad/
 */
export async function resolveMetaAdLibraryIdToPageId(raw: string): Promise<{
  pageId: string;
  pageName: string | null;
  adLibraryId: string;
  /** Pasted value was a Facebook Page id, not a Library ad `id` — we still return `pageId` for the watch. */
  resolvedVia?: "archived_ad" | "page_id";
}> {
  const token = metaAdLibraryToken();
  if (!token) {
    throw new Error(
      "Set META_AD_LIBRARY_TOKEN or META_APP_ID + META_APP_SECRET on the API host to look up an Ad Library ad by id."
    );
  }
  const adLibraryId = raw.replace(/\D/g, "");
  if (!adLibraryId || adLibraryId.length < 6 || adLibraryId.length > 24) {
    throw new Error("Paste the numeric Meta Ad Library ad id (usually many digits, from the API or a library ad).");
  }
  const sp = new URLSearchParams();
  sp.set("access_token", token);
  sp.set("fields", "page_id,page_name,id");
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(adLibraryId)}?${sp.toString()}`;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 22_000);
  let res: Response;
  try {
    res = await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(to);
  }
  const data = (await res.json().catch(() => ({}))) as {
    page_id?: string;
    page_name?: string;
    id?: string;
    error?: { message?: string; error_user_msg?: string; error_user_title?: string; code?: number };
  };
  if (data.error) {
    const pageGuess = await tryResolveGraphNumericIdAsPage(adLibraryId, token);
    if (pageGuess) {
      return {
        pageId: pageGuess.pageId,
        pageName: pageGuess.pageName,
        adLibraryId,
        resolvedVia: "page_id",
      };
    }
    const parts: string[] = [];
    if (data.error.error_user_msg) parts.push(data.error.error_user_msg);
    else if (data.error.message) parts.push(data.error.message);
    else parts.push("Graph could not read this ad id.");
    const m = data.error.message || "";
    const isPerm =
      /missing permission|does not support|unsupported get|does not exist/i.test(m) || /#10\b|code.?10|2332002/i.test(m);
    if (res.status === 400 || res.status === 404) {
      parts.push(
        "Use the numeric id from an ad row in ads_archive or a competitor scan (field id), not a Facebook Page id. For a Page, use “Resolve Facebook Page” or an Ad Library “view_all_page_id=…” link."
      );
    }
    if (isPerm) {
      parts.push(
        "If the id is correct, your token may not allow GET /{id} for Archived Ad — complete Ad Library API access and try META_AD_LIBRARY_TOKEN (if set, used before app credentials). If you only need the advertiser Page, use “Resolve Facebook Page” instead of an ad id."
      );
    }
    throw new Error(parts.join(" "));
  }
  const pageId =
    typeof data.page_id === "string" && /^\d{4,22}$/.test(data.page_id.trim()) ? data.page_id.trim() : null;
  if (!pageId) {
    throw new Error(
      "Meta returned no page_id for this ad. The id may not be a Library ad, or the ad is not visible to this token."
    );
  }
  const pageName = typeof data.page_name === "string" && data.page_name.trim() ? data.page_name.trim() : null;
  return { pageId, pageName, adLibraryId, resolvedVia: "archived_ad" };
}

/** Dedupe and compare facebook URLs from the same page (strip query, trailing slash). */
function normalizeFacebookWebUrlForDedup(href: string): string | null {
  const raw = href.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const h = u.hostname.toLowerCase().replace(/^(www|m|l|mbasic|web)\./, "");
  if (h !== "facebook.com" && h !== "fb.com") return null;
  u.search = "";
  u.hash = "";
  let p = u.pathname.replace(/\/$/, "");
  if (p === "" || p === "/") return null;
  return `${h}${p}`;
}

function isPlausibleFacebookPagePath(absoluteOrRelative: string): boolean {
  let u: URL;
  try {
    u = new URL(absoluteOrRelative.startsWith("http") ? absoluteOrRelative : `https://facebook.com${absoluteOrRelative.startsWith("/") ? "" : "/"}${absoluteOrRelative}`);
  } catch {
    return false;
  }
  const p = u.pathname.toLowerCase();
  if (
    p.includes("/sharer/") ||
    p.includes("share.php") ||
    p.includes("/dialog/") ||
    p.includes("/plugins/") ||
    p.includes("tr.php") ||
    p.includes("like.php")
  ) {
    return false;
  }
  if (p.startsWith("/groups/") || p.startsWith("/events/") || p.startsWith("/login") || p.startsWith("/watch/")) {
    return false;
  }
  if (p === "/" || p === "") return false;
  return true;
}

/**
 * From public HTML (e.g. competitor homepage), find facebook.com/… hrefs. Brands usually put the Page
 * in the footer; this avoids users opening the Ad Library when the site already links the Page.
 */
export function extractFacebookPageUrlsFromHtml(html: string, max = 10): string[] {
  const raw: string[] = [];
  const re =
    /\bhref\s*=\s*["']((https?:)?\/\/(?:www\.|l\.|m\.)?(?:facebook|fb)\.com\/[^"'>\s#?]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && raw.length < max * 3) {
    let href = m[1]!.trim();
    if (href && !href.startsWith("http")) href = "https:" + href;
    if (!isPlausibleFacebookPathHref(href)) continue;
    raw.push(href);
  }
  const ogm = /property=["']og:url["']\s+content=["'](https?:\/\/(?:www\.)?(?:facebook|fb)\.com\/[^"']+)/i.exec(
    html
  );
  if (ogm?.[1] && isPlausibleFacebookPathHref(ogm[1])) {
    raw.unshift(ogm[1]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of raw) {
    const k = normalizeFacebookWebUrlForDedup(h);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    if (!h.startsWith("http")) {
      out.push("https:" + h);
    } else {
      out.push(h);
    }
    if (out.length >= max) break;
  }
  return out;
}

function isPlausibleFacebookPathHref(href: string): boolean {
  if (!href) return false;
  return isPlausibleFacebookPagePath(href);
}

export type FacebookPageFromWebsiteRow = {
  pageUrl: string;
  pageId: string;
  source: "ad_library" | "direct" | "graph";
};

export type DiscoverFromWebsiteOptions = {
  /**
   * When true, follows internal links on the same hostname (BFS) up to maxCrawlPages.
   * @default true
   */
  crawlEntireSite?: boolean;
  /** @default 28 */
  maxCrawlPages?: number;
  /** Delay between same-host requests (ms). @default 350 */
  crawlDelayMs?: number;
  /**
   * Business name for optional Google Places Text Search (needs GOOGLE_PLACES_API_KEY).
   * Improves official website/Maps; API does not return Facebook for arbitrary listings.
   */
  companyName?: string;
  locationHint?: string;
  /** @default true when companyName and GOOGLE_PLACES_API_KEY are set */
  includeGooglePlace?: boolean;
};

export type GooglePlaceEnrichment = {
  textQuery: string;
  displayName: string | null;
  websiteUri: string | null;
  googleMapsUri: string | null;
  note: string;
};

const DEFAULT_CRAWL_MAX_PAGES = 28;
const DEFAULT_CRAWL_DELAY_MS = 350;

function normalizeUrlKeyForCrawl(href: string): string {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return href;
  }
  u.hash = "";
  const sp = u.searchParams;
  for (const k of [...sp.keys()]) {
    const kl = k.toLowerCase();
    if (kl.startsWith("utm_") || k === "gclid" || k === "fbclid" || k === "mscklid" || k === "_ga" || k.startsWith("mc_")) {
      sp.delete(k);
    }
  }
  u.search = sp.toString() ? "?" + sp.toString() : "";
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  if (u.pathname === "") u.pathname = "/";
  return u.href;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * HTML-only fetch for public http(s) URLs. Caller must ensure same-host policy for crawls.
 */
async function fetchPublicHtmlString(url: string): Promise<string | null> {
  const pub = assertPublicHttpUrl(url);
  if (!pub.ok) return null;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(pub.href, {
      signal: ac.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "GHL-AI-CompetitorBot/1.0 (+https://github.com) compatible; research",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
  if (!res.ok) return null;
  const len = res.headers.get("content-length");
  if (len && +len > MAX_HTML_BYTES) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_HTML_BYTES) return null;
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

/**
 * Internal links: same host only, no asset spam.
 */
function extractSameHostLinksFromHtml(html: string, pageUrl: string, hostLower: string, max: number): string[] {
  const base = new URL(pageUrl);
  const out: string[] = [];
  const re = /\bhref\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < max) {
    const raw = m[1]!.trim();
    if (raw.startsWith("mailto:") || raw.startsWith("tel:") || raw.startsWith("javascript:") || raw === "#" || raw.length > 2_000) {
      continue;
    }
    let abs: string;
    try {
      abs = new URL(raw, base).href;
    } catch {
      continue;
    }
    const u = new URL(abs);
    if (u.hostname.toLowerCase() !== hostLower) continue;
    if (/\.(pdf|zip|7z|tar|gz|rar|mp4|webm|mp3|woff2?|ttf|eot)(\?|$)/i.test(u.pathname)) continue;
    if (u.pathname.toLowerCase().endsWith(".xml") && u.pathname.includes("sitemap")) {
      // prefer not to follow raw sitemap in simple crawl (would need XML parse)
      continue;
    }
    u.hash = "";
    out.push(u.toString());
  }
  return out;
}

async function tryGooglePlaceEnrichment(companyName: string, locationHint: string | undefined): Promise<GooglePlaceEnrichment | null> {
  const key = (process.env.GOOGLE_PLACES_API_KEY || "").trim();
  if (!key || !companyName.trim()) return null;
  const textQuery = [companyName.trim(), (locationHint || "").trim()].filter(Boolean).join(" ");
  if (textQuery.length < 2) return null;
  const body = { textQuery: textQuery.slice(0, 400) };
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 12_000);
  let res: Response;
  try {
    res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      signal: ac.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.websiteUri,places.googleMapsUri",
      },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
  if (!res.ok) {
    return {
      textQuery,
      displayName: null,
      websiteUri: null,
      googleMapsUri: null,
      note: `Google Places search returned HTTP ${res.status} (check GOOGLE_PLACES_API_KEY and Places API (New) enabled for the key).`,
    };
  }
  const data = (await res.json().catch(() => null)) as {
    places?: { displayName?: { text?: string }; websiteUri?: string; googleMapsUri?: string; formattedAddress?: string }[];
  } | null;
  const p = data?.places?.[0];
  if (!p) {
    return {
      textQuery,
      displayName: null,
      websiteUri: null,
      googleMapsUri: null,
      note: "No Google place matched this name/location. Try a clearer business name and city/region in location hint.",
    };
  }
  return {
    textQuery,
    displayName: p.displayName?.text?.trim() || null,
    websiteUri: p.websiteUri?.trim() || null,
    googleMapsUri: p.googleMapsUri?.trim() || null,
    note:
      "Google’s Places API does not expose a Facebook field for arbitrary businesses. We use the listing to confirm name, official website, and a Maps link; Facebook still comes from website HTML or your paste.",
  };
}

/**
 * Fetches a public competitor website, optionally crawls same-site pages, optionally enriches from Google Places,
 * and resolves Facebook links to Page ids.
 */
export async function discoverFacebookPageFromCompetitorWebsite(
  website: string,
  options?: DiscoverFromWebsiteOptions
): Promise<{
  foundLinks: string[];
  candidates: FacebookPageFromWebsiteRow[];
  message?: string;
  crawledPageCount: number;
  crawlEntireSite: boolean;
  googlePlace?: GooglePlaceEnrichment;
}> {
  const pub = assertPublicHttpUrl(website);
  if (!pub.ok) {
    return { foundLinks: [], candidates: [], message: pub.error, crawledPageCount: 0, crawlEntireSite: false };
  }
  const startUrl = pub.href;
  const hostLower = new URL(startUrl).hostname.toLowerCase();
  const crawlEntireSite = options?.crawlEntireSite !== false;
  const maxPages = Math.min(50, Math.max(1, options?.maxCrawlPages ?? DEFAULT_CRAWL_MAX_PAGES));
  const delay = Math.max(0, options?.crawlDelayMs ?? DEFAULT_CRAWL_DELAY_MS);

  let googlePlace: GooglePlaceEnrichment | undefined;
  const name = (options?.companyName || "").trim();
  const wantPlace =
    (options?.includeGooglePlace !== false && name && (process.env.GOOGLE_PLACES_API_KEY || "").trim()) || options?.includeGooglePlace === true;
  if (wantPlace && name) {
    const gp = await tryGooglePlaceEnrichment(name, options?.locationHint);
    if (gp) googlePlace = gp;
  }

  const allFb: string[] = [];
  const seenFb = new Set<string>();
  const addFbFromHtml = (html: string) => {
    for (const f of extractFacebookPageUrlsFromHtml(html, 25)) {
      const k = normalizeFacebookWebUrlForDedup(f) || f;
      if (seenFb.has(k)) continue;
      seenFb.add(k);
      allFb.push(f);
    }
  };

  let crawled = 0;
  if (!crawlEntireSite) {
    const html = await fetchPublicHtmlString(startUrl);
    if (html) {
      crawled = 1;
      addFbFromHtml(html);
    } else {
      return {
        foundLinks: [],
        candidates: [],
        message: "Could not load the website homepage to scan for links.",
        crawledPageCount: 0,
        crawlEntireSite: false,
        googlePlace,
      };
    }
  } else {
    const queue: string[] = [startUrl];
    const visitKey = new Set<string>();
    const started = Date.now();
    const maxWallMs = 90_000;
    while (queue.length > 0 && crawled < maxPages && Date.now() - started < maxWallMs) {
      const raw = queue.shift()!;
      const k = normalizeUrlKeyForCrawl(raw);
      if (visitKey.has(k)) continue;
      visitKey.add(k);
      const check = assertPublicHttpUrl(raw);
      if (!check.ok) continue;
      const u = new URL(check.href);
      if (u.hostname.toLowerCase() !== hostLower) continue;
      if (crawled > 0) await sleep(delay);
      const html = await fetchPublicHtmlString(check.href);
      if (!html) continue;
      crawled++;
      addFbFromHtml(html);
      if (crawled < maxPages) {
        const more = extractSameHostLinksFromHtml(html, check.href, hostLower, 120);
        for (const x of more) {
          if (queue.length > 200) break;
          const nk = normalizeUrlKeyForCrawl(x);
          if (!visitKey.has(nk)) queue.push(x);
        }
      }
    }
  }

  /** One extra public page: Places “official” website if different host (single fetch, not full crawl). */
  if (googlePlace?.websiteUri) {
    const w = googlePlace.websiteUri;
    const pubW = assertPublicHttpUrl(w);
    if (pubW.ok) {
      const wHost = new URL(pubW.href).hostname.toLowerCase();
      if (wHost !== hostLower) {
        await sleep(delay);
        const h2 = await fetchPublicHtmlString(pubW.href);
        if (h2) {
          addFbFromHtml(h2);
        }
      } else {
        const h2 = await fetchPublicHtmlString(pubW.href);
        if (h2) addFbFromHtml(h2);
      }
    }
  }

  if (allFb.length === 0) {
    return {
      foundLinks: [],
      candidates: [],
      message:
        "No Facebook Page links found in the scanned page(s) (we follow same-site links up to a limit). " +
        "Add a public facebook.com/… link on the site, set GOOGLE_PLACES_API_KEY and company + location to try Google’s official website, or paste a Page link.",
      crawledPageCount: crawled,
      crawlEntireSite,
      googlePlace,
    };
  }
  const candidates: FacebookPageFromWebsiteRow[] = [];
  for (const pageUrl of allFb) {
    if (candidates.length >= 5) break;
    try {
      const ex = await resolveCompetitorFacebookPageInputEx(pageUrl);
      if (ex) {
        candidates.push({ pageUrl, pageId: ex.pageId, source: ex.source });
      }
    } catch {
      // try next link
    }
  }
  if (candidates.length === 0) {
    return {
      foundLinks: allFb,
      candidates: [],
      message:
        "Found Facebook link(s) in the crawl, but the server could not turn them into a Page id. Check META_APP_ID / token and app mode, or paste a Page id or Ad Library “View all” URL.",
      crawledPageCount: crawled,
      crawlEntireSite,
      googlePlace,
    };
  }
  return {
    foundLinks: allFb,
    candidates,
    crawledPageCount: crawled,
    crawlEntireSite,
    googlePlace,
  };
}

export type PublicUrlResult =
  | { ok: true; href: string }
  | { ok: false; error: string };

/** Block SSRF: only http(s), no localhost / private / link-local IPv4. */
export function assertPublicHttpUrl(href: string | null | undefined): PublicUrlResult {
  if (!href || !href.trim()) return { ok: false, error: "No URL" };
  let u: URL;
  try {
    u = new URL(href.trim());
  } catch {
    return { ok: false, error: "Invalid URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: "Only http(s) links are allowed" };
  }
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return { ok: false, error: "Local hostnames are not allowed" };
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    if (
      a === 10 ||
      a === 0 ||
      a === 127 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254)
    ) {
      return { ok: false, error: "Private or link-local IPs are not allowed" };
    }
  }
  return { ok: true, href: u.href };
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFromHtml(html: string): {
  title: string | null;
  description: string | null;
  h1: string[];
  textSample: string;
} {
  const titleM = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  const ogTitle =
    (metaContent(html, 'property="og:title"') || metaContent(html, "property='og:title'")) ?? null;
  const title = (ogTitle || titleM?.[1] || "").trim() || null;

  const desc =
    (metaContent(html, 'name="description"') ||
      metaContent(html, "name='description'") ||
      metaContent(html, 'property="og:description"') ||
      metaContent(html, 'property=\'og:description\'')) ?? null;

  const h1: string[] = [];
  const re = /<h1[^>]*>([^<]+)<\/h1>/gi;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(html)) !== null && h1.length < 5) {
    const t = mm[1].replace(/\s+/g, " ").trim();
    if (t) h1.push(t);
  }

  const textSample = stripTags(html).slice(0, 12_000);
  return { title, description: desc?.trim() || null, h1, textSample };
}

function metaContent(html: string, needle: string): string | null {
  const i = html.indexOf(needle);
  if (i === -1) return null;
  const sub = html.slice(i, i + 400);
  const m = /content\s*=\s*["']([^"']*)["']/i.exec(sub);
  return m?.[1] ? m[1].trim() : null;
}

export type WebsiteSnapshot = {
  url: string;
  finalUrl: string;
  status: number;
  title: string | null;
  description: string | null;
  h1: string[];
  textSample: string;
  keywordHits: { term: string; count: number }[];
};

function countKeywordHits(text: string, keywords: string[]): { term: string; count: number }[] {
  const lower = text.toLowerCase();
  const out: { term: string; count: number }[] = [];
  for (const raw of keywords) {
    const term = raw.trim();
    if (term.length < 2) continue;
    const t = term.toLowerCase();
    let count = 0;
    let pos = 0;
    while (pos < lower.length) {
      const i = lower.indexOf(t, pos);
      if (i === -1) break;
      count++;
      pos = i + t.length;
    }
    if (count > 0) out.push({ term, count });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 8);
}

export async function fetchWebsiteSnapshot(
  href: string,
  keywords: string[]
): Promise<{ ok: true; data: WebsiteSnapshot } | { ok: false; error: string }> {
  const pub = assertPublicHttpUrl(href);
  if (!pub.ok) return { ok: false, error: pub.error };

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(pub.href, {
      signal: ac.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "GHL-AI-CompetitorBot/1.0 (+https://github.com) compatible; research",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
    });
  } catch (e) {
    clearTimeout(t);
    const msg = e instanceof Error && e.name === "AbortError" ? "Request timed out" : "Could not fetch page";
    return { ok: false, error: msg };
  } finally {
    clearTimeout(t);
  }

  const lenHeader = res.headers.get("content-length");
  if (lenHeader && +lenHeader > MAX_HTML_BYTES) {
    return { ok: false, error: "Page is too large to analyze" };
  }

  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_HTML_BYTES) {
    return { ok: false, error: "Page is too large to analyze" };
  }

  const html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const ex = extractFromHtml(html);
  const finalUrl = res.url || pub.href;
  const keywordHits = countKeywordHits(ex.textSample, keywords);
  return {
    ok: true,
    data: {
      url: pub.href,
      finalUrl,
      status: res.status,
      title: ex.title,
      description: ex.description,
      h1: ex.h1,
      textSample: ex.textSample,
      keywordHits,
    },
  };
}

type MetaAdRow = {
  id: string;
  /** Advertiser Page id — needed when ads run under an agency/shell Page instead of the brand Page. */
  page_id?: string;
  ad_creation_time?: string;
  page_name?: string;
  ad_snapshot_url?: string;
  /** ISO 639-1 language codes in the creative (when returned by Graph). */
  languages?: string[];
  ad_creative_bodies?: { text?: string }[] | string[];
  ad_creative_link_titles?: { text?: string }[] | string[];
};

function pickCreativeText(
  field: MetaAdRow["ad_creative_bodies"] | MetaAdRow["ad_creative_link_titles"]
): string | null {
  if (!field || !Array.isArray(field) || field.length === 0) return null;
  const first = field[0] as { text?: string } | string;
  if (typeof first === "string") return first.slice(0, 2000);
  if (first && typeof first === "object" && typeof first.text === "string") return first.text.slice(0, 2000);
  return null;
}

/** Words too generic to use alone for keyword-only competitor relevance. */
const META_AD_RELEVANCE_GENERIC_WORDS = new Set([
  "spa",
  "club",
  "wellness",
  "beauty",
  "health",
  "skin",
  "body",
  "best",
  "free",
  "new",
  "the",
  "and",
  "for",
  "llc",
  "inc",
]);

function metaAdCreativeHaystack(ad: MetaAdRow): string {
  const parts: string[] = [];
  if (typeof ad.page_name === "string" && ad.page_name.trim()) parts.push(ad.page_name);
  const body = pickCreativeText(ad.ad_creative_bodies);
  const title = pickCreativeText(ad.ad_creative_link_titles);
  if (body) parts.push(body);
  if (title) parts.push(title);
  return parts.join("\n").toLowerCase();
}

/**
 * Keyword harvest should not store ads unrelated to the user's phrases (Meta often returns broad matches).
 * Requires at least one full phrase substring hit OR a non-generic token (≥4 chars) from phrases to appear in copy/Page name.
 * Disable with META_HARVEST_STRICT_KEYWORD_MATCH=false.
 */
function harvestAdMatchesHarvestKeywords(ad: MetaAdRow, keywords: string[]): boolean {
  const hay = metaAdCreativeHaystack(ad);
  const page = (typeof ad.page_name === "string" ? ad.page_name : "").toLowerCase();
  const hayFull = `${hay}\n${page}`;
  const phrases = keywords.map((k) => k.trim().toLowerCase()).filter((k) => k.length >= 3);
  if (phrases.length === 0) return true;
  if (phrases.some((p) => hayFull.includes(p))) return true;
  const words = phrases
    .flatMap((p) => p.split(/\s+/))
    .map((w) => w.replace(/[^a-z0-9']/gi, "").toLowerCase())
    .filter((w) => w.length >= 4);
  const meaningful = [...new Set(words)].filter((w) => !META_AD_RELEVANCE_GENERIC_WORDS.has(w));
  if (meaningful.length === 0) return false;
  return meaningful.some((w) => hayFull.includes(w));
}

function websiteHostBrandHint(website: string | null): string | null {
  const w = website?.trim();
  if (!w) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(w) ? w : `https://${w}`);
    const first = u.hostname.replace(/^www\./i, "").split(".")[0] ?? "";
    const clean = first.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (clean.length >= 4) return clean;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * After a broad `ads_archive` keyword fetch, keep rows that look like this competitor (name, keywords, website host).
 */
function metaAdLikelyForWatch(ad: MetaAdRow, competitorName: string, keywords: string[], competitorWebsite: string | null): boolean {
  const hay = metaAdCreativeHaystack(ad);
  const page = (typeof ad.page_name === "string" ? ad.page_name : "").toLowerCase();
  const name = competitorName.toLowerCase().replace(/\s+/g, " ").trim();
  if (name.length >= 5 && hay.includes(name)) return true;
  const nameWords = name
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9']/gi, ""))
    .filter((w) => w.length >= 4 && !META_AD_RELEVANCE_GENERIC_WORDS.has(w));
  if (nameWords.length >= 2) {
    const hits = nameWords.filter((w) => hay.includes(w)).length;
    if (hits >= 2) return true;
    if (hits >= 1 && nameWords[0] && page.includes(nameWords[0])) return true;
  } else if (nameWords.length === 1 && hay.includes(nameWords[0]!)) {
    return true;
  }
  const hostHint = websiteHostBrandHint(competitorWebsite);
  if (hostHint && hay.includes(hostHint)) return true;
  const kwStrong = keywords.map((k) => k.trim().toLowerCase()).filter((k) => k.length >= 5);
  let kwHits = 0;
  for (const k of kwStrong) {
    if (hay.includes(k)) kwHits++;
  }
  if (kwHits >= 2) return true;
  if (kwHits >= 1 && nameWords.some((w) => hay.includes(w))) return true;
  const kwMedium = keywords.map((k) => k.trim().toLowerCase()).filter((k) => k.length === 4);
  for (const k of kwMedium) {
    if (hay.includes(k) && nameWords.some((w) => hay.includes(w))) return true;
  }
  return false;
}

const ADS_ARCHIVE_FIELDS = [
  "id",
  "page_id",
  "ad_creation_time",
  "page_name",
  "ad_snapshot_url",
  "ad_creative_bodies",
  "ad_creative_link_titles",
].join(",");

const MAX_HARVEST_SNAPSHOT_URL_LEN = 8_000;

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number.parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)));
}

/** Gather candidate preview image URLs from Meta snapshot HTML (og tags, embedded JSON, CDN URLs). */
function extractCreativePreviewUrlsFromHtml(html: string): string[] {
  const out: string[] = [];
  const push = (raw: string | null | undefined) => {
    const t = raw?.trim();
    if (!t || !/^https:\/\//i.test(t)) return;
    try {
      out.push(decodeHtmlEntities(t.replace(/\\\//g, "/")));
    } catch {
      /* ignore */
    }
  };

  for (const m of html.matchAll(/property=["'](?:og:image|og:image:url|og:image:secure_url)["']\s+content=["']([^"']+)["']/gi)) {
    push(m[1]);
  }
  for (const m of html.matchAll(/content=["']([^"']+)["']\s+property=["'](?:og:image|og:image:url|og:image:secure_url)["']/gi)) {
    push(m[1]);
  }
  for (const m of html.matchAll(/name=["'](?:twitter:image|twitter:image:src)["']\s+content=["']([^"']+)["']/gi)) {
    push(m[1]);
  }
  for (const m of html.matchAll(/rel=["']image_src["']\s+href=["']([^"']+)["']/gi)) {
    push(m[1]);
  }

  // Embedded JSON-style keys Meta sometimes ships in inline payloads
  for (const m of html.matchAll(/"(?:thumbnail_uri|preferred_thumbnail_image_uri|image_uri)"\s*:\s*"([^"]+)"/gi)) {
    push(m[1]?.replace(/\\u002F/gi, "/"));
  }

  const cdnRe =
    /https:\/\/(?:scontent[^"'\\\s<>]*\.fbcdn\.net|[^"'\\\s<>]*\.fbcdn\.net|external[^"'\\\s<>]*\.fbcdn\.net)[^"'\\\s<>]{15,900}/gi;
  let cm: RegExpExecArray | null;
  while ((cm = cdnRe.exec(html)) !== null) {
    let u = cm[0];
    if (/rsrc\.php|\/emoji|tracking|pixel|\/safe_image/i.test(u)) continue;
    push(u);
  }

  return [...new Set(out)];
}

function sanitizeMetaSnapshotHtmlForSrcdoc(html: string): string | null {
  let out = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  out = out.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "");
  out = out.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "");
  out = out.replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, "");
  out = out.replace(/<embed\b[^>]*>/gi, "");
  out = out.replace(/<link\b[^>]*>/gi, "");
  out = out.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  out = out.replace(/href\s*=\s*["']?\s*javascript:/gi, 'href="#"');
  out = out.replace(/(\ssrc=["'])\/\//gi, "$1https://");
  out = out.replace(/(\shref=["'])\/\//gi, "$1https://");

  const injectHead =
    `<base target="_blank" href="https://www.facebook.com/">` +
    `<style>body{margin:0;background:#f4f4f5}img,video,picture{display:block;max-width:100%;height:auto}</style>`;

  if (!/<html[\s>]/i.test(out)) {
    out = `<!DOCTYPE html><html><head>${injectHead}</head><body>${out}</body></html>`;
  } else if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1>${injectHead}`);
  } else {
    out = out.replace(/<html([^>]*)>/i, `<html$1><head>${injectHead}</head>`);
  }

  if (out.length < 280 || !/<(img|video|picture|svg)\b/i.test(out)) return null;
  return out.slice(0, 520_000);
}

async function fetchMetaSnapshotHtmlDocument(snapshotUrl: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(snapshotUrl);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./i, "").toLowerCase();
  if (!["facebook.com", "m.facebook.com", "lm.facebook.com"].includes(host)) return null;
  if (!u.pathname.includes("/ads/") && !u.pathname.includes("render_ad")) return null;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 22_000);
  try {
    const res = await fetch(snapshotUrl, {
      redirect: "follow",
      signal: ac.signal,
      headers: {
        "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type MetaSnapshotPreviewResult = {
  thumbnailUrl: string | null;
  /** Stripped snapshot HTML for iframe srcdoc when no image URL was found (no scripts). */
  previewHtml: string | null;
};

/** Single fetch: derive thumbnail URL and/or sanitized embeddable snapshot HTML. */
export async function resolveMetaSnapshotPreview(snapshotUrl: string): Promise<MetaSnapshotPreviewResult> {
  const html = await fetchMetaSnapshotHtmlDocument(snapshotUrl);
  if (!html) return { thumbnailUrl: null, previewHtml: null };

  const candidates = extractCreativePreviewUrlsFromHtml(html);
  const thumbnailUrl =
    candidates.find((x) => /\.fbcdn\.net\//i.test(x)) ??
    candidates.find((x) => /\.(jpg|jpeg|png|webp)(\?|$)/i.test(x)) ??
    candidates[0] ??
    null;

  const previewHtml = thumbnailUrl ? null : sanitizeMetaSnapshotHtmlForSrcdoc(html);

  return { thumbnailUrl, previewHtml };
}

/** @deprecated Prefer resolveMetaSnapshotPreview — kept for callers that only need og:image-style URL. */
export async function fetchMetaSnapshotOgImageUrl(snapshotUrl: string): Promise<string | null> {
  const r = await resolveMetaSnapshotPreview(snapshotUrl);
  return r.thumbnailUrl;
}

/**
 * Optional `ads_archive` language filter (ISO 639-1), e.g. `META_AD_LIBRARY_CONTENT_LANGUAGES=en`
 * or `en,fr`. Empty / unset = Meta returns ads in any language (common source of Spanish in US sweeps).
 */
function metaAdLibraryContentLanguages(): string[] | undefined {
  const raw = (process.env.META_AD_LIBRARY_CONTENT_LANGUAGES || "").trim();
  if (!raw) return undefined;
  const codes = raw
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-z]{2}$/.test(s) || s === "cmn" || s === "yue");
  return codes.length ? [...new Set(codes)] : undefined;
}

function appendAdsArchiveLanguageFilter(sp: URLSearchParams): void {
  const langs = metaAdLibraryContentLanguages();
  if (langs?.length) sp.set("languages", JSON.stringify(langs));
}

type AdsArchiveJson = {
  data?: MetaAdRow[];
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    error_user_msg?: string;
    error_user_title?: string;
  };
};

function formatAdsArchiveError(e: NonNullable<AdsArchiveJson["error"]>): string {
  const parts: string[] = [];
  if (e.message) parts.push(e.message);
  if (typeof e.error_subcode === "number") parts.push(`(error_subcode ${e.error_subcode})`);
  if (e.error_user_title?.trim()) parts.push(`[${e.error_user_title.trim()}]`);
  if (e.error_user_msg?.trim()) parts.push(e.error_user_msg.trim());
  return parts.join(" ");
}

/** Expired user token, bad app secret, etc. — retrying other request shapes won’t help. */
function isMetaAdsArchiveOAuthFatal(err: NonNullable<AdsArchiveJson["error"]>): boolean {
  const code = typeof err.code === "number" ? err.code : NaN;
  if ([190, 463, 467].includes(code)) return true;
  const blob = `${err.message || ""} ${err.error_user_msg || ""} ${err.error_user_title || ""}`.toLowerCase();
  return /\b(access token|oauth|session has expired|invalid token|expired token)\b/i.test(blob);
}

/** Meta cURL uses `ad_reached_countries=['US']` (single-quoted). Node uses JSON `["US"]` first; this is a second encoding some stacks expect. */
function adReachedCountriesToMetaCurlString(codes: string[], max = 20): string {
  const c = codes.slice(0, max).filter((x) => /^[A-Z]{2}$/.test(x));
  if (c.length === 0) return "['US']";
  return "['" + c.join("','") + "']";
}

type AdLibRequestShape = {
  label: string;
  /** Graph doc: comma-separated; many examples use a JSON string array. */
  pageIdFormat: "plain" | "jsonArray";
  /** Double-quote JSON (standard) or Meta cURL single-quote style. */
  countriesFormat: "json" | "metaCurl";
  countries: string[];
  adActiveStatus: "ACTIVE" | "ALL";
};

/** One Graph ads_archive GET. */
async function getAdsArchiveOnce(
  searchPageId: string,
  shape: Pick<AdLibRequestShape, "pageIdFormat" | "countriesFormat" | "countries" | "adActiveStatus">
): Promise<{ res: Response; data: AdsArchiveJson }> {
  const token = metaAdLibraryToken()!;
  const sp = new URLSearchParams();
  sp.set("access_token", token);
  if (shape.pageIdFormat === "jsonArray") {
    sp.set("search_page_ids", JSON.stringify([searchPageId]));
  } else {
    sp.set("search_page_ids", searchPageId);
  }
  if (shape.countriesFormat === "json") {
    sp.set("ad_reached_countries", JSON.stringify(shape.countries));
  } else {
    sp.set("ad_reached_countries", adReachedCountriesToMetaCurlString(shape.countries, 32));
  }
  sp.set("ad_active_status", shape.adActiveStatus);
  sp.set("ad_type", "ALL");
  sp.set("fields", ADS_ARCHIVE_FIELDS);
  sp.set("limit", "30");
  appendAdsArchiveLanguageFilter(sp);
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/ads_archive?${sp.toString()}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25_000);
  let res: Response;
  try {
    res = await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
  const data = (await res.json().catch(() => ({}))) as AdsArchiveJson;
  return { res, data };
}

/** Graph `ads_archive` with `search_terms` (no `search_page_ids`) — lists ads across Pages that match text. */
async function getAdsArchiveBySearchTermOnce(
  searchTerm: string,
  shape: Pick<AdLibRequestShape, "countriesFormat" | "countries" | "adActiveStatus">
): Promise<{ res: Response; data: AdsArchiveJson }> {
  const token = metaAdLibraryToken()!;
  const sp = new URLSearchParams();
  sp.set("access_token", token);
  sp.set("search_terms", searchTerm.trim());
  if (shape.countriesFormat === "json") {
    sp.set("ad_reached_countries", JSON.stringify(shape.countries));
  } else {
    sp.set("ad_reached_countries", adReachedCountriesToMetaCurlString(shape.countries, 32));
  }
  sp.set("ad_active_status", shape.adActiveStatus);
  sp.set("ad_type", "ALL");
  sp.set("fields", ADS_ARCHIVE_FIELDS);
  sp.set("limit", "50");
  appendAdsArchiveLanguageFilter(sp);
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/ads_archive?${sp.toString()}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25_000);
  let res: Response;
  try {
    res = await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
  const data = (await res.json().catch(() => ({}))) as AdsArchiveJson;
  return { res, data };
}

async function upsertArchiveAdForWatch(watchId: string, ad: MetaAdRow): Promise<boolean> {
  if (!ad.id) return false;
  const body = pickCreativeText(ad.ad_creative_bodies);
  const title = pickCreativeText(ad.ad_creative_link_titles);
  let headline = title || (body ? body.replace(/\s+/g, " ").trim().slice(0, 300) : null);
  if (!headline && !body) {
    const pn = typeof ad.page_name === "string" && ad.page_name.trim() ? ad.page_name.trim() : null;
    headline = pn ? `Ad from ${pn.slice(0, 120)}` : "Ad in Meta Ad Library (creative text not in this API row)";
  }
  const mediaUrl = typeof ad.ad_snapshot_url === "string" && ad.ad_snapshot_url.startsWith("http") ? ad.ad_snapshot_url : null;
  try {
    await prisma.competitorAd.upsert({
      where: {
        watchId_platform_adLibraryId: {
          watchId,
          platform: "meta",
          adLibraryId: ad.id,
        },
      },
      create: {
        watchId,
        platform: "meta",
        adLibraryId: ad.id,
        headline,
        bodyText: body,
        mediaUrl: mediaUrl ? mediaUrl.slice(0, 500) : null,
        lastSeenAt: new Date(),
        rawData: ad as unknown as Prisma.InputJsonValue,
      },
      update: {
        headline: headline ?? undefined,
        bodyText: body ?? undefined,
        mediaUrl: mediaUrl ? mediaUrl.slice(0, 500) : undefined,
        lastSeenAt: new Date(),
        rawData: ad as unknown as Prisma.InputJsonValue,
      },
    });
    return true;
  } catch (e) {
    console.error("[competitorIntel] upsert ad (keyword mode)", e);
    return false;
  }
}

/**
 * No Page id: pull ads via `search_terms` (competitor name + keywords), then drop rows that don’t match name/keywords/site host.
 * Replaces existing Meta ads on this watch so stale Page-scraped rows don’t linger.
 */
async function fetchAndStoreMetaAdLibraryByKeywords(
  watchId: string,
  competitorName: string,
  keywords: string[],
  competitorWebsite: string | null
): Promise<{ ok: true; count: number; error?: string; debug?: string } | { ok: false; error: string; debug?: string }> {
  const token = metaAdLibraryToken();
  if (!token) {
    return {
      ok: true,
      count: 0,
      error:
        "Meta Ad Library: set META_AD_LIBRARY_TOKEN or META_APP_ID + META_APP_SECRET on the API host (with META_AD_LIBRARY_TOKEN set, Ad Library uses that token first).",
    };
  }

  const terms: string[] = [];
  const nameT = competitorName.trim().slice(0, 200);
  if (nameT.length >= 3) terms.push(nameT);
  const seenTerm = new Set(terms.map((t) => t.toLowerCase()));
  for (const k of keywords) {
    const t = k.trim().slice(0, 200);
    if (t.length < 3) continue;
    const low = t.toLowerCase();
    if (seenTerm.has(low)) continue;
    if (nameT.length >= 6 && nameT.toLowerCase().includes(low)) continue;
    terms.push(t);
    seenTerm.add(low);
    if (terms.length >= 3) break;
  }
  if (terms.length === 0) {
    return { ok: false, error: "Meta keyword mode: use a competitor name of at least 3 characters or add keywords." };
  }

  await prisma.competitorAd.deleteMany({ where: { watchId, platform: "meta" } });

  const tiers = adReachedCountriesTiers();
  const attempts: Pick<AdLibRequestShape, "countriesFormat" | "countries" | "adActiveStatus">[] = [
    { countriesFormat: "json", countries: tiers.primary, adActiveStatus: "ACTIVE" },
    { countriesFormat: "json", countries: tiers.wide, adActiveStatus: "ALL" },
    { countriesFormat: "metaCurl", countries: tiers.wide.slice(0, 28), adActiveStatus: "ALL" },
  ];

  const merged = new Map<string, MetaAdRow>();
  let lastHttpError: string | null = null;

  outer: for (const term of terms) {
    for (const shape of attempts) {
      let one: { res: Response; data: AdsArchiveJson };
      try {
        one = await getAdsArchiveBySearchTermOnce(term, shape);
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Meta Ad Library keyword request failed",
        };
      }
      const { res, data } = one;
      if (!res.ok && data.error) {
        lastHttpError = `Meta Ad Library: ${formatAdsArchiveError(data.error)}`;
        const err = data.error;
        if (err.code === 10 && (err.error_subcode === 2332002 || err.error_subcode === 2332004)) {
          return { ok: false, error: lastHttpError };
        }
        const em = err.message || "";
        if (err.code === 190 || /invalid.*token|OAuthException|expired|session has been invalidated/i.test(em)) {
          return { ok: false, error: lastHttpError };
        }
        continue;
      }
      if (!res.ok) {
        lastHttpError = `Meta Ad Library: HTTP ${res.status}`;
        continue;
      }
      for (const ad of data.data || []) {
        if (!ad?.id || merged.has(ad.id)) continue;
        merged.set(ad.id, ad);
        if (merged.size >= 180) break outer;
      }
    }
  }

  const raw = merged.size;
  let kept = 0;
  let upsertFails = 0;
  for (const ad of merged.values()) {
    if (!metaAdLikelyForWatch(ad, competitorName, keywords, competitorWebsite)) continue;
    const ok = await upsertArchiveAdForWatch(watchId, ad);
    if (ok) kept++;
    else upsertFails++;
  }

  const debug = `keyword-mode raw:${raw} kept:${kept} terms:${terms.length}`;
  if (upsertFails > 0 && kept === 0) {
    return {
      ok: false,
      error: "Meta Ad Library: keyword mode matched ads but saving to the database failed. Check server logs.",
      debug,
    };
  }
  if (raw === 0) {
    if (lastHttpError) return { ok: false, error: lastHttpError, debug };
    return {
      ok: true,
      count: 0,
      error:
        "Meta Ad Library keyword search returned no ads for your phrases/regions. Try different keywords or META_AD_LIBRARY_COUNTRIES.",
      debug,
    };
  }
  if (kept === 0) {
    return {
      ok: true,
      count: 0,
      error:
        `Meta Ad Library: fetched ${raw} public ad(s) by keyword but none matched competitor name / keywords / website host after filtering — add more specific keywords or a Facebook Page id.`,
      debug,
    };
  }
  return { ok: true, count: kept, debug };
}

/**
 * Keyword search against Meta Ad Library (same Graph endpoint as Page scans).
 * Aggregates distinct advertiser Pages (`page_id`) so users can pick the Page that actually runs ads (often not the brand Page).
 */
export async function discoverMetaAdvertiserPagesFromAdLibrarySearch(searchTerm: string): Promise<{
  candidates: { pageId: string; pageName: string | null; adsSeenInSample: number }[];
  message?: string;
}> {
  const term = searchTerm.trim().slice(0, 200);
  if (term.length < 2) {
    throw new Error("searchTerm must be at least 2 characters.");
  }
  const token = metaAdLibraryToken();
  if (!token) {
    throw new Error(
      "Set META_AD_LIBRARY_TOKEN or both META_APP_ID and META_APP_SECRET on the API host for Ad Library."
    );
  }

  const tiers = adReachedCountriesTiers();
  const attempts: Pick<AdLibRequestShape, "countriesFormat" | "countries" | "adActiveStatus">[] = [
    { countriesFormat: "json", countries: tiers.primary, adActiveStatus: "ACTIVE" },
    { countriesFormat: "json", countries: tiers.wide, adActiveStatus: "ALL" },
    { countriesFormat: "metaCurl", countries: tiers.wide.slice(0, 28), adActiveStatus: "ALL" },
  ];

  const seenAdIds = new Set<string>();
  const pageMap = new Map<string, { pageName: string | null; count: number }>();
  let lastHttpError: string | null = null;
  let gotOkWithDataKey = false;

  for (const shape of attempts) {
    let one: { res: Response; data: AdsArchiveJson };
    try {
      one = await getAdsArchiveBySearchTermOnce(term, shape);
    } catch (e) {
      return {
        candidates: [],
        message: e instanceof Error ? e.message : "Ad Library keyword search failed.",
      };
    }
    const { res, data } = one;
    if (res.ok && data.data !== undefined) gotOkWithDataKey = true;

    if (!res.ok && data.error) {
      const err = data.error;
      lastHttpError = `Meta Ad Library: ${formatAdsArchiveError(err)}`;
      if (err.code === 10 && err.error_subcode === 2332002) {
        return {
          candidates: [],
          message:
            `${lastHttpError} Complete Meta’s Ad Library API access at https://www.facebook.com/ads/library/api — app tokens alone may not be enough until the app is authorized there.`,
        };
      }
      if (err.code === 10 && err.error_subcode === 2332004) {
        return {
          candidates: [],
          message:
            `${lastHttpError} [2332004] Try META_AD_LIBRARY_TOKEN on the API host (used before app credentials), or add App roles + Live mode — https://developers.facebook.com/docs/development/build-and-test/app-roles`,
        };
      }
      const em = err.message || `HTTP ${res.status}`;
      if (err.code === 190 || /invalid.*token|OAuthException|expired|session has been invalidated/i.test(em)) {
        return { candidates: [], message: lastHttpError };
      }
      if (err.code === 4 || /rate limit|too many|temporarily|limit/i.test(em)) {
        return { candidates: [], message: lastHttpError };
      }
      continue;
    }

    for (const ad of data.data || []) {
      if (!ad.id || seenAdIds.has(ad.id)) continue;
      seenAdIds.add(ad.id);
      const rawPid = typeof ad.page_id === "string" ? ad.page_id.trim() : "";
      const pid = /^\d{4,22}$/.test(rawPid) ? rawPid : "";
      if (!pid) continue;
      const pn = typeof ad.page_name === "string" && ad.page_name.trim() ? ad.page_name.trim() : null;
      const prev = pageMap.get(pid);
      if (prev) {
        prev.count += 1;
        if (!prev.pageName && pn) prev.pageName = pn;
      } else {
        pageMap.set(pid, { pageName: pn, count: 1 });
      }
    }

    if (pageMap.size >= 12 || seenAdIds.size >= 150) break;
  }

  const candidates = [...pageMap.entries()]
    .map(([pageId, v]) => ({
      pageId,
      pageName: v.pageName,
      adsSeenInSample: v.count,
    }))
    .sort((a, b) => b.adsSeenInSample - a.adsSeenInSample)
    .slice(0, 25);

  let message: string | undefined;
  if (candidates.length === 0) {
    if (seenAdIds.size > 0) {
      message =
        "Meta returned ads for this keyword but none included page_id in the API payload. Try “Get Page id from ad id” on one Library ad instead.";
    } else if (lastHttpError) {
      message = lastHttpError;
    } else if (!gotOkWithDataKey) {
      message =
        "Could not query Meta Ad Library by keyword (unexpected response). Check server logs and Meta token / Ad Library API access.";
    } else {
      message =
        "No ads matched this keyword in your configured regions (META_AD_LIBRARY_COUNTRIES). Try a brand-specific phrase, widen regions, open Meta’s library by hand to confirm wording, or resolve Page id from one live ad.";
    }
  }

  return { candidates, message };
}

export async function fetchAndStoreMetaAdLibrary(
  watchId: string,
  pageId: string
): Promise<{ ok: true; count: number; error?: string; debug?: string } | { ok: false; error: string; debug?: string }> {
  const token = metaAdLibraryToken();
  if (!token) {
    return {
      ok: true,
      count: 0,
      error:
        "Meta Ad Library: set META_AD_LIBRARY_TOKEN or META_APP_ID + META_APP_SECRET on the API host (with META_AD_LIBRARY_TOKEN set, Ad Library uses that token first).",
    };
  }
  const numericId = pageId.replace(/\D/g, "");
  if (!numericId || numericId.length < 3) {
    return { ok: false, error: "Meta Ad Library: need a numeric Facebook Page id (digits from Page info or a resolved link)." };
  }

  const tiers = adReachedCountriesTiers();
  /**
   * Meta’s examples mix: `search_page_ids` as plain id vs `["id"]`, and `ad_reached_countries` as JSON vs `['US']`.
   * App tokens sometimes return HTTP 200 + [] until the right shape + `ad_type=ALL` + correct countries.
   */
  const attempts: AdLibRequestShape[] = [
    { label: "jsonPage+pri+ACTIVE+jsonC", pageIdFormat: "jsonArray", countriesFormat: "json", countries: tiers.primary, adActiveStatus: "ACTIVE" },
    { label: "plainPage+pri+ACTIVE+jsonC", pageIdFormat: "plain", countriesFormat: "json", countries: tiers.primary, adActiveStatus: "ACTIVE" },
    { label: "jsonPage+wide+ALL+jsonC", pageIdFormat: "jsonArray", countriesFormat: "json", countries: tiers.wide, adActiveStatus: "ALL" },
    { label: "plainPage+wide+ALL+jsonC", pageIdFormat: "plain", countriesFormat: "json", countries: tiers.wide, adActiveStatus: "ALL" },
    { label: "jsonPage+wide+ALL+metaCurlC", pageIdFormat: "jsonArray", countriesFormat: "metaCurl", countries: tiers.wide, adActiveStatus: "ALL" },
    { label: "plainPage+pri+ACTIVE+metaCurlC", pageIdFormat: "plain", countriesFormat: "metaCurl", countries: tiers.primary.slice(0, 8), adActiveStatus: "ACTIVE" },
  ];

  let lastHttpError: string | null = null;
  const tried: string[] = [];

  for (const a of attempts) {
    const key = `${a.label}`;
    tried.push(key);
    let one: { res: Response; data: AdsArchiveJson };
    try {
      one = await getAdsArchiveOnce(numericId, a);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Ad Library request failed", debug: tried.join(" | ") };
    }
    const { res, data } = one;
    if (!res.ok && data.error) {
      const err = data.error;
      const full = formatAdsArchiveError(err);
      lastHttpError = `Meta Ad Library: ${full}`;
      if (err.code === 10 && err.error_subcode === 2332002) {
        return {
          ok: false,
          error:
            `Meta Ad Library: ${full} ` +
            `Meta requires completing the official Ad Library API access flow at https://www.facebook.com/ads/library/api (use “Access the API” / get authorized). ` +
            `This is not the same as only selecting ads_read in Graph API Explorer. Follow any identity or app steps Meta shows there; https://www.facebook.com/ID may be required for some people.`,
          debug: tried.join(" | "),
        };
      }
      if (err.code === 10 && err.error_subcode === 2332004) {
        return {
          ok: false,
          error:
            `Meta Ad Library: ${full} ` +
            `[2332004 / App role] In Meta for Developers open the same app as META_APP_ID on your server → Roles → assign your Facebook user as Administrator or Developer (` +
            `https://developers.facebook.com/docs/development/build-and-test/app-roles). Development-mode apps often require this even when using APP_ID|APP_SECRET. ` +
            `Alternatively set META_AD_LIBRARY_TOKEN (long-lived token with Ad Library access) on the API host — it is used before app credentials for these calls. ` +
            `Also complete Ad Library API access at https://www.facebook.com/ads/library/api for that app and switch to Live when Meta allows. ` +
            `Graph API Explorer uses a user token — log in with an account that has an app role.`,
          debug: tried.join(" | "),
        };
      }
      const em = err.message || `HTTP ${res.status}`;
      if (err.code === 190 || /invalid.*token|OAuthException|expired|session has been invalidated/i.test(em)) {
        return { ok: false, error: lastHttpError, debug: tried.join(" | ") };
      }
      if (err.code === 4 || /rate limit|too many|temporarily|limit/i.test(em)) {
        return { ok: false, error: lastHttpError, debug: tried.join(" | ") };
      }
      if (err.code === 10 || /permission|not authorized|does not have permission/i.test(em)) {
        return {
          ok: false,
          error: `${lastHttpError} (If you already use a user token + ads_read, still complete https://www.facebook.com/ads/library/api — not only Explorer.)`,
          debug: tried.join(" | "),
        };
      }
      continue;
    }
    if (!res.ok) {
      lastHttpError = `Meta Ad Library: HTTP ${res.status}`;
      continue;
    }
    const rows = data.data || [];
    if (rows.length === 0) {
      if (res.ok) {
        console.warn(`[competitorIntel] ads_archive 200 empty: page=${numericId} attempt=${a.label}`);
      }
      continue;
    }

    let count = 0;
    for (const ad of rows) {
      if (!ad.id) continue;
      const body = pickCreativeText(ad.ad_creative_bodies);
      const title = pickCreativeText(ad.ad_creative_link_titles);
      let headline = title || (body ? body.replace(/\s+/g, " ").trim().slice(0, 300) : null);
      if (!headline && !body) {
        const pn = typeof ad.page_name === "string" && ad.page_name.trim() ? ad.page_name.trim() : null;
        headline = pn ? `Ad from ${pn.slice(0, 120)}` : "Ad in Meta Ad Library (creative text not in this API row)";
      }
      const mediaUrl = typeof ad.ad_snapshot_url === "string" && ad.ad_snapshot_url.startsWith("http") ? ad.ad_snapshot_url : null;
      try {
        await prisma.competitorAd.upsert({
          where: {
            watchId_platform_adLibraryId: {
              watchId,
              platform: "meta",
              adLibraryId: ad.id,
            },
          },
          create: {
            watchId,
            platform: "meta",
            adLibraryId: ad.id,
            headline,
            bodyText: body,
            mediaUrl: mediaUrl ? mediaUrl.slice(0, 500) : null,
            lastSeenAt: new Date(),
            rawData: ad as unknown as Prisma.InputJsonValue,
          },
          update: {
            headline: headline ?? undefined,
            bodyText: body ?? undefined,
            mediaUrl: mediaUrl ? mediaUrl.slice(0, 500) : undefined,
            lastSeenAt: new Date(),
            rawData: ad as unknown as Prisma.InputJsonValue,
          },
        });
        count++;
      } catch (e) {
        console.error("[competitorIntel] upsert ad", e);
      }
    }
    if (count > 0) {
      if (a.label !== "jsonPage+pri+ACTIVE+jsonC") {
        console.info(`[competitorIntel] Ad Library: got ${count} ad(s) using ${a.label}`);
      }
      return { ok: true, count, debug: `used:${a.label}` };
    }
    if (rows.length > 0) {
      return {
        ok: false,
        error: "Meta Ad Library: Meta returned ads but saving them to the database failed. Check server logs for [competitorIntel] upsert ad.",
        debug: tried.join(" | "),
      };
    }
  }

  const hint =
    "0 ads returned from the Graph `ads_archive` call for this Page after all request shapes. Brands often run ads under a **different** Facebook Page (agency, reseller, or shell Page): use **Search advertisers by keyword** on the competitor watch, or open a live Library ad and **Get Page id from ad id**. Also verify META_AD_LIBRARY_COUNTRIES matches regions where ads run and the numeric Page id matches the **advertiser** row in Meta’s library. If ads appear under another Page id in the public library, confirm **Ad Library API** access and set **META_AD_LIBRARY_TOKEN** (used first when set) or **META_APP_ID** + **META_APP_SECRET** on the API host.";
  if (lastHttpError) {
    return { ok: false, error: lastHttpError, debug: tried.join(" | ") };
  }
  return { ok: true, count: 0, error: `Meta Ad Library: ${hint}`, debug: tried.join(" | ") };
}

export type YourCampaignIdea = {
  title: string;
  platform: string;
  angle: string;
  adCopy: string;
  whyItWorks: string;
};

export type CompetitivePack = {
  theirPlaybook: string;
  howToWin: string[];
  yourCampaigns: YourCampaignIdea[];
  theirAdTactics: { headline: string; tactic: string }[];
};

export type SynthesisResult = {
  summary: string;
  topThemes: string[];
  suggestedCounterAngles: string[];
  strongestAds: { headline: string; note?: string }[];
  competitivePack: CompetitivePack | null;
  rawPromptUsed?: string;
};

function fallbackSynthesis(
  name: string,
  kw: string[],
  site: WebsiteSnapshot | null,
  notes: string[]
): SynthesisResult {
  const lines: string[] = [
    `**${name}** — scan snapshot (partial automation).`,
    site
      ? `Site signals: ${site.title || "—"}${site.description ? ` · ${site.description.slice(0, 220)}` : ""}`
      : "No public website was fetched (add a URL or check access).",
  ];
  if (kw.length) {
    lines.push(`Keywords you track: ${kw.join(", ")}.`);
  }
  if (site && site.keywordHits.length) {
    lines.push(
      `Keyword presence on the page: ${site.keywordHits.map((h) => `${h.term} (${h.count})`).join(", ")}.`
    );
  }
  if (notes.length) {
    lines.push("Notes: " + notes.join(" · "));
  }
  const topThemes: string[] = [];
  if (site?.h1[0]) topThemes.push(`Headline: ${site.h1[0]}`);
  if (site?.description) topThemes.push(`Positioning: ${site.description.slice(0, 120)}${site.description.length > 120 ? "…" : ""}`);
  if (topThemes.length === 0) topThemes.push("Add website + keywords, then re-run scan for richer output.");

  return {
    summary: lines.join("\n\n"),
    topThemes,
    suggestedCounterAngles: [
      "Emphasize a clearer guarantee and proof than this competitor’s generic claims.",
      "Test a different primary hook: urgency, community, or risk-reversal for the same product.",
    ],
    strongestAds: [],
    competitivePack: {
      theirPlaybook: "Insufficient data: connect Meta Ad Library and set OPENAI_API_KEY for a full playbook.",
      howToWin: [
        "Differentiate on trust (reviews, credentials, or process transparency).",
        "Own a narrower audience message than their broad “everyone” appeal.",
      ],
      yourCampaigns: [],
      theirAdTactics: [],
    },
  };
}

export async function synthesizeWithOpenAI(input: {
  competitorName: string;
  keywords: string[];
  site: WebsiteSnapshot | null;
  scanNotes: string[];
  /** Full lines for ad library context */
  adDetails: { headline: string | null; body: string | null; pageName?: string | null }[];
}): Promise<SynthesisResult> {
  const openai = openaiClient();
  const fb = fallbackSynthesis(input.competitorName, input.keywords, input.site, input.scanNotes);
  if (!openai) return fb;

  const siteBlock = input.site
    ? `Website (${input.site.finalUrl}):\nTitle: ${input.site.title || "—"}\nMeta description: ${input.site.description || "—"}\nH1s: ${input.site.h1.join(" | ") || "—"}\nKeyword hits: ${input.site.keywordHits.map((k) => `${k.term}:${k.count}`).join(", ") || "none"}\nText excerpt:\n${input.site.textSample.slice(0, 4_000)}`
    : "No website text captured.";

  const adsBlock =
    input.adDetails.length > 0
      ? `Public ads visible in Meta Ad Library for this Page (paraphrase from copy below — these are the competitor’s current angles, not full “campaigns” in Ads Manager, but the live ads they are running to the public):\n${input.adDetails
          .slice(0, 15)
          .map((a, i) => {
            const h = a.headline || "—";
            const b = (a.body || "—").replace(/\s+/g, " ").trim().slice(0, 400);
            const pn = a.pageName ? ` [${a.pageName}]` : "";
            return `${i + 1}.${pn} Headline: ${h}\n   Body: ${b}`;
          })
          .join("\n\n")}`
      : "No Meta ads pulled (add a Facebook Page link + backend Meta token, or the Page has no current ads in the US for this query).";

  const prompt = `You are a senior performance marketer and competitive strategist. The user is running ads on Meta/Google/etc. and wants to **beat** this competitor. Be direct, non-generic, and action-oriented. Output a single JSON object (no markdown fences).

${siteBlock}

${adsBlock}

Competitor: ${input.competitorName}
Our tracked keywords: ${input.keywords.length ? input.keywords.join(", ") : "(none)"}
System / scan notes: ${input.scanNotes.join(" | ") || "none"}

Return JSON with these keys:
- "summary" (string, markdown **bold** ok): 3-5 short paragraphs. Cover what they are doing in marketing, evidence from site/ads, and the biggest opportunity for our user to win.
- "theirPlaybook" (string): 2-4 sentences on what this competitor’s go-to market looks like (channels, offer style, social proof, discounting, fear/aspiration, etc.).
- "howToWin" (string array, 5-8 items): specific moves to beat them (not platitudes) — e.g. creative angles, offer structure, audience wedge, creative testing order.
- "yourCampaigns" (array, 3-5 objects): each has "title" (short name), "platform" (e.g. meta, google, both), "angle" (one line positioning), "adCopy" (2-4 sentences of **ready-to-adapt** ad body copy the user can paste into a new campaign in this app as a starting point), "whyItWorks" (one sentence tied to the gap vs this competitor).
- "theirAdTactics" (array, up to 8): { "headline": string, "tactic": string } for each important ad in the data — "tactic" = what this ad is doing psychologically and marketing-wise.
- "topThemes" (string array, max 5): short labels for their messaging themes.
- "suggestedCounterAngles" (string array, max 5): quick counter-angles (can overlap with howToWin but shorter).
- "strongestAds" (array, max 5): { "headline": string, "note": string } for the strongest competitor ad themes and why they work.

If ads data is empty, still use the website and be honest; reduce reliance on "theirAdTactics" and say what to do once Ad Library is connected.`;

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_COMPETITOR_MODEL?.trim() || "gpt-4o-mini",
      temperature: 0.4,
      max_tokens: 4_200,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You return only valid JSON. Tactics and campaign ideas must be specific to the inputs; avoid empty platitudes. adCopy in yourCampaigns must be original text for the USER to run, not copied verbatim from the competitor.",
        },
        { role: "user", content: prompt },
      ],
    });
    const raw = completion.choices[0]?.message?.content?.trim() || "";
    const parsed = JSON.parse(raw) as {
      summary?: string;
      theirPlaybook?: string;
      howToWin?: unknown;
      yourCampaigns?: unknown;
      theirAdTactics?: unknown;
      topThemes?: unknown;
      suggestedCounterAngles?: unknown;
      strongestAds?: unknown;
    };
    const topThemes = Array.isArray(parsed.topThemes)
      ? parsed.topThemes.filter((x): x is string => typeof x === "string").slice(0, 5)
      : fb.topThemes;
    const suggestedCounterAngles = Array.isArray(parsed.suggestedCounterAngles)
      ? parsed.suggestedCounterAngles.filter((x): x is string => typeof x === "string").slice(0, 8)
      : fb.suggestedCounterAngles;
    const strongestRaw = Array.isArray(parsed.strongestAds) ? parsed.strongestAds : [];
    const strongestAds: { headline: string; note?: string }[] = [];
    for (const x of strongestRaw.slice(0, 5)) {
      if (x && typeof x === "object" && typeof (x as { headline?: string }).headline === "string") {
        const note =
          typeof (x as { note?: string }).note === "string" ? (x as { note: string }).note : undefined;
        strongestAds.push({ headline: (x as { headline: string }).headline, note });
      }
    }

    const howToWin = Array.isArray(parsed.howToWin)
      ? parsed.howToWin.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim())
      : fb.competitivePack!.howToWin;
    const yourCampaigns: YourCampaignIdea[] = [];
    if (Array.isArray(parsed.yourCampaigns)) {
      for (const c of parsed.yourCampaigns) {
        if (!c || typeof c !== "object") continue;
        const o = c as Record<string, unknown>;
        if (typeof o.title === "string" && typeof o.adCopy === "string") {
          yourCampaigns.push({
            title: o.title.slice(0, 120),
            platform: typeof o.platform === "string" ? o.platform.slice(0, 40) : "meta",
            angle: typeof o.angle === "string" ? o.angle.slice(0, 300) : "",
            adCopy: o.adCopy.slice(0, 2_000),
            whyItWorks: typeof o.whyItWorks === "string" ? o.whyItWorks.slice(0, 500) : "",
          });
        }
      }
    }
    const theirAdTactics: { headline: string; tactic: string }[] = [];
    if (Array.isArray(parsed.theirAdTactics)) {
      for (const t of parsed.theirAdTactics) {
        if (t && typeof t === "object" && typeof (t as { headline?: string }).headline === "string") {
          theirAdTactics.push({
            headline: (t as { headline: string }).headline.slice(0, 500),
            tactic: typeof (t as { tactic?: string }).tactic === "string" ? (t as { tactic: string }).tactic.slice(0, 500) : "",
          });
        }
      }
    }
    const theirPlaybook =
      typeof parsed.theirPlaybook === "string" && parsed.theirPlaybook.trim()
        ? parsed.theirPlaybook.trim()
        : `**${input.competitorName}** — marketing focus inferred from the inputs above.`;

    const competitivePack: CompetitivePack = {
      theirPlaybook,
      howToWin: howToWin.length ? howToWin : fb.competitivePack!.howToWin,
      yourCampaigns: yourCampaigns.slice(0, 5),
      theirAdTactics: theirAdTactics.slice(0, 8),
    };

    return {
      summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : fb.summary,
      topThemes: topThemes.length ? topThemes : fb.topThemes,
      suggestedCounterAngles: suggestedCounterAngles.length ? suggestedCounterAngles : fb.suggestedCounterAngles,
      strongestAds: strongestAds.length ? strongestAds : fb.strongestAds,
      competitivePack,
      rawPromptUsed: "openai:competitor scan synthesis v2",
    };
  } catch (e) {
    console.error("[competitorIntel] OpenAI synthesis", e);
    return fb;
  }
}

/** Aggregate “keyword harvest” sample — many advertisers — landscape themes & differentiation (same JSON shape as watch synthesis). */
export async function synthesizeHarvestLandscapeWithOpenAI(input: {
  topicLabel: string;
  harvestKeywords: string[];
  scanNotes: string[];
  adDetails: { headline: string | null; body: string | null; pageName?: string | null }[];
}): Promise<SynthesisResult> {
  const openai = openaiClient();
  const fb = fallbackSynthesis(
    input.topicLabel,
    input.harvestKeywords,
    null,
    input.scanNotes
  );
  if (!openai) return fb;

  const adsBlock =
    input.adDetails.length > 0
      ? `Sample of many advertisers’ live Meta ads from your keyword harvest (numbered — infer patterns across the market, not one brand):\n${input.adDetails
          .slice(0, 30)
          .map((a, i) => {
            const h = a.headline || "—";
            const b = (a.body || "—").replace(/\s+/g, " ").trim().slice(0, 380);
            const pn = a.pageName ? ` [${a.pageName}]` : "";
            return `${i + 1}.${pn} Headline: ${h}\n   Body: ${b}`;
          })
          .join("\n\n")}`
      : "No ads in this filtered sample.";

  const prompt = `You are a senior performance marketer. The user ran a **broad Meta Ad Library keyword harvest** — the ads below come from **many different Pages**, not a single competitor. Treat this as a **market snapshot**.

${adsBlock}

Research topic label: ${input.topicLabel}
Harvest / focus keywords: ${input.harvestKeywords.length ? input.harvestKeywords.join(", ") : "(infer from topic)"}
Notes: ${input.scanNotes.join(" | ") || "none"}

Deliver a **landscape analysis** — what the market is doing as a whole, where it is crowded, and how the user can stand out. Output one JSON object (no markdown fences).

Return JSON with these keys:
- "summary" (string, markdown **bold** ok): 4-6 short paragraphs on overall patterns, common offers/hooks, tone, social proof, creative formats implied, gaps/whitespace, and concrete ways to differ.
- "theirPlaybook" (string): 2-4 sentences summarizing the **dominant playbook in this sample** (not one company — the “typical” approach).
- "howToWin" (string array, 6-10 items): differentiation moves — campaign structure, audiences, creative angles, offers, sequencing — tied to what you see **across** the sample.
- "yourCampaigns" (array, 3-6 objects): each has "title", "platform" (often "meta"), "angle", "adCopy" (2-5 sentences original for the USER, not copied from ads), "whyItWorks" (one sentence vs crowded patterns).
- "theirAdTactics" (array, up to 10): { "headline": string, "tactic": string } — recurring **archetypes** you observe (merge similar advertisers).
- "topThemes" (string array, max 6): cross-market messaging themes.
- "suggestedCounterAngles" (string array, max 6): angles less used in this sample worth testing.
- "strongestAds" (array, max 6): { "headline": string, "note": string } — exemplar patterns from the sample (paraphrase, don’t plagiarize).

If the sample is thin, say so honestly and still give strategic hypotheses.`;

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_COMPETITOR_MODEL?.trim() || "gpt-4o-mini",
      temperature: 0.45,
      max_tokens: 4_400,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You return only valid JSON. Speak to aggregate patterns across advertisers; avoid naming a single competitor unless unavoidable. adCopy must be original for the user.",
        },
        { role: "user", content: prompt },
      ],
    });
    const raw = completion.choices[0]?.message?.content?.trim() || "";
    const parsed = JSON.parse(raw) as {
      summary?: string;
      theirPlaybook?: string;
      howToWin?: unknown;
      yourCampaigns?: unknown;
      theirAdTactics?: unknown;
      topThemes?: unknown;
      suggestedCounterAngles?: unknown;
      strongestAds?: unknown;
    };
    const topThemes = Array.isArray(parsed.topThemes)
      ? parsed.topThemes.filter((x): x is string => typeof x === "string").slice(0, 6)
      : fb.topThemes;
    const suggestedCounterAngles = Array.isArray(parsed.suggestedCounterAngles)
      ? parsed.suggestedCounterAngles.filter((x): x is string => typeof x === "string").slice(0, 8)
      : fb.suggestedCounterAngles;
    const strongestRaw = Array.isArray(parsed.strongestAds) ? parsed.strongestAds : [];
    const strongestAds: { headline: string; note?: string }[] = [];
    for (const x of strongestRaw.slice(0, 6)) {
      if (x && typeof x === "object" && typeof (x as { headline?: string }).headline === "string") {
        const note =
          typeof (x as { note?: string }).note === "string" ? (x as { note: string }).note : undefined;
        strongestAds.push({ headline: (x as { headline: string }).headline, note });
      }
    }

    const howToWin = Array.isArray(parsed.howToWin)
      ? parsed.howToWin.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim())
      : fb.competitivePack!.howToWin;
    const yourCampaigns: YourCampaignIdea[] = [];
    if (Array.isArray(parsed.yourCampaigns)) {
      for (const c of parsed.yourCampaigns) {
        if (!c || typeof c !== "object") continue;
        const o = c as Record<string, unknown>;
        if (typeof o.title === "string" && typeof o.adCopy === "string") {
          yourCampaigns.push({
            title: o.title.slice(0, 120),
            platform: typeof o.platform === "string" ? o.platform.slice(0, 40) : "meta",
            angle: typeof o.angle === "string" ? o.angle.slice(0, 300) : "",
            adCopy: o.adCopy.slice(0, 2_000),
            whyItWorks: typeof o.whyItWorks === "string" ? o.whyItWorks.slice(0, 500) : "",
          });
        }
      }
    }
    const theirAdTactics: { headline: string; tactic: string }[] = [];
    if (Array.isArray(parsed.theirAdTactics)) {
      for (const t of parsed.theirAdTactics) {
        if (t && typeof t === "object" && typeof (t as { headline?: string }).headline === "string") {
          theirAdTactics.push({
            headline: (t as { headline: string }).headline.slice(0, 500),
            tactic: typeof (t as { tactic?: string }).tactic === "string" ? (t as { tactic: string }).tactic.slice(0, 500) : "",
          });
        }
      }
    }
    const theirPlaybook =
      typeof parsed.theirPlaybook === "string" && parsed.theirPlaybook.trim()
        ? parsed.theirPlaybook.trim()
        : `**${input.topicLabel}** — inferred market mix from sampled ads.`;

    const competitivePack: CompetitivePack = {
      theirPlaybook,
      howToWin: howToWin.length ? howToWin : fb.competitivePack!.howToWin,
      yourCampaigns: yourCampaigns.slice(0, 6),
      theirAdTactics: theirAdTactics.slice(0, 10),
    };

    return {
      summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : fb.summary,
      topThemes: topThemes.length ? topThemes : fb.topThemes,
      suggestedCounterAngles: suggestedCounterAngles.length ? suggestedCounterAngles : fb.suggestedCounterAngles,
      strongestAds: strongestAds.length ? strongestAds : fb.strongestAds,
      competitivePack,
      rawPromptUsed: "openai:harvest landscape synthesis",
    };
  } catch (e) {
    console.error("[competitorIntel] OpenAI landscape synthesis", e);
    return fb;
  }
}

export async function runCompetitorScanForWatch(
  watch: {
    id: string;
    competitorName: string;
    competitorWebsite: string | null;
    competitorFacebookPageId: string | null;
    keywords: Prisma.JsonValue;
  }
): Promise<{
  summary: string;
  topThemes: Prisma.InputJsonValue;
  suggestedCounterAngles: Prisma.InputJsonValue;
  strongestAds: Prisma.InputJsonValue;
  competitivePack: Prisma.InputJsonValue | null;
  rawPromptUsed: string | null;
  /** Always returned; echoed in the scan API as `diagnostics` so the UI can show a visible “what happened” list. */
  scanNotes: string[];
}> {
  const kw = Array.isArray(watch.keywords)
    ? watch.keywords.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((k) => k.trim())
    : [];
  const scanNotes: string[] = [];

  let site: WebsiteSnapshot | null = null;
  if (watch.competitorWebsite?.trim()) {
    const w = await fetchWebsiteSnapshot(watch.competitorWebsite, kw);
    if (w.ok) {
      site = w.data;
      if (w.data.status >= 400) {
        scanNotes.push(`Site HTTP ${w.data.status}`);
      }
    } else {
      scanNotes.push(`Website: ${w.error}`);
    }
  } else {
    scanNotes.push("No website on file — add a URL to analyze landing copy.");
  }

  if (watch.competitorFacebookPageId?.trim()) {
    const raw = watch.competitorFacebookPageId.trim();
    let numericPageId = "";
    try {
      const r = await resolveCompetitorFacebookPageInput(raw);
      if (r) numericPageId = r;
    } catch (e) {
      scanNotes.push(`Facebook Page: ${e instanceof Error ? e.message : "Could not resolve"}`);
    }
    if (numericPageId) {
      if (raw !== numericPageId) {
        try {
          await prisma.competitorWatch.update({
            where: { id: watch.id },
            data: { competitorFacebookPageId: numericPageId },
          });
        } catch (e) {
          console.error("[competitor scan] could not store resolved Page id", e);
        }
        scanNotes.push(`Saved resolved Page id ${numericPageId}.`);
      }
      const m = await fetchAndStoreMetaAdLibrary(watch.id, numericPageId);
      if (m.ok) {
        if (m.error) scanNotes.push(m.error);
        if (m.debug) scanNotes.push(`Meta Ad Library: ${m.debug}`);
        if (m.count) scanNotes.push(`Pulled ${m.count} Meta ad(s) from Ad Library.`);
      } else {
        scanNotes.push(`Meta ads: ${m.error}`);
        if (m.debug) scanNotes.push(`Meta Ad Library: ${m.debug}`);
      }
    }
  } else {
    const tok = metaAdLibraryToken();
    if (!tok) {
      scanNotes.push(
        "Meta: set META_AD_LIBRARY_TOKEN or META_APP_ID + META_APP_SECRET, then add a Facebook Page id or use keyword-only mode (competitor name / keywords)."
      );
    } else {
      const name = watch.competitorName.trim();
      if (kw.length > 0 || name.length >= 3) {
        const site = watch.competitorWebsite?.trim() ? watch.competitorWebsite.trim() : null;
        const m = await fetchAndStoreMetaAdLibraryByKeywords(watch.id, name, kw, site);
        if (m.ok) {
          if (m.error) scanNotes.push(m.error);
          if (m.debug) scanNotes.push(`Meta Ad Library: ${m.debug}`);
          if (m.count) scanNotes.push(`Keyword-only Meta pull: stored ${m.count} ad(s) after relevance filter.`);
        } else {
          scanNotes.push(`Meta ads: ${m.error}`);
          if (m.debug) scanNotes.push(`Meta Ad Library: ${m.debug}`);
        }
      } else {
        scanNotes.push(
          "Meta: add a Facebook Page id for ads tied to one Page, or enter competitor name (3+ chars) / keywords for keyword-only Ad Library search."
        );
      }
    }
  }

  const recentAds = await prisma.competitorAd.findMany({
    where: { watchId: watch.id, platform: "meta" },
    orderBy: { lastSeenAt: "desc" },
    take: 30,
  });
  type RecentAdRow = (typeof recentAds)[number];
  const adDetails = recentAds.map((a: RecentAdRow) => {
    const raw = a.rawData as { page_name?: string } | null;
    return {
      headline: a.headline,
      body: a.bodyText,
      pageName: raw && typeof raw.page_name === "string" ? raw.page_name : null,
    };
  });
  const adHeadlineFallbacks = adDetails
    .map((a: (typeof adDetails)[number]) => a.headline || a.body?.replace(/\s+/g, " ").trim().slice(0, 200) || "")
    .filter(Boolean) as string[];

  const syn = await synthesizeWithOpenAI({
    competitorName: watch.competitorName,
    keywords: kw,
    site,
    scanNotes,
    adDetails,
  });

  const logBody = scanNotes
    .map((s) => `• ${s.replace(/\s+/g, " ").trim()}`)
    .join("\n\n");
  const logBlock =
    scanNotes.length > 0
      ? `\n\n**Scan (system log)**\n\n${logBody.length > 4_500 ? `${logBody.slice(0, 4_500)}…` : logBody}`
      : "";
  const summaryWithNotes = (syn.summary + logBlock).slice(0, 12_000);

  return {
    summary: summaryWithNotes,
    topThemes: syn.topThemes as unknown as Prisma.InputJsonValue,
    suggestedCounterAngles: syn.suggestedCounterAngles as unknown as Prisma.InputJsonValue,
    strongestAds: (syn.strongestAds.length
      ? syn.strongestAds
      : adHeadlineFallbacks.slice(0, 5).map((h) => ({ headline: h }))) as unknown as Prisma.InputJsonValue,
    competitivePack: syn.competitivePack
      ? (JSON.parse(JSON.stringify(syn.competitivePack)) as Prisma.InputJsonValue)
      : null,
    rawPromptUsed: syn.rawPromptUsed || null,
    scanNotes,
  };
}

function harvestPayloadFromArchiveAd(ad: MetaAdRow): {
  facebookPageId: string;
  pageName: string | null;
  adLibraryId: string;
  headline: string | null;
  bodyText: string | null;
  mediaUrl: string | null;
  rawData: Prisma.InputJsonValue;
} | null {
  if (!ad.id) return null;
  const rawPid = typeof ad.page_id === "string" ? ad.page_id.trim() : "";
  const facebookPageId = /^\d{4,22}$/.test(rawPid) ? rawPid : null;
  if (!facebookPageId) return null;
  const body = pickCreativeText(ad.ad_creative_bodies);
  const title = pickCreativeText(ad.ad_creative_link_titles);
  let headline = title || (body ? body.replace(/\s+/g, " ").trim().slice(0, 300) : null);
  if (!headline && !body) {
    const pn = typeof ad.page_name === "string" && ad.page_name.trim() ? ad.page_name.trim() : null;
    headline = pn ? `Ad from ${pn.slice(0, 120)}` : "Ad in Meta Ad Library (creative text not in this API row)";
  }
  const mediaUrl = typeof ad.ad_snapshot_url === "string" && ad.ad_snapshot_url.startsWith("http") ? ad.ad_snapshot_url : null;
  const pageName = typeof ad.page_name === "string" && ad.page_name.trim() ? ad.page_name.trim().slice(0, 500) : null;
  return {
    facebookPageId,
    pageName,
    adLibraryId: ad.id,
    headline,
    bodyText: body,
    mediaUrl: mediaUrl ? mediaUrl.slice(0, MAX_HARVEST_SNAPSHOT_URL_LEN) : null,
    rawData: ad as unknown as Prisma.InputJsonValue,
  };
}

const META_HARVEST_MAX_MERGED_UNIQUE = 320;
const META_HARVEST_MAX_STORE = 260;

/** Keyword sweep across Ad Library — stores ads by advertiser Page for brand search & harvest reports (no per-brand watch required). */
export async function executeMetaHarvestRun(runId: string): Promise<{ adsStored: number; diagnostics: string[] }> {
  const diagnostics: string[] = [];

  try {
    const run = await prisma.metaAdHarvestRun.findUnique({ where: { id: runId } });
    if (!run) {
      return { adsStored: 0, diagnostics: ["Run not found."] };
    }

    await prisma.metaAdHarvestRun.update({
      where: { id: runId },
      data: { status: "running", errorMessage: null },
    });

    const kwArr = Array.isArray(run.keywords)
      ? (run.keywords as unknown[]).filter((x: unknown): x is string => typeof x === "string" && x.trim().length > 2).map((k) => k.trim().slice(0, 200))
      : [];

    if (kwArr.length === 0) {
      diagnostics.push("No keywords — each must be at least 3 characters.");
      await prisma.metaAdHarvestRun.update({
        where: { id: runId },
        data: {
          status: "failed",
          errorMessage: diagnostics[0],
          completedAt: new Date(),
          diagnostics: diagnostics as unknown as Prisma.InputJsonValue,
        },
      });
      return { adsStored: 0, diagnostics };
    }

    const token = metaAdLibraryToken();
    if (!token) {
      const msg = "Meta token missing — set META_AD_LIBRARY_TOKEN or META_APP_ID + META_APP_SECRET.";
      diagnostics.push(msg);
      await prisma.metaAdHarvestRun.update({
        where: { id: runId },
        data: {
          status: "failed",
          errorMessage: msg,
          completedAt: new Date(),
          diagnostics: diagnostics as unknown as Prisma.InputJsonValue,
        },
      });
      return { adsStored: 0, diagnostics };
    }

    const tiers = adReachedCountriesTiers();
    const attempts: Pick<AdLibRequestShape, "countriesFormat" | "countries" | "adActiveStatus">[] = [
      { countriesFormat: "json", countries: tiers.primary, adActiveStatus: "ACTIVE" },
      { countriesFormat: "json", countries: tiers.wide, adActiveStatus: "ALL" },
      { countriesFormat: "metaCurl", countries: tiers.wide.slice(0, 28), adActiveStatus: "ALL" },
    ];
    const langFilter = metaAdLibraryContentLanguages();
    if (langFilter?.length) {
      diagnostics.push(`Ad Library language filter: ${langFilter.join(", ")} (set META_AD_LIBRARY_CONTENT_LANGUAGES to change, or clear for all languages).`);
    }

    const merged = new Map<string, MetaAdRow>();
    let lastHttpError: string | null = null;

    outer: for (const term of kwArr.slice(0, 10)) {
      for (const shape of attempts) {
        let one: { res: Response; data: AdsArchiveJson };
        try {
          one = await getAdsArchiveBySearchTermOnce(term, shape);
        } catch (e) {
          diagnostics.push(e instanceof Error ? e.message : "Ad Library request failed");
          await prisma.metaAdHarvestRun.update({
            where: { id: runId },
            data: {
              status: "failed",
              errorMessage: diagnostics.join(" "),
              completedAt: new Date(),
              diagnostics: diagnostics as unknown as Prisma.InputJsonValue,
            },
          });
          return { adsStored: 0, diagnostics };
        }
        const { res, data } = one;
        if (!res.ok && data.error) {
          lastHttpError = formatAdsArchiveError(data.error);
          const err = data.error;
          const permissionFatal = err.code === 10 && (err.error_subcode === 2332002 || err.error_subcode === 2332004);
          const oauthFatal = isMetaAdsArchiveOAuthFatal(err);
          if (permissionFatal || oauthFatal) {
            diagnostics.push(`Meta Ad Library: ${lastHttpError}`);
            if (oauthFatal) {
              diagnostics.push(
                "Token or app credentials look invalid/expired — refresh META_AD_LIBRARY_TOKEN (if you use it) or verify META_APP_ID + META_APP_SECRET, then redeploy/restart the API."
              );
            }
            await prisma.metaAdHarvestRun.update({
              where: { id: runId },
              data: {
                status: "failed",
                errorMessage: diagnostics.join(" "),
                completedAt: new Date(),
                diagnostics: diagnostics as unknown as Prisma.InputJsonValue,
              },
            });
            return { adsStored: 0, diagnostics };
          }
          continue;
        }
        if (!res.ok) continue;
        for (const ad of data.data || []) {
          if (!ad?.id || merged.has(ad.id)) continue;
          merged.set(ad.id, ad);
          if (merged.size >= META_HARVEST_MAX_MERGED_UNIQUE) break outer;
        }
      }
    }

    diagnostics.push(`Merged ${merged.size} unique Library ads from Meta.`);

    const strictHarvestKw =
      String(process.env.META_HARVEST_STRICT_KEYWORD_MATCH ?? "true").toLowerCase() !== "false" &&
      String(process.env.META_HARVEST_STRICT_KEYWORD_MATCH ?? "true") !== "0";

    let mergedForStore = merged;
    if (strictHarvestKw && kwArr.length > 0) {
      mergedForStore = new Map([...merged].filter(([, ad]) => harvestAdMatchesHarvestKeywords(ad, kwArr)));
      const dropped = merged.size - mergedForStore.size;
      if (dropped > 0) {
        diagnostics.push(
          `Dropped ${dropped} ads that did not match your keywords in visible copy or Page name (set META_HARVEST_STRICT_KEYWORD_MATCH=false to store Meta’s full broad list).`
        );
      }
      if (mergedForStore.size === 0 && merged.size > 0) {
        diagnostics.push(
          `Keyword filtering removed all ${merged.size} ads — use more generic phrases or disable META_HARVEST_STRICT_KEYWORD_MATCH temporarily.`
        );
      }
    }

    if (merged.size === 0 && langFilter?.length) {
      diagnostics.push(
        `No rows from Meta — if this persists, clear META_AD_LIBRARY_CONTENT_LANGUAGES (currently ${langFilter.join(",")}) or widen keywords.`
      );
    }

    const rows: Prisma.MetaAdHarvestAdCreateManyInput[] = [];
    for (const ad of mergedForStore.values()) {
      const payload = harvestPayloadFromArchiveAd(ad);
      if (!payload) continue;
      rows.push({
        runId,
        facebookPageId: payload.facebookPageId,
        pageName: payload.pageName,
        adLibraryId: payload.adLibraryId,
        headline: payload.headline,
        bodyText: payload.bodyText,
        mediaUrl: payload.mediaUrl,
        rawData: payload.rawData,
      });
      if (rows.length >= META_HARVEST_MAX_STORE) break;
    }

    diagnostics.push(`${rows.length} ads included page_id and were queued for insert.`);

    if (rows.length === 0) {
      const hint =
        mergedForStore.size === 0
          ? merged.size === 0
            ? lastHttpError
              ? `No ads returned; last Graph hint: ${lastHttpError}`
              : "No ads returned for these keywords/regions."
            : "Keyword filtering removed every returned ad — see diagnostics above."
          : "Meta returned ads but none included page_id in API rows.";
      diagnostics.push(hint);
      await prisma.metaAdHarvestRun.update({
        where: { id: runId },
        data: {
          status: "completed",
          adsStored: 0,
          completedAt: new Date(),
          diagnostics: diagnostics as unknown as Prisma.InputJsonValue,
        },
      });
      return { adsStored: 0, diagnostics };
    }

    const batchSize = 80;
    let stored = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      const ins = await prisma.metaAdHarvestAd.createMany({ data: chunk, skipDuplicates: true });
      stored += ins.count;
    }

    diagnostics.push(`Stored ${stored} rows (unique per run by Library id).`);

    await prisma.metaAdHarvestRun.update({
      where: { id: runId },
      data: {
        status: "completed",
        adsStored: stored,
        completedAt: new Date(),
        diagnostics: diagnostics as unknown as Prisma.InputJsonValue,
      },
    });

    return { adsStored: stored, diagnostics };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    diagnostics.push(`Harvest crashed: ${msg}`);
    await prisma.metaAdHarvestRun
      .update({
        where: { id: runId },
        data: {
          status: "failed",
          errorMessage: msg.slice(0, 2000),
          completedAt: new Date(),
          diagnostics: diagnostics as unknown as Prisma.InputJsonValue,
        },
      })
      .catch(() => {});
    return { adsStored: 0, diagnostics };
  }
}

type HarvestAdForFilter = {
  adLibraryId: string;
  pageName: string | null;
  headline: string | null;
  body: string | null;
};

function harvestAdHaystack(a: HarvestAdForFilter): string {
  return [a.pageName, a.headline, a.body].filter(Boolean).join(" ").toLowerCase();
}

async function filterHarvestAdsWithOpenAIBatches(
  ads: HarvestAdForFilter[],
  ctx: {
    intentLabel: string;
    harvestKeywords: string[];
    excludePhrases: string[];
    strictRelevanceFilter: boolean;
  }
): Promise<{ kept: HarvestAdForFilter[]; notes: string[] }> {
  const BATCH = 26;
  const kept: HarvestAdForFilter[] = [];
  const notes: string[] = [];
  const oa = openaiClient();
  if (!oa) return { kept: ads, notes: ["No OpenAI client for semantic filter."] };

  for (let start = 0; start < ads.length; start += BATCH) {
    const batch = ads.slice(start, start + BATCH);
    const lines = batch
      .map((a, idx) => {
        const pn = (a.pageName || "—").replace(/\s+/g, " ").slice(0, 80);
        const h = (a.headline || "—").replace(/\s+/g, " ").slice(0, 120);
        const b = (a.body || "—").replace(/\s+/g, " ").slice(0, 200);
        return `${idx + 1}. [${pn}] ${h} | ${b}`;
      })
      .join("\n");

    const strictLine = ctx.strictRelevanceFilter
      ? "Also DROP ads that are clearly off-topic vs the research intent (shared keywords can still be wrong vertical, e.g. medical cryotherapy vs fertility “cryo”)."
      : "If there are no exclusion themes, KEEP borderline ads that could plausibly match the intent.";

    const user = `Research intent: ${ctx.intentLabel}
Keywords tied to this sample: ${ctx.harvestKeywords.length ? ctx.harvestKeywords.join(", ") : "(not specified — use intent label only)"}

Exclusion themes — DROP if the ad clearly matches (synonyms OK):
${ctx.excludePhrases.length ? ctx.excludePhrases.join("; ") : "(none)"}

${strictLine}

Numbered ads (this block only, indices 1–${batch.length}):
${lines}

Return JSON only: { "keep": [1,2,3], "batchNote": "optional short note" }
Use 1-based indices for this block. When in doubt under strict medical/wellness ambiguity, DROP if exclusions might apply.`;

    try {
      const completion = await oa.chat.completions.create({
        model: process.env.OPENAI_COMPETITOR_MODEL?.trim() || "gpt-4o-mini",
        temperature: 0.1,
        max_tokens: 900,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You return only valid JSON. Prefer dropping clear category mismatches (e.g. fertility vs cold therapy spas) when exclusions or strict mode say so.",
          },
          { role: "user", content: user },
        ],
      });
      const raw = completion.choices[0]?.message?.content?.trim() || "{}";
      const parsed = JSON.parse(raw) as { keep?: unknown; batchNote?: string };
      const arr = Array.isArray(parsed.keep)
        ? parsed.keep.filter((x): x is number => typeof x === "number" && Number.isFinite(x))
        : [];
      const ok = new Set(
        arr.map((n) => Math.floor(n)).filter((n) => n >= 1 && n <= batch.length)
      );
      if (ok.size === 0 && batch.length > 0) {
        notes.push(`AI batch (offset ${start}): no keeps — retaining all ${batch.length} ads in this batch.`);
        kept.push(...batch);
      } else {
        for (let i = 0; i < batch.length; i++) {
          if (ok.has(i + 1)) kept.push(batch[i]!);
        }
      }
      if (typeof parsed.batchNote === "string" && parsed.batchNote.trim()) {
        notes.push(`AI filter: ${parsed.batchNote.trim()}`);
      }
    } catch (e) {
      notes.push(`AI filter batch failed (${start}): ${e instanceof Error ? e.message : "error"} — kept all in batch.`);
      kept.push(...batch);
    }
  }

  return { kept, notes };
}

async function filterHarvestAdsPipeline(
  ads: HarvestAdForFilter[],
  opts: {
    intentLabel: string;
    harvestKeywords: string[];
    excludePhrases: string[];
    strictRelevanceFilter: boolean;
  }
): Promise<{ kept: HarvestAdForFilter[]; scanNotes: string[] }> {
  const notes: string[] = [];
  const phrases = opts.excludePhrases.map((p) => p.trim()).filter((p) => p.length >= 2);

  let pool = ads;
  if (phrases.length > 0) {
    const next: HarvestAdForFilter[] = [];
    let ex = 0;
    for (const a of pool) {
      const h = harvestAdHaystack(a);
      const bad = phrases.some((p) => h.includes(p.toLowerCase()));
      if (bad) ex++;
      else next.push(a);
    }
    pool = next;
    if (ex > 0) notes.push(`Phrase exclusion removed ${ex} ad(s) (page + copy substring match).`);
  }

  const wantAi = phrases.length > 0 || opts.strictRelevanceFilter;
  if (!wantAi || pool.length === 0) {
    return { kept: pool, scanNotes: notes };
  }

  if (!openaiClient()) {
    notes.push("Semantic filter skipped: no OPENAI_API_KEY (substring exclusion still applied).");
    return { kept: pool, scanNotes: notes };
  }

  const beforeAi = pool.length;
  const aiResult = await filterHarvestAdsWithOpenAIBatches(pool, {
    intentLabel: opts.intentLabel,
    harvestKeywords: opts.harvestKeywords,
    excludePhrases: phrases,
    strictRelevanceFilter: opts.strictRelevanceFilter,
  });
  notes.push(...aiResult.notes);

  if (aiResult.kept.length === 0 && beforeAi > 0) {
    notes.push("AI returned no keeps — using phrase-filtered set only.");
    return { kept: pool, scanNotes: notes };
  }
  if (aiResult.kept.length < 5 && beforeAi >= 20) {
    notes.push("AI filter removed almost all ads — using phrase-filtered set to avoid an empty brief.");
    return { kept: pool, scanNotes: notes };
  }
  return { kept: aiResult.kept, scanNotes: notes };
}

/** Pull harvested ads for chosen advertiser Pages and/or explicit Meta Ad Library ad ids; run OpenAI synthesis used for competitor watches. */
export async function buildMetaHarvestBrandReport(input: {
  agencyId: string;
  clientId: string;
  /** Required unless `adLibraryIds` lists harvested ads explicitly. */
  facebookPageIds?: string[];
  /** When set, only these harvested ads are used (workspace scope). Order preserved. Semantic relevance filtering is skipped unless exclusion phrases apply. */
  adLibraryIds?: string[];
  competitorDisplayName?: string;
  keywords?: string[];
  /** Case-insensitive substring match on page name + copy before AI pass. */
  excludePhrases?: string[];
  /** When true, adds an OpenAI pass to drop off-topic ads (keyword collision). Still runs AI when `excludePhrases` is non-empty. Ignored when ads are explicitly listed via `adLibraryIds`. */
  strictRelevanceFilter?: boolean;
}): Promise<{
  competitorDisplayName: string;
  adsUsed: number;
  adsConsidered: number;
  adsExcluded: number;
  summary: string;
  topThemes: Prisma.InputJsonValue;
  suggestedCounterAngles: Prisma.InputJsonValue;
  strongestAds: Prisma.InputJsonValue;
  competitivePack: Prisma.InputJsonValue | null;
  rawPromptUsed: string | null;
  scanNotes: string[];
}> {
  const pageIds = [...new Set((input.facebookPageIds ?? []).map((x) => x.replace(/\D/g, "")).filter((x) => x.length >= 4))];
  const libIds = [...new Set((input.adLibraryIds ?? []).map((x) => String(x).trim()).filter((x) => x.length > 0))].slice(
    0,
    48
  );

  if (pageIds.length === 0 && libIds.length === 0) {
    throw new Error("Provide advertiser Page id(s) and/or harvested Meta Ad Library ad id(s).");
  }

  const excludePhrases = (input.excludePhrases ?? []).map((x) => x.trim()).filter((x) => x.length >= 2).slice(0, 24);
  const hk = (input.keywords ?? []).map((x) => x.trim()).filter(Boolean).slice(0, 12);
  const handPicked = libIds.length > 0;
  const strict = Boolean(input.strictRelevanceFilter) && !handPicked;

  const scopeWhere: Prisma.MetaAdHarvestAdWhereInput = {
    run: { agencyId: input.agencyId, clientId: input.clientId },
  };

  let ads: {
    adLibraryId: string;
    facebookPageId: string;
    pageName: string | null;
    headline: string | null;
    bodyText: string | null;
  }[];

  if (handPicked) {
    ads = await prisma.metaAdHarvestAd.findMany({
      where: {
        ...scopeWhere,
        adLibraryId: { in: libIds },
        ...(pageIds.length ? { facebookPageId: { in: pageIds } } : {}),
      },
      select: {
        adLibraryId: true,
        facebookPageId: true,
        pageName: true,
        headline: true,
        bodyText: true,
      },
    });
    const orderMap = new Map(libIds.map((id, i) => [id, i]));
    ads.sort((a, b) => (orderMap.get(a.adLibraryId) ?? 999) - (orderMap.get(b.adLibraryId) ?? 999));
  } else {
    ads = await prisma.metaAdHarvestAd.findMany({
      where: {
        ...scopeWhere,
        facebookPageId: { in: pageIds },
      },
      orderBy: { createdAt: "desc" },
      take: 64,
      select: {
        adLibraryId: true,
        facebookPageId: true,
        pageName: true,
        headline: true,
        bodyText: true,
      },
    });
  }

  if (handPicked && ads.length === 0) {
    throw new Error(
      "No harvested ads matched those Library ids—reload ads from your collection or run a keyword harvest first."
    );
  }

  const seen = new Set<string>();
  const forFilter: HarvestAdForFilter[] = [];
  for (const a of ads) {
    if (seen.has(a.adLibraryId)) continue;
    seen.add(a.adLibraryId);
    forFilter.push({
      adLibraryId: a.adLibraryId,
      pageName: a.pageName,
      headline: a.headline,
      body: a.bodyText,
    });
  }

  const ids = pageIds.length ? pageIds : [...new Set(ads.map((a) => a.facebookPageId.replace(/\D/g, "")).filter((x) => x.length >= 4))];

  let displayName = input.competitorDisplayName?.trim();
  if (!displayName) {
    const pn = ads.find((x) => x.pageName)?.pageName;
    displayName = pn || (handPicked ? `Selected ads (${forFilter.length})` : `Advertisers (${ids.join(", ")})`);
  }
  displayName = displayName.slice(0, 200);

  const { kept, scanNotes: filterNotes } = await filterHarvestAdsPipeline(forFilter, {
    intentLabel: displayName,
    harvestKeywords: hk,
    excludePhrases,
    strictRelevanceFilter: strict,
  });

  const adSlice = kept.slice(0, 40);
  const adDetails = adSlice.map((a) => ({
    headline: a.headline,
    body: a.body,
    pageName: a.pageName,
  }));

  const adsConsidered = forFilter.length;
  const adsExcluded = Math.max(0, adsConsidered - kept.length);
  if (kept.length > adDetails.length) {
    filterNotes.push(`Brief uses top ${adDetails.length} ads after filters (${kept.length} passed filters).`);
  }

  const learningHint = await getHarvestLearningPromptAddition(input.agencyId, input.clientId);

  const scanNotes = [
    ...(learningHint
      ? [`Workspace priors from past analyses (soft bias — judge this sample on its merits): ${learningHint}`]
      : []),
    handPicked
      ? `Harvest-brand report from ${forFilter.length} hand-picked Meta Library ad row(s).`
      : `Harvest-brand report for Page id(s): ${pageIds.join(", ")}.`,
    `Ads in pool before filters: ${adsConsidered}; used in brief: ${adDetails.length}.`,
    ...filterNotes,
  ];

  const syn = await synthesizeWithOpenAI({
    competitorName: displayName,
    keywords: hk,
    site: null,
    scanNotes,
    adDetails,
  });

  const logBody = scanNotes.map((s) => `• ${s.replace(/\s+/g, " ").trim()}`).join("\n\n");
  const summaryWithNotes = (syn.summary + `\n\n**Harvest report log**\n\n${logBody}`).slice(0, 12_000);

  return {
    competitorDisplayName: displayName,
    adsUsed: adDetails.length,
    adsConsidered,
    adsExcluded,
    summary: summaryWithNotes,
    topThemes: syn.topThemes as unknown as Prisma.InputJsonValue,
    suggestedCounterAngles: syn.suggestedCounterAngles as unknown as Prisma.InputJsonValue,
    strongestAds: syn.strongestAds as unknown as Prisma.InputJsonValue,
    competitivePack: syn.competitivePack
      ? (JSON.parse(JSON.stringify(syn.competitivePack)) as Prisma.InputJsonValue)
      : null,
    rawPromptUsed: syn.rawPromptUsed || null,
    scanNotes,
  };
}

/** Entire harvest run (or workspace pool): landscape analysis after optional phrase + AI filtering. */
export async function buildMetaHarvestLandscapeReport(input: {
  agencyId: string;
  clientId: string;
  /** When set, only ads from this run; otherwise all harvest rows in the workspace (capped). */
  harvestRunId?: string | null;
  topicHint?: string;
  excludePhrases?: string[];
  strictRelevanceFilter?: boolean;
  /** With harvestRunId, restrict analysis to these Meta Library rows from that collection (order preserved). */
  adLibraryIds?: string[];
}): Promise<{
  competitorDisplayName: string;
  adsUsed: number;
  adsConsidered: number;
  adsExcluded: number;
  summary: string;
  topThemes: Prisma.InputJsonValue;
  suggestedCounterAngles: Prisma.InputJsonValue;
  strongestAds: Prisma.InputJsonValue;
  competitivePack: Prisma.InputJsonValue | null;
  rawPromptUsed: string | null;
  scanNotes: string[];
}> {
  const excludePhrases = (input.excludePhrases ?? []).map((x) => x.trim()).filter((x) => x.length >= 2).slice(0, 24);
  const libIds = [...new Set((input.adLibraryIds ?? []).map((x) => String(x).trim()).filter((x) => x.length > 0))].slice(
    0,
    80
  );
  const handPicked = libIds.length > 0;
  const strict = Boolean(input.strictRelevanceFilter) && !handPicked;

  let harvestKeywords: string[] = [];
  let topicLabel = input.topicHint?.trim().slice(0, 240) || "";

  if (handPicked && !input.harvestRunId?.trim()) {
    throw new Error("Pick which saved collection those ads are from (collection required when listing specific ads).");
  }

  if (input.harvestRunId?.trim()) {
    const run = await prisma.metaAdHarvestRun.findFirst({
      where: { id: input.harvestRunId.trim(), agencyId: input.agencyId, clientId: input.clientId },
    });
    if (!run) throw new Error("Harvest run not found.");
    const kwArr = Array.isArray(run.keywords)
      ? (run.keywords as unknown[]).filter((x: unknown): x is string => typeof x === "string" && x.trim().length > 0).map((k) => k.trim().slice(0, 120))
      : [];
    harvestKeywords = kwArr.slice(0, 12);
    if (!topicLabel) {
      topicLabel =
        (run.label?.trim() && run.label.trim().slice(0, 200)) ||
        (harvestKeywords.length ? harvestKeywords.slice(0, 4).join(", ") : "Keyword harvest landscape");
    }
  } else if (!topicLabel) {
    topicLabel = "Workspace harvest pool (all runs)";
  }

  const where: Prisma.MetaAdHarvestAdWhereInput = {
    run: {
      agencyId: input.agencyId,
      clientId: input.clientId,
      ...(input.harvestRunId?.trim() ? { id: input.harvestRunId.trim() } : {}),
    },
    ...(handPicked ? { adLibraryId: { in: libIds } } : {}),
  };

  type HarvestAdPickFields = {
    adLibraryId: string;
    pageName: string | null;
    headline: string | null;
    bodyText: string | null;
  };

  const seen = new Set<string>();
  const forFilter: HarvestAdForFilter[] = [];

  if (handPicked) {
    const rawPicks: HarvestAdPickFields[] = await prisma.metaAdHarvestAd.findMany({
      where,
      select: {
        adLibraryId: true,
        pageName: true,
        headline: true,
        bodyText: true,
      },
    });
    const byId = new Map(rawPicks.map((row: HarvestAdPickFields) => [row.adLibraryId, row] as const));
    for (const id of libIds) {
      const a = byId.get(id);
      if (!a || seen.has(a.adLibraryId)) continue;
      seen.add(a.adLibraryId);
      forFilter.push({
        adLibraryId: a.adLibraryId,
        pageName: a.pageName,
        headline: a.headline,
        body: a.bodyText,
      });
    }
    if (forFilter.length === 0) {
      throw new Error("None of those ads were found in that collection.");
    }
  } else {
    const rawRows = await prisma.metaAdHarvestAd.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 220,
    });
    for (const a of rawRows) {
      if (seen.has(a.adLibraryId)) continue;
      seen.add(a.adLibraryId);
      forFilter.push({
        adLibraryId: a.adLibraryId,
        pageName: a.pageName,
        headline: a.headline,
        body: a.bodyText,
      });
      if (forFilter.length >= 140) break;
    }
  }

  const displayName = topicLabel.slice(0, 200);

  const { kept, scanNotes: filterNotes } = await filterHarvestAdsPipeline(forFilter, {
    intentLabel: displayName,
    harvestKeywords,
    excludePhrases,
    strictRelevanceFilter: strict,
  });

  const adSlice = kept.slice(0, 42);
  const adDetails = adSlice.map((a) => ({
    headline: a.headline,
    body: a.body,
    pageName: a.pageName,
  }));

  const adsConsidered = forFilter.length;
  const adsExcluded = Math.max(0, adsConsidered - kept.length);
  if (kept.length > adDetails.length) {
    filterNotes.push(`Landscape uses ${adDetails.length} ads (${kept.length} passed filters).`);
  }

  const learningHint = await getHarvestLearningPromptAddition(input.agencyId, input.clientId);

  const scanNotes = [
    ...(learningHint
      ? [`Workspace priors from past analyses (soft bias — judge this sample on its merits): ${learningHint}`]
      : []),
    handPicked
      ? `Landscape from ${forFilter.length} selected ad(s) in collection ${input.harvestRunId!.trim()}.`
      : input.harvestRunId?.trim()
        ? `Landscape for harvest run ${input.harvestRunId.trim()}.`
        : `Landscape across workspace harvest ads (multiple runs allowed in sample).`,
    `Ads in sample before filters: ${adsConsidered}; used in AI: ${adDetails.length}.`,
    ...filterNotes,
  ];

  const syn = await synthesizeHarvestLandscapeWithOpenAI({
    topicLabel: displayName,
    harvestKeywords,
    scanNotes,
    adDetails,
  });

  const logBody = scanNotes.map((s) => `• ${s.replace(/\s+/g, " ").trim()}`).join("\n\n");
  const summaryWithNotes = (syn.summary + `\n\n**Harvest landscape log**\n\n${logBody}`).slice(0, 12_000);

  return {
    competitorDisplayName: displayName,
    adsUsed: adDetails.length,
    adsConsidered,
    adsExcluded,
    summary: summaryWithNotes,
    topThemes: syn.topThemes as unknown as Prisma.InputJsonValue,
    suggestedCounterAngles: syn.suggestedCounterAngles as unknown as Prisma.InputJsonValue,
    strongestAds: syn.strongestAds as unknown as Prisma.InputJsonValue,
    competitivePack: syn.competitivePack
      ? (JSON.parse(JSON.stringify(syn.competitivePack)) as Prisma.InputJsonValue)
      : null,
    rawPromptUsed: syn.rawPromptUsed || null,
    scanNotes,
  };
}
