import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt, buildUserPrompt, buildVariantsFromOnePrompt, AdPlatform } from "./aiPromptTemplates";
import { prisma } from "./db";
import { launchTikTokCampaign, tiktokListIdentities } from "./tiktokMarketing";
import {
  launchGoogleDisplayCampaign,
  refreshAndStoreGoogleAccessToken,
  googleAdsApiErrorMessage,
  googleAdsApiHeaders,
} from "./googleMarketing";

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
} else if (!isProduction) {
  console.log("[OPENAI] Using key:", OPENAI_API_KEY.slice(0, 7) + "..." + OPENAI_API_KEY.slice(-4));
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY || "not-set"
});

const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || "").trim();
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
if (process.env.NODE_ENV !== "production" && !ANTHROPIC_API_KEY) {
  console.log("[ANTHROPIC] No ANTHROPIC_API_KEY set; split/anthropic provider will fall back to OpenAI.");
}

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
// Creative uploads send base64 JSON; default 100kb limit breaks "nothing happens" on the client.
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 4000;
const OPTIMIZER_URL = process.env.OPTIMIZER_URL || "http://localhost:5001";

// Auth: user and JWT (users stored in DB via Prisma)
const JWT_SECRET = (process.env.JWT_SECRET || "change-me-in-production").trim();

// Extend Express Request so we can attach user and effective user (for agency viewing-as)
interface AuthRequest extends Request {
  user?: { id: string; email: string; accountType?: string };
  /** When agency views as a client, this is the client's userId for data scope. */
  effectiveUserId?: string;
}

async function requireAuthAsync(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: string; email: string };
    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    const accountType = (user as { accountType?: string }).accountType ?? "single";
    req.user = { id: user.id, email: user.email, accountType };
    // Resolve effective user: agency can send X-Viewing-As: clientUserId to act as that client
    const viewingAs = (req.headers["x-viewing-as"] ?? req.headers["viewing-as"]) as string | undefined;
    if (accountType === "agency" && viewingAs && typeof viewingAs === "string" && viewingAs.trim()) {
      const allowed = await prisma.agencyClient.findFirst({
        where: { agencyUserId: user.id, clientUserId: viewingAs.trim() },
      });
      if (allowed) req.effectiveUserId = viewingAs.trim();
    }
    if (!req.effectiveUserId) req.effectiveUserId = user.id;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  requireAuthAsync(req, res, next).catch(next);
}

// Admin: only these emails can access /admin and see extra metrics
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

function isAdmin(email: string): boolean {
  return ADMIN_EMAILS.has(email.toLowerCase().trim());
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
  creativesSource?: "ai" | "mix" | "own";
  /** Which AI generated ad copy: openai, anthropic, or split (half each). Set when creativesSource === "ai" or "mix". */
  aiProvider?: "openai" | "anthropic" | "split";
  aiCreativeCount?: number; // set at launch: how many variants get AI-created creatives (0 = none)
  /** Optional: how the user wants the ad image/creative to look (used when generating AI creatives). */
  creativePrompt?: string;
  /** IDs of user creatives from the library attached to this campaign (when using own or mixed creatives). */
  attachedCreativeIds?: string[];
  /** When same campaign is launched on multiple platforms, all experiments share this id for grouping in Campaign Manager. */
  campaignGroupId?: string;
  metaCampaignId?: string;
  metaAdSetId?: string;
  tiktokCampaignId?: string;
  tiktokAdGroupId?: string;
  googleCampaignId?: string;
  googleAdGroupId?: string;
  aiOptimizationMode?: string;
}

interface VariantRecord {
  id: string;
  experimentId: string;
  index: number;
  copy: string;
  status: string;
  imageData?: string; // base64 PNG from DALL-E
  /** Which AI generated this variant (openai | anthropic). Set when experiment uses AI copy. */
  aiSource?: "openai" | "anthropic";
}

/** Variant fields safe to load in bulk (excludes imageData blob — can be megabytes per row). */
const VARIANT_PUBLIC_SELECT = {
  id: true,
  experimentId: true,
  index: true,
  copy: true,
  status: true,
  aiSource: true,
} as const;

type VariantPublic = {
  id: string;
  experimentId: string;
  index: number;
  copy: string;
  status: string;
  aiSource?: string | null;
};

// API shape (never embed base64 imageData in JSON)
function variantToJson(v: VariantPublic, hasCreative: boolean): Record<string, unknown> {
  return {
    id: v.id,
    experimentId: v.experimentId,
    index: v.index,
    copy: v.copy,
    status: v.status,
    hasCreative,
    aiSource: v.aiSource ?? undefined,
  };
}

/** Which variant ids have a stored creative (checks NOT NULL only; does not load blob bytes in SELECT). */
async function variantIdsWithImageData(variantIds: string[]): Promise<Set<string>> {
  if (variantIds.length === 0) return new Set();
  const rows = await prisma.variant.findMany({
    where: { id: { in: variantIds }, NOT: { imageData: null } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

// ----- Integrations: connected ad accounts (Meta, TikTok, Google) -----
const META_APP_ID = (process.env.META_APP_ID || "").trim();
const META_APP_SECRET = (process.env.META_APP_SECRET || "").trim();
const TIKTOK_APP_ID = (process.env.TIKTOK_APP_ID || process.env.TIKTOK_CLIENT_KEY || "").trim();
const TIKTOK_APP_SECRET = (process.env.TIKTOK_APP_SECRET || process.env.TIKTOK_CLIENT_SECRET || "").trim();
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
const GOOGLE_ADS_DEVELOPER_TOKEN = (process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "").trim();
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
// IDs are generated by Prisma (cuid)

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
  try {
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
    const existing = await prisma.user.findUnique({ where: { email: emailNorm } });
    if (existing) {
      return res.status(400).json({ error: "An account with this email already exists" });
    }
    const passwordHash = await bcrypt.hash(passwordTrimmed, 10);
    const user = await prisma.user.create({ data: { email: emailNorm, passwordHash } });
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
    return res.status(201).json({ token, user: { id: user.id, email: user.email } });
  } catch (err: unknown) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code: string }).code : "";
    if (code === "P2002") {
      return res.status(400).json({ error: "An account with this email already exists" });
    }
    const msg = err instanceof Error ? err.message : "Registration failed";
    console.error("[auth/register]", err);
    return res.status(500).json({ error: msg });
  }
});

app.post("/auth/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }
    const emailNorm = (email as string).trim().toLowerCase();
    const passwordTrimmed = (password as string).trim();
    const user = await prisma.user.findUnique({ where: { email: emailNorm } });
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    if ((user as { loginDisabled?: boolean }).loginDisabled) {
      return res.status(403).json({ error: "Login disabled for this account. Contact your agency." });
    }
    const match = await bcrypt.compare(passwordTrimmed, user.passwordHash);
    if (!match) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Login failed";
    console.error("[auth/login]", err);
    return res.status(500).json({ error: msg });
  }
});

// ----- Agency: self-serve client management (agency users only) -----
function requireAgency(req: AuthRequest, res: Response, next: NextFunction): void {
  const type = req.user?.accountType ?? "single";
  if (type !== "agency") {
    res.status(403).json({ error: "Agency account required" });
    return;
  }
  next();
}

function makeTempPassword(): string {
  // 12 chars, URL-safe; good enough for a one-time temp credential.
  return crypto.randomBytes(9).toString("base64url");
}

app.get("/agency/clients", requireAuth, requireAgency, async (req: AuthRequest, res: Response) => {
  const list = await prisma.agencyClient.findMany({
    where: { agencyUserId: req.user!.id },
    include: { clientUser: { select: { id: true, email: true, loginDisabled: true, createdAt: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json({
    clients: list.map((c) => ({
      id: c.clientUser.id,
      email: c.clientUser.email,
      loginDisabled: c.clientUser.loginDisabled,
      createdAt: c.clientUser.createdAt.toISOString(),
    })),
  });
});

app.post("/agency/clients", requireAuth, requireAgency, async (req: AuthRequest, res: Response) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const allowLogin = req.body?.allowLogin === true;
  if (!email || email.length < 3 || !email.includes("@")) {
    return res.status(400).json({ error: "Body must include a valid email" });
  }
  if (email === req.user!.email.toLowerCase()) {
    return res.status(400).json({ error: "You cannot add yourself as a client" });
  }

  let client = await prisma.user.findUnique({ where: { email } });
  let tempPassword: string | undefined;

  if (!client) {
    const pw = makeTempPassword();
    tempPassword = allowLogin ? pw : undefined;
    const passwordHash = await bcrypt.hash(pw, 10);
    client = await prisma.user.create({
      data: {
        email,
        passwordHash,
        accountType: "single",
        loginDisabled: !allowLogin,
      },
    });
  } else {
    // If the user already exists and the agency wants to disable login, only allow if it's already disabled.
    const disabled = (client as { loginDisabled?: boolean }).loginDisabled ?? false;
    if (!allowLogin && !disabled) {
      return res.status(400).json({ error: "That email already has a login-enabled account. Ask them to use their existing login." });
    }
  }

  await prisma.agencyClient.upsert({
    where: { agencyUserId_clientUserId: { agencyUserId: req.user!.id, clientUserId: client.id } },
    create: { agencyUserId: req.user!.id, clientUserId: client.id },
    update: {},
  });

  res.status(201).json({
    client: { id: client.id, email: client.email, loginDisabled: (client as { loginDisabled?: boolean }).loginDisabled ?? false },
    ...(tempPassword ? { tempPassword } : {}),
  });
});

app.delete("/agency/clients/:clientUserId", requireAuth, requireAgency, async (req: AuthRequest, res: Response) => {
  const clientUserId = req.params.clientUserId;
  const deleted = await prisma.agencyClient.deleteMany({
    where: { agencyUserId: req.user!.id, clientUserId },
  });
  if (deleted.count === 0) return res.status(404).json({ error: "Client link not found" });
  res.json({ ok: true });
});

app.get("/auth/me", async (req: AuthRequest, res: Response) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Not logged in" });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: string; email: string };
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { agencyClients: { include: { clientUser: { select: { id: true, email: true } } } } },
    });
    if (!user) return res.status(401).json({ error: "User not found" });
    const accountType = (user as { accountType?: string }).accountType ?? "single";
    const clients =
      accountType === "agency"
        ? (user as { agencyClients?: { clientUser: { id: string; email: string } }[] }).agencyClients?.map((ac) => ({
            id: ac.clientUser.id,
            email: ac.clientUser.email,
          })) ?? []
        : undefined;
    res.json({
      user: { id: user.id, email: user.email },
      isAdmin: isAdmin(user.email),
      accountType,
      clients,
    });
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
});

function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.user || !isAdmin(req.user.email)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

// ----- Integrations: connect ad accounts (Meta, etc.) -----
app.get("/integrations", requireAuth, async (req: AuthRequest, res: Response) => {
  const uid = req.effectiveUserId ?? req.user!.id;
  const list = await prisma.connectedAccount.findMany({
    where: { userId: uid },
    select: { id: true, platform: true, platformAccountId: true, platformAccountName: true, createdAt: true },
  });
  res.json({ integrations: list.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })) });
});

