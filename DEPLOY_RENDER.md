# Deploying on Render (database connections)

## `prisma:error ... Error { kind: Closed, cause: None }`

This usually means **the database server (or a proxy) closed an idle connection**. Your boot sequence can still be fine (`[DB] Connected` → `listening on port …`).

- **If API calls still work:** The log is often Prisma noticing a dead socket; the **next query opens a new connection**. You can treat it as noisy.
- **If the next request fails** (timeouts, `P1001`, 500s): Fix the connection string / pooling (below).

## Things that trigger idle disconnects

1. **Neon / serverless Postgres** – Use the **pooled** connection string (host often contains `pooler` or `-pooler`). Prefer that for `DATABASE_URL` on long-running Node.
2. **Supabase** – Use the **Transaction pooler** (port `6543`) for the app; keep the direct URL for migrations only.
3. **Very low connection limits** – Free tiers may close sessions aggressively.

## Prisma: pooled URL + direct URL (recommended with PgBouncer)

When your host gives you **both** a pooler URL and a direct URL:

1. In Render **Environment**:
   - `DATABASE_URL` = **pooled** (for `node dist/index.js`)
   - `DIRECT_URL` = **direct** (for `prisma migrate` / `db push` from your machine or CI)

2. In `prisma/schema.prisma`:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}
```

Add `DIRECT_URL` to Render only if you run migrations from Render; otherwise local/CI is enough.

For **transaction-mode** poolers, some providers require `?pgbouncer=true` on `DATABASE_URL` (check your provider’s Prisma docs).

## Quick URL tweaks (non-pooler Postgres)

Append query params as supported by your host, for example:

- `connect_timeout=30`
- `connection_limit=5` (Prisma reads this from the URL)

Example (adjust for your credentials):

`postgresql://user:pass@host:5432/db?sslmode=require&connection_limit=5&connect_timeout=30`

## After schema changes (e.g. new columns)

From a machine that can reach production DB:

```bash
npx prisma db push
# or
npx prisma migrate deploy
```

---

## Render free web tier

Instances **spin down** when idle; the first request can take **~50s+**. That is separate from DB connection closes but can look like “the app died” in the UI.

---

## Render email: “exceeded memory limit” / “memory leak”

Often this is **high peak memory**, not a true leak. This app used to load **every variant’s full base64 image** from the DB when listing or opening campaigns — that can use **hundreds of MB** with many creatives. The backend now loads **metadata only** for those routes and uses a small query to see which variants have an image (`hasCreative`).

**Still helpful on small instances:**

- Set `NODE_OPTIONS=--max-old-space-size=400` (see below).
- Avoid creating **many large image variants** in one request (launch / heavy pages).
- Upgrade to a Render plan with **more RAM** if peaks remain high.

---

## Instance exited with status **134** (SIGABRT)

On small instances this is often **Node/V8 running out of memory** while handling big responses (e.g. **many AI variants**, Prisma, JSON). The default V8 heap can overshoot the container’s RAM limit and the process **aborts**.

**On Render → `ghl-ai-backend` → Environment**, add:

| Key | Suggested value |
|-----|-----------------|
| `NODE_OPTIONS` | `--max-old-space-size=400` |

Use **350–450** depending on stability; stay below the instance RAM so the OS doesn’t OOM-kill you.

Then **Manual Deploy** or push to redeploy. Also try campaigns with **1–3 variants** first to confirm.

If 134 persists, open **Logs** right before the crash (stack trace / “heap” / `prisma`); upgrade to a plan with **more RAM** if needed.
