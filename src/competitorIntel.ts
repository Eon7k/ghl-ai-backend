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

export async function fetchAndStoreMetaAdLibrary(
  watchId: string,
  pageId: string
): Promise<{ ok: true; count: number; error?: string } | { ok: false; error: string }> {
  const token = metaAdLibraryToken();
  if (!token) {
    return { ok: true, count: 0, error: "Meta Ad Library: no META_AD_LIBRARY_TOKEN or META_APP_ID+META_APP_SECRET" };
  }
  const q = new URLSearchParams({
    access_token: token,
    search_page_ids: pageId.replace(/\D/g, "") || pageId,
    ad_reached_countries: "US",
    fields: "id,ad_creation_time,ad_creative_bodies,ad_creative_link_titles",
    limit: "12",
  });
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/ads_archive?${q.toString()}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(url, { signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e instanceof Error ? e.message : "Ad Library request failed" };
  } finally {
    clearTimeout(timer);
  }
  const data = (await res.json().catch(() => ({}))) as {
    data?: MetaAdRow[];
    error?: { message?: string };
  };
  if (!res.ok) {
    const em = data.error?.message || `HTTP ${res.status}`;
    return { ok: true, count: 0, error: `Meta Ad Library: ${em}` };
  }
  const rows = data.data || [];
  let count = 0;
  for (const ad of rows) {
    if (!ad.id) continue;
    const body = pickCreativeText(ad.ad_creative_bodies);
    const title = pickCreativeText(ad.ad_creative_link_titles);
    const headline = title || (body ? body.replace(/\s+/g, " ").trim().slice(0, 300) : null);
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
          lastSeenAt: new Date(),
          rawData: ad as unknown as Prisma.InputJsonValue,
        },
        update: {
          headline: headline ?? undefined,
          bodyText: body ?? undefined,
          lastSeenAt: new Date(),
          rawData: ad as unknown as Prisma.InputJsonValue,
        },
      });
      count++;
    } catch (e) {
      console.error("[competitorIntel] upsert ad", e);
    }
  }
  return { ok: true, count };
}

export type SynthesisResult = {
  summary: string;
  topThemes: string[];
  suggestedCounterAngles: string[];
  strongestAds: { headline: string; note?: string }[];
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
      "Emphasize your unique guarantee or proof vs. this competitor’s generic claims.",
      "Test a different hook (time savings, risk reversal, or social proof) on the same offer.",
    ],
    strongestAds: [],
  };
}

export async function synthesizeWithOpenAI(input: {
  competitorName: string;
  keywords: string[];
  site: WebsiteSnapshot | null;
  scanNotes: string[];
  adHeadlines: string[];
}): Promise<SynthesisResult> {
  const openai = openaiClient();
  const fb = fallbackSynthesis(input.competitorName, input.keywords, input.site, input.scanNotes);
  if (!openai) return fb;

  const siteBlock = input.site
    ? `Website (${input.site.finalUrl}):\nTitle: ${input.site.title || "—"}\nMeta description: ${input.site.description || "—"}\nH1s: ${input.site.h1.join(" | ") || "—"}\nKeyword hits: ${input.site.keywordHits.map((k) => `${k.term}:${k.count}`).join(", ") || "none"}\nText excerpt:\n${input.site.textSample.slice(0, 4_000)}`
    : "No website text captured.";

  const adsBlock =
    input.adHeadlines.length > 0
      ? `Recent Meta ad headlines/snippets:\n${input.adHeadlines.slice(0, 10).map((h, i) => `${i + 1}. ${h}`).join("\n")}`
      : "No Meta ads pulled this run (add Page ID + Meta token, or no ads in library).";

  const prompt = `You are a competitive marketing analyst. Given data about a competitor, output JSON only.

${siteBlock}

${adsBlock}

Competitor name: ${input.competitorName}
Watch keywords: ${input.keywords.length ? input.keywords.join(", ") : "(none)"}
System notes: ${input.scanNotes.join(" | ") || "none"}

Return a JSON object with:
- "summary" (string, markdown allowed, 2-4 short paragraphs): executive read for a marketer
- "topThemes" (string[], max 5): themes in their current messaging/landing/ads
- "suggestedCounterAngles" (string[], max 5): concrete ways YOUR client could differentiate or counter-position
- "strongestAds" (array of { "headline": string, "note": string }): up to 5 strongest or most relevant ad angles observed (use ads block; if empty, short hypotheses from site)

Output valid JSON only, no markdown fences.`;

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_COMPETITOR_MODEL?.trim() || "gpt-4o-mini",
      temperature: 0.35,
      max_tokens: 1_800,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You return only valid JSON. Be specific and non-generic when data exists." },
        { role: "user", content: prompt },
      ],
    });
    const raw = completion.choices[0]?.message?.content?.trim() || "";
    const parsed = JSON.parse(raw) as {
      summary?: string;
      topThemes?: unknown;
      suggestedCounterAngles?: unknown;
      strongestAds?: unknown;
    };
    const topThemes = Array.isArray(parsed.topThemes)
      ? parsed.topThemes.filter((x): x is string => typeof x === "string").slice(0, 5)
      : fb.topThemes;
    const suggestedCounterAngles = Array.isArray(parsed.suggestedCounterAngles)
      ? parsed.suggestedCounterAngles.filter((x): x is string => typeof x === "string").slice(0, 5)
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
    return {
      summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : fb.summary,
      topThemes: topThemes.length ? topThemes : fb.topThemes,
      suggestedCounterAngles: suggestedCounterAngles.length ? suggestedCounterAngles : fb.suggestedCounterAngles,
      strongestAds: strongestAds.length ? strongestAds : fb.strongestAds,
      rawPromptUsed: "openai:competitor scan synthesis",
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
  rawPromptUsed: string | null;
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
    const m = await fetchAndStoreMetaAdLibrary(watch.id, watch.competitorFacebookPageId.trim());
    if (m.ok) {
      if (m.error) scanNotes.push(m.error);
      if (m.count) scanNotes.push(`Pulled ${m.count} Meta ad(s) from Ad Library.`);
    } else {
      scanNotes.push(`Meta ads: ${m.error}`);
    }
  } else {
    scanNotes.push("Meta: no Page ID — add a numeric Meta Page ID to pull public ads (requires app token in env).");
  }

  const recentAds = await prisma.competitorAd.findMany({
    where: { watchId: watch.id, platform: "meta" },
    orderBy: { lastSeenAt: "desc" },
    take: 12,
  });
  const adHeadlines = recentAds
    .map((a) => a.headline || a.bodyText?.replace(/\s+/g, " ").trim().slice(0, 200) || "")
    .filter(Boolean) as string[];

  const syn = await synthesizeWithOpenAI({
    competitorName: watch.competitorName,
    keywords: kw,
    site,
    scanNotes,
    adHeadlines,
  });

  return {
    summary: syn.summary,
    topThemes: syn.topThemes as unknown as Prisma.InputJsonValue,
    suggestedCounterAngles: syn.suggestedCounterAngles as unknown as Prisma.InputJsonValue,
    strongestAds: (syn.strongestAds.length ? syn.strongestAds : adHeadlines.slice(0, 5).map((h) => ({ headline: h }))) as unknown as Prisma.InputJsonValue,
    rawPromptUsed: syn.rawPromptUsed || null,
    scanNotes,
  };
}