// Start Meta OAuth: redirect user to Meta login. Call with ?token=JWT so we know the user (browser can't send Authorization on redirect).
// For agency: ?token=JWT&viewingAs=clientUserId stores the Meta token for that client.
app.get("/integrations/meta/connect", async (req: Request, res: Response) => {
  const tokenParam = (req.query.token as string) || "";
  const token = tokenParam.trim() || (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null);
  if (!token) {
    return res.status(401).send("Missing token. Log in and use the Connect Meta button from the Integrations page.");
  }
  let userId: string;
  const viewingAs = typeof req.query.viewingAs === "string" ? req.query.viewingAs.trim() : "";
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: string };
    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) return res.status(401).send("User not found");
    const accountType = (user as { accountType?: string }).accountType ?? "single";
    if (accountType === "agency" && viewingAs) {
      const allowed = await prisma.agencyClient.findFirst({
        where: { agencyUserId: user.id, clientUserId: viewingAs },
      });
      userId = allowed ? viewingAs : user.id;
    } else {
      userId = user.id;
    }
  } catch {
    return res.status(401).send("Invalid or expired token. Please log in again.");
  }
  if (!META_APP_ID || !META_APP_SECRET) {
    return res.status(503).send("Meta integration is not configured. Set META_APP_ID and META_APP_SECRET on the server.");
  }
  const backendUrl = process.env.BACKEND_URL || `http://localhost:${PORT}`;
  const redirectUri = `${backendUrl.replace(/\/$/, "")}/integrations/meta/callback`;
  // pages_show_list is needed so we can fetch a Page id for object_story_spec (required for link ad creatives).
  const scope = "ads_management,ads_read,business_management,pages_show_list";
  const state = userId;
  const metaAuthUrl = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${encodeURIComponent(META_APP_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}`;
  res.redirect(302, metaAuthUrl);
});

// Meta OAuth callback: exchange code for access token, store for user, redirect to frontend.
app.get("/integrations/meta/callback", async (req: Request, res: Response) => {
  const { code, state: userId, error: metaError } = req.query as { code?: string; state?: string; error?: string };
  const frontendBase = FRONTEND_URL;
  const redirectPath = "/";
  if (metaError || !code) {
    const err = metaError || "No authorization code received";
    res.redirect(302, `${frontendBase}${redirectPath}?error=${encodeURIComponent(err)}`);
    return;
  }
  const userMeta = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
  if (!userMeta) {
    res.redirect(302, `${frontendBase}${redirectPath}?error=${encodeURIComponent("Invalid state")}`);
    return;
  }
  if (!META_APP_ID || !META_APP_SECRET) {
    res.redirect(302, `${frontendBase}${redirectPath}?error=${encodeURIComponent("Meta not configured")}`);
    return;
  }
  const backendUrl = process.env.BACKEND_URL || `http://localhost:${PORT}`;
  const redirectUri = `${backendUrl.replace(/\/$/, "")}/integrations/meta/callback`;
  const tokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${encodeURIComponent(META_APP_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${encodeURIComponent(META_APP_SECRET)}&code=${encodeURIComponent(code)}`;
  try {
    const tokenRes = await axios.get<{ access_token: string; token_type?: string }>(tokenUrl);
    const accessToken = tokenRes.data?.access_token;
    if (!accessToken) {
      res.redirect(302, `${frontendBase}${redirectPath}?error=${encodeURIComponent("No token from Meta")}`);
      return;
    }
    const uid = userMeta.id;
    await prisma.connectedAccount.deleteMany({ where: { userId: uid, platform: "meta" } });
    await prisma.connectedAccount.create({
      data: { userId: uid, platform: "meta", accessToken },
    });
    res.redirect(302, `${frontendBase}${redirectPath}?connected=meta`);
  } catch (err: unknown) {
    let message = "Token exchange failed";
    if (err && typeof err === "object" && "response" in err) {
      const ax = err as { response?: { data?: { error?: { message?: string; type?: string } } } };
      const metaMsg = ax.response?.data?.error?.message;
      const metaType = ax.response?.data?.error?.type;
      if (metaMsg) message = metaType ? `${metaType}: ${metaMsg}` : metaMsg;
    } else if (err instanceof Error) {
      message = err.message;
    }
    console.error("[Meta callback]", message);
    res.redirect(302, `${frontendBase}${redirectPath}?error=${encodeURIComponent(message)}`);
  }
});

// ----- TikTok OAuth (Business / Marketing API) -----
// Start TikTok OAuth: redirect user to TikTok. Call with ?token=JWT.
app.get("/integrations/tiktok/connect", async (req: Request, res: Response) => {
  const tokenParam = (req.query.token as string) || "";
  const token = tokenParam.trim() || (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null);
  if (!token) {
    return res.status(401).send("Missing token. Log in and use the Connect TikTok button from the Integrations page.");
  }
  let userId: string;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: string };
    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) return res.status(401).send("User not found");
    userId = user.id;
  } catch {
    return res.status(401).send("Invalid or expired token. Please log in again.");
  }
  if (!TIKTOK_APP_ID || !TIKTOK_APP_SECRET) {
    return res.status(503).send("TikTok integration is not configured. Set TIKTOK_APP_ID and TIKTOK_APP_SECRET on the server.");
  }
  const backendUrl = process.env.BACKEND_URL || `http://localhost:${PORT}`;
  const redirectUri = `${backendUrl.replace(/\/$/, "")}/integrations/tiktok/callback`;
  const state = userId;
  // TikTok Business API auth URL (portal)
  const tiktokAuthUrl = `https://business-api.tiktok.com/portal/auth?app_id=${encodeURIComponent(TIKTOK_APP_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
  res.redirect(302, tiktokAuthUrl);
});

// TikTok OAuth callback: exchange auth_code for access token, store for user, redirect to frontend.
app.get("/integrations/tiktok/callback", async (req: Request, res: Response) => {
  const { auth_code: authCode, code, state: userId, error: tiktokError } = req.query as { auth_code?: string; code?: string; state?: string; error?: string };
  const frontendBase = FRONTEND_URL;
  const redirectPath = "/";
  const codeToUse = authCode || code;
  if (tiktokError || !codeToUse) {
    const err = tiktokError || "No authorization code received";
    res.redirect(302, `${frontendBase}${redirectPath}?error=${encodeURIComponent(String(err))}`);
    return;
  }
  const userTiktok = await prisma.user.findUnique({ where: { id: userId ?? "" } });
  if (!userTiktok) {
    res.redirect(302, `${frontendBase}${redirectPath}?error=${encodeURIComponent("Invalid state")}`);
    return;
  }
  if (!TIKTOK_APP_ID || !TIKTOK_APP_SECRET) {
    res.redirect(302, `${frontendBase}${redirectPath}?error=${encodeURIComponent("TikTok not configured")}`);
    return;
  }
  const backendUrl = process.env.BACKEND_URL || `http://localhost:${PORT}`;
  const redirectUri = `${backendUrl.replace(/\/$/, "")}/integrations/tiktok/callback`;
  try {
    const tokenRes = await axios.post<{ data?: { access_token?: string; refresh_token?: string; open_id?: string } }>(
      "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/",
      {
        app_id: TIKTOK_APP_ID,
        secret: TIKTOK_APP_SECRET,
        auth_code: codeToUse,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      },
      { headers: { "Content-Type": "application/json" } }
    );
    const data = tokenRes.data?.data;
    const accessToken = data?.access_token;
    if (!accessToken) {
      res.redirect(302, `${frontendBase}${redirectPath}?error=${encodeURIComponent("No token from TikTok")}`);
      return;
    }
    const refreshToken = data?.refresh_token;
    const openId = data?.open_id;
    const uid = userTiktok.id;
    await prisma.connectedAccount.deleteMany({ where: { userId: uid, platform: "tiktok" } });
    await prisma.connectedAccount.create({
      data: {
        userId: uid,
        platform: "tiktok",
        accessToken,
        ...(refreshToken && { refreshToken }),
        ...(openId && { platformAccountId: openId }),
      },
    });
    res.redirect(302, `${frontendBase}${redirectPath}?connected=tiktok`);
  } catch (err: unknown) {
    const msg = err && typeof err === "object" && "response" in err
      ? (err as { response?: { data?: { message?: string } } }).response?.data?.message
      : err instanceof Error ? err.message : "Token exchange failed";
    res.redirect(302, `${frontendBase}${redirectPath}?error=${encodeURIComponent(String(msg))}`);
  }
});

// ----- Google OAuth (Google Ads API) -----
const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

app.get("/integrations/google/connect", async (req: Request, res: Response) => {
  const tokenParam = (req.query.token as string) || "";
  const token = tokenParam.trim() || (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null);
  if (!token) {
    return res.status(401).send("Missing token. Log in and use the Connect Google button from the Integrations page.");
  }
  const viewingAs = typeof req.query.viewingAs === "string" ? req.query.viewingAs.trim() : "";
  let userId: string;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: string };
    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) return res.status(401).send("User not found");
    const accountType = (user as { accountType?: string }).accountType ?? "single";
    if (accountType === "agency" && viewingAs) {
      const allowed = await prisma.agencyClient.findFirst({
        where: { agencyUserId: user.id, clientUserId: viewingAs },
      });
      userId = allowed ? viewingAs : user.id;
    } else {
      userId = user.id;
    }
  } catch {
    return res.status(401).send("Invalid or expired token. Please log in again.");
  }
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(503).send("Google integration is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server.");
  }
  const backendUrl = process.env.BACKEND_URL || `http://localhost:${PORT}`;
  const redirectUri = `${backendUrl.replace(/\/$/, "")}/integrations/google/callback`;
  const state = userId;
  const authUrl =
    `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(GOOGLE_ADS_SCOPE)}` +
    `&state=${encodeURIComponent(state)}` +
    `&access_type=offline` +
    `&prompt=consent`;
  res.redirect(302, authUrl);
});

app.get("/integrations/google/callback", async (req: Request, res: Response) => {
  const { code, state: userId, error: googleError } = req.query as { code?: string; state?: string; error?: string };
  const frontendBase = FRONTEND_URL;
  const redirectPath = "/";
  if (googleError || !code) {
    const err = googleError || "No authorization code received";
    res.redirect(302, `${frontendBase}${redirectPath}?error=${encodeURIComponent(String(err))}`);
    return;
  }
  const userGoogle = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
  if (!userGoogle) {
    res.redirect(302, `${frontendBase}${redirectPath}?error=${encodeURIComponent("Invalid state")}`);
    return;
  }
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    res.redirect(302, `${frontendBase}${redirectPath}?error=${encodeURIComponent("Google not configured")}`);
    return;
  }
  const backendUrl = process.env.BACKEND_URL || `http://localhost:${PORT}`;
  const redirectUri = `${backendUrl.replace(/\/$/, "")}/integrations/google/callback`;
  try {
    const tokenRes = await axios.post<{ access_token?: string; refresh_token?: string }>(
      "https://oauth2.googleapis.com/token",
      new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const accessToken = tokenRes.data?.access_token;
    if (!accessToken) {
      res.redirect(302, `${frontendBase}${redirectPath}?error=${encodeURIComponent("No token from Google")}`);
      return;
    }
    const refreshToken = tokenRes.data?.refresh_token;
    const uid = userGoogle.id;
    await prisma.connectedAccount.deleteMany({ where: { userId: uid, platform: "google" } });
    await prisma.connectedAccount.create({
      data: { userId: uid, platform: "google", accessToken, ...(refreshToken && { refreshToken }) },
    });
    res.redirect(302, `${frontendBase}${redirectPath}?connected=google`);
  } catch (err: unknown) {
    const msg = err && typeof err === "object" && "response" in err
      ? (err as { response?: { data?: { error_description?: string } } }).response?.data?.error_description
      : err instanceof Error ? err.message : "Token exchange failed";
    res.redirect(302, `${frontendBase}${redirectPath}?error=${encodeURIComponent(String(msg || "Google token exchange failed"))}`);
  }
});

