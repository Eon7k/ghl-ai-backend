import OpenAI from "openai";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";

type HarvestWeightsJson = {
  pageScores?: Record<string, number>;
  tokenHints?: Record<string, number>;
  intentSnippets?: string[];
};

const RANK_GENERIC_STOP = new Set([
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
  "your",
  "our",
  "with",
  "from",
  "this",
  "that",
  "have",
  "been",
  "about",
  "more",
]);

export function parseHarvestKeywordStrings(raw: unknown, max = 28): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().slice(0, 160))
    .filter((x) => x.length > 2)
    .slice(0, max);
}

export type HarvestRankingScoreContext = {
  harvestKeywords: string[];
  rankingKeywords: string[];
  intentPrompt: string;
  pageBoost: Record<string, number>;
  tokenHints: Record<string, number>;
};

export function scoreHarvestAdForRanking(
  ad: {
    facebookPageId: string;
    pageName: string | null;
    headline: string | null;
    bodyText: string | null;
    adLibraryId: string;
  },
  ctx: HarvestRankingScoreContext
): number {
  const hay = [ad.pageName, ad.headline, ad.bodyText].filter(Boolean).join("\n").toLowerCase();
  let score = 0;

  const phrases = [...ctx.harvestKeywords, ...ctx.rankingKeywords]
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length >= 2);
  const seenPhrase = new Set<string>();
  for (const p of phrases) {
    if (!p || seenPhrase.has(p)) continue;
    seenPhrase.add(p);
    if (!hay.includes(p)) continue;
    if (p.length >= 14) score += 28;
    else if (p.length >= 8) score += 20;
    else if (p.length >= 4) score += 12;
    else score += 6;
  }

  const intent = ctx.intentPrompt.trim().toLowerCase();
  if (intent.length >= 8) {
    const tokens = intent
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9]/gi, ""))
      .filter((w) => w.length >= 4 && !RANK_GENERIC_STOP.has(w));
    for (const t of [...new Set(tokens)].slice(0, 36)) {
      if (hay.includes(t)) score += 5;
    }
  }

  const pid = ad.facebookPageId.replace(/\D/g, "");
  if (pid && ctx.pageBoost[pid]) {
    score += Math.min(48, ctx.pageBoost[pid]! * 7);
  }

  const hintEntries = Object.entries(ctx.tokenHints)
    .filter(([tok]) => tok.length >= 5 && !RANK_GENERIC_STOP.has(tok))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 28);
  for (const [tok, n] of hintEntries) {
    if (hay.includes(tok)) score += Math.min(14, 4 + Math.floor(Math.sqrt(n)));
  }

  return score;
}

export async function loadHarvestRankingScoreContext(
  agencyId: string,
  clientId: string,
  run: {
    keywords: unknown;
    rankingKeywords: unknown;
    intentPrompt: string | null;
  }
): Promise<HarvestRankingScoreContext> {
  const pref = await prisma.harvestAnalysisPreference.findUnique({
    where: { agencyId_clientId: { agencyId, clientId } },
  });
  const w = (pref?.weightsJson as HarvestWeightsJson) || {};
  return {
    harvestKeywords: parseHarvestKeywordStrings(run.keywords),
    rankingKeywords: parseHarvestKeywordStrings(run.rankingKeywords),
    intentPrompt: run.intentPrompt?.trim() ?? "",
    pageBoost: w.pageScores ?? {},
    tokenHints: w.tokenHints ?? {},
  };
}

export function attachHarvestAdRelevanceScores<
  T extends {
    facebookPageId: string;
    pageName: string | null;
    headline: string | null;
    bodyText: string | null;
    adLibraryId: string;
  },
>(ads: T[], ctx: HarvestRankingScoreContext): (T & { relevanceScore: number })[] {
  const scored = ads.map((a) => ({
    ...a,
    relevanceScore: scoreHarvestAdForRanking(a, ctx),
  }));
  scored.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
    return a.adLibraryId.localeCompare(b.adLibraryId);
  });
  return scored;
}

export async function getHarvestLearningPromptAddition(agencyId: string, clientId: string): Promise<string | null> {
  const pref = await prisma.harvestAnalysisPreference.findUnique({
    where: { agencyId_clientId: { agencyId, clientId } },
  });
  if (!pref) return null;
  const w = (pref.weightsJson as HarvestWeightsJson) || {};
  const pages = w.pageScores ?? {};
  const topPages = Object.entries(pages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, n]) => `${id}×${n}`)
    .join(", ");
  const tok = w.tokenHints ?? {};
  const topTok = Object.entries(tok)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16)
    .map(([t]) => t)
    .join(", ");
  const intents = Array.isArray(w.intentSnippets) ? w.intentSnippets.slice(-4).join(" · ") : "";
  const parts: string[] = [];
  if (topPages) parts.push(`Past report selections leaned on Meta Page ids (counts approximate): ${topPages}.`);
  if (topTok) parts.push(`Words that often appeared in ads they previously chose for analysis: ${topTok}.`);
  if (intents) parts.push(`Recent ranking intents logged in-app: ${intents.slice(0, 720)}`);
  return parts.length ? parts.join(" ") : null;
}

