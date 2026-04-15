import express, { Request, Response, NextFunction, Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import dns from "dns/promises";
import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";

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

  r.get("/agency/branding", expansionRequireAuth, requireAgency, async (req: ExpansionAuthRequest, res: Response) => {
    try {
      const row = await prisma.agencyBranding.findUnique({ where: { userId: req.user!.id } });
      return res.json({ branding: row });
    } catch (e) {
      console.error("[GET /agency/branding]", e);
      return apiErr(res, 500, "SERVER_ERROR", "Could not load branding");
    }
  });

  r.put("/agency/branding", expansionRequireAuth, requireAgency, async (req: ExpansionAuthRequest, res: Response) => {
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

  r.post("/agency/branding/domain/verify-init", expansionRequireAuth, requireAgency, async (req: ExpansionAuthRequest, res: Response) => {
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

  r.post("/agency/branding/domain/verify-check", expansionRequireAuth, requireAgency, async (req: ExpansionAuthRequest, res: Response) => {
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

  r.get("/agency/kits", expansionRequireAuth, requireAgency, async (req: ExpansionAuthRequest, res: Response) => {
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
          apiErr(res, 403, "FORBIDDEN", "Not allowed to manage this client's landing pages");
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

  r.get("/agency/landing-pages", expansionRequireAuth, async (req: ExpansionAuthRequest, res: Response) => {
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

  r.post("/agency/landing-pages", expansionRequireAuth, async (req: ExpansionAuthRequest, res: Response) => {
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

  r.get("/agency/landing-pages/:id", expansionRequireAuth, async (req: ExpansionAuthRequest, res: Response) => {
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

  r.patch("/agency/landing-pages/:id", expansionRequireAuth, async (req: ExpansionAuthRequest, res: Response) => {
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

  r.delete("/agency/landing-pages/:id", expansionRequireAuth, async (req: ExpansionAuthRequest, res: Response) => {
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

  r.post("/agency/kits/:kitId/install", expansionRequireAuth, requireAgency, async (req: ExpansionAuthRequest, res: Response) => {
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

  const notImpl =
    (name: string) =>
    (_req: Request, res: Response): Response =>
      apiErr(
        res,
        501,
        "NOT_IMPLEMENTED",
        `${name} is not implemented yet — database schema and Module 1–2 routes are live.`
      );

  r.use("/reports", notImpl("Reports API"));
  r.use("/dfy", notImpl("DFY API"));
  r.use("/competitor", notImpl("Competitor spy API"));
  r.use("/client", notImpl("Client kit assets API"));

  return r;
}