// Get Google Ads customer accounts (requires GOOGLE_ADS_DEVELOPER_TOKEN and connected Google OAuth).
app.get("/integrations/google/ad-accounts", requireAuth, async (req: AuthRequest, res: Response) => {
  const googleConn = await prisma.connectedAccount.findFirst({
    where: { userId: req.effectiveUserId ?? req.user!.id, platform: "google" },
  });
  if (!googleConn) {
    return res.status(404).json({ error: "Google not connected. Connect Google in Integrations first." });
  }
  if (!GOOGLE_ADS_DEVELOPER_TOKEN) {
    return res.status(503).json({
      error: "Google Ads API developer token is not configured. Set GOOGLE_ADS_DEVELOPER_TOKEN on the server to list ad accounts.",
    });
  }
  let accessToken = googleConn.accessToken;
  try {
    if (googleConn.refreshToken && GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
      accessToken = await refreshAndStoreGoogleAccessToken(
        prisma,
        googleConn,
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET
      );
    }
    const resAd = await axios.get<{ resourceNames?: string[] }>(
      "https://googleads.googleapis.com/v20/customers:listAccessibleCustomers",
      {
        headers: googleAdsApiHeaders(accessToken, GOOGLE_ADS_DEVELOPER_TOKEN),
      }
    );
    const resourceNames = resAd.data?.resourceNames || [];
    const adAccounts = resourceNames.map((rn) => {
      const id = rn.replace(/^customers\//, "");
      return { id, name: `Customer ${id}`, accountId: id };
    });
    return res.json({ adAccounts });
  } catch (err: unknown) {
    const msg = googleAdsApiErrorMessage(err);
    console.error("[Google ad-accounts]", msg);
    return res.status(502).json({ error: typeof msg === "string" ? msg : "Google Ads API error" });
  }
});

// Test Google Ads connection (token + developer token + list accessible customers).
app.get("/integrations/google/test", requireAuth, async (req: AuthRequest, res: Response) => {
  const uid = req.effectiveUserId ?? req.user!.id;
  const googleConn = await prisma.connectedAccount.findFirst({
    where: { userId: uid, platform: "google" },
  });
  if (!googleConn) {
    return res.status(400).json({ ok: false, error: "Google not connected. Connect Google in Integrations first." });
  }
  if (!GOOGLE_ADS_DEVELOPER_TOKEN) {
    return res.status(400).json({
      ok: false,
      error: "GOOGLE_ADS_DEVELOPER_TOKEN is not set on the server. Add it in Render (or .env) to use Google Ads API.",
    });
  }
  try {
    let accessToken = googleConn.accessToken;
    if (googleConn.refreshToken && GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
      accessToken = await refreshAndStoreGoogleAccessToken(
        prisma,
        googleConn,
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET
      );
    }
    const resAd = await axios.get<{ resourceNames?: string[] }>(
      "https://googleads.googleapis.com/v20/customers:listAccessibleCustomers",
      {
        headers: googleAdsApiHeaders(accessToken, GOOGLE_ADS_DEVELOPER_TOKEN),
      }
    );
    const n = resAd.data?.resourceNames?.length ?? 0;
    res.json({ ok: true, customerCount: n });
  } catch (err: unknown) {
    const msg = googleAdsApiErrorMessage(err);
    console.error("[Google test]", msg);
    res.status(502).json({ ok: false, error: msg });
  }
});

// Get TikTok ad accounts (advertisers) for the connected TikTok integration.
app.get("/integrations/tiktok/ad-accounts", requireAuth, async (req: AuthRequest, res: Response) => {
  const tiktokConn = await prisma.connectedAccount.findFirst({
    where: { userId: req.effectiveUserId ?? req.user!.id, platform: "tiktok" },
  });
  if (!tiktokConn) {
    return res.status(404).json({ error: "TikTok not connected. Connect TikTok in Integrations first." });
  }
  if (!TIKTOK_APP_ID || !TIKTOK_APP_SECRET) {
    return res.status(503).json({ error: "TikTok integration is not configured on the server." });
  }
  try {
    const url = "https://business-api.tiktok.com/open_api/v1.3/oauth2/advertiser/get/";
    const resAd = await axios.get<{ data?: { list?: Array<{ advertiser_id: string; advertiser_name: string }> } }>(url, {
      params: {
        app_id: TIKTOK_APP_ID,
        secret: TIKTOK_APP_SECRET,
        access_token: tiktokConn.accessToken,
      },
    });
    const list = resAd.data?.data?.list || [];
    res.json({
      adAccounts: list.map((a) => ({ id: a.advertiser_id, name: a.advertiser_name, accountId: a.advertiser_id })),
    });
  } catch (err: unknown) {
    const msg = err && typeof err === "object" && "response" in err
      ? (err as { response?: { data?: { message?: string } } }).response?.data?.message
      : err instanceof Error ? err.message : "Failed to fetch ad accounts";
    console.error("[TikTok ad-accounts]", msg);
    res.status(502).json({ error: typeof msg === "string" ? msg : "TikTok API error" });
  }
});

// List TikTok identities for an advertiser (needed to create ads — pick one in UI or we auto-pick).
app.get("/integrations/tiktok/identities", requireAuth, async (req: AuthRequest, res: Response) => {
  const advertiserId = typeof req.query.advertiser_id === "string" ? req.query.advertiser_id.trim() : "";
  if (!advertiserId) {
    return res.status(400).json({ error: "Query advertiser_id is required" });
  }
  const tiktokConn = await prisma.connectedAccount.findFirst({
    where: { userId: req.effectiveUserId ?? req.user!.id, platform: "tiktok" },
  });
  if (!tiktokConn) {
    return res.status(404).json({ error: "TikTok not connected. Connect TikTok in Integrations first." });
  }
  try {
    const list = await tiktokListIdentities(tiktokConn.accessToken, advertiserId);
    res.json({
      identities: list.map((i) => ({
        identityId: i.identity_id,
        identityType: i.identity_type,
        displayName: i.display_name ?? i.identity_id,
      })),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to list identities";
    console.error("[TikTok identities]", msg);
    return res.status(502).json({ error: msg });
  }
});

app.delete("/integrations/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const uid = req.effectiveUserId ?? req.user!.id;
  const conn = await prisma.connectedAccount.findFirst({ where: { id: req.params.id, userId: uid } });
  if (!conn) return res.status(404).json({ error: "Connection not found" });
  await prisma.connectedAccount.delete({ where: { id: conn.id } });
  res.json({ ok: true });
});

// ----- Creatives library (user uploads; can attach to campaigns) -----
app.get("/creatives", requireAuth, async (req: AuthRequest, res: Response) => {
  const uid = req.effectiveUserId ?? req.user!.id;
  const list = await prisma.creative.findMany({
    where: { userId: uid },
    select: { id: true, name: true, createdAt: true },
  });
  res.json({ creatives: list.map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt.toISOString() })) });
});

app.post("/creatives", requireAuth, async (req: AuthRequest, res: Response) => {
  const { name, imageData } = req.body;
  if (!name || typeof name !== "string" || !imageData || typeof imageData !== "string") {
    return res.status(400).json({ error: "name and imageData (base64 string) are required" });
  }
  const base64 = imageData.replace(/^data:image\/[a-z]+;base64,/, "").trim();
  if (!base64.length) return res.status(400).json({ error: "imageData must be a valid base64 image" });
  const uid = req.effectiveUserId ?? req.user!.id;
  const creative = await prisma.creative.create({
    data: {
      userId: uid,
      name: String(name).trim().slice(0, 200) || "Creative",
      imageData: base64,
    },
  });
  res.status(201).json({ id: creative.id, name: creative.name, createdAt: creative.createdAt.toISOString() });
});

app.delete("/creatives/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const uid = req.effectiveUserId ?? req.user!.id;
  const c = await prisma.creative.findFirst({ where: { id: req.params.id, userId: uid } });
  if (!c) return res.status(404).json({ error: "Creative not found" });
  await prisma.creative.delete({ where: { id: c.id } });
  res.json({ ok: true });
});

app.get("/creatives/:id/asset", requireAuth, async (req: AuthRequest, res: Response) => {
  const uid = req.effectiveUserId ?? req.user!.id;
  const c = await prisma.creative.findFirst({ where: { id: req.params.id, userId: uid } });
  if (!c) return res.status(404).json({ error: "Creative not found" });
  const buf = Buffer.from(c.imageData, "base64");
  res.setHeader("Content-Type", "image/png");
  res.send(buf);
});