export async function appendHarvestIntentSnippet(agencyId: string, clientId: string, snippet: string): Promise<void> {
  const s = snippet.trim().slice(0, 900);
  if (s.length < 12) return;
  const pref = await prisma.harvestAnalysisPreference.findUnique({
    where: { agencyId_clientId: { agencyId, clientId } },
  });
  const prev = (pref?.weightsJson as HarvestWeightsJson) || {};
  const arr = [...(Array.isArray(prev.intentSnippets) ? prev.intentSnippets : [])];
  arr.push(s);
  while (arr.length > 18) arr.shift();
  const next: HarvestWeightsJson = {
    ...prev,
    intentSnippets: arr,
    pageScores: prev.pageScores ?? {},
    tokenHints: prev.tokenHints ?? {},
  };
  await prisma.harvestAnalysisPreference.upsert({
    where: { agencyId_clientId: { agencyId, clientId } },
    create: {
      agencyId,
      clientId,
      weightsJson: next as unknown as Prisma.InputJsonValue,
    },
    update: {
      weightsJson: next as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function recordHarvestSelectionsFromAds(opts: {
  agencyId: string;
  clientId: string;
  ads: { facebookPageId: string; headline: string | null; bodyText: string | null }[];
}): Promise<void> {
  if (opts.ads.length === 0) return;
  const pref = await prisma.harvestAnalysisPreference.findUnique({
    where: { agencyId_clientId: { agencyId: opts.agencyId, clientId: opts.clientId } },
  });
  const prev = (pref?.weightsJson as HarvestWeightsJson) || {};
  const pageScores = { ...(prev.pageScores ?? {}) };
  for (const a of opts.ads) {
    const pid = a.facebookPageId.replace(/\D/g, "");
    if (!pid) continue;
    pageScores[pid] = (pageScores[pid] ?? 0) + 1;
  }
  const trimmedPages = Object.fromEntries(Object.entries(pageScores).sort((a, b) => b[1] - a[1]).slice(0, 140));

  const tokenHints = { ...(prev.tokenHints ?? {}) };
  for (const a of opts.ads) {
    const blob = `${a.headline || ""} ${a.bodyText || ""}`.toLowerCase();
    for (const w of blob.split(/\s+/)) {
      const clean = w.replace(/[^a-z0-9]/gi, "");
      if (clean.length >= 5 && !RANK_GENERIC_STOP.has(clean)) {
        tokenHints[clean] = (tokenHints[clean] ?? 0) + 1;
      }
    }
  }
  const trimmedTok = Object.fromEntries(Object.entries(tokenHints).sort((a, b) => b[1] - a[1]).slice(0, 100));

  const next: HarvestWeightsJson = {
    ...prev,
    pageScores: trimmedPages,
    tokenHints: trimmedTok,
    intentSnippets: prev.intentSnippets ?? [],
  };

  await prisma.harvestAnalysisPreference.upsert({
    where: { agencyId_clientId: { agencyId: opts.agencyId, clientId: opts.clientId } },
    create: {
      agencyId: opts.agencyId,
      clientId: opts.clientId,
      weightsJson: next as unknown as Prisma.InputJsonValue,
    },
    update: {
      weightsJson: next as unknown as Prisma.InputJsonValue,
    },
  });
}

function rankingOpenAI(): OpenAI | null {
  const k = (process.env.OPENAI_API_KEY || "").trim();
  if (!k || k.length < 20) return null;
  return new OpenAI({ apiKey: k });
}

export async function suggestRankingKeywordsFromIntent(args: {
  intentPrompt: string;
  harvestKeywords: string[];
}): Promise<string[]> {
  const oa = rankingOpenAI();
  const intent = args.intentPrompt.trim().slice(0, 4000);
  if (!oa || intent.length < 8) return [];
  try {
    const completion = await oa.chat.completions.create({
      model: process.env.OPENAI_COMPETITOR_MODEL?.trim() || "gpt-4o-mini",
      temperature: 0.35,
      max_tokens: 600,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'Return JSON {"keywords": string[]} only. Keywords are short phrases (1–5 words) used to rank Meta ads by relevance.',
        },
        {
          role: "user",
          content: `Original harvest keywords used when collecting ads:\n${args.harvestKeywords.join(", ") || "(none)"}\n\nUser describes what they want to prioritize now:\n${intent}\n\nReply with 12–22 concise phrases mixing niche terms and angles. No duplicates.`,
        },
      ],
    });
    const raw = completion.choices[0]?.message?.content?.trim() || "";
    const parsed = JSON.parse(raw) as { keywords?: unknown };
    if (!Array.isArray(parsed.keywords)) return [];
    return parsed.keywords
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim().slice(0, 120))
      .filter((x) => x.length > 1)
      .slice(0, 28);
  } catch {
    return [];
  }
}
