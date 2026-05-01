import express, { Request, Response, NextFunction, Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import dns from "dns/promises";
import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { enabledProductKeysFromDb, userHasProduct } from "./productEntitlements";
import {
  runCompetitorScanForWatch,
  resolveCompetitorFacebookPageInput,
  resolveCompetitorFacebookPageInputEx,
  discoverFacebookPageFromCompetitorWebsite,
  discoverMetaAdvertiserPagesFromAdLibrarySearch,
  resolveMetaAdLibraryIdToPageId,
  executeMetaHarvestRun,
  buildMetaHarvestBrandReport,
  buildMetaHarvestLandscapeReport,
  resolveMetaSnapshotPreview,
} from "./competitorIntel";
import {
  appendHarvestIntentSnippet,
  attachHarvestAdRelevanceScores,
  loadHarvestRankingScoreContext,
  parseHarvestKeywordStrings,
  recordHarvestSelectionsFromAds,
  suggestRankingKeywordsFromIntent,
} from "./harvestRankingLearning";

const JWT_SECRET = (process.env.JWT_SECRET || "change-me-in-production").trim();
export const EXPANSION_UPLOADS_ROOT = path.resolve(
  process.cwd(),
  (process.env.UPLOADS_PATH || "uploads").replace(/^\.\//, "")
);
const UPLOADS_ROOT = EXPANSION_UPLOADS_ROOT;
const BRANDING_DIR = path.join(UPLOADS_ROOT, "branding");

function ensureUploadDirs(): void {
  for (const d of [UPLOADS_ROOT, BRANDING_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}
ensureUploadDirs();

export interface ExpansionAuthRequest extends Request {
  user?: { id: string; email: string; accountType?: string };
  effectiveUserId?: string;
  file?: Express.Multer.File;
}

function apiErr(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: true, code, message });
}

async function expansionRequireAuth(
  req: ExpansionAuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    apiErr(res, 401, "UNAUTHORIZED", "Authentication required");
    return;
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: string; email: string };
    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) {
      apiErr(res, 401, "UNAUTHORIZED", "User not found");
      return;
    }
    const accountType = user.accountType ?? "single";
    req.user = { id: user.id, email: user.email, accountType };
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
    apiErr(res, 401, "UNAUTHORIZED", "Invalid or expired token");
  }
}

function requireAgency(req: ExpansionAuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.accountType !== "agency") {
    apiErr(res, 403, "FORBIDDEN", "Agency account required");
    return;
  }
  next();
}

const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

function requireSuperAdmin(req: ExpansionAuthRequest, res: Response, next: NextFunction): void {
  if (!req.user?.email || !ADMIN_EMAILS.has(req.user.email.toLowerCase())) {
    apiErr(res, 403, "FORBIDDEN", "Super admin required");
    return;
  }
  next();
}

function skipHarvestLearning(req: ExpansionAuthRequest): boolean {
  const email = req.user?.email?.toLowerCase().trim();
  return !!(email && ADMIN_EMAILS.has(email));
}

async function maybeRecordHarvestAdSelections(opts: {
  skipLearning: boolean;
  agencyId: string;
  clientId: string;
  adLibraryIds: string[];
}): Promise<void> {
  if (opts.skipLearning || opts.adLibraryIds.length === 0) return;
  const ads = await prisma.metaAdHarvestAd.findMany({
    where: {
      adLibraryId: { in: opts.adLibraryIds },
      run: { agencyId: opts.agencyId, clientId: opts.clientId },
    },
    select: { facebookPageId: true, headline: true, bodyText: true },
  });
  await recordHarvestSelectionsFromAds({
    agencyId: opts.agencyId,
    clientId: opts.clientId,
    ads,
  });
}

/** Gate expansion modules by User.enabledProductKeys (admin emails bypass). */
function expansionRequireProduct(productKey: string) {
  return async (req: ExpansionAuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      apiErr(res, 401, "UNAUTHORIZED", "Authentication required");
      return;
    }
    const email = req.user.email?.toLowerCase().trim();
    if (email && ADMIN_EMAILS.has(email)) {
      next();
      return;
    }
    try {
      const row = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { enabledProductKeys: true },
      });
      const keys = enabledProductKeysFromDb(row?.enabledProductKeys);
      if (!userHasProduct(keys, productKey)) {
        apiErr(
          res,
          403,
          "PRODUCT_DISABLED",
          "This feature is not enabled for your account. Ask your administrator to enable it in Admin."
        );
        return;
      }
    } catch (e) {
      console.error("[expansionRequireProduct]", e);
      apiErr(res, 500, "SERVER_ERROR", "Could not verify product access");
      return;
    }
    next();
  };
}

function brandingUploader(prefix: string) {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, BRANDING_DIR),
      filename: (req, file, cb) => {
        const uid = (req as ExpansionAuthRequest).user!.id;
        const ext = path.extname(file.originalname).slice(0, 12) || ".bin";
        cb(null, `${uid}-${prefix}-${Date.now()}${ext}`);
      },
    }),
    limits: { fileSize: 3 * 1024 * 1024 },
  });
}
const uploadLogo = brandingUploader("logo");
const uploadFavicon = brandingUploader("favicon");

function backendPublicBase(req: Request): string {
  const fromEnv = (process.env.BACKEND_URL || "").replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  return `${req.protocol}://${req.get("host")}`;
}

function brandingFilePublicUrl(req: Request, filename: string): string {
  return `${backendPublicBase(req)}/uploads/branding/${filename}`;
}

function sanitizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split(":")[0];
}

/** Attach verified white-label branding by Host header (for downstream handlers). */
export async function attachBrandingHost(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const host = (req.get("host") || "").split(":")[0].toLowerCase();
    if (host) {
      const b = await prisma.agencyBranding.findFirst({
        where: { customDomain: host, customDomainVerified: true },
        select: {
          brandName: true,
          logoUrl: true,
          faviconUrl: true,
          primaryColor: true,
          secondaryColor: true,
          accentColor: true,
          supportEmail: true,
          supportUrl: true,
          hidePoweredBy: true,
          onboardingWelcomeMessage: true,
        },
      });
      (req as ExpansionAuthRequest & { hostBranding?: typeof b }).hostBranding = b;
    }
  } catch (e) {
    console.error("[attachBrandingHost]", e);
  }
  next();
}

function harvestReportFromInsightRow(row: {
  status: string;
  summary: string | null;
  competitorDisplayName: string | null;
  adsUsed: number | null;
  adsConsidered: number | null;
  adsExcluded: number | null;
  topThemes: unknown;
  suggestedCounterAngles: unknown;
  strongestAds: unknown;
  competitivePack: unknown;
  rawPromptUsed: string | null;
  scanNotes: unknown;
}):
  | {
      competitorDisplayName: string;
      adsUsed: number;
      adsConsidered?: number;
      adsExcluded?: number;
      summary: string;
      topThemes: unknown;
      suggestedCounterAngles: unknown;
      strongestAds: unknown;
      competitivePack: unknown;
      rawPromptUsed: string | null;
      scanNotes: string[];
    }
  | null {
  if (row.status !== "completed" || row.summary == null || row.competitorDisplayName == null || row.adsUsed == null) {
    return null;
  }
  const notes = Array.isArray(row.scanNotes)
    ? row.scanNotes.filter((x): x is string => typeof x === "string")
    : [];
  return {
    competitorDisplayName: row.competitorDisplayName,
    adsUsed: row.adsUsed,
    adsConsidered: row.adsConsidered ?? undefined,
    adsExcluded: row.adsExcluded ?? undefined,
    summary: row.summary,
    topThemes: row.topThemes ?? [],
    suggestedCounterAngles: row.suggestedCounterAngles ?? [],
    strongestAds: row.strongestAds ?? [],
    competitivePack: row.competitivePack ?? null,
    rawPromptUsed: row.rawPromptUsed,
    scanNotes: notes,
  };
}

function jsonHarvestInsight(row: {
  id: string;
  agencyId: string;
  clientId: string;
  kind: string;
  title: string | null;
  harvestRunId: string | null;
  facebookPageIds: unknown;
  excludePhrases: unknown;
  strictFilter: boolean;
  topicHint: string | null;
  competitorDisplayName: string | null;
  adsUsed: number | null;
  adsConsidered: number | null;
  adsExcluded: number | null;
  summary: string | null;
  topThemes: unknown;
  suggestedCounterAngles: unknown;
  strongestAds: unknown;
  competitivePack: unknown;
  rawPromptUsed: string | null;
  scanNotes: unknown;
  status: string;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}) {
  return {
    id: row.id,
    agencyId: row.agencyId,
    clientId: row.clientId,
    kind: row.kind,
    title: row.title,
    harvestRunId: row.harvestRunId,
    facebookPageIds: row.facebookPageIds ?? null,
    excludePhrases: row.excludePhrases ?? null,
    strictFilter: row.strictFilter,
    topicHint: row.topicHint,
    competitorDisplayName: row.competitorDisplayName,
    adsUsed: row.adsUsed,
    adsConsidered: row.adsConsidered,
    adsExcluded: row.adsExcluded,
    status: row.status,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    report: harvestReportFromInsightRow(row),
  };
}