// Get Meta ad accounts for the connected Meta integration (so we can show/use them for launching).
app.get("/integrations/meta/ad-accounts", requireAuth, async (req: AuthRequest, res: Response) => {
  const uid = req.effectiveUserId ?? req.user!.id;
  const metaConn = await prisma.connectedAccount.findFirst({
    where: { userId: uid, platform: "meta" },
  });
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

// Test Meta connection (token + ad account access). Use before launching to confirm integration works.
app.get("/integrations/meta/test", requireAuth, async (req: AuthRequest, res: Response) => {
  const uid = req.effectiveUserId ?? req.user!.id;
  const metaConn = await prisma.connectedAccount.findFirst({
    where: { userId: uid, platform: "meta" },
  });
  if (!metaConn) {
    return res.status(400).json({ ok: false, error: "Meta not connected. Connect Meta in Integrations first." });
  }
  try {
    const url = `https://graph.facebook.com/v21.0/me/adaccounts?fields=id&access_token=${encodeURIComponent(metaConn.accessToken)}`;
    const apiRes = await axios.get<{ data?: unknown[] }>(url);
    const count = Array.isArray(apiRes.data?.data) ? apiRes.data.data.length : 0;
    res.json({ ok: true, adAccountCount: count });
  } catch (err: unknown) {
    const msg = err && typeof err === "object" && "response" in err
      ? (err as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message
      : err instanceof Error ? err.message : "Meta API error";
    console.error("[Meta test]", msg);
    res.status(502).json({ ok: false, error: typeof msg === "string" ? msg : "Meta API error" });
  }
});

// ----- Experiments (auth required) -----
// List all experiments for the logged-in user (with variants and variantCount)
app.get("/experiments", requireAuth, async (req: AuthRequest, res: Response) => {
  const uid = req.effectiveUserId ?? req.user!.id;
  const list = await prisma.experiment.findMany({
    where: { userId: uid },
    include: { variants: { select: VARIANT_PUBLIC_SELECT } },
  });
  const allVIds = list.flatMap((e) => e.variants.map((v) => v.id));
  const withCreative = await variantIdsWithImageData(allVIds);
  res.json(list.map((e) => ({
    id: e.id,
    userId: e.userId,
    name: e.name,
    platform: e.platform,
    status: e.status,
    phase: e.phase,
    totalDailyBudget: e.totalDailyBudget,
    prompt: e.prompt ?? undefined,
    variantCount: e.variantCount ?? e.variants.length,
    creativesSource: e.creativesSource ?? undefined,
    aiProvider: e.aiProvider ?? undefined,
    aiCreativeCount: e.aiCreativeCount ?? undefined,
    creativePrompt: e.creativePrompt ?? undefined,
    targetAudiencePrompt: e.targetAudiencePrompt ?? undefined,
    campaignGroupId: e.campaignGroupId ?? undefined,
    metaCampaignId: e.metaCampaignId ?? undefined,
    metaAdSetId: e.metaAdSetId ?? undefined,
    tiktokCampaignId: e.tiktokCampaignId ?? undefined,
    tiktokAdGroupId: e.tiktokAdGroupId ?? undefined,
    googleCampaignId: e.googleCampaignId ?? undefined,
    googleAdGroupId: e.googleAdGroupId ?? undefined,
    aiOptimizationMode: e.aiOptimizationMode ?? undefined,
    attachedCreativeIds: e.attachedCreativeIds ?? undefined,
    variants: e.variants.map((v) => variantToJson(v, withCreative.has(v.id))),
  })));
});

// Get one experiment with its variants (must belong to user). Variants omit imageData; use GET .../creative for image.
app.get("/experiments/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const uid = req.effectiveUserId ?? req.user!.id;
  const exp = await prisma.experiment.findFirst({
    where: { id: req.params.id, userId: uid },
    include: { variants: { select: VARIANT_PUBLIC_SELECT } },
  });
  if (!exp) return res.status(404).json({ error: "Experiment not found" });
  const withCreativeOne = await variantIdsWithImageData(exp.variants.map((v) => v.id));
  res.json({
    id: exp.id,
    userId: exp.userId,
    name: exp.name,
    platform: exp.platform,
    status: exp.status,
    phase: exp.phase,
    totalDailyBudget: exp.totalDailyBudget,
    prompt: exp.prompt ?? undefined,
    variantCount: exp.variantCount ?? exp.variants.length,
    creativesSource: exp.creativesSource ?? undefined,
    aiProvider: exp.aiProvider ?? undefined,
    aiCreativeCount: exp.aiCreativeCount ?? undefined,
    creativePrompt: exp.creativePrompt ?? undefined,
    targetAudiencePrompt: exp.targetAudiencePrompt ?? undefined,
    campaignGroupId: exp.campaignGroupId ?? undefined,
    metaCampaignId: exp.metaCampaignId ?? undefined,
    metaAdSetId: exp.metaAdSetId ?? undefined,
    tiktokCampaignId: exp.tiktokCampaignId ?? undefined,
    tiktokAdGroupId: exp.tiktokAdGroupId ?? undefined,
    googleCampaignId: exp.googleCampaignId ?? undefined,
    googleAdGroupId: exp.googleAdGroupId ?? undefined,
    aiOptimizationMode: exp.aiOptimizationMode ?? undefined,
    attachedCreativeIds: exp.attachedCreativeIds ?? undefined,
    variants: exp.variants.map((v) => variantToJson(v, withCreativeOne.has(v.id))),
  });
});

// Update experiment (e.g. creative direction, target audience, AI optimization mode).
app.patch("/experiments/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const uid = req.effectiveUserId ?? req.user!.id;
  const exp = await prisma.experiment.findFirst({ where: { id: req.params.id, userId: uid } });
  if (!exp) return res.status(404).json({ error: "Experiment not found" });
  const creativePrompt =
    req.body?.creativePrompt !== undefined
      ? (typeof req.body.creativePrompt === "string" ? req.body.creativePrompt.trim() : null) || null
      : undefined;
  const targetAudiencePrompt =
    req.body?.targetAudiencePrompt !== undefined
      ? (typeof req.body.targetAudiencePrompt === "string" ? req.body.targetAudiencePrompt.trim() : null) || null
      : undefined;
  let aiOptimizationMode: string | undefined;
  if (req.body?.aiOptimizationMode !== undefined) {
    const raw = String(req.body.aiOptimizationMode).trim().toLowerCase();
    if (raw !== "off" && raw !== "suggestions" && raw !== "auto") {
      return res.status(400).json({ error: "aiOptimizationMode must be off, suggestions, or auto" });
    }
    aiOptimizationMode = raw;
  }
  const data: {
    creativePrompt?: string | null;
    targetAudiencePrompt?: string | null;
    aiOptimizationMode?: string;
  } = {};
  if (creativePrompt !== undefined) data.creativePrompt = creativePrompt || null;
  if (targetAudiencePrompt !== undefined) data.targetAudiencePrompt = targetAudiencePrompt || null;
  if (aiOptimizationMode !== undefined) data.aiOptimizationMode = aiOptimizationMode;
  if (Object.keys(data).length === 0) {
    return res.status(400).json({
      error:
        "Body must include at least one field to update (e.g. creativePrompt, targetAudiencePrompt, aiOptimizationMode)",
    });
  }
  const updated = await prisma.experiment.update({ where: { id: exp.id }, data });
  res.json({
    id: updated.id,
    name: updated.name,
    platform: updated.platform,
    status: updated.status,
    phase: updated.phase,
    totalDailyBudget: updated.totalDailyBudget,
    prompt: updated.prompt ?? undefined,
    creativesSource: updated.creativesSource ?? undefined,
    creativePrompt: updated.creativePrompt ?? undefined,
    targetAudiencePrompt: updated.targetAudiencePrompt ?? undefined,
    variantCount: exp.variantCount ?? undefined,
    aiProvider: updated.aiProvider ?? undefined,
    aiCreativeCount: updated.aiCreativeCount ?? undefined,
    campaignGroupId: updated.campaignGroupId ?? undefined,
    metaCampaignId: updated.metaCampaignId ?? undefined,
    metaAdSetId: updated.metaAdSetId ?? undefined,
    tiktokCampaignId: updated.tiktokCampaignId ?? undefined,
    tiktokAdGroupId: updated.tiktokAdGroupId ?? undefined,
    googleCampaignId: updated.googleCampaignId ?? undefined,
    googleAdGroupId: updated.googleAdGroupId ?? undefined,
    aiOptimizationMode: updated.aiOptimizationMode ?? undefined,
    attachedCreativeIds: updated.attachedCreativeIds ?? undefined,
  });
});

// Preview how a natural-language audience will be interpreted for Meta ad set targeting (no launch).
app.post("/experiments/:id/preview-meta-targeting", requireAuth, async (req: AuthRequest, res: Response) => {
  const uid = req.effectiveUserId ?? req.user!.id;
  const exp = await prisma.experiment.findFirst({ where: { id: req.params.id, userId: uid } });
  if (!exp) return res.status(404).json({ error: "Experiment not found" });
  if (exp.platform !== "meta") return res.status(400).json({ error: "Targeting preview is for Meta campaigns only." });
  const text = typeof req.body?.targetAudiencePrompt === "string" ? req.body.targetAudiencePrompt.trim() : "";
  if (!text) return res.status(400).json({ error: "targetAudiencePrompt is required" });
  const targeting = await buildMetaTargetingFromDescription(text);
  res.json({ targeting });
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

type AiProviderOption = "openai" | "anthropic" | "split";

function parseVariantsFromContent(content: string, count: number): string[] {
  let trimmed = content.trim();
  // Strip markdown code blocks (Anthropic often wraps JSON in ```json ... ```)
  const codeFence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/m);
  if (codeFence) trimmed = codeFence[1].trim();
  const innerBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (innerBlock) trimmed = innerBlock[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    const match = trimmed.match(/\[[\s\S]*\]/);
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

  const copies: string[] = [];
  for (let i = 0; i < count; i++) {
    const item = arr[i];
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const combined = extractCopyFromItem(item as Record<string, unknown>);
      copies.push(combined || `Variant ${i + 1} — AI returned no text`);
    } else if (typeof item === "string" && item.trim()) {
      copies.push(item.trim());
    } else {
      copies.push(`Variant ${i + 1} — no content`);
    }
  }
  return copies.length >= count ? copies : [...copies, ...Array(Math.max(0, count - copies.length)).fill("Variant (missing)")].slice(0, count);
}

const DEFAULT_META_TARGETING: Record<string, unknown> = { geo_locations: { countries: ["US"] } };

/** User-visible detail from Meta Graph / Marketing API errors (helps debug "Invalid parameter"). */
function metaMarketingApiErrorDetail(err: unknown): string {
  if (err && typeof err === "object" && "response" in err) {
    const ax = err as { response?: { data?: { error?: Record<string, unknown> } } };
    const e = ax.response?.data?.error;
    if (e && typeof e === "object") {
      const message = typeof e.message === "string" ? e.message : "";
      const userMsg = typeof e.error_user_msg === "string" ? e.error_user_msg : "";
      const userTitle = typeof e.error_user_title === "string" ? e.error_user_title : "";
      const subcode = e.error_subcode != null ? String(e.error_subcode) : "";
      const blame = e.blame_field_specs;
      const blameStr =
        blame == null ? "" : typeof blame === "string" ? blame : JSON.stringify(blame);
      const head = [message, userTitle, userMsg].filter((s) => s.trim()).join(" — ");
      const base = head || "Meta API error";
      const tail = [subcode && `subcode ${subcode}`, blameStr && blameStr !== "{}" && `fields ${blameStr}`]
        .filter(Boolean)
        .join("; ");
      return tail ? `${base} (${tail})` : base;
    }
  }
  return err instanceof Error ? err.message : "Meta API error";
}

type AiMetaTargetingShape = {
  countries?: string[];
  age_min?: number;
  age_max?: number;
  gender?: "all" | "male" | "female";
};

function clampMetaAge(n: unknown, def: number, min: number, max: number): number {
  const x = typeof n === "number" && !Number.isNaN(n) ? n : def;
  return Math.min(max, Math.max(min, Math.round(x)));
}

function targetingShapeToMetaObject(ai: AiMetaTargetingShape): Record<string, unknown> {
  const countries = Array.isArray(ai.countries) && ai.countries.length
    ? ai.countries
        .map((c) => String(c).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2))
        .filter((c) => c.length === 2)
    : [];
  const uniqCountries = [...new Set(countries)].slice(0, 25);
  const geo = uniqCountries.length ? { countries: uniqCountries } : { countries: ["US"] };
  const ageMin = clampMetaAge(ai.age_min, 25, 18, 65);
  let ageMax = clampMetaAge(ai.age_max, 54, 18, 65);
  if (ageMax < ageMin) ageMax = Math.min(65, ageMin + 20);
  let genders: number[] = [1, 2];
  if (ai.gender === "male") genders = [1];
  else if (ai.gender === "female") genders = [2];
  return {
    geo_locations: geo,
    age_min: ageMin,
    age_max: ageMax,
    genders,
  };
}

/** Convert natural-language audience description to Meta Marketing API targeting object (geo, age, gender). */
async function buildMetaTargetingFromDescription(description: string): Promise<Record<string, unknown>> {
  const trimmed = description.trim();
  if (!trimmed) return { ...DEFAULT_META_TARGETING };
  if (!OPENAI_API_KEY || OPENAI_API_KEY.length < 20) {
    return { ...DEFAULT_META_TARGETING };
  }
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You convert natural language ad audience descriptions into Meta (Facebook) ad set targeting parameters. " +
            "Return ONLY valid JSON with keys: countries (array of 2-letter ISO country codes, e.g. [\"US\"]), " +
            "age_min (integer 18-65), age_max (integer 18-65; use 65 when the audience is broad or older), " +
            "gender (\"all\" | \"male\" | \"female\"). If location is ambiguous, use [\"US\"]. If ages are missing, use 25-54.",
        },
        { role: "user", content: trimmed.slice(0, 2000) },
      ],
      response_format: { type: "json_object" },
    });
    const raw = (completion.choices[0]?.message?.content || "").trim();
    const parsed = JSON.parse(raw) as AiMetaTargetingShape;
    return targetingShapeToMetaObject(parsed);
  } catch (e) {
    console.error("[Meta targeting AI]", e);
    return { ...DEFAULT_META_TARGETING };
  }
}

async function generateWithOpenAI(prompt: string, platform: string, count: number): Promise<string[]> {
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

  const content = (completion.choices[0]?.message?.content || "").trim();
  return parseVariantsFromContent(content, count);
}

async function generateWithAnthropic(prompt: string, platform: string, count: number): Promise<string[]> {
  const systemPrompt =
    "You are an expert ad copywriter. You write NEW, original ad copy. " +
    "Never repeat or echo the user's idea text as the headline or body. " +
    "Output only valid JSON: a single object with key \"variants\" whose value is an array of objects. Each object must have \"headline\" and \"primaryText\" as strings. Do not wrap the JSON in markdown code blocks.";
  const userPrompt = buildVariantsFromOnePrompt(prompt, platform as AdPlatform, count);

  // claude-3-5-haiku-latest was retired; use current Haiku (alias tracks latest 4.5)
  const message = await anthropic!.messages.create({
    model: process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }]
  });

  const block = message.content.find((b) => b.type === "text");
  const content = block && block.type === "text" ? block.text : "";
  return parseVariantsFromContent(content, count);
}

/** Generate N ad copy variants. provider "split" = half OpenAI, half Anthropic (merged in order). */
async function generateVariantsFromPrompt(
  prompt: string,
  platform: string,
  count: number,
  provider: AiProviderOption = "openai"
): Promise<string[]> {
  if (provider === "split" && anthropic) {
    const half = Math.ceil(count / 2);
    const rest = count - half;
    let openaiCopies: string[];
    let anthropicCopies: string[];
    try {
      openaiCopies = await generateWithOpenAI(prompt, platform, half);
    } catch (err: any) {
      console.error("[AI] OpenAI half failed in split, retrying:", err?.message || err);
      openaiCopies = await generateWithOpenAI(prompt, platform, half);
    }
    try {
      anthropicCopies = await generateWithAnthropic(prompt, platform, rest);
    } catch (err: any) {
      console.error("[AI] Anthropic half failed in split, using OpenAI for rest:", err?.message || err);
      anthropicCopies = await generateWithOpenAI(prompt, platform, rest);
    }
    return [...openaiCopies, ...anthropicCopies];
  }

  if (provider === "anthropic" && anthropic) {
    try {
      return await generateWithAnthropic(prompt, platform, count);
    } catch (err: any) {
      console.error("[AI] Anthropic failed, falling back to OpenAI:", err?.message || err);
      return generateWithOpenAI(prompt, platform, count);
    }
  }

  return generateWithOpenAI(prompt, platform, count);
}

/** Copy library creative imageData onto variants after experiment create (own = all; mix = from slot N onward, N = AI creative count). */
async function copyLibraryCreativesToVariants(
  userId: string,
  experimentId: string,
  attachedCreativeIds: string[],
  source: "own" | "mix" | "ai",
  mixAiCreativeVariantCount: number | undefined
): Promise<void> {
  if (source === "ai" || attachedCreativeIds.length === 0) return;
  const creatives = await prisma.creative.findMany({
    where: { userId, id: { in: attachedCreativeIds } },
    select: { id: true, imageData: true },
  });
  const byId = new Map(creatives.map((c) => [c.id, c.imageData]));
  const orderedImages: string[] = [];
  for (const id of attachedCreativeIds) {
    const img = byId.get(id);
    if (img) orderedImages.push(img);
  }
  if (orderedImages.length === 0) return;

  const variants = await prisma.variant.findMany({
    where: { experimentId },
    orderBy: { index: "asc" },
    select: { id: true },
  });

  let aiSlots = 0;
  if (source === "mix") {
    const raw =
      typeof mixAiCreativeVariantCount === "number" && !Number.isNaN(mixAiCreativeVariantCount)
        ? Math.floor(mixAiCreativeVariantCount)
        : 0;
    aiSlots = Math.max(0, Math.min(variants.length, raw));
  }

  const updates: { id: string; imageData: string }[] = [];
  for (let i = 0; i < variants.length; i++) {
    if (source === "mix" && i < aiSlots) continue;
    const libIdx = source === "own" ? i : i - aiSlots;
    updates.push({
      id: variants[i].id,
      imageData: orderedImages[libIdx % orderedImages.length],
    });
  }
  if (updates.length === 0) return;
  await prisma.$transaction(
    updates.map((u) => prisma.variant.update({ where: { id: u.id }, data: { imageData: u.imageData } }))
  );
}

