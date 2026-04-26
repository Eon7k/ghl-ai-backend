/**
 * Competitor watch scan: SSRF-safe website snapshot, optional Meta Ad Library,
 * and OpenAI-structured insight (themes, counter-angles) when API key is set.
 */

import OpenAI from "openai";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";

const GRAPH_VERSION = (process.env.META_GRAPH_API_VERSION || "v21.0").replace(/^v?/, "v");
const MAX_HTML_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 14_000;

function openaiClient(): OpenAI | null {
  const k = (process.env.OPENAI_API_KEY || "").trim();
  if (!k || k.length < 20) return null;
  return new OpenAI({ apiKey: k });
}

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

export type FacebookPageParse = { type: "numericId"; id: string } | { type: "graphHandle"; handle: string } | { type: "empty" };

/**
 * From a pasted Page id, @handle, or facebook.com/... URL, extract a numeric id or a Graph "username" to resolve.
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
    if (host === "fb.com" || host === "facebook.com" || host === "m.facebook.com" || host === "web.facebook.com" || host === "business.facebook.com" || host === "mbasic.facebook.com") {
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
    throw new Error("Set META_APP_ID and META_APP_SECRET (or META_AD_LIBRARY_TOKEN) to resolve Facebook links.");
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
  ad_creation_time?: string;
  page_name?: string;
  ad_snapshot_url?: string;
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

const ADS_ARCHIVE_FIELDS = [
  "id",
  "ad_creation_time",
  "page_name",
  "ad_snapshot_url",
  "ad_creative_bodies",
  "ad_creative_link_titles",
].join(",");

type AdsArchiveJson = { data?: MetaAdRow[]; error?: { message?: string; code?: number } };

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

export async function fetchAndStoreMetaAdLibrary(
  watchId: string,
  pageId: string
): Promise<{ ok: true; count: number; error?: string; debug?: string } | { ok: false; error: string; debug?: string }> {
  const token = metaAdLibraryToken();
  if (!token) {
    return { ok: true, count: 0, error: "Meta Ad Library: no META_AD_LIBRARY_TOKEN or META_APP_ID+META_APP_SECRET" };
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
    if (!res.ok) {
      const em = data.error?.message || `HTTP ${res.status}`;
      const code = data.error?.code;
      lastHttpError = `Meta Ad Library: ${em}`;
      if (code === 190 || /invalid.*token|OAuthException|expired|session has been invalidated/i.test(em)) {
        return { ok: false, error: lastHttpError, debug: tried.join(" | ") };
      }
      if (code === 4 || /rate limit|too many|temporarily|limit/i.test(em)) {
        return { ok: false, error: lastHttpError, debug: tried.join(" | ") };
      }
      if (code === 10 || /permission|not authorized|does not have permission|2332002/i.test(em)) {
        return {
          ok: false,
          error: `${lastHttpError} (Ad Library often needs a long-lived *user* token with the right product access, not only an app id|secret. Check Meta’s Ad Library API setup.)`,
          debug: tried.join(" | "),
        };
      }
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
    "0 ads returned from the Graph `ads_archive` call for this Page after all request shapes. If the public Ad Library (website) still shows their ads, Meta may require a **user access token** (not only app_id|app_secret) and/or Ad Library API access in your app — see developers.facebook.com → Ad Library API. You can also set META_AD_LIBRARY_COUNTRIES to the regions you see in the ad’s “reached” filter (e.g. US,GB,DE) and re-check the **numeric** Page id matches the one in the public library URL.";
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
    scanNotes.push("Meta: add a Facebook Page link or id to pull public ads (server needs META_APP_ID + META_APP_SECRET and Graph).");
  }

  const recentAds = await prisma.competitorAd.findMany({
    where: { watchId: watch.id, platform: "meta" },
    orderBy: { lastSeenAt: "desc" },
    take: 30,
  });
  const adDetails = recentAds.map((a) => {
    const raw = a.rawData as { page_name?: string } | null;
    return {
      headline: a.headline,
      body: a.bodyText,
      pageName: raw && typeof raw.page_name === "string" ? raw.page_name : null,
    };
  });
  const adHeadlineFallbacks = adDetails
    .map((a) => a.headline || a.body?.replace(/\s+/g, " ").trim().slice(0, 200) || "")
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
