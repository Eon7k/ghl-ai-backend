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