// Create one or more experiments (same campaign, one per platform when platforms[] has multiple)
app.post("/experiments", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const {
      name,
      platform: platformBody,
      platforms: platformsBody,
      totalDailyBudget,
      prompt,
      variantCount,
      creativesSource,
      aiProvider: aiProviderBody,
      creativePrompt: creativePromptBody,
      attachedCreativeIds: attachedCreativeIdsBody,
      mixAiCreativeVariantCount: mixAiCreativeVariantCountBody,
    } = req.body;

    const aiProvider: AiProviderOption =
      aiProviderBody === "anthropic" || aiProviderBody === "split" ? aiProviderBody : "openai";

    const platformsList: string[] =
      Array.isArray(platformsBody) && platformsBody.length > 0
        ? platformsBody.filter((p: string) => p === "meta" || p === "google" || p === "tiktok")
        : platformBody
          ? [platformBody]
          : [];

    if (!name || platformsList.length === 0 || typeof totalDailyBudget !== "number") {
      return res
        .status(400)
        .json({ error: "name, platform or platforms (array), and totalDailyBudget are required" });
    }

    const count = Math.min(20, Math.max(1, Number(variantCount) || 3));
    const source = creativesSource === "own" ? "own" : creativesSource === "mix" ? "mix" : "ai";
    const promptText =
      typeof prompt === "string" && prompt.trim()
        ? prompt.trim()
        : "Generate varied ad copy for this campaign.";
    const creativePrompt =
      typeof creativePromptBody === "string" && creativePromptBody.trim() ? creativePromptBody.trim() : undefined;
    /** Library creative ids are Prisma cuids (not a creative- prefix). */
    const attachedCreativeIds: string[] = Array.isArray(attachedCreativeIdsBody)
      ? attachedCreativeIdsBody
          .filter((id: unknown) => typeof id === "string" && String(id).trim().length > 0)
          .map((id: string) => id.trim())
      : [];
    const mixAiCreativeVariantCount =
      typeof mixAiCreativeVariantCountBody === "number" && !Number.isNaN(mixAiCreativeVariantCountBody)
        ? Math.floor(mixAiCreativeVariantCountBody)
        : undefined;

    const platformForAi = platformsList[0];

    let copies: string[];
    if (source === "own") {
      copies = Array.from({ length: count }, () => "");
    } else {
      try {
        copies = await generateVariantsFromPrompt(promptText, platformForAi, count, aiProvider);
      } catch (err: any) {
        console.error("AI variant generation failed", err?.message || err);
        copies = Array.from(
          { length: count },
          (_, i) => `Variant ${i + 1} — Ad copy (generation failed; use Regenerate to try again)`
        );
      }
    }

    const half = (source === "ai" || source === "mix") && aiProvider === "split" ? Math.ceil(count / 2) : 0;
    const createdExperimentIds: string[] = [];
    const campaignGroupId =
      platformsList.length > 1 ? `cg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}` : undefined;

    const uid = req.effectiveUserId ?? req.user!.id;
    for (const platform of platformsList) {
      const exp = await prisma.experiment.create({
        data: {
          userId: uid,
          name,
          platform,
          status: "draft",
          phase: "setup",
          totalDailyBudget: Number(totalDailyBudget),
          prompt: promptText,
          variantCount: count,
          creativesSource: source,
          ...((source === "ai" || source === "mix") && { aiProvider }),
          ...(creativePrompt && { creativePrompt }),
          ...(attachedCreativeIds.length > 0 && { attachedCreativeIds }),
          campaignGroupId: campaignGroupId ?? undefined,
          variants: {
            create: copies.map((copy, i) => {
              const text = typeof copy === "string" && copy.trim() ? copy.trim() : "";
              const fallback = source === "own" ? "Paste your ad copy here..." : `Variant ${i + 1} — Ad copy`;
              let aiSource: string | undefined;
              if ((source === "ai" || source === "mix") && aiProvider) {
                if (aiProvider === "openai") aiSource = "openai";
                else if (aiProvider === "anthropic") aiSource = "anthropic";
                else if (aiProvider === "split") aiSource = i < half ? "openai" : "anthropic";
              }
              return { index: i + 1, copy: text || fallback, status: "draft", ...(aiSource && { aiSource }) };
            }),
          },
        },
        include: { variants: { select: VARIANT_PUBLIC_SELECT } },
      });
      if (platformsList.length === 1) {
        await prisma.experiment.update({ where: { id: exp.id }, data: { campaignGroupId: exp.id } });
      }
      await copyLibraryCreativesToVariants(
        uid,
        exp.id,
        attachedCreativeIds,
        source,
        mixAiCreativeVariantCount
      );
      createdExperimentIds.push(exp.id);
    }

    const firstId = createdExperimentIds[0];
    const firstExp = await prisma.experiment.findUniqueOrThrow({
      where: { id: firstId },
      include: { variants: { select: VARIANT_PUBLIC_SELECT } },
    });
    const firstExpCreativeIds = await variantIdsWithImageData(firstExp.variants.map((v) => v.id));

    res.status(201).json({
      id: firstExp.id,
      userId: firstExp.userId,
      name: firstExp.name,
      platform: firstExp.platform,
      status: firstExp.status,
      phase: firstExp.phase,
      totalDailyBudget: firstExp.totalDailyBudget,
      prompt: firstExp.prompt ?? undefined,
      variantCount: firstExp.variantCount ?? firstExp.variants.length,
      creativesSource: firstExp.creativesSource ?? undefined,
      aiProvider: firstExp.aiProvider ?? undefined,
      creativePrompt: firstExp.creativePrompt ?? undefined,
      campaignGroupId: firstExp.campaignGroupId ?? undefined,
      metaCampaignId: firstExp.metaCampaignId ?? undefined,
      metaAdSetId: firstExp.metaAdSetId ?? undefined,
      tiktokCampaignId: firstExp.tiktokCampaignId ?? undefined,
      tiktokAdGroupId: firstExp.tiktokAdGroupId ?? undefined,
      googleCampaignId: firstExp.googleCampaignId ?? undefined,
      googleAdGroupId: firstExp.googleAdGroupId ?? undefined,
      aiOptimizationMode: firstExp.aiOptimizationMode ?? undefined,
      attachedCreativeIds: firstExp.attachedCreativeIds ?? undefined,
      variants: firstExp.variants.map((v) => variantToJson(v, firstExpCreativeIds.has(v.id))),
      createdExperimentIds,
    });
  } catch (err: unknown) {
    const code =
      err && typeof err === "object" && "code" in err ? String((err as { code: string }).code) : "";
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /experiments]", code || msg, msg);
    const schemaHint =
      /P20\d{2}|column|does not exist|relation|migration/i.test(msg)
        ? " Database schema may be out of date — run `npx prisma db push` (or migrate) against production."
        : "";
    return res.status(500).json({
      error: `Could not create campaign.${schemaHint ? ` ${schemaHint}` : ""}`,
      details: process.env.NODE_ENV === "production" ? undefined : msg,
    });
  }
});

// Update one variant's copy (Phase 2)
app.patch("/experiments/:experimentId/variants/:variantId", requireAuth, async (req: AuthRequest, res: Response) => {
  const { experimentId, variantId } = req.params;
  const { copy } = req.body;

  if (typeof copy !== "string") {
    return res.status(400).json({ error: "Body must include copy (string)" });
  }

  const uid = req.effectiveUserId ?? req.user!.id;
  const exp = await prisma.experiment.findFirst({ where: { id: experimentId, userId: uid } });
  if (!exp) return res.status(404).json({ error: "Experiment not found" });
  const variant = await prisma.variant.findFirst({ where: { id: variantId, experimentId } });
  if (!variant) return res.status(404).json({ error: "Variant not found" });
  const updated = await prisma.variant.update({ where: { id: variantId }, data: { copy } });
  res.json(variantToJson(updated, !!updated.imageData));
});

// Reorder variants by new index order. Body: { variantIds: string[] } (ids in desired order).
app.patch("/experiments/:experimentId/variants/reorder", requireAuth, async (req: AuthRequest, res: Response) => {
  const { experimentId } = req.params;
  const variantIds = req.body?.variantIds;
  if (!Array.isArray(variantIds) || variantIds.length === 0) {
    return res.status(400).json({ error: "Body must include variantIds (non-empty array)" });
  }
  const uid = req.effectiveUserId ?? req.user!.id;
  const exp = await prisma.experiment.findFirst({
    where: { id: experimentId, userId: uid },
    include: { variants: { select: { id: true } } },
  });
  if (!exp) return res.status(404).json({ error: "Experiment not found" });
  const expVariantIds = new Set(exp.variants.map((v) => v.id));
  for (const id of variantIds) {
    if (typeof id !== "string" || !expVariantIds.has(id)) {
      return res.status(400).json({ error: "variantIds must only contain variant ids belonging to this experiment" });
    }
  }
  await prisma.$transaction(
    variantIds.map((id, i) => prisma.variant.update({ where: { id }, data: { index: i + 1 } }))
  );
  const updated = await prisma.variant.findMany({
    where: { experimentId },
    orderBy: { index: "asc" },
    select: VARIANT_PUBLIC_SELECT,
  });
  const withCreativeReorder = await variantIdsWithImageData(updated.map((v) => v.id));
  res.json({ variants: updated.map((v) => variantToJson(v, withCreativeReorder.has(v.id))) });
});

// Swap creatives (imageData) between two variants. Body: { variantIdA: string, variantIdB: string }.
app.post("/experiments/:experimentId/variants/swap-creatives", requireAuth, async (req: AuthRequest, res: Response) => {
  const { experimentId } = req.params;
  const variantIdA = typeof req.body?.variantIdA === "string" ? req.body.variantIdA.trim() : undefined;
  const variantIdB = typeof req.body?.variantIdB === "string" ? req.body.variantIdB.trim() : undefined;
  if (!variantIdA || !variantIdB || variantIdA === variantIdB) {
    return res.status(400).json({ error: "Body must include variantIdA and variantIdB (two different variant ids)" });
  }
  const uid = req.effectiveUserId ?? req.user!.id;
  const exp = await prisma.experiment.findFirst({ where: { id: experimentId, userId: uid } });
  if (!exp) return res.status(404).json({ error: "Experiment not found" });
  const [va, vb] = await Promise.all([
    prisma.variant.findFirst({ where: { id: variantIdA, experimentId } }),
    prisma.variant.findFirst({ where: { id: variantIdB, experimentId } }),
  ]);
  if (!va || !vb) return res.status(404).json({ error: "One or both variants not found in this experiment" });
  const imageA = va.imageData;
  const imageB = vb.imageData;
  await prisma.$transaction([
    prisma.variant.update({ where: { id: variantIdA }, data: { imageData: imageB } }),
    prisma.variant.update({ where: { id: variantIdB }, data: { imageData: imageA } }),
  ]);
  const updated = await prisma.variant.findMany({
    where: { id: { in: [variantIdA, variantIdB] } },
    select: VARIANT_PUBLIC_SELECT,
  });
  const withCreativeSwap = await variantIdsWithImageData([variantIdA, variantIdB]);
  res.json({ variants: updated.map((v) => variantToJson(v, withCreativeSwap.has(v.id))) });
});

// Attach a library creative or raw upload (base64 / data URL) to a variant.
app.post("/experiments/:experimentId/variants/:variantId/set-creative", requireAuth, async (req: AuthRequest, res: Response) => {
  const { experimentId, variantId } = req.params;
  const creativeId = typeof req.body?.creativeId === "string" ? req.body.creativeId.trim() : undefined;
  const imageDataRaw = typeof req.body?.imageData === "string" ? req.body.imageData : undefined;
  if ((creativeId && imageDataRaw) || (!creativeId && !imageDataRaw)) {
    return res
      .status(400)
      .json({ error: "Provide exactly one of creativeId (library) or imageData (base64 or data URL)" });
  }
  const uid = req.effectiveUserId ?? req.user!.id;
  const exp = await prisma.experiment.findFirst({ where: { id: experimentId, userId: uid } });
  if (!exp) return res.status(404).json({ error: "Experiment not found" });
  const variant = await prisma.variant.findFirst({ where: { id: variantId, experimentId } });
  if (!variant) return res.status(404).json({ error: "Variant not found" });

  let imageData: string;
  if (creativeId) {
    const c = await prisma.creative.findFirst({ where: { id: creativeId, userId: uid } });
    if (!c) return res.status(404).json({ error: "Creative not found" });
    imageData = c.imageData;
  } else {
    imageData = imageDataRaw!.replace(/^data:image\/[a-z]+;base64,/, "").trim();
    if (!imageData.length) {
      return res.status(400).json({ error: "imageData must be a valid base64 image" });
    }
  }

  const updated = await prisma.variant.update({
    where: { id: variantId },
    data: { imageData },
    select: VARIANT_PUBLIC_SELECT,
  });
  res.json({ variant: variantToJson(updated, true) });
});

