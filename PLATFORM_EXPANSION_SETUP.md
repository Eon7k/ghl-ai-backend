# Platform expansion (full agency roadmap)

This document tracks the **large-scale expansion** described in `cursor_prompt_full_platform_expansion.md`, adapted to this codebase (**Express + TypeScript + Prisma + Next.js**).

## What is implemented now

1. **Database (Prisma)** — Models for all six modules:
   - Module 1: `AgencyBranding` (keyed by agency `User.id`)
   - Module 2: `VerticalKit`, `VerticalKitItem`, `AgencyKit`, `AgencyKitAsset`
   - Module 3: `LandingPage`, `LandingPageAnalytics`
   - Module 4: `ReportConfig`, `GeneratedReport`
   - Module 5: `DfyEngagement`, `DfyOnboardingStep`, `DfyActivityLog`, `DfyClientMessage`
   - Module 6: `CompetitorWatch`, `CompetitorAd`, `CompetitorInsight`
   - `User.role` optional string for future RBAC (`super_admin`, `agency_admin`, etc.)

2. **Module 1 — White label (backend + frontend)**  
   - Routes under **`/api`** on the backend (proxied from the Next app as `/api/proxy/api/...`):
     - `GET /api/resolve-brand?domain=` (public)
     - `GET|PUT /api/agency/branding`
     - `POST /api/agency/branding/logo`, `.../favicon` (multipart `file`)
     - `POST /api/agency/branding/domain/verify-init`, `.../verify-check`
   - Static files: `GET /uploads/branding/*` (from `UPLOADS_PATH`, default `./uploads`)
   - Middleware: `attachBrandingHost` sets `req.hostBranding` when `Host` matches a verified `customDomain`
   - Frontend: `/settings/white-label`, `BrandingHostBootstrap`, CSS variables `--brand-*`

3. **Module 2 — Partial**  
   - `GET /api/admin/vertical-kits`, `POST /api/admin/vertical-kits` (requires `ADMIN_EMAILS`)  
   - `GET /api/agency/kits`, `POST /api/agency/kits/:kitId/install`

4. **Modules 3–6 — API stubs**  
   - `GET`/`POST` under `/api/landing-pages`, `/api/reports`, `/api/dfy`, `/api/competitor`, `/api/client` return **501** with a JSON error until implemented.

## Apply the schema

From `ghl-ai-backend`:

```bash
npx prisma db push
```

(or create a migration in production: `npx prisma migrate dev`)

## Environment variables

See `.env.example`. Expansion-related:

| Variable | Purpose |
|----------|---------|
| `UPLOADS_PATH` | Root for branding uploads (default `./uploads`) |
| `BACKEND_URL` | Public base URL for absolute logo/favicon URLs (e.g. `https://api.example.com`) |
| `ADMIN_EMAILS` | Comma-separated emails allowed to use `/api/admin/vertical-kits` |

Planned for later modules (not wired yet):

- `META_AD_LIBRARY_API_TOKEN`, SMTP_*, `LANDING_PAGE_BASE_DOMAIN`, `EXPORTS_PATH`, `REPORTS_PATH`, etc.

## Frontend proxy

- JSON APIs use `/api/proxy/<backend-path>`.
- New routes use backend path prefix **`api/`** (e.g. `api/agency/branding`).
- **PUT** is supported by the proxy for branding updates.

## Custom domain checklist

1. In **White label** settings, set brand fields and run **Start verification** for your hostname (e.g. `ads.client.com`).
2. Add the **TXT** record returned by the API at your DNS host.
3. Run **Check verification**. When successful, `customDomainVerified` is true.
4. Point the hostname (CNAME or A) to your **frontend** host (e.g. Vercel). Theme resolution uses `GET /api/resolve-brand?domain=<hostname>`.

## Build order for remaining work (from original spec)

1. Landing page builder: Node routes + OpenAI (or Python service) + public `GET /p/:subdomain/:slug`
2. Reports: Python/weasyprint or Node PDF + scheduler + SMTP
3. Vertical kits: marketplace UI + admin kit builder CRUD
4. DFY: engagements API + agency + client read-only views
5. Competitor spy: Meta Ad Library + scheduler + UI  
6. RBAC: enforce `User.role` on all `/api/*` routes; align with spec’s agency/client permissions

## Cron / jobs

Not scheduled yet. When adding:

- Report scheduler (hourly)
- Competitor scan (every 6 hours)

use Render cron, a worker process, or `node-cron` in a dedicated entry file.
