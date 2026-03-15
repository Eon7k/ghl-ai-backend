import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import OpenAI from "openai";
import { buildSystemPrompt, buildUserPrompt, buildVariantsFromOnePrompt, AdPlatform } from "./aiPromptTemplates";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY || OPENAI_API_KEY.length < 10) {
  console.warn(
    "[WARN] OPENAI_API_KEY is not set or invalid. AI ad generation and regenerate will fail. " +
    "Set OPENAI_API_KEY in .env (local) or in Render Environment (production)."
  );
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY || "not-set"
});

const app = express();
// CORS: allow any origin (e.g. GHL iframe) so fetch is not blocked
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
    credentials: false,
    optionsSuccessStatus: 200,
  })
);
app.use(express.json());

const PORT = process.env.PORT || 4000;
const OPTIMIZER_URL = process.env.OPTIMIZER_URL || "http://localhost:5001";

// Experiment and variant types for Phase 2 (frontend API spec)
interface ExperimentRecord {
  id: string;
  name: string;
  platform: string;
  status: string;
  phase: string;
  totalDailyBudget: number;
  prompt?: string;
  variantCount?: number;
  creativesSource?: "ai" | "own";
}

interface VariantRecord {
  id: string;
  experimentId: string;
  index: number;
  copy: string;
  status: string;
}

// Temporary in-memory storage (no database yet)
const experiments: ExperimentRecord[] = [];
const variantsByExperimentId: Record<string, VariantRecord[]> = {};

function generateId(): string {
  return `exp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function generateVariantId(): string {
  return `var-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

type OptimizationKPI = "CPL" | "CPA" | "CTR";

interface VariantMetrics {
  variantId: string;
  impressions: number;
  clicks: number;
  conversions: number;
  spend: number;
}

interface ExperimentSettings {
  kpi: OptimizationKPI;
  minImpressions: number;
  minClicks: number;
  minDays: number;
  aggressiveness: "slow" | "normal" | "aggressive";
  targetTopVariants: number;
  totalDailyBudget: number;
}

interface OptimizationRequest {
  experimentId: string;
  variants: VariantMetrics[];
  currentBudgets: Record<string, number>;
  settings: ExperimentSettings;
}

interface OptimizationResponse {
  experimentId: string;
  phase: "explore" | "exploit" | "winners_scaled";
  pauseVariantIds: string[];
  newBudgets: Record<string, number>;
  notes?: string;
}

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// List all experiments (with variants and variantCount for Phase 2)
app.get("/experiments", (_req: Request, res: Response) => {
  const list = experiments.map((e) => {
    const variants = variantsByExperimentId[e.id] || [];
    return {
      ...e,
      variants,
      variantCount: e.variantCount ?? variants.length
    };
  });
  res.json(list);
});

// Get one experiment with its variants
app.get("/experiments/:id", (req: Request, res: Response) => {
  const exp = experiments.find((e) => e.id === req.params.id);
  if (!exp) {
    return res.status(404).json({ error: "Experiment not found" });
  }
  const variants = variantsByExperimentId[exp.id] || [];
  res.json({ ...exp, variants });
});

// AI ad copy generation
app.post("/ai/generate-ad-copy", async (req: Request, res: Response) => {
  const {
    offerDescription,
    audienceDescription,
    brandVoice,
    platform,
    numVariants
  } = req.body;

  if (!offerDescription || !audienceDescription || !platform || !numVariants) {
    return res.status(400).json({
      error: "offerDescription, audienceDescription, platform, numVariants are required"
    });
  }

  try {
    const sysPrompt = buildSystemPrompt(platform as AdPlatform);
    const userPrompt = buildUserPrompt({
      offerDescription,
      audienceDescription,
      brandVoice,
      platform,
      numVariants
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: sysPrompt },
        { role: "user", content: userPrompt }
      ]
    });

    const content = completion.choices[0]?.message?.content || "";
    let parsed: unknown;

    try {
      parsed = JSON.parse(content);
    } catch {
      const match = content.match(/\[([\s\S]*?)\]/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        throw new Error("AI response was not valid JSON");
      }
    }

    res.json({ variants: parsed });
  } catch (err: any) {
    console.error("AI generation failed", err?.message || err);
    res.status(500).json({ error: "Failed to generate ad copy" });
  }
});