// Generate AI creative (image) for a variant using DALL-E. Stores base64 PNG on variant.
app.post("/experiments/:experimentId/variants/:variantId/generate-creative", requireAuth, async (req: AuthRequest, res: Response) => {
  const { experimentId, variantId } = req.params;
  const uid = req.effectiveUserId ?? req.user!.id;
  const exp = await prisma.experiment.findFirst({
    where: { id: experimentId, userId: uid },
    select: { id: true, creativePrompt: true },
  });
  if (!exp) return res.status(404).json({ error: "Experiment not found" });
  const variant = await prisma.variant.findFirst({
    where: { id: variantId, experimentId },
    select: { id: true, copy: true },
  });
  if (!variant) return res.status(404).json({ error: "Variant not found" });

  const copy = (variant.copy || "").trim().slice(0, 500);
  const userCreativeDirection = (exp.creativePrompt || "").trim().slice(0, 500);
  const imagePrompt =
    (userCreativeDirection ? `Creative direction: ${userCreativeDirection}. ` : "") +
    `Professional advertising image for a social media ad. Visual only, no text or words in the image. ` +
    `Style: clean, modern, high quality, suitable for Facebook or Instagram feed. ` +
    `Theme or mood inspired by: ${copy || "modern marketing"}.`;

  try {
    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: imagePrompt,
      n: 1,
      size: "1024x1024",
      response_format: "b64_json",
      quality: "standard",
    });
    const b64 = response.data?.[0]?.b64_json;
    if (!b64) {
      return res.status(500).json({ error: "No image data from AI" });
    }
    await prisma.variant.update({ where: { id: variantId }, data: { imageData: b64 } });
    res.json({ hasCreative: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Image generation failed";
    console.error("[generate-creative]", msg);
    res.status(500).json({ error: String(msg) });
  }
});

// Serve variant creative image (PNG). No auth on URL so img src works; variant is scoped by experiment ownership.
app.get("/experiments/:experimentId/variants/:variantId/creative", requireAuth, async (req: AuthRequest, res: Response) => {
  const { experimentId, variantId } = req.params;
  const uid = req.effectiveUserId ?? req.user!.id;
  const exp = await prisma.experiment.findFirst({ where: { id: experimentId, userId: uid } });
  if (!exp) return res.status(404).send();
  const variant = await prisma.variant.findFirst({ where: { id: variantId, experimentId }, select: { imageData: true } });
  if (!variant?.imageData) return res.status(404).send();
  const buf = Buffer.from(variant.imageData, "base64");
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(buf);
});

// Regenerate one variant's copy with AI (same prompt, new angle)
app.post("/experiments/:experimentId/variants/:variantId/regenerate", requireAuth, async (req: AuthRequest, res: Response) => {
  const { experimentId, variantId } = req.params;
  const uid = req.effectiveUserId ?? req.user!.id;
  const exp = await prisma.experiment.findFirst({ where: { id: experimentId, userId: uid } });
  if (!exp) return res.status(404).json({ error: "Experiment not found" });

  const variant = await prisma.variant.findFirst({ where: { id: variantId, experimentId } });
  if (!variant) return res.status(404).json({ error: "Variant not found" });

  const promptText = exp.prompt || "Generate a new, distinct ad copy variant.";
  try {
    const copies = await generateVariantsFromPrompt(promptText, exp.platform, 1);
    const newCopy = copies[0] || "";
    const updated = await prisma.variant.update({
      where: { id: variantId },
      data: { copy: newCopy, aiSource: "openai" },
    });
    res.json({ copy: newCopy, variant: variantToJson(updated, !!updated.imageData) });
  } catch (err: any) {
    console.error("Regenerate variant failed", err?.message || err);
    res.status(500).json({ error: "Failed to regenerate ad copy" });
  }
});

// Launch experiment (Phase 2). For Meta: pass metaAdAccountId (act_xxx) and optional landingPageUrl to create live campaign.
app.post("/experiments/:id/launch", requireAuth, async (req: AuthRequest, res: Response) => {
  const uid = req.effectiveUserId ?? req.user!.id;
  const exp = await prisma.experiment.findFirst({
    where: { id: req.params.id, userId: uid },
    include: { variants: true },
  });
  if (!exp) return res.status(404).json({ error: "Experiment not found" });
  const aiCreativeCount = req.body?.aiCreativeCount;
  const metaAdAccountId = typeof req.body?.metaAdAccountId === "string" ? req.body.metaAdAccountId.trim() : undefined;
  const googleAdsCustomerIdBody =
    typeof req.body?.googleAdsCustomerId === "string" ? req.body.googleAdsCustomerId.trim() : "";
  const googleAdsCustomerDigits = googleAdsCustomerIdBody.replace(/\D/g, "");
  const tiktokAdvertiserId =
    typeof req.body?.tiktokAdvertiserId === "string" ? req.body.tiktokAdvertiserId.trim() : undefined;
  const tiktokIdentityId =
    typeof req.body?.tiktokIdentityId === "string" ? req.body.tiktokIdentityId.trim() : undefined;
  const tiktokIdentityType =
    typeof req.body?.tiktokIdentityType === "string" ? req.body.tiktokIdentityType.trim() : undefined;
  const landingPageUrl = typeof req.body?.landingPageUrl === "string" && req.body.landingPageUrl.trim()
    ? req.body.landingPageUrl.trim()
    : "https://example.com";
  /** When true: create campaign on Meta but leave it PAUSED so you can verify in Ads Manager with no spend. */
  const dryRun = req.body?.dryRun === true;
  /** Optional: only launch these variant ids (must have imageData). If omitted, all variants with images are launched. */
  const variantIds =
    Array.isArray(req.body?.variantIds) && req.body.variantIds.length > 0
      ? (req.body.variantIds as string[]).filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim())
      : undefined;
  const targetAudienceOverride =
    typeof req.body?.targetAudiencePrompt === "string" && req.body.targetAudiencePrompt.trim()
      ? req.body.targetAudiencePrompt.trim()
      : undefined;
  const storedAudience = (exp.targetAudiencePrompt || "").trim();
  const audienceForTargeting = targetAudienceOverride ?? storedAudience;

  const data: {
    status: string;
    phase: string;
    aiCreativeCount?: number;
    metaCampaignId?: string;
    metaAdSetId?: string;
    tiktokCampaignId?: string;
    tiktokAdGroupId?: string;
    googleCampaignId?: string;
    googleAdGroupId?: string;
  } = {
    status: "launched",
    phase: "running",
  };
  if (typeof aiCreativeCount === "number" && aiCreativeCount >= 0) {
    data.aiCreativeCount = Math.min(aiCreativeCount, exp.variantCount ?? 20);
  }

  if (exp.platform === "meta" && metaAdAccountId) {
    const metaConn = await prisma.connectedAccount.findFirst({
      where: { userId: uid, platform: "meta" },
    });
    if (!metaConn) {
      return res.status(400).json({ error: "Meta not connected. Connect Meta in Integrations first." });
    }
    const adAccountId = metaAdAccountId.startsWith("act_") ? metaAdAccountId : `act_${metaAdAccountId}`;
    const token = metaConn.accessToken;

    if (!landingPageUrl || landingPageUrl === "https://example.com") {
      return res.status(400).json({
        error:
          "Enter a real landing page URL (https://…) where ad clicks should go. A Facebook Page is only for the ad identity; it is not the same as this website link.",
      });
    }
    try {
      new URL(landingPageUrl);
    } catch {
      return res.status(400).json({ error: "Landing page URL must be a full URL, e.g. https://yoursite.com/booking" });
    }
    if (!/^https:\/\//i.test(landingPageUrl)) {
      return res.status(400).json({ error: "Use an https:// URL for the landing page (Meta link ads require a valid secure URL)." });
    }

    try {
      // Meta ad creatives for link ads typically require a Page id in object_story_spec.
      // We fetch the first available Page the user can access.
      let pageId: string | null = null;
      try {
        const pageRes = await axios.get<{ data?: Array<{ id: string }> }>(
          `https://graph.facebook.com/v21.0/me/accounts?fields=id&limit=1&access_token=${encodeURIComponent(token)}`
        );
        pageId = pageRes.data?.data?.[0]?.id ?? null;
      } catch {
        pageId = null;
      }
      if (!pageId) {
        return res.status(400).json({
          error:
            "Meta needs a Facebook Page connected to create ad creatives. Ensure the Meta user has access to at least one Page, and reconnect Meta (we request pages_show_list permission).",
        });
      }

      const metaTargeting = audienceForTargeting
        ? await buildMetaTargetingFromDescription(audienceForTargeting)
        : { ...DEFAULT_META_TARGETING };

      // 1. Create Campaign (ad set has daily_budget, so not CBO — Meta requires explicit is_adset_budget_sharing_enabled)
      const campaignRes = await axios.post<{ id: string }>(
        `https://graph.facebook.com/v21.0/${adAccountId}/campaigns`,
        null,
        {
          params: {
            name: exp.name.slice(0, 200),
            objective: "OUTCOME_TRAFFIC",
            status: "PAUSED",
            special_ad_categories: "[]",
            is_adset_budget_sharing_enabled: "false",
            access_token: token,
          },
        }
      );
      const campaignId = campaignRes.data?.id;
      if (!campaignId) {
        throw new Error("Meta did not return campaign id");
      }
      data.metaCampaignId = campaignId;

      // 2. Create Ad Set (daily_budget in cents). Link lives on creatives; promoted_object+link here often triggers vague "Invalid parameter".
      const budgetCents = Math.round(exp.totalDailyBudget * 100);
      const adSetRes = await axios.post<{ id: string }>(
        `https://graph.facebook.com/v21.0/${adAccountId}/adsets`,
        null,
        {
          params: {
            name: `${exp.name} - Ad Set`.slice(0, 200),
            campaign_id: campaignId,
            daily_budget: String(budgetCents),
            billing_event: "IMPRESSIONS",
            optimization_goal: "LINK_CLICKS",
            destination_type: "WEBSITE",
            targeting: JSON.stringify(metaTargeting),
            status: "PAUSED",
            access_token: token,
          },
        }
      );
      const adSetId = adSetRes.data?.id;
      if (!adSetId) {
        throw new Error("Meta did not return ad set id");
      }
      data.metaAdSetId = adSetId;

      // 3. Upload images and create creatives + ads for each variant that has image (and is in variantIds if provided)
      const variantIdSet = variantIds ? new Set(variantIds) : null;
      const variantsWithImage = exp.variants.filter(
        (v) => v.imageData && (!variantIdSet || variantIdSet.has(v.id))
      );
      if (variantsWithImage.length === 0) {
        return res.status(400).json({
          error: variantIds
            ? "No selected variants have creatives. Generate images for at least one selected variant, or leave all selected to launch every variant with an image."
            : "No variants have creatives yet. Generate creatives for at least one variant before launching.",
        });
      }
      data.aiCreativeCount = variantsWithImage.length;
      for (let i = 0; i < variantsWithImage.length; i++) {
        const v = variantsWithImage[i];
        const imageBase64 = (v.imageData || "").replace(/^data:image\/[a-z]+;base64,/, "");
        if (!imageBase64) continue;
        const imageRes = await axios.post<{ images?: Record<string, { hash: string }> }>(
          `https://graph.facebook.com/v21.0/${adAccountId}/adimages`,
          new URLSearchParams({ bytes: imageBase64, access_token: token }).toString(),
          {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
          }
        );
        const hash = imageRes.data?.images && Object.values(imageRes.data.images)[0]?.hash;
        if (!hash) continue;

        const objectStorySpec = JSON.stringify({
          page_id: pageId,
          link_data: {
            image_hash: hash,
            link: landingPageUrl,
            message: (v.copy || "").slice(0, 1250),
            name: (exp.name + ` - Variant ${i + 1}`).slice(0, 40),
            // Meta rejects many link ads without value.link on the CTA ("Invalid parameter").
            call_to_action: { type: "LEARN_MORE", value: { link: landingPageUrl } },
          },
        });

        const creativeRes = await axios.post<{ id: string }>(
          `https://graph.facebook.com/v21.0/${adAccountId}/adcreatives`,
          null,
          {
            params: {
              name: `${exp.name} - Creative ${i + 1}`.slice(0, 200),
              object_story_spec: objectStorySpec,
              access_token: token,
            },
          }
        );
        const creativeId = creativeRes.data?.id;
        if (!creativeId) continue;

        await axios.post(`https://graph.facebook.com/v21.0/${adAccountId}/ads`, null, {
          params: {
            name: `${exp.name} - Ad ${i + 1}`.slice(0, 200),
            adset_id: adSetId,
            creative: JSON.stringify({ creative_id: creativeId }),
            status: "PAUSED",
            access_token: token,
          },
        });
      }

      // If we created at least one ad and this is not a dry run, set campaign and ad set to ACTIVE so it goes live
      if (variantsWithImage.length > 0 && !dryRun) {
        await axios.post(
          `https://graph.facebook.com/v21.0/${campaignId}`,
          null,
          { params: { status: "ACTIVE", access_token: token } }
        );
        await axios.post(
          `https://graph.facebook.com/v21.0/${adSetId}`,
          null,
          { params: { status: "ACTIVE", access_token: token } }
        );
      }
    } catch (err: unknown) {
      const msg = metaMarketingApiErrorDetail(err);
      const full =
        err && typeof err === "object" && "response" in err
          ? (err as { response?: { data?: unknown } }).response?.data
          : undefined;
      console.error("[Meta launch]", msg, full ? JSON.stringify(full) : "");
      return res.status(502).json({ error: msg });
    }
  }

  if (exp.platform === "tiktok" && tiktokAdvertiserId) {
    if (!landingPageUrl || landingPageUrl === "https://example.com") {
      return res.status(400).json({
        error: "Enter a real landing page URL for TikTok (required for website traffic ads).",
      });
    }
    const tiktokConn = await prisma.connectedAccount.findFirst({
      where: { userId: uid, platform: "tiktok" },
    });
    if (!tiktokConn) {
      return res.status(400).json({ error: "TikTok not connected. Connect TikTok in Integrations first." });
    }
    const variantIdSetTt = variantIds ? new Set(variantIds) : null;
    const variantsWithImageTt = exp.variants.filter(
      (v) => v.imageData && (!variantIdSetTt || variantIdSetTt.has(v.id))
    );
    if (variantsWithImageTt.length === 0) {
      return res.status(400).json({
        error: variantIds
          ? "No selected variants have creatives. Generate images for at least one selected variant."
          : "No variants have creatives yet. Generate creatives for at least one variant before launching.",
      });
    }
    data.aiCreativeCount = variantsWithImageTt.length;
    try {
      const ttResult = await launchTikTokCampaign({
        accessToken: tiktokConn.accessToken,
        advertiserId: tiktokAdvertiserId,
        campaignName: exp.name,
        dailyBudget: exp.totalDailyBudget,
        landingPageUrl,
        dryRun,
        identityId: tiktokIdentityId,
        identityType: tiktokIdentityType,
        variants: variantsWithImageTt.map((v, i) => ({
          title: `${exp.name} - ${i + 1}`.slice(0, 100),
          adText: (v.copy || "").replace(/\n/g, " ").trim() || `${exp.name} — variant ${i + 1}`,
          imagePngBase64: (v.imageData || "").replace(/^data:image\/[a-z]+;base64,/, ""),
        })),
      });
      data.tiktokCampaignId = ttResult.campaignId;
      data.tiktokAdGroupId = ttResult.adGroupId;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "TikTok API error";
      console.error("[TikTok launch]", msg);
      return res.status(502).json({ error: msg });
    }
  }

  if (exp.platform === "google" && googleAdsCustomerDigits.length >= 6) {
    if (!GOOGLE_ADS_DEVELOPER_TOKEN) {
      return res.status(503).json({
        error: "Google Ads API is not configured. Set GOOGLE_ADS_DEVELOPER_TOKEN on the server.",
      });
    }
    if (!landingPageUrl || landingPageUrl === "https://example.com") {
      return res.status(400).json({
        error: "Enter a real landing page URL for Google Ads (required for your ad final URLs).",
      });
    }
    const googleConn = await prisma.connectedAccount.findFirst({
      where: { userId: uid, platform: "google" },
    });
    if (!googleConn) {
      return res.status(400).json({ error: "Google not connected. Connect Google in Integrations first." });
    }
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.status(400).json({ error: "Google OAuth is not configured on the server." });
    }
    const variantIdSetG = variantIds ? new Set(variantIds) : null;
    const variantsWithImageG = exp.variants.filter(
      (v) => v.imageData && (!variantIdSetG || variantIdSetG.has(v.id))
    );
    if (variantsWithImageG.length === 0) {
      return res.status(400).json({
        error: variantIds
          ? "No selected variants have creatives. Generate or attach images for at least one selected variant."
          : "No variants have creatives yet. Add creatives before launching.",
      });
    }
    data.aiCreativeCount = variantsWithImageG.length;
    try {
      let accessToken = googleConn.accessToken;
      if (googleConn.refreshToken) {
        accessToken = await refreshAndStoreGoogleAccessToken(
          prisma,
          googleConn,
          GOOGLE_CLIENT_ID,
          GOOGLE_CLIENT_SECRET
        );
      }
      const businessName = exp.name.slice(0, 25) || "Advertiser";
      const gg = await launchGoogleDisplayCampaign({
        customerIdDigits: googleAdsCustomerDigits,
        accessToken,
        developerToken: GOOGLE_ADS_DEVELOPER_TOKEN,
        campaignName: exp.name.slice(0, 200),
        dailyBudgetUsd: exp.totalDailyBudget,
        finalUrl: landingPageUrl,
        businessName,
        experimentName: exp.name,
        variants: variantsWithImageG.map((v) => ({
          copy: (v.copy || "").trim(),
          imageBase64: (v.imageData || "").replace(/^data:image\/[a-z]+;base64,/, ""),
        })),
        dryRun,
      });
      data.googleCampaignId = gg.campaignId;
      data.googleAdGroupId = gg.adGroupId;
    } catch (err: unknown) {
      const msg = googleAdsApiErrorMessage(err);
      console.error("[Google launch]", msg);
      return res.status(502).json({ error: msg });
    }
  }

  const updated = await prisma.experiment.update({ where: { id: exp.id }, data });
  const payload: Record<string, unknown> = { ...updated, aiProvider: updated.aiProvider ?? undefined, creativePrompt: updated.creativePrompt ?? undefined, campaignGroupId: updated.campaignGroupId ?? undefined, attachedCreativeIds: updated.attachedCreativeIds ?? undefined };
  if (exp.platform === "meta" && metaAdAccountId && dryRun) payload.dryRun = true;
  if (exp.platform === "tiktok" && tiktokAdvertiserId && dryRun) payload.dryRun = true;
  if (exp.platform === "google" && googleAdsCustomerDigits.length >= 6 && dryRun) payload.dryRun = true;
  res.json(payload);
});

