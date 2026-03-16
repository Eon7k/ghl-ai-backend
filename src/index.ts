import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import OpenAI from "openai";
import { buildSystemPrompt, buildUserPrompt, buildVariantsFromOnePrompt, AdPlatform } from "./aiPromptTemplates";

// Only load .env file when NOT in production (so Render always uses its own env vars)
if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const isProduction = process.env.NODE_ENV === "production";
console.log("[OPENAI] NODE_ENV:", process.env.NODE_ENV || "(not set)", "| Key present:", !!OPENAI_API_KEY, "| Key starts with sk-:", OPENAI_API_KEY.startsWith("sk-"));

if (!OPENAI_API_KEY || OPENAI_API_KEY.length < 20) {
  console.warn(
    "[WARN] OPENAI_API_KEY is missing or too short. Set OPENAI_API_KEY in Render → Environment (exact name)."
  );
} else if (!OPENAI_API_KEY.startsWith("sk-")) {
  console.warn("[WARN] OPENAI_API_KEY should start with sk-. Check for typos or extra characters in Render.");
} else {
  console.log("[OPENAI] Using key:", OPENAI_API_KEY.slice(0, 7) + "..." + OPENAI_API_KEY.slice(-4));
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

// Auth: user and JWT
const JWT_SECRET = (process.env.JWT_SECRET || "change-me-in-production").trim();
interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}
const usersByEmail = new Map<string, UserRecord>();
const usersById = new Map<string, UserRecord>();

function generateUserId(): string {
  return `user-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// Extend Express Request so we can attach user
interface AuthRequest extends Request {
  user?: { id: string; email: string };
}

function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: string; email: string };
    const user = usersById.get(payload.userId);
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    req.user = { id: user.id, email: user.email };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Experiment and variant types for Phase 2 (frontend API spec)
interface ExperimentRecord {
  id: string;
  userId: string;
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

// ----- Integrations: connected ad accounts (Meta, TikTok, Google) -----
const META_APP_ID = (process.env.META_APP_ID || "").trim();
const META_APP_SECRET = (process.env.META_APP_SECRET || "").trim();
// Must be a full URL (https://...) so redirect after OAuth goes to the frontend, not a path on the backend
function normalizeFrontendUrl(url: string): string {
  const trimmed = url.replace(/\/$/, "");
  if (!trimmed) return "http://localhost:3000";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  return `https://${trimmed}`;
}
const FRONTEND_URL = normalizeFrontendUrl(process.env.FRONTEND_URL || "http://localhost:3000");

interface ConnectedAccountRecord {
  id: string;
  userId: string;
  platform: "meta" | "tiktok" | "google";
  accessToken: string;
  refreshToken?: string;
  platformAccountId?: string;
  platformAccountName?: string;
  createdAt: string;
}
const connectedAccounts: ConnectedAccountRecord[] = [];
const connectedAccountsById = new Map<string, ConnectedAccountRecord>();

