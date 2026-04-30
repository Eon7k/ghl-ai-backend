import Anthropic from "@anthropic-ai/sdk";
import type { GhlCsvRow } from "./ghlSocialPlanner";

const KEY = (process.env.ANTHROPIC_API_KEY || "").trim();
/** Default to a capable text model; override with ANTHROPIC_CONTENT_STRATEGY_MODEL. */
const DEFAULT_MODEL = "claude-3-5-sonnet-20241022";

export type ContentStrategyMode = "full" | "text_plus_prompts" | "ideas_only";
export type ContentStrategyHorizon = "single" | "week" | "month";

function modelForContentStrategy(): string {
  return (process.env.ANTHROPIC_CONTENT_STRATEGY_MODEL || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL).trim();
}

export function assertAnthropicKeyForContentStrategy(): void {
  if (!KEY || KEY.length < 20) {
    throw new Error("ANTHROPIC_API_KEY is missing or too short. Set it for Claude-powered content strategy.");
  }
}

/**
 * Produces a Markdown plan. Uses the same ANTHROPIC_API_KEY as the rest of the app; optional model
 * via ANTHROPIC_CONTENT_STRATEGY_MODEL.
 */
export async function generateContentStrategyPlan(input: {
  businessModelProfile: unknown;
  userPrompt: string;
  mode: ContentStrategyMode;
  horizon: ContentStrategyHorizon;
}): Promise<string> {
  assertAnthropicKeyForContentStrategy();
  const client = new Anthropic({ apiKey: KEY });
  const model = modelForContentStrategy();

  const system = `You are a senior social and content marketing strategist. You output clear, actionable plans in structured Markdown. Do not use JSON unless the user asks. Be specific to the business model, audience, and channels described. If information is missing, make reasonable assumptions and state them in a short "Assumptions" note.`;

  const modeDesc =
    input.mode === "full"
      ? "OUTPUT MODE — FULL: For each content slot, write complete, ready-to-post copy (headline if relevant + body) plus a brief suggested CTA. Include light guidance on image/video (description prompts). Assume standard channels (e.g. LinkedIn, Instagram, or what fits the business) unless the user specified otherwise."
      : input.mode === "text_plus_prompts"
        ? "OUTPUT MODE — TEXT + ASSET CHECKLIST: Write full post text for each slot. For each, add a bullet list titled \"What to create or gather\" (specific assets: photos, video clips, screenshots, UGC, etc.). Do not write full ad creative for images; be concrete about what the human must supply."
        : "OUTPUT MODE — IDEAS ONLY: Only themes, hooks, one-line ideas, and angles. No full post copy. The user will write everything. Use tables or lists for a calendar-style layout.";

  const horizonDesc =
    input.horizon === "single"
      ? "TIME — ONE POST: A single high-impact post plan (one block)."
      : input.horizon === "week"
        ? "TIME — 7-DAY CALENDAR: Day 1 through Day 7; one primary idea per day."
        : "TIME — MONTH-LEVEL PLAN: 4 weeks; each week 3–5 post slots or themes (roughly a month of direction).";

  const businessJson = JSON.stringify(input.businessModelProfile ?? {});

  const user = [
    `## Business model profile (treat as source of truth)\n${businessJson}\n`,
    `## Extra context or goals from the user\n${(input.userPrompt || "").trim() || "(none)"}\n`,
    `## Requirements\n- ${modeDesc}\n- ${horizonDesc}\n`,
    `Start with a one-line strategy summary, then the deliverable in Markdown: headings, numbered lists, and tables if useful.`,
  ].join("\n");

  const message = await client.messages.create({
    model,
    max_tokens: 8192,
    system,
    messages: [{ role: "user", content: user }],
  });
  const block = message.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : "";
}

function horizonSlotCount(horizon: ContentStrategyHorizon): number {
  if (horizon === "single") return 1;
  if (horizon === "week") return 7;
  return 12;
}