// Campaign metrics: full Meta-style metrics for dashboard. From Meta when we have metaCampaignId.
interface CampaignMetricsResponse {
  spend: number;
  impressions: number;
  reach: number;
  frequency: number;
  cpm: number;
  clicks: number;
  ctr: number;
  cpc: number;
  linkClicks: number;
  conversions: number;
  costPerConversion: number;
  source: "placeholder" | "meta";
  datePreset?: string;
}

function parseNum(value: unknown): number {
  if (typeof value === "number" && !Number.isNaN(value)) return value;
  if (typeof value === "string") {
    const n = parseFloat(value);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

/** Parse Meta actions array for conversion count (e.g. offsite_conversion.fb_pixel_purchase) */
function parseConversionsFromActions(actions: unknown): number {
  if (!Array.isArray(actions)) return 0;
  let total = 0;
  for (const a of actions) {
    if (a && typeof a === "object" && "action_type" in a) {
      const type = (a as { action_type?: string }).action_type;
      if (type && (type.includes("conversion") || type.includes("purchase") || type.includes("lead"))) {
        total += parseNum((a as { value?: unknown }).value);
      }
    }
  }
  return total;
}

const placeholderMetrics: CampaignMetricsResponse = {
  spend: 0,
  impressions: 0,
  reach: 0,
  frequency: 0,
  cpm: 0,
  clicks: 0,
  ctr: 0,
  cpc: 0,
  linkClicks: 0,
  conversions: 0,
  costPerConversion: 0,
  source: "placeholder",
};

/** Fetch Meta insights for a campaign; used by metrics route and admin aggregation. */
async function fetchMetaMetrics(
  metaCampaignId: string,
  accessToken: string
): Promise<Omit<CampaignMetricsResponse, "source" | "datePreset"> | null> {
  try {
    const fields = "spend,impressions,reach,frequency,cpm,clicks,ctr,cpc,inline_link_clicks,actions";
    const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(metaCampaignId)}/insights?fields=${fields}&date_preset=last_7d&access_token=${encodeURIComponent(accessToken)}`;
    const apiRes = await axios.get<{ data?: Array<Record<string, unknown>> }>(url);
    const insights = apiRes.data?.data;
    const row = Array.isArray(insights) && insights.length > 0 ? insights[0] : null;
    if (!row) return null;
    const spend = parseNum(row.spend);
    const impressions = parseNum(row.impressions);
    const reach = parseNum(row.reach);
    const frequency = parseNum(row.frequency);
    const cpm = parseNum(row.cpm);
    const clicks = parseNum(row.clicks);
    const ctr = parseNum(row.ctr);
    const cpc = parseNum(row.cpc);
    const linkClicks = parseNum(row.inline_link_clicks);
    const conversions = parseConversionsFromActions(row.actions);
    const costPerConversion = conversions > 0 ? spend / conversions : 0;
    return {
      spend,
      impressions,
      reach,
      frequency,
      cpm,
      clicks,
      ctr,
      cpc,
      linkClicks,
      conversions,
      costPerConversion,
    };
  } catch (err: unknown) {
    const msg = err && typeof err === "object" && "response" in err
      ? (err as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message
      : err instanceof Error ? err.message : "Meta API error";
    console.error("[Meta metrics]", msg);
    return null;
  }
}

/** Live Meta metrics when linked; other platforms return placeholders until native reporting is integrated. */
async function getResolvedCampaignMetrics(
  uid: string,
  exp: { status: string; platform: string; metaCampaignId: string | null }
): Promise<CampaignMetricsResponse> {
  if (exp.status !== "launched") {
    return { ...placeholderMetrics };
  }
  if (exp.platform === "meta" && exp.metaCampaignId) {
    const metaConn = await prisma.connectedAccount.findFirst({
      where: { userId: uid, platform: "meta" },
    });
    if (metaConn) {
      const m = await fetchMetaMetrics(exp.metaCampaignId, metaConn.accessToken);
      if (m) return { ...m, source: "meta", datePreset: "last_7d" };
    }
  }
  return { ...placeholderMetrics };
}

app.get("/experiments/:id/metrics", requireAuth, async (req: AuthRequest, res: Response) => {
  const uid = req.effectiveUserId ?? req.user!.id;
  const exp = await prisma.experiment.findFirst({ where: { id: req.params.id, userId: uid } });
  if (!exp) {
    return res.status(404).json({ error: "Campaign not found" });
  }
  if (exp.status !== "launched") {
    return res.status(400).json({ error: "Campaign is not launched" });
  }
  const metrics = await getResolvedCampaignMetrics(uid, exp);
  return res.json(metrics);
});

// AI reads latest metrics (all platforms; live data where available) and returns suggestions. Mode "auto" may apply Meta ad-set budget only.
app.post("/experiments/:id/ai-performance-insights", requireAuth, async (req: AuthRequest, res: Response) => {
  if (!OPENAI_API_KEY || OPENAI_API_KEY.length < 20) {
    return res.status(503).json({ error: "OpenAI is not configured for AI performance insights." });
  }
  const uid = req.effectiveUserId ?? req.user!.id;
  const exp = await prisma.experiment.findFirst({ where: { id: req.params.id, userId: uid } });
  if (!exp) return res.status(404).json({ error: "Campaign not found" });
  if (exp.status !== "launched") {
    return res.status(400).json({ error: "Campaign must be launched to analyze performance." });
  }

  const metrics = await getResolvedCampaignMetrics(uid, exp);
  const mode = (exp.aiOptimizationMode || "off").toLowerCase();

  const systemPrompt =
    "You are a senior performance marketer. Analyze the JSON campaign snapshot for the given ad platform (meta, google, or tiktok). " +
    "If metrics are mostly zero or the data source is placeholder, state clearly that in-app data is limited and the user should verify spend and delivery in the native ad manager — still give 2–3 platform-appropriate optimization ideas. " +
    "Do not invent specific numbers that are not implied by the data. " +
    'Respond with ONLY valid JSON (no markdown) in this exact shape: {"summary":"one short paragraph","suggestions":["..."],"recommendedDailyBudget": number or null}. ' +
    "Rules for recommendedDailyBudget (USD, total daily budget for this campaign): " +
    "Use null unless you have meaningful performance signals (e.g. Meta live metrics with real spend). " +
    "If you do suggest a number, keep it within ±25% of totalDailyBudgetUsd when adjusting. " +
    "For Google Ads or TikTok when metrics are placeholder, always use null.";

  const userPayload = {
    platform: exp.platform,
    campaignName: exp.name,
    totalDailyBudgetUsd: exp.totalDailyBudget,
    variantCount: exp.variantCount,
    optimizationMode: mode,
    metricsSource: metrics.source,
    metrics,
  };

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
      response_format: { type: "json_object" },
    });
    const raw = completion.choices[0]?.message?.content || "{}";
    let parsed: { summary?: string; suggestions?: unknown; recommendedDailyBudget?: unknown };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      return res.status(502).json({ error: "AI returned invalid JSON" });
    }

    const summary = typeof parsed.summary === "string" ? parsed.summary : "";
    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    const recRaw = parsed.recommendedDailyBudget;
    const rec =
      typeof recRaw === "number" && !Number.isNaN(recRaw) && recRaw > 0 ? recRaw : null;

    let budgetAutoApplied = false;
    let budgetNote: string | undefined;
    let newTotalDailyBudget: number | undefined;

    if (mode === "auto" && rec != null) {
      if (exp.platform !== "meta" || !exp.metaAdSetId) {
        budgetNote =
          "Automatic budget updates are only available for Meta campaigns with a linked ad set. Use Google Ads or TikTok Ads Manager to change budgets for those platforms.";
      } else {
        const cur = exp.totalDailyBudget;
        const low = Math.max(1, Math.round(cur * 0.75 * 100) / 100);
        const high = Math.max(low, Math.round(cur * 1.25 * 100) / 100);
        const next = Math.max(low, Math.min(rec, high));
        const metaConn = await prisma.connectedAccount.findFirst({
          where: { userId: uid, platform: "meta" },
        });
        if (!metaConn) {
          budgetNote = "Meta is not connected; budget was not changed.";
        } else {
          try {
            const budgetCents = Math.round(next * 100);
            const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(exp.metaAdSetId)}?daily_budget=${budgetCents}&access_token=${encodeURIComponent(metaConn.accessToken)}`;
            await axios.post(url);
            await prisma.experiment.update({
              where: { id: exp.id },
              data: { totalDailyBudget: next },
            });
            budgetAutoApplied = true;
            newTotalDailyBudget = next;
            budgetNote = `Meta ad set daily budget updated to $${next}/day (clamped between $${low} and $${high} from prior $${cur}/day).`;
          } catch (err: unknown) {
            const msg =
              err && typeof err === "object" && "response" in err
                ? (err as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message
                : err instanceof Error
                  ? err.message
                  : "Meta API error";
            budgetNote = typeof msg === "string" ? `Meta budget update failed: ${msg}` : "Meta budget update failed.";
          }
        }
      }
    } else if (mode === "suggestions") {
      budgetNote =
        "Suggestions only — change optimization mode to Auto to allow Meta ad-set budget updates when the AI recommends a budget.";
    } else if (mode === "off") {
      budgetNote =
        "Mode is Off — suggestions above are informational only. Use Suggestions or Auto if you want Meta budget recommendations or automatic Meta budget updates on each review.";
    }

    return res.json({
      summary,
      suggestions,
      recommendedDailyBudget: rec,
      budgetAutoApplied,
      budgetNote,
      metricsSource: metrics.source,
      platform: exp.platform,
      ...(newTotalDailyBudget != null && { newTotalDailyBudget }),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "AI insights failed";
    console.error("[ai-performance-insights]", msg);
    return res.status(500).json({ error: msg });
  }
});