// Call optimizer to adjust budgets
app.post("/experiments/:id/optimize", async (req: Request, res: Response) => {
  const experimentId = req.params.id;

  const payload: OptimizationRequest = {
    experimentId,
    variants: req.body.variants,
    currentBudgets: req.body.currentBudgets,
    settings: req.body.settings
  };

  try {
    const response = await axios.post<OptimizationResponse>(
      `${OPTIMIZER_URL}/optimize`,
      payload,
      { timeout: 10_000 }
    );
    res.json(response.data);
  } catch (error: any) {
    console.error("Optimizer call failed", error?.message || error);
    res.status(500).json({ error: "Failed to reach optimizer service" });
  }
});

// Normalize object keys to lowercase and get headline + body from common key names
function extractCopyFromItem(item: Record<string, unknown>): string {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(item)) {
    if (typeof v === "string") lower[k.toLowerCase()] = v;
  }
  const headline =
    lower.headline ?? lower.headlinetext ?? lower.title ?? lower.head ?? "";
  const body =
    lower.primarytext ??
    lower["primary text"] ??
    lower.primary_text ??
    lower.body ??
    lower.copy ??
    lower.text ??
    lower.description ??
    "";
  const parts = [headline, body].filter(Boolean);
  let combined = parts.join("\n\n").trim();
  if (!combined) {
    const allStrings = Object.values(lower).filter((v) => v && v.length > 2);
    combined = allStrings.join("\n\n").trim();
  }
  return combined;
}

// Generate N ad copy variants from one user prompt (experiment flow)
async function generateVariantsFromPrompt(
  prompt: string,
  platform: string,
  count: number
): Promise<string[]> {
  const systemPrompt =
    "You are an expert ad copywriter. You write NEW, original ad copy. " +
    "Never repeat or echo the user's idea text as the headline or body. " +
    "Output only valid JSON: a single object with key \"variants\" whose value is an array of objects. Each object must have \"headline\" and \"primaryText\" as strings.";

  const userPrompt = buildVariantsFromOnePrompt(prompt, platform as AdPlatform, count);

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    response_format: { type: "json_object" }
  });

  let content = (completion.choices[0]?.message?.content || "").trim();
  const codeFence = content.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (codeFence) content = codeFence[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    console.error("[AI] JSON parse failed. Content preview:", content.slice(0, 300));
    const match = content.match(/\[[\s\S]*\]/);
    parsed = match ? JSON.parse(match[0]) : { variants: [] };
  }

  const raw = parsed as Record<string, unknown>;
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray(raw?.variants)
      ? raw.variants
      : Array.isArray(raw?.ads)
        ? raw.ads
        : [];

  console.log("[AI] Parsed variants count:", arr.length, "First item keys:", arr[0] && typeof arr[0] === "object" ? Object.keys(arr[0] as object) : "n/a");

  const copies: string[] = [];
  for (let i = 0; i < count; i++) {
    const item = arr[i];
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const combined = extractCopyFromItem(item as Record<string, unknown>);
      copies.push(combined || `Variant ${i + 1} — AI returned no text (see Render logs)`);
    } else if (typeof item === "string" && item.trim()) {
      copies.push(item.trim());
    } else {
      copies.push(`Variant ${i + 1} — no content`);
    }
  }
  return copies.length >= count ? copies : [...copies, ...Array(Math.max(0, count - copies.length)).fill("Variant (missing)")].slice(0, count);
}