async function persistCompletedHarvestInsight(params: {
  agencyId: string;
  clientId: string;
  kind: string;
  title: string | null;
  harvestRunId?: string | null;
  facebookPageIds?: string[];
  excludePhrases: string[];
  strictFilter: boolean;
  topicHint?: string | null;
  report: {
    competitorDisplayName: string;
    adsUsed: number;
    adsConsidered?: number;
    adsExcluded?: number;
    summary: string;
    topThemes: Prisma.InputJsonValue;
    suggestedCounterAngles: Prisma.InputJsonValue;
    strongestAds: Prisma.InputJsonValue;
    competitivePack: Prisma.InputJsonValue | null;
    rawPromptUsed: string | null;
    scanNotes: string[];
  };
}) {
  return prisma.metaHarvestInsight.create({
    data: {
      agencyId: params.agencyId,
      clientId: params.clientId,
      kind: params.kind,
      title: params.title,
      harvestRunId: params.harvestRunId ?? null,
      facebookPageIds:
        params.facebookPageIds?.length && params.kind === "brand"
          ? (params.facebookPageIds as unknown as Prisma.InputJsonValue)
          : undefined,
      excludePhrases: params.excludePhrases.length ? params.excludePhrases : undefined,
      strictFilter: params.strictFilter,
      topicHint: params.topicHint ?? null,
      competitorDisplayName: params.report.competitorDisplayName,
      adsUsed: params.report.adsUsed,
      adsConsidered: params.report.adsConsidered ?? null,
      adsExcluded: params.report.adsExcluded ?? null,
      summary: params.report.summary,
      topThemes: params.report.topThemes as Prisma.InputJsonValue,
      suggestedCounterAngles: params.report.suggestedCounterAngles as Prisma.InputJsonValue,
      strongestAds: params.report.strongestAds as Prisma.InputJsonValue,
      competitivePack: params.report.competitivePack ?? Prisma.JsonNull,
      rawPromptUsed: params.report.rawPromptUsed,
      scanNotes: params.report.scanNotes as unknown as Prisma.InputJsonValue,
      status: "completed",
      completedAt: new Date(),
    },
  });
}