// Campaign adjustments: update status (pause/activate) or daily budget on Meta. Require metaCampaignId (and metaAdSetId for budget).
app.patch("/experiments/:id/campaign-status", requireAuth, async (req: AuthRequest, res: Response) => {
  const uid = req.effectiveUserId ?? req.user!.id;
  const exp = await prisma.experiment.findFirst({ where: { id: req.params.id, userId: uid } });
  if (!exp) {
    return res.status(404).json({ error: "Campaign not found" });
  }
  const status = req.body?.status === "PAUSED" || req.body?.status === "ACTIVE" ? req.body.status : null;
  if (!status) {
    return res.status(400).json({ error: "Body must include status: 'ACTIVE' or 'PAUSED'" });
  }
  if (!exp.metaCampaignId) {
    return res.status(400).json({ error: "Campaign is not linked to Meta. Launch to Meta first." });
  }
  const metaConn = await prisma.connectedAccount.findFirst({ where: { userId: uid, platform: "meta" } });
  if (!metaConn) {
    return res.status(400).json({ error: "Meta not connected. Connect Meta in Integrations." });
  }
  try {
    const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(exp.metaCampaignId)}?status=${status}&access_token=${encodeURIComponent(metaConn.accessToken)}`;
    await axios.post(url);
    return res.json({ ok: true, status });
  } catch (err: unknown) {
    const msg = err && typeof err === "object" && "response" in err
      ? (err as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message
      : err instanceof Error ? err.message : "Meta API error";
    console.error("[Meta campaign-status]", msg);
    return res.status(502).json({ error: typeof msg === "string" ? msg : "Meta API error" });
  }
});

app.patch("/experiments/:id/campaign-budget", requireAuth, async (req: AuthRequest, res: Response) => {
  const uid = req.effectiveUserId ?? req.user!.id;
  const exp = await prisma.experiment.findFirst({ where: { id: req.params.id, userId: uid } });
  if (!exp) {
    return res.status(404).json({ error: "Campaign not found" });
  }
  const dailyBudget = typeof req.body?.dailyBudget === "number" ? req.body.dailyBudget : null;
  if (dailyBudget == null || dailyBudget < 1) {
    return res.status(400).json({ error: "Body must include dailyBudget (number, min 1)" });
  }
  if (!exp.metaAdSetId) {
    return res.status(400).json({ error: "Campaign has no linked Meta ad set. Launch to Meta first." });
  }
  const metaConn = await prisma.connectedAccount.findFirst({ where: { userId: uid, platform: "meta" } });
  if (!metaConn) {
    return res.status(400).json({ error: "Meta not connected. Connect Meta in Integrations." });
  }
  try {
    const budgetCents = Math.round(dailyBudget * 100);
    const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(exp.metaAdSetId)}?daily_budget=${budgetCents}&access_token=${encodeURIComponent(metaConn.accessToken)}`;
    await axios.post(url);
    return res.json({ ok: true, dailyBudget });
  } catch (err: unknown) {
    const msg = err && typeof err === "object" && "response" in err
      ? (err as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message
      : err instanceof Error ? err.message : "Meta API error";
    console.error("[Meta campaign-budget]", msg);
    return res.status(502).json({ error: typeof msg === "string" ? msg : "Meta API error" });
  }
});

// ----- Admin: user list, account type, agency clients (only for ADMIN_EMAILS) -----
app.get("/admin/users", requireAuth, requireAdmin, async (_req: AuthRequest, res: Response) => {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, accountType: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  res.json({
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      accountType: (u as { accountType?: string }).accountType ?? "single",
      createdAt: u.createdAt.toISOString(),
    })),
  });
});

app.patch("/admin/users/:id", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  const accountType = req.body?.accountType;
  if (accountType !== "single" && accountType !== "agency") {
    return res.status(400).json({ error: "Body must include accountType: 'single' or 'agency'" });
  }
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: "User not found" });
  await prisma.user.update({
    where: { id: req.params.id },
    data: { accountType },
  });
  res.json({ ok: true, accountType });
});

app.get("/admin/agencies/:userId/clients", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  const agencyUserId = req.params.userId;
  const clients = await prisma.agencyClient.findMany({
    where: { agencyUserId },
    include: { clientUser: { select: { id: true, email: true } } },
  });
  res.json({
    clients: clients.map((c) => ({ id: c.clientUserId, email: c.clientUser.email })),
  });
});

app.post("/admin/agencies/:userId/clients", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  const agencyUserId = req.params.userId;
  const clientUserId = req.body?.clientUserId ?? (typeof req.body?.email === "string" ? null : null);
  let resolvedClientId: string;
  if (clientUserId && typeof clientUserId === "string") {
    resolvedClientId = clientUserId.trim();
  } else if (typeof req.body?.email === "string" && req.body.email.trim()) {
    const client = await prisma.user.findUnique({ where: { email: req.body.email.trim().toLowerCase() } });
    if (!client) return res.status(404).json({ error: "No user found with that email" });
    resolvedClientId = client.id;
  } else {
    return res.status(400).json({ error: "Body must include clientUserId or email" });
  }
  if (resolvedClientId === agencyUserId) {
    return res.status(400).json({ error: "Agency cannot add themselves as a client" });
  }
  const agency = await prisma.user.findUnique({ where: { id: agencyUserId } });
  if (!agency) return res.status(404).json({ error: "Agency user not found" });
  await prisma.agencyClient.upsert({
    where: {
      agencyUserId_clientUserId: { agencyUserId, clientUserId: resolvedClientId },
    },
    create: { agencyUserId, clientUserId: resolvedClientId },
    update: {},
  });
  const clientUser = await prisma.user.findUnique({ where: { id: resolvedClientId }, select: { id: true, email: true } });
  res.status(201).json({ client: { id: resolvedClientId, email: clientUser?.email ?? "" } });
});

app.delete("/admin/agencies/:userId/clients/:clientUserId", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { userId: agencyUserId, clientUserId } = req.params;
  const deleted = await prisma.agencyClient.deleteMany({
    where: { agencyUserId, clientUserId },
  });
  if (deleted.count === 0) return res.status(404).json({ error: "Client link not found" });
  res.json({ ok: true });
});

// ----- Admin: extra metrics and AI performance (only for ADMIN_EMAILS) -----
app.get("/admin/overview", requireAuth, requireAdmin, async (_req: AuthRequest, res: Response) => {
  const [totalUsers, experimentsList] = await Promise.all([
    prisma.user.count(),
    prisma.experiment.findMany(),
  ]);
  const launched = experimentsList.filter((e) => e.status === "launched");
  const byPlatform: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const e of experimentsList) {
    byPlatform[e.platform] = (byPlatform[e.platform] || 0) + 1;
    byStatus[e.status] = (byStatus[e.status] || 0) + 1;
  }
  res.json({
    totalUsers,
    totalCampaigns: experimentsList.length,
    launchedCampaigns: launched.length,
    byPlatform,
    byStatus,
    funnel: { created: experimentsList.length, launched: launched.length },
  });
});

app.get("/admin/ai-performance", requireAuth, requireAdmin, async (_req: AuthRequest, res: Response) => {
  type ProviderKey = "openai" | "anthropic" | "split";
  const agg: Record<
    ProviderKey,
    { campaigns: number; spend: number; impressions: number; clicks: number; conversions: number; ctrSum: number; cpcSum: number }
  > = {
    openai: { campaigns: 0, spend: 0, impressions: 0, clicks: 0, conversions: 0, ctrSum: 0, cpcSum: 0 },
    anthropic: { campaigns: 0, spend: 0, impressions: 0, clicks: 0, conversions: 0, ctrSum: 0, cpcSum: 0 },
    split: { campaigns: 0, spend: 0, impressions: 0, clicks: 0, conversions: 0, ctrSum: 0, cpcSum: 0 },
  };

  const launchedWithAi = await prisma.experiment.findMany({
    where: { status: "launched", platform: "meta", metaCampaignId: { not: null }, aiProvider: { not: null } },
  });

  for (const exp of launchedWithAi) {
    const metaConn = await prisma.connectedAccount.findFirst({ where: { userId: exp.userId, platform: "meta" } });
    if (!metaConn || !exp.metaCampaignId) continue;
    const m = await fetchMetaMetrics(exp.metaCampaignId, metaConn.accessToken);
    const provider = (exp.aiProvider || "openai") as ProviderKey;
    if (!agg[provider]) agg[provider] = { campaigns: 0, spend: 0, impressions: 0, clicks: 0, conversions: 0, ctrSum: 0, cpcSum: 0 };
    agg[provider].campaigns += 1;
    if (m) {
      agg[provider].spend += m.spend;
      agg[provider].impressions += m.impressions;
      agg[provider].clicks += m.clicks;
      agg[provider].conversions += m.conversions;
      agg[provider].ctrSum += m.ctr;
      agg[provider].cpcSum += m.cpc;
    }
  }

  const byProvider = Object.fromEntries(
    (["openai", "anthropic", "split"] as const).map((key) => {
      const a = agg[key];
      const campaigns = a.campaigns;
      const avgCtr = campaigns > 0 ? a.ctrSum / campaigns : 0;
      const avgCpc = campaigns > 0 ? a.cpcSum / campaigns : 0;
      return [
        key,
        {
          campaigns,
          spend: Math.round(a.spend * 100) / 100,
          impressions: a.impressions,
          clicks: a.clicks,
          conversions: a.conversions,
          avgCtr: Math.round(avgCtr * 10000) / 100,
          avgCpc: Math.round(avgCpc * 100) / 100,
        },
      ];
    })
  );

  res.json({ byProvider });
});

process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err);
});
process.on("unhandledRejection", (reason, p) => {
  console.error("[FATAL] unhandledRejection:", reason, p);
});

async function start() {
  if (process.env.NODE_OPTIONS) {
    console.log("[NODE] NODE_OPTIONS=" + process.env.NODE_OPTIONS);
  }
  if (!process.env.DATABASE_URL?.trim()) {
    console.error("[FATAL] DATABASE_URL is required. Add it to .env (e.g. PostgreSQL from Render, Neon, or Supabase).");
    process.exit(1);
  }
  try {
    await prisma.$connect();
    console.log("[DB] Connected to database.");
  } catch (err) {
    console.error("[FATAL] Database connection failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
  });
}

start();
