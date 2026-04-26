import Anthropic from "@anthropic-ai/sdk";

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