function scheduleLandscapeHarvestInsightJob(
  insightId: string,
  agencyId: string,
  clientId: string,
  params: {
    harvestRunId?: string;
    topicHint?: string;
    excludePhrases: string[];
    strictRelevanceFilter: boolean;
    adLibraryIds?: string[];
    skipLearning?: boolean;
  }
): void {
  void (async () => {
    try {
      const report = await buildMetaHarvestLandscapeReport({
        agencyId,
        clientId,
        harvestRunId: params.harvestRunId,
        topicHint: params.topicHint,
        excludePhrases: params.excludePhrases.length ? params.excludePhrases : undefined,
        strictRelevanceFilter: params.strictRelevanceFilter,
        adLibraryIds: params.adLibraryIds?.length ? params.adLibraryIds : undefined,
      });
      await prisma.metaHarvestInsight.update({
        where: { id: insightId, agencyId, clientId },
        data: {
          status: "completed",
          completedAt: new Date(),
          competitorDisplayName: report.competitorDisplayName,
          adsUsed: report.adsUsed,
          adsConsidered: report.adsConsidered ?? null,
          adsExcluded: report.adsExcluded ?? null,
          summary: report.summary,
          topThemes: report.topThemes as Prisma.InputJsonValue,
          suggestedCounterAngles: report.suggestedCounterAngles as Prisma.InputJsonValue,
          strongestAds: report.strongestAds as Prisma.InputJsonValue,
          competitivePack: report.competitivePack ?? Prisma.JsonNull,
          rawPromptUsed: report.rawPromptUsed,
          scanNotes: report.scanNotes as unknown as Prisma.InputJsonValue,
          errorMessage: null,
        },
      });
      if (!params.skipLearning && params.adLibraryIds?.length) {
        await maybeRecordHarvestAdSelections({
          skipLearning: false,
          agencyId,
          clientId,
          adLibraryIds: params.adLibraryIds,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 2000) : "Could not finish report.";
      console.error("[meta-harvest-insight landscape job]", insightId, e);
      await prisma.metaHarvestInsight
        .update({
          where: { id: insightId, agencyId, clientId },
          data: {
            status: "failed",
            completedAt: new Date(),
            errorMessage: msg,
          },
        })
        .catch(() => {});
    }
  })();
}

function scheduleBrandHarvestInsightJob(
  insightId: string,
  agencyId: string,
  clientId: string,
  params: {
    facebookPageIds: string[];
    adLibraryIds?: string[];
    competitorDisplayName?: string;
    keywords?: string[];
    excludePhrases: string[];
    strictRelevanceFilter: boolean;
    skipLearning?: boolean;
  }
): void {
  void (async () => {
    try {
      const report = await buildMetaHarvestBrandReport({
        agencyId,
        clientId,
        facebookPageIds: params.facebookPageIds.length ? params.facebookPageIds : undefined,
        adLibraryIds: params.adLibraryIds?.length ? params.adLibraryIds : undefined,
        competitorDisplayName: params.competitorDisplayName,
        keywords: params.keywords,
        excludePhrases: params.excludePhrases.length ? params.excludePhrases : undefined,
        strictRelevanceFilter: params.strictRelevanceFilter,
      });
      await prisma.metaHarvestInsight.update({
        where: { id: insightId, agencyId, clientId },
        data: {
          status: "completed",
          completedAt: new Date(),
          competitorDisplayName: report.competitorDisplayName,
          adsUsed: report.adsUsed,
          adsConsidered: report.adsConsidered ?? null,
          adsExcluded: report.adsExcluded ?? null,
          summary: report.summary,
          topThemes: report.topThemes as Prisma.InputJsonValue,
          suggestedCounterAngles: report.suggestedCounterAngles as Prisma.InputJsonValue,
          strongestAds: report.strongestAds as Prisma.InputJsonValue,
          competitivePack: report.competitivePack ?? Prisma.JsonNull,
          rawPromptUsed: report.rawPromptUsed,
          scanNotes: report.scanNotes as unknown as Prisma.InputJsonValue,
          errorMessage: null,
        },
      });
      if (!params.skipLearning && params.adLibraryIds?.length) {
        await maybeRecordHarvestAdSelections({
          skipLearning: false,
          agencyId,
          clientId,
          adLibraryIds: params.adLibraryIds,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 2000) : "Could not finish report.";
      console.error("[meta-harvest-insight brand job]", insightId, e);
      await prisma.metaHarvestInsight
        .update({
          where: { id: insightId, agencyId, clientId },
          data: {
            status: "failed",
            completedAt: new Date(),
            errorMessage: msg,
          },
        })
        .catch(() => {});
    }
  })();
}

export function createExpansionRouter(): Router {
  const r = Router();

  r.get("/resolve-brand", async (req, res) => {
    try {
      const raw = typeof req.query.domain === "string" ? req.query.domain : "";
      const domain = sanitizeDomain(raw);
      if (!domain) {
        return apiErr(res, 400, "VALIDATION", "domain query parameter is required");
      }
      const row = await prisma.agencyBranding.findFirst({
        where: { customDomain: domain, customDomainVerified: true },
      });
      if (!row) {
        return res.json({ branding: null });
      }
      return res.json({
        branding: {
          brandName: row.brandName,
          logoUrl: row.logoUrl,
          faviconUrl: row.faviconUrl,
          primaryColor: row.primaryColor,
          secondaryColor: row.secondaryColor,
          accentColor: row.accentColor,
          supportEmail: row.supportEmail,
          supportUrl: row.supportUrl,
          hidePoweredBy: row.hidePoweredBy,
          onboardingWelcomeMessage: row.onboardingWelcomeMessage,
        },
      });
    } catch (e) {
      console.error("[resolve-brand]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not resolve branding");
    }
  });

  r.get("/agency/branding", expansionRequireAuth, expansionRequireProduct("white_label"), requireAgency, async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const row = await prisma.agencyBranding.findUnique({ where: { userId: req.user!.id } });
      return res.json({ branding: row });
    } catch (e) {
      console.error("[GET /agency/branding]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not load branding");
    }
  });

  r.put("/agency/branding", expansionRequireAuth, expansionRequireProduct("white_label"), requireAgency, async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const b = req.body || {};
      const brandName =
        typeof b.brandName === "string" && b.brandName.trim() ? b.brandName.trim().slice(0, 100) : undefined;
      if (!brandName) {
        return apiErr(res, 400, "VALIDATION", "brandName is required");
      }
      const str = (v: unknown, max: number) =>
        typeof v === "string" ? v.trim().slice(0, max) || null : undefined;
      const hex = (v: unknown) => (typeof v === "string" && /^#[0-9A-Fa-f]{6}$/.test(v.trim()) ? v.trim() : undefined);

      const updatePayload: Record<string, unknown> = { brandName };
      if (b.logoUrl !== undefined) updatePayload.logoUrl = str(b.logoUrl, 500);
      if (b.faviconUrl !== undefined) updatePayload.faviconUrl = str(b.faviconUrl, 500);
      if (b.primaryColor !== undefined) {
        const x = hex(b.primaryColor);
        if (x) updatePayload.primaryColor = x;
      }
      if (b.secondaryColor !== undefined) {
        const x = hex(b.secondaryColor);
        if (x) updatePayload.secondaryColor = x;
      }
      if (b.accentColor !== undefined) {
        const x = hex(b.accentColor);
        if (x) updatePayload.accentColor = x;
      }
      if (b.supportEmail !== undefined) updatePayload.supportEmail = str(b.supportEmail, 255);
      if (b.supportUrl !== undefined) updatePayload.supportUrl = str(b.supportUrl, 500);
      if (typeof b.hidePoweredBy === "boolean") updatePayload.hidePoweredBy = b.hidePoweredBy;
      if (b.onboardingWelcomeMessage !== undefined) {
        updatePayload.onboardingWelcomeMessage =
          typeof b.onboardingWelcomeMessage === "string" ? b.onboardingWelcomeMessage.slice(0, 8000) : null;
      }
      if (b.customDomain !== undefined) {
        const d = b.customDomain === null || b.customDomain === "" ? null : sanitizeDomain(String(b.customDomain));
        updatePayload.customDomain = d;
        if (d) {
          updatePayload.customDomainVerified = false;
          updatePayload.customDomainVerificationToken = null;
        }
      }

      const row = await prisma.agencyBranding.upsert({
        where: { userId: req.user!.id },
        create: {
          userId: req.user!.id,
          brandName,
          primaryColor: (updatePayload.primaryColor as string) || "#2563eb",
          secondaryColor: (updatePayload.secondaryColor as string) || "#64748b",
          accentColor: (updatePayload.accentColor as string) || "#7c3aed",
          logoUrl: (updatePayload.logoUrl as string | null | undefined) ?? null,
          faviconUrl: (updatePayload.faviconUrl as string | null | undefined) ?? null,
          supportEmail: (updatePayload.supportEmail as string | null | undefined) ?? null,
          supportUrl: (updatePayload.supportUrl as string | null | undefined) ?? null,
          hidePoweredBy: (updatePayload.hidePoweredBy as boolean | undefined) ?? false,
          onboardingWelcomeMessage: (updatePayload.onboardingWelcomeMessage as string | null | undefined) ?? null,
          customDomain: (updatePayload.customDomain as string | null | undefined) ?? null,
          customDomainVerified: false,
          customDomainVerificationToken: null,
        },
        update: updatePayload,
      });
      return res.json({ branding: row });
    } catch (e: unknown) {
      if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "P2002") {
        return apiErr(res, 400, "DUPLICATE", "customDomain is already in use");
      }
      console.error("[PUT /agency/branding]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not save branding");
    }
  });

  r.post(
    "/agency/branding/logo",
    expansionRequireAuth,
    expansionRequireProduct("white_label"),
    requireAgency,
    uploadLogo.single("file"),
    async (req: ExpansionAuthRequest, res: Response) => {
      try {
        if (!req.file) return apiErr(res, 400, "VALIDATION", "file field required (multipart)");
        const url = brandingFilePublicUrl(req, req.file.filename);
        return res.json({ ok: true, logoUrl: url });
      } catch (e) {
        console.error("[POST logo]", e);
        return apiErr(res, 500, "SERVER_ERROR", "Upload failed");
      }
    }
  );

  r.post(
    "/agency/branding/favicon",
    expansionRequireAuth,
    expansionRequireProduct("white_label"),
    requireAgency,
    uploadFavicon.single("file"),
    async (req: ExpansionAuthRequest, res: Response) => {
      try {
        if (!req.file) return apiErr(res, 400, "VALIDATION", "file field required (multipart)");
        const url = brandingFilePublicUrl(req, req.file.filename);
        return res.json({ ok: true, faviconUrl: url });
      } catch (e) {
        console.error("[POST favicon]", e);
        return apiErr(res, 500, "SERVER_ERROR", "Upload failed");
      }
    }
  );

  r.post("/agency/branding/domain/verify-init", expansionRequireAuth, expansionRequireProduct("white_label"), requireAgency, async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const domain =
        typeof req.body?.domain === "string" ? sanitizeDomain(req.body.domain) : "";
      if (!domain) return apiErr(res, 400, "VALIDATION", "domain is required");
      const token = crypto.randomBytes(16).toString("hex");
      const txtHost = `_adplatform-verify.${domain}`;
      await prisma.agencyBranding.upsert({
        where: { userId: req.user!.id },
        create: {
          userId: req.user!.id,
          brandName: "My agency",
          customDomain: domain,
          customDomainVerified: false,
          customDomainVerificationToken: token,
        },
        update: {
          customDomain: domain,
          customDomainVerified: false,
          customDomainVerificationToken: token,
        },
      });
      return res.json({
        ok: true,
        txtHost,
        txtValue: token,
        instructions: `Add a TXT record: host/name ${txtHost} value ${token}`,
      });
    } catch (e) {
      console.error("[verify-init]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not start verification");
    }
  });

  r.post("/agency/branding/domain/verify-check", expansionRequireAuth, expansionRequireProduct("white_label"), requireAgency, async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const row = await prisma.agencyBranding.findUnique({ where: { userId: req.user!.id } });
      if (!row?.customDomain || !row.customDomainVerificationToken) {
        return apiErr(res, 400, "VALIDATION", "Run verify-init first");
      }
      const txtHost = `_adplatform-verify.${row.customDomain}`;
      let verified = false;
      try {
        const records = await dns.resolveTxt(txtHost);
        const flat = records.flat().map((s) => s.trim());
        verified = flat.includes(row.customDomainVerificationToken);
      } catch {
        verified = false;
      }
      if (verified) {
        await prisma.agencyBranding.update({
          where: { userId: req.user!.id },
          data: { customDomainVerified: true },
        });
        return res.json({ ok: true, verified: true, message: "Domain active" });
      }
      return res.json({
        ok: true,
        verified: false,
        message:
          "TXT record not found or does not match. Propagation can take up to 48 hours. Confirm host and value at your DNS provider.",
      });
    } catch (e) {
      console.error("[verify-check]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Verification failed");
    }
  });

  // ----- Module 2 stubs (admin + agency) -----
  r.get("/admin/vertical-kits", expansionRequireAuth, requireSuperAdmin, async (_req, res) => {
    try {
      const kits = await prisma.verticalKit.findMany({
        orderBy: { name: "asc" },
        include: { items: true },
      });
      return res.json({ kits });
    } catch (e) {
      console.error("[vertical-kits]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not list kits");
    }
  });

  r.post("/admin/vertical-kits", expansionRequireAuth, requireSuperAdmin, async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 100) : "";
      const slug = typeof req.body?.slug === "string" ? req.body.slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 100) : "";
      if (!name || !slug) return apiErr(res, 400, "VALIDATION", "name and slug required");
      const kit = await prisma.verticalKit.create({
        data: {
          name,
          slug,
          description: typeof req.body?.description === "string" ? req.body.description : undefined,
          industryCategory:
            typeof req.body?.industryCategory === "string" ? req.body.industryCategory.slice(0, 100) : undefined,
        },
      });
      return res.status(201).json({ kit });
    } catch (e: unknown) {
      if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "P2002") {
        return apiErr(res, 400, "DUPLICATE", "slug already exists");
      }
      console.error("[create kit]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not create kit");
    }
  });

  r.get("/agency/kits", expansionRequireAuth, expansionRequireProduct("kits"), requireAgency, async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const kits = await prisma.agencyKit.findMany({
        where: { agencyId: req.user!.id, isActive: true },
        include: { kit: { include: { items: true } } },
      });
      return res.json({ kits });
    } catch (e) {
      console.error("[agency kits]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not list kits");
    }
  });

  function landingSlugify(raw: string): string {
    const s = raw
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 200);
    return s || "page";
  }

  async function resolveLandingScope(
    req: ExpansionAuthRequest,
    res: Response
  ): Promise<{ agencyId: string; clientId: string } | null> {
    const u = req.user!;
    const eff = req.effectiveUserId!;
    if (u.accountType === "agency") {
      if (eff !== u.id) {
        const link = await prisma.agencyClient.findFirst({
          where: { agencyUserId: u.id, clientUserId: eff },
        });
        if (!link) {
          apiErr(res, 403, "FORBIDDEN", "Not allowed to manage this client's data");
          return null;
        }
      }
      return { agencyId: u.id, clientId: eff };
    }
    if (eff !== u.id) {
      apiErr(res, 403, "FORBIDDEN", "Invalid context");
      return null;
    }
    return { agencyId: u.id, clientId: u.id };
  }

  async function assertCampaignForClient(campaignId: string | null | undefined, clientId: string): Promise<boolean> {
    if (campaignId == null || campaignId === "") return true;
    const exp = await prisma.experiment.findFirst({ where: { id: campaignId, userId: clientId } });
    return !!exp;
  }

  const landingPageInclude = {
    experiment: { select: { id: true, name: true, platform: true, status: true } },
  } as const;

  r.get("/agency/landing-pages", expansionRequireAuth, expansionRequireProduct("landing_pages"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const pages = await prisma.landingPage.findMany({
        where: { agencyId: scope.agencyId, clientId: scope.clientId },
        orderBy: { updatedAt: "desc" },
        include: landingPageInclude,
      });
      return res.json({ pages });
    } catch (e) {
      console.error("[GET landing-pages]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not list landing pages");
    }
  });

  r.post("/agency/landing-pages", expansionRequireAuth, expansionRequireProduct("landing_pages"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const b = req.body || {};
      const title =
        typeof b.title === "string" && b.title.trim() ? b.title.trim().slice(0, 200) : "";
      if (!title) return apiErr(res, 400, "VALIDATION", "title is required");
      const slug =
        typeof b.slug === "string" && b.slug.trim()
          ? landingSlugify(b.slug)
          : landingSlugify(title);
      const campaignId =
        typeof b.campaignId === "string" && b.campaignId.trim() ? b.campaignId.trim() : null;
      if (!(await assertCampaignForClient(campaignId, scope.clientId))) {
        return apiErr(res, 400, "VALIDATION", "campaignId must be an experiment owned by this client");
      }
      let pageData: Prisma.InputJsonValue = {};
      if (b.pageData !== undefined && b.pageData !== null && typeof b.pageData === "object") {
        pageData = b.pageData as Prisma.InputJsonValue;
      }
      const statusStr =
        typeof b.status === "string" && ["draft", "published", "archived"].includes(b.status)
          ? b.status
          : "draft";
      const hostingType =
        typeof b.hostingType === "string" && ["platform", "export"].includes(b.hostingType)
          ? b.hostingType
          : "platform";
      const subdomain =
        typeof b.subdomain === "string" && b.subdomain.trim()
          ? b.subdomain.trim().toLowerCase().slice(0, 100)
          : null;
      const aiGenerationPrompt =
        typeof b.aiGenerationPrompt === "string" ? b.aiGenerationPrompt.slice(0, 50000) : null;
      const conversionGoal =
        typeof b.conversionGoal === "string" ? b.conversionGoal.trim().slice(0, 200) : null;
      const conversionTrackingPixel =
        typeof b.conversionTrackingPixel === "string"
          ? b.conversionTrackingPixel.slice(0, 50000)
          : null;

      const publishedAt = statusStr === "published" ? new Date() : null;

      const page = await prisma.landingPage.create({
        data: {
          agencyId: scope.agencyId,
          clientId: scope.clientId,
          campaignId,
          title,
          slug,
          status: statusStr,
          hostingType,
          subdomain,
          pageData,
          aiGenerationPrompt,
          conversionGoal,
          conversionTrackingPixel,
          publishedAt,
        },
        include: landingPageInclude,
      });
      return res.status(201).json({ page });
    } catch (e: unknown) {
      if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "P2002") {
        return apiErr(res, 400, "DUPLICATE", "slug already exists for this client");
      }
      console.error("[POST landing-pages]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not create landing page");
    }
  });

  r.get("/agency/landing-pages/:id", expansionRequireAuth, expansionRequireProduct("landing_pages"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const page = await prisma.landingPage.findFirst({
        where: { id: req.params.id, agencyId: scope.agencyId, clientId: scope.clientId },
        include: landingPageInclude,
      });
      if (!page) return apiErr(res, 404, "NOT_FOUND", "Landing page not found");
      return res.json({ page });
    } catch (e) {
      console.error("[GET landing-page]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not load landing page");
    }
  });

  r.patch("/agency/landing-pages/:id", expansionRequireAuth, expansionRequireProduct("landing_pages"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const existing = await prisma.landingPage.findFirst({
        where: { id: req.params.id, agencyId: scope.agencyId, clientId: scope.clientId },
      });
      if (!existing) return apiErr(res, 404, "NOT_FOUND", "Landing page not found");

      const b = req.body || {};
      const data: Prisma.LandingPageUncheckedUpdateInput = {};

      if (typeof b.title === "string" && b.title.trim()) data.title = b.title.trim().slice(0, 200);
      if (typeof b.slug === "string" && b.slug.trim()) data.slug = landingSlugify(b.slug);
      if (typeof b.status === "string" && ["draft", "published", "archived"].includes(b.status)) {
        data.status = b.status;
        if (b.status === "published" && !existing.publishedAt) {
          data.publishedAt = new Date();
        }
      }
      if (typeof b.hostingType === "string" && ["platform", "export"].includes(b.hostingType)) {
        data.hostingType = b.hostingType;
      }
      if (b.subdomain !== undefined) {
        data.subdomain =
          b.subdomain === null || b.subdomain === ""
            ? null
            : String(b.subdomain).trim().toLowerCase().slice(0, 100);
      }
      if (b.pageData !== undefined) {
        if (b.pageData === null || (typeof b.pageData === "object" && Object.keys(b.pageData).length === 0)) {
          data.pageData = {};
        } else if (typeof b.pageData === "object") {
          data.pageData = b.pageData as Prisma.InputJsonValue;
        }
      }
      if (b.aiGenerationPrompt !== undefined) {
        data.aiGenerationPrompt =
          typeof b.aiGenerationPrompt === "string" ? b.aiGenerationPrompt.slice(0, 50000) : null;
      }
      if (b.conversionGoal !== undefined) {
        data.conversionGoal =
          typeof b.conversionGoal === "string" ? b.conversionGoal.trim().slice(0, 200) : null;
      }
      if (b.conversionTrackingPixel !== undefined) {
        data.conversionTrackingPixel =
          typeof b.conversionTrackingPixel === "string"
            ? b.conversionTrackingPixel.slice(0, 50000)
            : null;
      }
      if (b.campaignId !== undefined) {
        const cid =
          b.campaignId === null || b.campaignId === ""
            ? null
            : typeof b.campaignId === "string"
              ? b.campaignId.trim()
              : null;
        if (cid && !(await assertCampaignForClient(cid, scope.clientId))) {
          return apiErr(res, 400, "VALIDATION", "campaignId must be an experiment owned by this client");
        }
        data.campaignId = cid;
      }

      const page = await prisma.landingPage.update({
        where: { id: existing.id },
        data,
        include: landingPageInclude,
      });
      return res.json({ page });
    } catch (e: unknown) {
      if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "P2002") {
        return apiErr(res, 400, "DUPLICATE", "slug already exists for this client");
      }
      console.error("[PATCH landing-page]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not update landing page");
    }
  });

  r.delete("/agency/landing-pages/:id", expansionRequireAuth, expansionRequireProduct("landing_pages"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const result = await prisma.landingPage.deleteMany({
        where: { id: req.params.id, agencyId: scope.agencyId, clientId: scope.clientId },
      });
      if (result.count === 0) return apiErr(res, 404, "NOT_FOUND", "Landing page not found");
      return res.json({ ok: true });
    } catch (e) {
      console.error("[DELETE landing-page]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not delete landing page");
    }
  });

  r.post("/agency/kits/:kitId/install", expansionRequireAuth, expansionRequireProduct("kits"), requireAgency, async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const { kitId } = req.params;
      const kit = await prisma.verticalKit.findFirst({ where: { id: kitId, isActive: true } });
      if (!kit) return apiErr(res, 404, "NOT_FOUND", "Kit not found");

      const agKit = await prisma.agencyKit.upsert({
        where: { agencyId_kitId: { agencyId: req.user!.id, kitId } },
        create: { agencyId: req.user!.id, kitId, assignedBy: req.user!.id },
        update: { isActive: true },
      });

      await prisma.agencyKitAsset.deleteMany({ where: { agencyKitId: agKit.id } });
      const items = await prisma.verticalKitItem.findMany({ where: { kitId } });
      const summary = { ad_template: 0, audience_preset: 0, landing_page_template: 0, campaign_structure: 0, email_sequence: 0 };
      for (const it of items) {
        await prisma.agencyKitAsset.create({
          data: {
            agencyKitId: agKit.id,
            itemType: it.itemType,
            itemName: it.itemName,
            itemData: it.itemData as Prisma.InputJsonValue,
            platform: it.platform,
          },
        });
        const k = it.itemType as keyof typeof summary;
        if (Object.prototype.hasOwnProperty.call(summary, k)) summary[k]++;
      }
      return res.json({
        ok: true,
        installed: {
          ad_templates: summary.ad_template,
          audiences: summary.audience_preset,
          landing_pages: summary.landing_page_template,
          campaigns: summary.campaign_structure,
          email_sequences: summary.email_sequence,
        },
      });
    } catch (e) {
      console.error("[install kit]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Install failed");
    }
  });

  function parseStringArray(val: unknown, maxItemLen: number): string[] {
    if (!Array.isArray(val)) return [];
    const out: string[] = [];
    for (const x of val) {
      if (typeof x !== "string") continue;
      const t = x.trim();
      if (t) out.push(t.slice(0, maxItemLen));
    }
    return out;
  }

  // ----- Module 4: Report configs & history -----
  r.get("/agency/reports/configs", expansionRequireAuth, expansionRequireProduct("reports"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const configs = await prisma.reportConfig.findMany({
        where: { agencyId: scope.agencyId, clientId: scope.clientId },
        orderBy: { updatedAt: "desc" },
        include: { _count: { select: { generatedReports: true } } },
      });
      return res.json({ configs });
    } catch (e) {
      console.error("[GET report configs]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not list report configs");
    }
  });

  r.post("/agency/reports/configs", expansionRequireAuth, expansionRequireProduct("reports"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const b = req.body || {};
      const reportName =
        typeof b.reportName === "string" && b.reportName.trim() ? b.reportName.trim().slice(0, 200) : "";
      if (!reportName) return apiErr(res, 400, "VALIDATION", "reportName is required");
      const frequency =
        typeof b.frequency === "string" && ["weekly", "biweekly", "monthly", "on_demand"].includes(b.frequency)
          ? b.frequency
          : "monthly";
      const sendDay =
        typeof b.sendDay === "number" && Number.isInteger(b.sendDay) && b.sendDay >= 0 && b.sendDay <= 6
          ? b.sendDay
          : null;
      const sendTime =
        typeof b.sendTime === "string" && /^\d{2}:\d{2}$/.test(b.sendTime.trim()) ? b.sendTime.trim() : null;
      const emailRecipients = parseStringArray(b.emailRecipients, 320) as Prisma.InputJsonValue;
      let includeSections: Prisma.InputJsonValue = {};
      if (b.includeSections !== undefined && b.includeSections !== null && typeof b.includeSections === "object") {
        includeSections = b.includeSections as Prisma.InputJsonValue;
      }
      const reportFormat =
        typeof b.reportFormat === "string" && ["pdf", "html", "both"].includes(b.reportFormat)
          ? b.reportFormat
          : "pdf";
      const isActive = typeof b.isActive === "boolean" ? b.isActive : true;

      const row = await prisma.reportConfig.create({
        data: {
          agencyId: scope.agencyId,
          clientId: scope.clientId,
          reportName,
          frequency,
          sendDay,
          sendTime,
          emailRecipients,
          includeSections,
          reportFormat,
          isActive,
        },
        include: { _count: { select: { generatedReports: true } } },
      });
      return res.status(201).json({ config: row });
    } catch (e) {
      console.error("[POST report config]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not create report config");
    }
  });

  r.get("/agency/reports/configs/:id", expansionRequireAuth, expansionRequireProduct("reports"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const row = await prisma.reportConfig.findFirst({
        where: { id: req.params.id, agencyId: scope.agencyId, clientId: scope.clientId },
        include: { _count: { select: { generatedReports: true } } },
      });
      if (!row) return apiErr(res, 404, "NOT_FOUND", "Report config not found");
      return res.json({ config: row });
    } catch (e) {
      console.error("[GET report config]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not load report config");
    }
  });

  r.patch("/agency/reports/configs/:id", expansionRequireAuth, expansionRequireProduct("reports"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const existing = await prisma.reportConfig.findFirst({
        where: { id: req.params.id, agencyId: scope.agencyId, clientId: scope.clientId },
      });
      if (!existing) return apiErr(res, 404, "NOT_FOUND", "Report config not found");
      const b = req.body || {};
      const data: Prisma.ReportConfigUncheckedUpdateInput = {};
      if (typeof b.reportName === "string" && b.reportName.trim()) data.reportName = b.reportName.trim().slice(0, 200);
      if (typeof b.frequency === "string" && ["weekly", "biweekly", "monthly", "on_demand"].includes(b.frequency)) {
        data.frequency = b.frequency;
      }
      if (b.sendDay !== undefined) {
        data.sendDay =
          b.sendDay === null
            ? null
            : typeof b.sendDay === "number" && Number.isInteger(b.sendDay) && b.sendDay >= 0 && b.sendDay <= 6
              ? b.sendDay
              : undefined;
      }
      if (b.sendTime !== undefined) {
        data.sendTime =
          b.sendTime === null || b.sendTime === ""
            ? null
            : typeof b.sendTime === "string" && /^\d{2}:\d{2}$/.test(String(b.sendTime).trim())
              ? String(b.sendTime).trim()
              : undefined;
      }
      if (b.emailRecipients !== undefined) {
        data.emailRecipients = parseStringArray(b.emailRecipients, 320) as Prisma.InputJsonValue;
      }
      if (b.includeSections !== undefined) {
        if (b.includeSections === null) data.includeSections = {};
        else if (typeof b.includeSections === "object") {
          data.includeSections = b.includeSections as Prisma.InputJsonValue;
        }
      }
      if (typeof b.reportFormat === "string" && ["pdf", "html", "both"].includes(b.reportFormat)) {
        data.reportFormat = b.reportFormat;
      }
      if (typeof b.isActive === "boolean") data.isActive = b.isActive;

      const row = await prisma.reportConfig.update({
        where: { id: existing.id },
        data,
        include: { _count: { select: { generatedReports: true } } },
      });
      return res.json({ config: row });
    } catch (e) {
      console.error("[PATCH report config]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not update report config");
    }
  });

  r.delete("/agency/reports/configs/:id", expansionRequireAuth, expansionRequireProduct("reports"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const result = await prisma.reportConfig.deleteMany({
        where: { id: req.params.id, agencyId: scope.agencyId, clientId: scope.clientId },
      });
      if (result.count === 0) return apiErr(res, 404, "NOT_FOUND", "Report config not found");
      return res.json({ ok: true });
    } catch (e) {
      console.error("[DELETE report config]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not delete report config");
    }
  });

  r.get("/agency/reports/configs/:id/generated", expansionRequireAuth, expansionRequireProduct("reports"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const config = await prisma.reportConfig.findFirst({
        where: { id: req.params.id, agencyId: scope.agencyId, clientId: scope.clientId },
      });
      if (!config) return apiErr(res, 404, "NOT_FOUND", "Report config not found");
      const generated = await prisma.generatedReport.findMany({
        where: { configId: config.id },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return res.json({ generated });
    } catch (e) {
      console.error("[GET generated reports]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not list generated reports");
    }
  });

  /** Record a completed run (PDF/HTML delivery still optional — files added when pipeline exists). */
  r.post("/agency/reports/configs/:id/record-run", expansionRequireAuth, expansionRequireProduct("reports"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const config = await prisma.reportConfig.findFirst({
        where: { id: req.params.id, agencyId: scope.agencyId, clientId: scope.clientId },
      });
      if (!config) return apiErr(res, 404, "NOT_FOUND", "Report config not found");
      const b = req.body || {};
      const now = new Date();
      const periodEnd = new Date(now);
      const periodStart = new Date(now);
      periodStart.setDate(periodStart.getDate() - 30);
      let start = periodStart;
      let end = periodEnd;
      if (typeof b.reportPeriodStart === "string" && b.reportPeriodStart.trim()) {
        const d = new Date(b.reportPeriodStart);
        if (!Number.isNaN(d.getTime())) start = d;
      }
      if (typeof b.reportPeriodEnd === "string" && b.reportPeriodEnd.trim()) {
        const d = new Date(b.reportPeriodEnd);
        if (!Number.isNaN(d.getTime())) end = d;
      }
      const row = await prisma.generatedReport.create({
        data: {
          configId: config.id,
          agencyId: scope.agencyId,
          clientId: scope.clientId,
          reportPeriodStart: start,
          reportPeriodEnd: end,
          status: "ready",
          fileUrlPdf: typeof b.fileUrlPdf === "string" ? b.fileUrlPdf.trim().slice(0, 500) : null,
          fileUrlHtml: typeof b.fileUrlHtml === "string" ? b.fileUrlHtml.trim().slice(0, 500) : null,
        },
      });
      await prisma.reportConfig.update({
        where: { id: config.id },
        data: { lastSentAt: now },
      });
      return res.status(201).json({ generated: row });
    } catch (e) {
      console.error("[record-run]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not record report run");
    }
  });

  // ----- Module 6: Competitor watches -----
  /** Resolve Facebook Page to numeric id (Ad Library “View all” URL, link, @handle, or id). */
  r.post("/agency/competitor/resolve-facebook-page", expansionRequireAuth, expansionRequireProduct("competitors"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const b = (req.body || {}) as { input?: unknown };
      const input = typeof b.input === "string" ? b.input.trim() : "";
      if (!input) return apiErr(res, 400, "VALIDATION", "input is required");
      if (input.length > 2000) return apiErr(res, 400, "VALIDATION", "input is too long");
      const result = await resolveCompetitorFacebookPageInputEx(input);
      if (!result) {
        return res.json({ pageId: null, source: null, message: "Could not read a Facebook Page from that text." });
      }
      return res.json({ pageId: result.pageId, source: result.source });
    } catch (e) {
      return apiErr(
        res,
        400,
        "VALIDATION",
        e instanceof Error ? e.message : "Could not resolve that Facebook Page. Try a full page URL, Ad Library “View all” link, or numeric id."
      );
    }
  });

  /** One Ad Library ad id → page_id (Graph Archived ad) for search_page_ids / scans. */
  r.post(
    "/agency/competitor/resolve-page-from-ad-library-id",
    expansionRequireAuth,
    expansionRequireProduct("competitors"),
    async (req: ExpansionAuthRequest, res: Response) => {
      try {
        const b = (req.body || {}) as { adLibraryId?: unknown };
        const adLibraryId = typeof b.adLibraryId === "string" ? b.adLibraryId.trim() : "";
        if (!adLibraryId) return apiErr(res, 400, "VALIDATION", "adLibraryId is required");
        if (adLibraryId.length > 80) return apiErr(res, 400, "VALIDATION", "adLibraryId is too long");
        const r0 = await resolveMetaAdLibraryIdToPageId(adLibraryId);
        return res.json(r0);
      } catch (e) {
        return apiErr(
          res,
          400,
          "VALIDATION",
          e instanceof Error
            ? e.message
            : "Could not resolve that Ad Library ad id. Check the id and server Meta token (Ad Library access)."
        );
      }
    }
  );

  /** Scrape the competitor’s public website for facebook.com/… links, then resolve to Page id (no Ad Library). */
  r.post(
    "/agency/competitor/discover-facebook-page-from-website",
    expansionRequireAuth,
    expansionRequireProduct("competitors"),
    async (req: ExpansionAuthRequest, res: Response) => {
      try {
        const b = (req.body || {}) as {
          website?: unknown;
          companyName?: unknown;
          locationHint?: unknown;
          crawlEntireSite?: unknown;
          includeGooglePlace?: unknown;
        };
        const website = typeof b.website === "string" ? b.website.trim() : "";
        if (!website) return apiErr(res, 400, "VALIDATION", "website is required");
        if (website.length > 500) return apiErr(res, 400, "VALIDATION", "website is too long");
        const companyName = typeof b.companyName === "string" ? b.companyName.trim().slice(0, 200) : "";
        const locationHint = typeof b.locationHint === "string" ? b.locationHint.trim().slice(0, 120) : "";
        const crawlEntireSite = b.crawlEntireSite === false ? false : true;
        const includeGooglePlace = b.includeGooglePlace === false ? false : true;
        const r0 = await discoverFacebookPageFromCompetitorWebsite(website, {
          crawlEntireSite,
          companyName: companyName || undefined,
          locationHint: locationHint || undefined,
          includeGooglePlace,
        });
        return res.json(r0);
      } catch (e) {
        console.error("[discover-facebook-page-from-website]", e);
        return apiErr(
          res,
          500,
          "SERVER_ERROR",
          e instanceof Error ? e.message : "Could not scan the website for Facebook links."
        );
      }
    }
  );

  /**
   * Meta Ad Library keyword search → distinct advertiser Pages (`page_id`) ranked by how often they appear in the sample.
   * Helps when the brand Page has no ads but a management/agency Page runs them.
   */
  r.post(
    "/agency/competitor/discover-meta-pages-from-ad-library-search",
    expansionRequireAuth,
    expansionRequireProduct("competitors"),
    async (req: ExpansionAuthRequest, res: Response) => {
      try {
        const b = (req.body || {}) as { searchTerm?: unknown };
        const searchTerm = typeof b.searchTerm === "string" ? b.searchTerm.trim() : "";
        if (!searchTerm) return apiErr(res, 400, "VALIDATION", "searchTerm is required");
        if (searchTerm.length > 200) return apiErr(res, 400, "VALIDATION", "searchTerm is too long");
        const r0 = await discoverMetaAdvertiserPagesFromAdLibrarySearch(searchTerm);
        return res.json(r0);
      } catch (e) {
        console.error("[discover-meta-pages-from-ad-library-search]", e);
        return apiErr(
          res,
          400,
          "VALIDATION",
          e instanceof Error ? e.message : "Could not search Meta Ad Library by keyword."
        );
      }
    }
  );

  // ----- Keyword harvest pool (Ads Library → brands → optional AI report) -----
  r.post("/agency/competitor/meta-harvest-runs", expansionRequireAuth, expansionRequireProduct("competitors"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const b = req.body || {};
      const rawKw = Array.isArray(b.keywords) ? (b.keywords as unknown[]) : [];
      const keywords = rawKw
        .filter((x: unknown): x is string => typeof x === "string" && x.trim().length > 2)
        .map((k: string) => k.trim().slice(0, 200));
      if (keywords.length === 0) return apiErr(res, 400, "VALIDATION", "keywords must be a non-empty array of strings (each 3+ characters)");
      if (keywords.length > 12) return apiErr(res, 400, "VALIDATION", "Maximum 12 keywords per harvest run");
      const label = typeof b.label === "string" ? b.label.trim().slice(0, 200) : null;
      const run = await prisma.metaAdHarvestRun.create({
        data: {
          agencyId: scope.agencyId,
          clientId: scope.clientId,
          keywords: keywords as unknown as Prisma.InputJsonValue,
          label: label || null,
          status: "pending",
        },
      });
      await executeMetaHarvestRun(run.id);
      const row = await prisma.metaAdHarvestRun.findFirst({
        where: { id: run.id, agencyId: scope.agencyId, clientId: scope.clientId },
        include: { _count: { select: { ads: true } } },
      });
      return res.status(201).json({ run: row });
    } catch (e) {
      console.error("[meta-harvest-runs POST]", e);
      return apiErr(res, 500, "SERVER_ERROR", e instanceof Error ? e.message : "Could not run keyword harvest");
    }
  });

  r.get("/agency/competitor/meta-harvest-runs", expansionRequireAuth, expansionRequireProduct("competitors"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const runs = await prisma.metaAdHarvestRun.findMany({
        where: { agencyId: scope.agencyId, clientId: scope.clientId },
        orderBy: { createdAt: "desc" },
        take: 40,
        include: { _count: { select: { ads: true } } },
      });
      return res.json({ runs });
    } catch (e) {
      console.error("[meta-harvest-runs GET]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not list harvest runs");
    }
  });

  r.get("/agency/competitor/meta-harvest-runs/:id", expansionRequireAuth, expansionRequireProduct("competitors"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const run = await prisma.metaAdHarvestRun.findFirst({
        where: { id: req.params.id, agencyId: scope.agencyId, clientId: scope.clientId },
        include: {
          ads: { orderBy: { createdAt: "desc" }, take: 120 },
          _count: { select: { ads: true } },
        },
      });
      if (!run) return apiErr(res, 404, "NOT_FOUND", "Harvest run not found");
      const ctx = await loadHarvestRankingScoreContext(scope.agencyId, scope.clientId, run);
      const stripped = run.ads.map(({ rawData, ...rest }) => rest);
      const adsRanked = attachHarvestAdRelevanceScores(stripped, ctx);
      return res.json({
        run: {
          ...run,
          ads: adsRanked,
        },
      });
    } catch (e) {
      console.error("[meta-harvest-runs/:id]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not load harvest run");
    }
  });

  r.patch("/agency/competitor/meta-harvest-runs/:id/ranking-context", expansionRequireAuth, expansionRequireProduct("competitors"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const runId = typeof req.params.id === "string" ? req.params.id.trim() : "";
      if (!runId) return apiErr(res, 400, "VALIDATION", "Missing run id");
      const existing = await prisma.metaAdHarvestRun.findFirst({
        where: { id: runId, agencyId: scope.agencyId, clientId: scope.clientId },
      });
      if (!existing) return apiErr(res, 404, "NOT_FOUND", "Harvest run not found");

      const b = req.body || {};
      const intentPrompt =
        typeof b.intentPrompt === "string" ? b.intentPrompt.trim().slice(0, 8000) : undefined;
      let rankingKeywords: string[] | undefined;
      if (Array.isArray(b.rankingKeywords)) {
        rankingKeywords = (b.rankingKeywords as unknown[])
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim().slice(0, 160))
          .filter((x) => x.length > 1)
          .slice(0, 36);
      }

      const data: Prisma.MetaAdHarvestRunUpdateInput = {
        rankingKeywordsUpdatedAt: new Date(),
      };
      if (intentPrompt !== undefined) data.intentPrompt = intentPrompt.length ? intentPrompt : null;
      if (rankingKeywords !== undefined) data.rankingKeywords = rankingKeywords as unknown as Prisma.InputJsonValue;

      await prisma.metaAdHarvestRun.update({
        where: { id: runId },
        data,
      });

      if (intentPrompt !== undefined && intentPrompt.length >= 12) {
        await appendHarvestIntentSnippet(scope.agencyId, scope.clientId, intentPrompt);
      }

      const row = await prisma.metaAdHarvestRun.findFirst({
        where: { id: runId, agencyId: scope.agencyId, clientId: scope.clientId },
        include: { _count: { select: { ads: true } } },
      });
      return res.json({ run: row });
    } catch (e) {
      console.error("[meta-harvest-runs PATCH ranking-context]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not update ranking context");
    }
  });

  r.post("/agency/competitor/meta-harvest-runs/:id/suggest-ranking-keywords", expansionRequireAuth, expansionRequireProduct("competitors"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const runId = typeof req.params.id === "string" ? req.params.id.trim() : "";
      if (!runId) return apiErr(res, 400, "VALIDATION", "Missing run id");
      const run = await prisma.metaAdHarvestRun.findFirst({
        where: { id: runId, agencyId: scope.agencyId, clientId: scope.clientId },
      });
      if (!run) return apiErr(res, 404, "NOT_FOUND", "Harvest run not found");
      const b = req.body || {};
      const intent =
        typeof b.intentPrompt === "string"
          ? b.intentPrompt.trim()
          : run.intentPrompt?.trim() ?? "";
      const keywords = await suggestRankingKeywordsFromIntent({
        intentPrompt: intent,
        harvestKeywords: parseHarvestKeywordStrings(run.keywords),
      });
      return res.json({ keywords });
    } catch (e) {
      console.error("[meta-harvest-runs suggest-ranking-keywords]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not suggest keywords");
    }
  });

  r.post("/agency/competitor/meta-ad-snapshot-thumb", expansionRequireAuth, expansionRequireProduct("competitors"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const snapshotUrl = typeof req.body?.snapshotUrl === "string" ? req.body.snapshotUrl.trim() : "";
      if (!snapshotUrl.startsWith("http")) {
        return apiErr(res, 400, "VALIDATION", "snapshotUrl must be an http(s) URL");
      }
      const preview = await resolveMetaSnapshotPreview(snapshotUrl);
      return res.json({
        thumbnailUrl: preview.thumbnailUrl,
        previewHtml: preview.previewHtml,
      });
    } catch (e) {
      console.error("[meta-ad-snapshot-thumb]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not resolve preview image");
    }
  });

  r.get("/agency/competitor/meta-harvest-brands", expansionRequireAuth, expansionRequireProduct("competitors"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const digits = q.replace(/\D/g, "");
      const groups = await prisma.metaAdHarvestAd.groupBy({
        by: ["facebookPageId"],
        where: {
          run: { agencyId: scope.agencyId, clientId: scope.clientId },
          ...(q
            ? {
                OR: [
                  { pageName: { contains: q, mode: "insensitive" } },
                  ...(digits.length >= 4 ? [{ facebookPageId: { contains: digits } }] : []),
                ],
              }
            : {}),
        },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 80,
      });

      const pageIds = groups.map((g) => g.facebookPageId);
      const sampleRows =
        pageIds.length > 0
          ? await prisma.metaAdHarvestAd.findMany({
              where: {
                facebookPageId: { in: pageIds },
                run: { agencyId: scope.agencyId, clientId: scope.clientId },
              },
              orderBy: { createdAt: "desc" },
              select: { facebookPageId: true, pageName: true },
            })
          : [];
      const pageNameById = new Map<string, string | null>();
      for (const row of sampleRows) {
        if (!pageNameById.has(row.facebookPageId)) pageNameById.set(row.facebookPageId, row.pageName);
      }
      const brands = groups.map((g) => ({
        facebookPageId: g.facebookPageId,
        pageName: pageNameById.get(g.facebookPageId) ?? null,
        adCount: g._count.id,
      }));

      return res.json({ brands });
    } catch (e) {
      console.error("[meta-harvest-brands]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not list harvested brands");
    }
  });

  r.post("/agency/competitor/meta-harvest-report", expansionRequireAuth, expansionRequireProduct("competitors"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const b = req.body || {};
      const idsRaw = Array.isArray(b.facebookPageIds) ? (b.facebookPageIds as unknown[]) : [];
      const facebookPageIds = idsRaw
        .filter((x: unknown): x is string => typeof x === "string")
        .map((x: string) => x.replace(/\D/g, ""))
        .filter((id: string) => id.length >= 4);
      const libRaw = Array.isArray(b.adLibraryIds) ? (b.adLibraryIds as unknown[]) : [];
      const adLibraryIds = libRaw
        .filter((x: unknown): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x: string) => x.trim())
        .slice(0, 48);
      if (facebookPageIds.length === 0 && adLibraryIds.length === 0) {
        return apiErr(res, 400, "VALIDATION", "Provide facebookPageIds and/or adLibraryIds from your saved harvest");
      }
      if (facebookPageIds.length > 12) return apiErr(res, 400, "VALIDATION", "Maximum 12 Page ids per report");
      const competitorDisplayName = typeof b.competitorDisplayName === "string" ? b.competitorDisplayName.trim().slice(0, 200) : undefined;
      const hkRaw = Array.isArray(b.keywords) ? (b.keywords as unknown[]) : [];
      const hk = hkRaw
        .filter((x: unknown): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x: string) => x.trim().slice(0, 120));
      const exRaw = Array.isArray(b.excludePhrases) ? (b.excludePhrases as unknown[]) : [];
      const excludePhrases = exRaw
        .filter((x: unknown): x is string => typeof x === "string" && x.trim().length >= 2)
        .map((x: string) => x.trim().slice(0, 160))
        .slice(0, 24);
      const strictRelevanceFilter = Boolean(b.strictRelevanceFilter);
      const runInBackground = Boolean(b.runInBackground);
      const skipLearn = skipHarvestLearning(req);

      if (runInBackground) {
        const pending = await prisma.metaHarvestInsight.create({
          data: {
            agencyId: scope.agencyId,
            clientId: scope.clientId,
            kind: "brand",
            title: competitorDisplayName?.slice(0, 240) || "Brand report",
            facebookPageIds:
              facebookPageIds.length > 0
                ? (facebookPageIds as unknown as Prisma.InputJsonValue)
                : undefined,
            excludePhrases: excludePhrases.length ? excludePhrases : undefined,
            strictFilter: strictRelevanceFilter,
            status: "pending",
          },
        });
        scheduleBrandHarvestInsightJob(pending.id, scope.agencyId, scope.clientId, {
          facebookPageIds,
          adLibraryIds: adLibraryIds.length ? adLibraryIds : undefined,
          competitorDisplayName,
          keywords: hk.length ? hk : undefined,
          excludePhrases,
          strictRelevanceFilter,
          skipLearning: skipLearn,
        });
        return res.status(202).json({
          insight: jsonHarvestInsight(pending),
          backgroundAccepted: true,
        });
      }

      const report = await buildMetaHarvestBrandReport({
        agencyId: scope.agencyId,
        clientId: scope.clientId,
        facebookPageIds: facebookPageIds.length ? facebookPageIds : undefined,
        adLibraryIds: adLibraryIds.length ? adLibraryIds : undefined,
        competitorDisplayName,
        keywords: hk.length ? hk : undefined,
        excludePhrases: excludePhrases.length ? excludePhrases : undefined,
        strictRelevanceFilter,
      });
      const insight = await persistCompletedHarvestInsight({
        agencyId: scope.agencyId,
        clientId: scope.clientId,
        kind: "brand",
        title: competitorDisplayName?.slice(0, 240) || report.competitorDisplayName.slice(0, 240),
        facebookPageIds: facebookPageIds.length ? facebookPageIds : undefined,
        excludePhrases,
        strictFilter: strictRelevanceFilter,
        report,
      });
      await maybeRecordHarvestAdSelections({
        skipLearning: skipLearn,
        agencyId: scope.agencyId,
        clientId: scope.clientId,
        adLibraryIds,
      });
      return res.json({ report, insight: jsonHarvestInsight(insight) });
    } catch (e) {
      console.error("[meta-harvest-report]", e);
      return apiErr(
        res,
        400,
        "VALIDATION",
        e instanceof Error ? e.message : "Could not build harvest report"
      );
    }
  });

  r.post("/agency/competitor/meta-harvest-landscape-report", expansionRequireAuth, expansionRequireProduct("competitors"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const b = req.body || {};
      const harvestRunId =
        typeof b.harvestRunId === "string" && b.harvestRunId.trim().length > 0 ? b.harvestRunId.trim() : undefined;
      const topicHint = typeof b.topicHint === "string" ? b.topicHint.trim().slice(0, 240) : undefined;
      const exRaw = Array.isArray(b.excludePhrases) ? (b.excludePhrases as unknown[]) : [];
      const excludePhrases = exRaw
        .filter((x: unknown): x is string => typeof x === "string" && x.trim().length >= 2)
        .map((x: string) => x.trim().slice(0, 160))
        .slice(0, 24);
      const strictRelevanceFilter = Boolean(b.strictRelevanceFilter);
      const runInBackground = Boolean(b.runInBackground);
      const libRaw = Array.isArray(b.adLibraryIds) ? (b.adLibraryIds as unknown[]) : [];
      const adLibraryIds = libRaw
        .filter((x: unknown): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x: string) => x.trim())
        .slice(0, 80);
      if (adLibraryIds.length > 0 && !harvestRunId) {
        return apiErr(res, 400, "VALIDATION", "Choose a saved collection (harvestRunId) when listing specific ads.");
      }

      const skipLearn = skipHarvestLearning(req);

      if (runInBackground) {
        const pending = await prisma.metaHarvestInsight.create({
          data: {
            agencyId: scope.agencyId,
            clientId: scope.clientId,
            kind: "landscape",
            title: topicHint?.slice(0, 240) || "Market overview",
            harvestRunId: harvestRunId ?? null,
            excludePhrases: excludePhrases.length ? excludePhrases : undefined,
            strictFilter: strictRelevanceFilter,
            topicHint: topicHint ?? null,
            status: "pending",
          },
        });
        scheduleLandscapeHarvestInsightJob(pending.id, scope.agencyId, scope.clientId, {
          harvestRunId,
          topicHint,
          excludePhrases,
          strictRelevanceFilter,
          adLibraryIds: adLibraryIds.length ? adLibraryIds : undefined,
          skipLearning: skipLearn,
        });
        return res.status(202).json({
          insight: jsonHarvestInsight(pending),
          backgroundAccepted: true,
        });
      }

      const report = await buildMetaHarvestLandscapeReport({
        agencyId: scope.agencyId,
        clientId: scope.clientId,
        harvestRunId,
        topicHint,
        excludePhrases: excludePhrases.length ? excludePhrases : undefined,
        strictRelevanceFilter,
        adLibraryIds: adLibraryIds.length ? adLibraryIds : undefined,
      });
      const insight = await persistCompletedHarvestInsight({
        agencyId: scope.agencyId,
        clientId: scope.clientId,
        kind: "landscape",
        title: topicHint?.slice(0, 240) || report.competitorDisplayName.slice(0, 240),
        harvestRunId: harvestRunId ?? null,
        excludePhrases,
        strictFilter: strictRelevanceFilter,
        topicHint: topicHint ?? null,
        report,
      });
      await maybeRecordHarvestAdSelections({
        skipLearning: skipLearn,
        agencyId: scope.agencyId,
        clientId: scope.clientId,
        adLibraryIds,
      });
      return res.json({ report, insight: jsonHarvestInsight(insight) });
    } catch (e) {
      console.error("[meta-harvest-landscape-report]", e);
      return apiErr(
        res,
        400,
        "VALIDATION",
        e instanceof Error ? e.message : "Could not build harvest landscape report"
      );
    }
  });

  r.get("/agency/competitor/meta-harvest-insights", expansionRequireAuth, expansionRequireProduct("competitors"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const rows = await prisma.metaHarvestInsight.findMany({
        where: { agencyId: scope.agencyId, clientId: scope.clientId },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return res.json({ insights: rows.map(jsonHarvestInsight) });
    } catch (e) {
      console.error("[meta-harvest-insights GET]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not list saved reports");
    }
  });

  r.get("/agency/competitor/meta-harvest-insights/:id", expansionRequireAuth, expansionRequireProduct("competitors"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const row = await prisma.metaHarvestInsight.findFirst({
        where: { id: req.params.id, agencyId: scope.agencyId, clientId: scope.clientId },
      });
      if (!row) return apiErr(res, 404, "NOT_FOUND", "Saved report not found");
      return res.json({ insight: jsonHarvestInsight(row) });
    } catch (e) {
      console.error("[meta-harvest-insights/:id]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not load saved report");
    }
  });

  r.get("/agency/competitor/watches", expansionRequireAuth, expansionRequireProduct("competitors"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const watches = await prisma.competitorWatch.findMany({
        where: { agencyId: scope.agencyId, clientId: scope.clientId },
        orderBy: { updatedAt: "desc" },
        include: {
          _count: { select: { ads: true, insights: true } },
        },
      });
      return res.json({ watches });
    } catch (e) {
      console.error("[GET competitor watches]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not list competitor watches");
    }
  });

  r.post("/agency/competitor/watches", expansionRequireAuth, expansionRequireProduct("competitors"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const b = req.body || {};
      const competitorName =
        typeof b.competitorName === "string" && b.competitorName.trim()
          ? b.competitorName.trim().slice(0, 200)
          : "";
      if (!competitorName) return apiErr(res, 400, "VALIDATION", "competitorName is required");
      const competitorWebsite =
        typeof b.competitorWebsite === "string" && b.competitorWebsite.trim()
          ? b.competitorWebsite.trim().slice(0, 500)
          : null;
      let competitorFacebookPageId: string | null = null;
      if (typeof b.competitorFacebookPageId === "string" && b.competitorFacebookPageId.trim()) {
        try {
          competitorFacebookPageId = await resolveCompetitorFacebookPageInput(b.competitorFacebookPageId.trim().slice(0, 2000));
        } catch (e) {
          return apiErr(
            res,
            400,
            "VALIDATION",
            e instanceof Error ? e.message : "Could not use that Facebook Page link. Try a full page URL or numeric id."
          );
        }
      }
      const competitorGoogleAdvertiserId =
        typeof b.competitorGoogleAdvertiserId === "string" && b.competitorGoogleAdvertiserId.trim()
          ? b.competitorGoogleAdvertiserId.trim().slice(0, 200)
          : null;
      const keywords = parseStringArray(b.keywords, 200) as Prisma.InputJsonValue;
      let platforms = parseStringArray(b.platforms, 50);
      if (platforms.length === 0) platforms = ["meta"];
      const isActive = typeof b.isActive === "boolean" ? b.isActive : true;

      const row = await prisma.competitorWatch.create({
        data: {
          agencyId: scope.agencyId,
          clientId: scope.clientId,
          competitorName,
          competitorWebsite,
          competitorFacebookPageId,
          competitorGoogleAdvertiserId,
          keywords,
          platforms: platforms as Prisma.InputJsonValue,
          isActive,
        },
        include: { _count: { select: { ads: true, insights: true } } },
      });
      return res.status(201).json({ watch: row });
    } catch (e) {
      console.error("[POST competitor watch]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not create competitor watch");
    }
  });

  r.get("/agency/competitor/watches/:id", expansionRequireAuth, expansionRequireProduct("competitors"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const row = await prisma.competitorWatch.findFirst({
        where: { id: req.params.id, agencyId: scope.agencyId, clientId: scope.clientId },
        include: {
          insights: { orderBy: { generatedAt: "desc" }, take: 25 },
          ads: { orderBy: { lastSeenAt: "desc" }, take: 40 },
          _count: { select: { ads: true, insights: true } },
        },
      });
      if (!row) return apiErr(res, 404, "NOT_FOUND", "Watch not found");
      return res.json({ watch: row });
    } catch (e) {
      console.error("[GET competitor watch]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not load competitor watch");
    }
  });

  r.patch("/agency/competitor/watches/:id", expansionRequireAuth, expansionRequireProduct("competitors"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const existing = await prisma.competitorWatch.findFirst({
        where: { id: req.params.id, agencyId: scope.agencyId, clientId: scope.clientId },
      });
      if (!existing) return apiErr(res, 404, "NOT_FOUND", "Watch not found");
      const b = req.body || {};
      const data: Prisma.CompetitorWatchUncheckedUpdateInput = {};
      if (typeof b.competitorName === "string" && b.competitorName.trim()) {
        data.competitorName = b.competitorName.trim().slice(0, 200);
      }
      if (b.competitorWebsite !== undefined) {
        data.competitorWebsite =
          b.competitorWebsite === null || b.competitorWebsite === ""
            ? null
            : String(b.competitorWebsite).trim().slice(0, 500);
      }
      if (b.competitorFacebookPageId !== undefined) {
        if (b.competitorFacebookPageId === null || b.competitorFacebookPageId === "") {
          data.competitorFacebookPageId = null;
        } else {
          try {
            const raw = String(b.competitorFacebookPageId).trim().slice(0, 2000);
            const resolved = await resolveCompetitorFacebookPageInput(raw);
            data.competitorFacebookPageId = resolved;
          } catch (e) {
            return apiErr(
              res,
              400,
              "VALIDATION",
              e instanceof Error ? e.message : "Could not use that Facebook Page link. Try a full page URL or numeric id."
            );
          }
        }
      }
      if (b.competitorGoogleAdvertiserId !== undefined) {
        data.competitorGoogleAdvertiserId =
          b.competitorGoogleAdvertiserId === null || b.competitorGoogleAdvertiserId === ""
            ? null
            : String(b.competitorGoogleAdvertiserId).trim().slice(0, 200);
      }
      if (b.keywords !== undefined) data.keywords = parseStringArray(b.keywords, 200) as Prisma.InputJsonValue;
      if (b.platforms !== undefined) {
        const pl = parseStringArray(b.platforms, 50);
        data.platforms = (pl.length ? pl : ["meta"]) as Prisma.InputJsonValue;
      }
      if (typeof b.isActive === "boolean") data.isActive = b.isActive;

      const row = await prisma.competitorWatch.update({
        where: { id: existing.id },
        data,
        include: { _count: { select: { ads: true, insights: true } } },
      });
      return res.json({ watch: row });
    } catch (e) {
      console.error("[PATCH competitor watch]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not update competitor watch");
    }
  });

  r.delete("/agency/competitor/watches/:id", expansionRequireAuth, expansionRequireProduct("competitors"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const result = await prisma.competitorWatch.deleteMany({
        where: { id: req.params.id, agencyId: scope.agencyId, clientId: scope.clientId },
      });
      if (result.count === 0) return apiErr(res, 404, "NOT_FOUND", "Watch not found");
      return res.json({ ok: true });
    } catch (e) {
      console.error("[DELETE competitor watch]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not delete competitor watch");
    }
  });

  /** Full scan: website snapshot (SSRF-safe), optional Meta Ad Library, OpenAI-structured insight. */
  r.post("/agency/competitor/watches/:id/scan", expansionRequireAuth, expansionRequireProduct("competitors"), async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const scope = await resolveLandingScope(req, res);
      if (!scope) return;
      const watch = await prisma.competitorWatch.findFirst({
        where: { id: req.params.id, agencyId: scope.agencyId, clientId: scope.clientId },
      });
      if (!watch) return apiErr(res, 404, "NOT_FOUND", "Watch not found");
      const now = new Date();
      await prisma.competitorWatch.update({
        where: { id: watch.id },
        data: { lastScannedAt: now },
      });
      const manualSummary =
        typeof req.body?.summary === "string" && req.body.summary.trim() ? req.body.summary.trim().slice(0, 8000) : null;

      let summary: string;
      let topThemes: Prisma.InputJsonValue;
      let suggestedCounterAngles: Prisma.InputJsonValue;
      let strongestAds: Prisma.InputJsonValue;
      let competitivePack: Prisma.InputJsonValue | null = null;
      let rawPromptUsed: string | null = null;
      let scanDiagnostics: { scanNotes: string[] } | null = null;
      if (manualSummary) {
        summary = manualSummary;
        topThemes = [] as Prisma.InputJsonValue;
        suggestedCounterAngles = [] as Prisma.InputJsonValue;
        strongestAds = [] as Prisma.InputJsonValue;
      } else {
        const out = await runCompetitorScanForWatch(watch);
        summary = out.summary;
        topThemes = out.topThemes;
        suggestedCounterAngles = out.suggestedCounterAngles;
        strongestAds = out.strongestAds;
        competitivePack = out.competitivePack;
        rawPromptUsed = out.rawPromptUsed;
        scanDiagnostics = { scanNotes: out.scanNotes };
      }

      const insight = await prisma.competitorInsight.create({
        data: {
          watchId: watch.id,
          summary,
          topThemes,
          suggestedCounterAngles,
          strongestAds,
          competitivePack: competitivePack ?? undefined,
          rawPromptUsed,
        },
      });
      const row = await prisma.competitorWatch.findFirst({
        where: { id: watch.id },
        include: {
          insights: { orderBy: { generatedAt: "desc" }, take: 25 },
          ads: { orderBy: { lastSeenAt: "desc" }, take: 40 },
          _count: { select: { ads: true, insights: true } },
        },
      });
      return res.json({ watch: row, insight, diagnostics: scanDiagnostics });
    } catch (err: unknown) {
      console.error("[scan competitor]", err);
      const em = err instanceof Error ? err.message : String(err);
      if (
        /competitivePack|Unknown field|column .* does not exist|does not exist in the current database|Invalid.*invocation/i.test(
          em
        )
      ) {
        return apiErr(
          res,
          500,
          "SERVER_ERROR",
          "Scan could not be saved: the server database is missing a recent update. Your team should run: npx prisma db push (or deploy the latest migration), then try again."
        );
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        const code = err.code;
        if (code === "P2002" || code === "P2011") {
          return apiErr(
            res,
            500,
            "SERVER_ERROR",
            "Scan failed due to a data conflict. Try again, or contact support if it keeps happening."
          );
        }
      }
      return apiErr(
        res,
        500,
        "SERVER_ERROR",
        "Scan failed. If this happens again, your team can check the server log for [scan competitor]."
      );
    }
  });

  const notImpl =
    (name: string) =>
    (_req: Request, res: Response): Response =>
      apiErr(
        res,
        501,
        "NOT_IMPLEMENTED",
        `${name} is not implemented yet — database schema and Module 1–2 routes are live.`
      );

  r.use("/dfy", expansionRequireAuth, expansionRequireProduct("dfy"), (_req, res) => notImpl("DFY API")(_req, res));
  r.use("/client", expansionRequireAuth, expansionRequireProduct("kits"), (_req, res) => notImpl("Client kit assets API")(_req, res));

  return r;
}