function generateIntegrationId(): string {
  return `conn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

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

// ----- Auth (no auth required for these) -----
app.post("/auth/register", async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || typeof email !== "string" || !password || typeof password !== "string") {
    return res.status(400).json({ error: "email and password are required" });
  }
  const emailNorm = email.trim().toLowerCase();
  const passwordTrimmed = (password as string).trim();
  if (emailNorm.length < 3) {
    return res.status(400).json({ error: "Invalid email" });
  }
  if (passwordTrimmed.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  if (usersByEmail.has(emailNorm)) {
    return res.status(400).json({ error: "An account with this email already exists" });
  }
  const id = generateUserId();
  const passwordHash = await bcrypt.hash(passwordTrimmed, 10);
  const user: UserRecord = { id, email: emailNorm, passwordHash, createdAt: new Date().toISOString() };
  usersByEmail.set(emailNorm, user);
  usersById.set(id, user);
  const token = jwt.sign({ userId: id, email: emailNorm }, JWT_SECRET, { expiresIn: "7d" });
  res.status(201).json({ token, user: { id, email: emailNorm } });
});

app.post("/auth/login", async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  const emailNorm = (email as string).trim().toLowerCase();
  const passwordTrimmed = (password as string).trim();
  const user = usersByEmail.get(emailNorm);
  if (!user) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const match = await bcrypt.compare(passwordTrimmed, user.passwordHash);
  if (!match) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id: user.id, email: user.email } });
});

app.get("/auth/me", (req: AuthRequest, res: Response) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Not logged in" });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: string; email: string };
    const user = usersById.get(payload.userId);
    if (!user) return res.status(401).json({ error: "User not found" });
    res.json({ user: { id: user.id, email: user.email } });
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
});

// ----- Integrations: connect ad accounts (Meta, etc.) -----
app.get("/integrations", requireAuth, (req: AuthRequest, res: Response) => {
  const list = connectedAccounts
    .filter((c) => c.userId === req.user!.id)
    .map(({ id, platform, platformAccountId, platformAccountName, createdAt }) => ({
      id,
      platform,
      platformAccountId,
      platformAccountName,
      createdAt,
    }));
  res.json({ integrations: list });
});

// Start Meta OAuth: redirect user to Meta login. Call with ?token=JWT so we know the user (browser can't send Authorization on redirect).
app.get("/integrations/meta/connect", (req: Request, res: Response) => {
  const tokenParam = (req.query.token as string) || "";
  const token = tokenParam.trim() || (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null);
  if (!token) {
    return res.status(401).send("Missing token. Log in and use the Connect Meta button from the Integrations page.");
  }
  let userId: string;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: string };
    const user = usersById.get(payload.userId);
    if (!user) return res.status(401).send("User not found");
    userId = user.id;
  } catch {
    return res.status(401).send("Invalid or expired token. Please log in again.");
  }
  if (!META_APP_ID || !META_APP_SECRET) {
    return res.status(503).send("Meta integration is not configured. Set META_APP_ID and META_APP_SECRET on the server.");
  }
  const backendUrl = process.env.BACKEND_URL || `http://localhost:${PORT}`;
  const redirectUri = `${backendUrl.replace(/\/$/, "")}/integrations/meta/callback`;
  const scope = "ads_management,ads_read,business_management";
  const state = userId;
  const metaAuthUrl = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${encodeURIComponent(META_APP_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}`;
  res.redirect(302, metaAuthUrl);
});

// Meta OAuth callback: exchange code for access token, store for user, redirect to frontend.
app.get("/integrations/meta/callback", async (req: Request, res: Response) => {
  const { code, state: userId, error: metaError } = req.query as { code?: string; state?: string; error?: string };
  const frontendBase = FRONTEND_URL;
  const integrationsPath = "/integrations";
  if (metaError || !code) {
    const err = metaError || "No authorization code received";
    res.redirect(302, `${frontendBase}${integrationsPath}?error=${encodeURIComponent(err)}`);
    return;
  }
  if (!userId || !usersById.has(userId)) {
    res.redirect(302, `${frontendBase}${integrationsPath}?error=${encodeURIComponent("Invalid state")}`);
    return;
  }
  if (!META_APP_ID || !META_APP_SECRET) {
    res.redirect(302, `${frontendBase}${integrationsPath}?error=${encodeURIComponent("Meta not configured")}`);
    return;
  }
  const backendUrl = process.env.BACKEND_URL || `http://localhost:${PORT}`;
  const redirectUri = `${backendUrl.replace(/\/$/, "")}/integrations/meta/callback`;
  const tokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${encodeURIComponent(META_APP_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${encodeURIComponent(META_APP_SECRET)}&code=${encodeURIComponent(code)}`;
  try {
    const tokenRes = await axios.get<{ access_token: string; token_type?: string }>(tokenUrl);
    const accessToken = tokenRes.data?.access_token;
    if (!accessToken) {
      res.redirect(302, `${frontendBase}${integrationsPath}?error=${encodeURIComponent("No token from Meta")}`);
      return;
    }
    // Remove any existing Meta connection for this user (one Meta account per user for now)
    const existing = connectedAccounts.filter((c) => c.userId === userId && c.platform === "meta");
    existing.forEach((c) => {
      connectedAccountsById.delete(c.id);
    });
    const newList = connectedAccounts.filter((c) => !(c.userId === userId && c.platform === "meta"));
    connectedAccounts.length = 0;
    connectedAccounts.push(...newList);

    const id = generateIntegrationId();
    const record: ConnectedAccountRecord = {
      id,
      userId,
      platform: "meta",
      accessToken,
      createdAt: new Date().toISOString(),
    };
    connectedAccounts.push(record);
    connectedAccountsById.set(id, record);
    res.redirect(302, `${frontendBase}${integrationsPath}?connected=meta`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Token exchange failed";
    res.redirect(302, `${frontendBase}${integrationsPath}?error=${encodeURIComponent(String(message))}`);
  }
});

app.delete("/integrations/:id", requireAuth, (req: AuthRequest, res: Response) => {
  const conn = connectedAccountsById.get(req.params.id);
  if (!conn) return res.status(404).json({ error: "Connection not found" });
  if (conn.userId !== req.user!.id) return res.status(404).json({ error: "Connection not found" });
  connectedAccountsById.delete(conn.id);
  const idx = connectedAccounts.findIndex((c) => c.id === conn.id);
  if (idx !== -1) connectedAccounts.splice(idx, 1);
  res.json({ ok: true });
});

// Get Meta ad accounts for the connected Meta integration (so we can show/use them for launching).
app.get("/integrations/meta/ad-accounts", requireAuth, async (req: AuthRequest, res: Response) => {
  const metaConn = connectedAccounts.find(
    (c) => c.userId === req.user!.id && c.platform === "meta"
  );
  if (!metaConn) {
    return res.status(404).json({ error: "Meta not connected. Connect Meta in Integrations first." });
  }
  try {
    const url = `https://graph.facebook.com/v21.0/me/adaccounts?fields=id,name,account_id,account_status&access_token=${encodeURIComponent(metaConn.accessToken)}`;
    const apiRes = await axios.get<{ data?: Array<{ id: string; name: string; account_id: string; account_status?: number }> }>(url);
    const list = apiRes.data?.data || [];
    res.json({ adAccounts: list.map((a) => ({ id: a.id, name: a.name, accountId: a.account_id, accountStatus: a.account_status })) });
  } catch (err: unknown) {
    const msg = err && typeof err === "object" && "response" in err
      ? (err as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message
      : err instanceof Error ? err.message : "Failed to fetch ad accounts";
    console.error("[Meta ad-accounts]", msg);
    res.status(502).json({ error: typeof msg === "string" ? msg : "Meta API error" });
  }
});

// ----- Experiments (auth required) -----
// List all experiments for the logged-in user (with variants and variantCount)
app.get("/experiments", requireAuth, (req: AuthRequest, res: Response) => {
  const list = experiments
    .filter((e) => e.userId === req.user!.id)
    .map((e) => {
    const variants = variantsByExperimentId[e.id] || [];
    return {
      ...e,
      variants,
      variantCount: e.variantCount ?? variants.length
    };
  });
  res.json(list);
});

// Get one experiment with its variants (must belong to user)
app.get("/experiments/:id", requireAuth, (req: AuthRequest, res: Response) => {
  const exp = experiments.find((e) => e.id === req.params.id);
  if (!exp) return res.status(404).json({ error: "Experiment not found" });
  if (exp.userId !== req.user!.id) return res.status(404).json({ error: "Experiment not found" });
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
app.post("/experiments", requireAuth, async (req: AuthRequest, res: Response) => {
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
    userId: req.user!.id,
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
app.patch("/experiments/:experimentId/variants/:variantId", requireAuth, (req: AuthRequest, res: Response) => {
  const { experimentId, variantId } = req.params;
  const { copy } = req.body;

  if (typeof copy !== "string") {
    return res.status(400).json({ error: "Body must include copy (string)" });
  }

  const exp = experiments.find((e) => e.id === experimentId);
  if (!exp || exp.userId !== req.user!.id) {
    return res.status(404).json({ error: "Experiment not found" });
  }
  const variants = variantsByExperimentId[experimentId];
  if (!variants) return res.status(404).json({ error: "Experiment not found" });
  const variant = variants.find((v) => v.id === variantId);
  if (!variant) return res.status(404).json({ error: "Variant not found" });
  variant.copy = copy;
  res.json(variant);
});

// Regenerate one variant's copy with AI (same prompt, new angle)
app.post("/experiments/:experimentId/variants/:variantId/regenerate", requireAuth, async (req: AuthRequest, res: Response) => {
  const { experimentId, variantId } = req.params;

  const exp = experiments.find((e) => e.id === experimentId);
  if (!exp || exp.userId !== req.user!.id) {
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
app.post("/experiments/:id/launch", requireAuth, (req: AuthRequest, res: Response) => {
  const exp = experiments.find((e) => e.id === req.params.id);
  if (!exp || exp.userId !== req.user!.id) {
    return res.status(404).json({ error: "Experiment not found" });
  }
  exp.status = "launched";
  exp.phase = "running";
  res.json(exp);
});

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