function extractJsonArray(text: string): unknown {
  const t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```/m.exec(t);
  const raw = fence ? fence[1].trim() : t;
  return JSON.parse(raw);
}

function normalizeGhlPosts(rows: unknown, slotCount: number): GhlCsvRow[] {
  if (!Array.isArray(rows)) throw new Error("AI response must be a JSON array of posts.");
  const out: GhlCsvRow[] = [];
  const maxRows = Math.min(90, Math.max(1, slotCount));
  for (let i = 0; i < rows.length && out.length < maxRows; i++) {
    const r = rows[i];
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const postAtSpecificTime =
      typeof o.postAtSpecificTime === "string"
        ? o.postAtSpecificTime.trim()
        : typeof o.scheduledAt === "string"
          ? o.scheduledAt.trim()
          : "";
    const content = typeof o.content === "string" ? o.content.trim() : "";
    if (!postAtSpecificTime || !content) continue;
    const link = typeof o.link === "string" ? o.link.trim() : "";
    const imageUrls = typeof o.imageUrls === "string" ? o.imageUrls.trim() : "";
    const gifUrl = typeof o.gifUrl === "string" ? o.gifUrl.trim() : "";
    const videoUrls = typeof o.videoUrls === "string" ? o.videoUrls.trim() : "";
    out.push({
      postAtSpecificTime,
      content,
      ...(link ? { link } : {}),
      ...(imageUrls ? { imageUrls } : {}),
      ...(gifUrl ? { gifUrl } : {}),
      ...(videoUrls ? { videoUrls } : {}),
    });
  }
  if (out.length === 0) {
    throw new Error(
      "Could not parse scheduled posts from the AI response. Try again or shorten your prompt."
    );
  }
  return out;
}

/**
 * Structured rows for Go High Level Social Planner Basic CSV (date/time + caption + optional links/media URLs).
 */
export async function generateContentStrategyGhlPosts(input: {
  businessModelProfile: unknown;
  userPrompt: string;
  mode: ContentStrategyMode;
  horizon: ContentStrategyHorizon;
}): Promise<{ posts: GhlCsvRow[] }> {
  assertAnthropicKeyForContentStrategy();
  const client = new Anthropic({ apiKey: KEY });
  const model = modelForContentStrategy();
  const slotCount = horizonSlotCount(input.horizon);
  const todayUtc = new Date().toISOString().slice(0, 10);

  const modeDesc =
    input.mode === "full"
      ? "FULL: Write complete, ready-to-post captions for each slot."
      : input.mode === "text_plus_prompts"
        ? "TEXT + CHECKLIST: Still output caption text per slot in `content`; you may append one short checklist line if needed."
        : "IDEAS: Still produce usable captions so each slot has publishable text (not theme-only bullets).";

  const horizonDesc =
    input.horizon === "single"
      ? "TIME — ONE SLOT"
      : input.horizon === "week"
        ? "TIME — SEVEN SLOTS (Day 1–7)"
        : "TIME — TWELVE SLOTS spread across roughly one month";

  const system = `You output ONLY valid JSON (no Markdown, no prose before or after). The JSON must be a single array of objects.

Each object MUST use these keys:
- "postAtSpecificTime": string, format exactly "YYYY-MM-DD HH:mm:ss" using UTC. Schedule times at least 15 minutes after typical upload time; spread slots realistically (${slotCount} posts total).
- "content": string, the social caption/body (hashtags allowed).
- "link": optional string, URL for link preview if relevant, else omit or "".
- "imageUrls": optional string, comma-separated absolute HTTPS image URLs if you invent plausible placeholders leave empty.

Strict rules:
- Exactly ${slotCount} objects (or fewer only if impossible — prefer exactly ${slotCount}).
- Max ${slotCount} entries; never more than 90.
- Strings must escape quotes properly inside JSON only — use JSON UTF-8 rules.
Today's calendar date (UTC) for planning context: ${todayUtc}.`;

  const user = [
    `Business profile JSON:\n${JSON.stringify(input.businessModelProfile ?? {})}\n`,
    `User notes:\n${(input.userPrompt || "").trim() || "(none)"}\n`,
    `Requirements: ${modeDesc} ${horizonDesc}`,
    `Return ONLY the JSON array.`,
  ].join("\n");

  const message = await client.messages.create({
    model,
    max_tokens: 8192,
    system,
    messages: [{ role: "user", content: user }],
  });
  const block = message.content.find((b) => b.type === "text");
  const rawText = block && block.type === "text" ? block.text.trim() : "";
  if (!rawText) throw new Error("Empty AI response for CSV posts.");
  let parsed: unknown;
  try {
    parsed = extractJsonArray(rawText);
  } catch {
    throw new Error("AI did not return valid JSON for CSV rows. Try generating again.");
  }
  const posts = normalizeGhlPosts(parsed, slotCount);
  return { posts };
}