// Create a new experiment with variants (Phase 2: creativesSource, prompt, variantCount)
app.post("/experiments", async (req: Request, res: Response) => {
  const {
    name,
    platform,
    totalDailyBudget,
    prompt,
    variantCount,
    creativesSource
  } = req.body;

  if (!name || !platform || typeof totalDailyBudget !== "number") {
    return res
      .status(400)
      .json({ error: "name, platform, totalDailyBudget are required" });
  }

  const count = Math.min(20, Math.max(1, Number(variantCount) || 3));
  const source = creativesSource === "own" ? "own" : "ai";
  const promptText =
    typeof prompt === "string" && prompt.trim()
      ? prompt.trim()
      : "Generate varied ad copy for this campaign.";

  const id = generateId();
  const newExperiment: ExperimentRecord = {
    id,
    name,
    platform,
    status: "draft",
    phase: "setup",
    totalDailyBudget: Number(totalDailyBudget),
    prompt: promptText,
    variantCount: count,
    creativesSource: source
  };

  experiments.push(newExperiment);

  let copies: string[];
  if (source === "own") {
    copies = Array.from({ length: count }, () => "");
  } else {
    try {
      copies = await generateVariantsFromPrompt(promptText, platform, count);
    } catch (err: any) {
      console.error("AI variant generation failed", err?.message || err);
      copies = Array.from({ length: count }, (_, i) => `[Variant ${i + 1}] ${promptText.slice(0, 80)}...`);
    }
  }

  const variants: VariantRecord[] = copies.map((copy, i) => ({
    id: generateVariantId(),
    experimentId: id,
    index: i + 1,
    copy: copy || (source === "own" ? "Paste your ad copy here..." : copy),
    status: "draft"
  }));

  variantsByExperimentId[id] = variants;

  res.status(201).json({ ...newExperiment, variants });
});

// Update one variant's copy (Phase 2)
app.patch("/experiments/:experimentId/variants/:variantId", (req: Request, res: Response) => {
  const { experimentId, variantId } = req.params;
  const { copy } = req.body;

  if (typeof copy !== "string") {
    return res.status(400).json({ error: "Body must include copy (string)" });
  }

  const variants = variantsByExperimentId[experimentId];
  if (!variants) {
    return res.status(404).json({ error: "Experiment not found" });
  }
  const variant = variants.find((v) => v.id === variantId);
  if (!variant) {
    return res.status(404).json({ error: "Variant not found" });
  }
  variant.copy = copy;
  res.json(variant);
});

// Regenerate one variant's copy with AI (same prompt, new angle)
app.post("/experiments/:experimentId/variants/:variantId/regenerate", async (req: Request, res: Response) => {
  const { experimentId, variantId } = req.params;

  const exp = experiments.find((e) => e.id === experimentId);
  if (!exp) {
    return res.status(404).json({ error: "Experiment not found" });
  }

  const variants = variantsByExperimentId[experimentId];
  if (!variants) {
    return res.status(404).json({ error: "Experiment not found" });
  }
  const variant = variants.find((v) => v.id === variantId);
  if (!variant) {
    return res.status(404).json({ error: "Variant not found" });
  }

  const promptText = exp.prompt || "Generate a new, distinct ad copy variant.";
  try {
    const copies = await generateVariantsFromPrompt(promptText, exp.platform, 1);
    const newCopy = copies[0] || "";
    variant.copy = newCopy;
    res.json({ copy: newCopy, variant });
  } catch (err: any) {
    console.error("Regenerate variant failed", err?.message || err);
    res.status(500).json({ error: "Failed to regenerate ad copy" });
  }
});

// Launch experiment (Phase 2)
app.post("/experiments/:id/launch", (req: Request, res: Response) => {
  const exp = experiments.find((e) => e.id === req.params.id);
  if (!exp) {
    return res.status(404).json({ error: "Experiment not found" });
  }
  exp.status = "launched";
  exp.phase = "running";
  res.json(exp);
});

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
