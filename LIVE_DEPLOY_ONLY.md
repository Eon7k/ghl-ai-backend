# Deploy to live only (no local testing)

Use this if you **only** want to run the app on the live URLs (Render + Vercel) and don’t care about running it on your computer.

---

## 1. Database (you already have Neon)

You’re using **Neon**. Keep your connection string handy; you’ll add it to **Render** in the next step.

Example shape (yours will be different):
```text
postgresql://USER:PASSWORD@ep-xxxx.neon.tech/neondb?sslmode=require&channel_binding=require
```

---

## 2. Backend on Render – environment variables

Your backend runs on **Render**. All config for the **live** backend is in Render’s dashboard, not in a local `.env`.

1. Go to [Render](https://render.com) → your **backend** service (ghl-ai-backend).
2. Open **Environment** in the left sidebar.
3. Add these variables (use **Add Environment Variable** for each). Replace values with your real ones.

| Key | Value | Notes |
|-----|--------|--------|
| `DATABASE_URL` | Your full Neon connection string | Same one you used locally (from Neon dashboard). |
| `JWT_SECRET` | A long random string (e.g. 32+ characters) | Use a different value than local; keep it secret. |
| `PORT` | `4000` | Render often sets this automatically; add only if needed. |
| `OPENAI_API_KEY` | Your OpenAI API key | From OpenAI dashboard. |
| `ANTHROPIC_API_KEY` | (optional) Your Anthropic key | Only if you use Anthropic. |
| `FRONTEND_URL` | Your live frontend URL | e.g. `https://your-app.vercel.app` (no trailing slash). |
| `BACKEND_URL` | Your live backend URL | e.g. `https://your-backend.onrender.com` (no trailing slash). |

**OAuth (only if you use Meta/TikTok/Google connect):**

| Key | Value |
|-----|--------|
| `META_APP_ID` | From Meta for Developers app |
| `META_APP_SECRET` | From Meta for Developers app |
| `TIKTOK_APP_ID` | From TikTok for Developers (if used) |
| `TIKTOK_APP_SECRET` | From TikTok for Developers (if used) |
| `TIKTOK_OBJECTIVE_TYPE` | (optional) Only if TikTok rejects default `TRAFFIC` — see **TIKTOK_LIVE_SETUP.md** |

After schema changes for TikTok launch, run **`npx prisma db push`** against production. Full TikTok checklist: **`TIKTOK_LIVE_SETUP.md`**.
| `GOOGLE_CLIENT_ID` | From Google Cloud (if used) |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud (if used) |

4. Save. Render will redeploy the backend.

**Important:** The **live** backend uses only these Render env vars. It does **not** read a `.env` file from your repo.

---

## 3. Create database tables (one time)

The live backend needs tables in your Neon database. Run this **once** from your computer (with the same Neon URL) or from anywhere you have Node and the repo:

```bash
cd /Users/argylecryo/Documents/ghl-ai-backend
npm install
npx prisma db push
```

Your local `.env` must have `DATABASE_URL` set to your Neon URL (you already added it). This command creates/updates tables in **Neon**; it doesn’t start the server. After it succeeds, you don’t need to run it again unless the schema changes.

---

## 4. Frontend on Vercel – environment variables

Your frontend runs on **Vercel**. It only needs to know the **live** backend URL.

1. Go to [Vercel](https://vercel.com) → your frontend project.
2. **Settings** → **Environment Variables**.
3. Add:

| Key | Value |
|-----|--------|
| `NEXT_PUBLIC_BACKEND_URL` | Your live backend URL, e.g. `https://your-backend.onrender.com` |
| or `NEXT_PUBLIC_API_URL` | Same URL (if the app uses this name) |

4. Save and redeploy the frontend (or trigger a new deploy from the Deployments tab).

---

## 5. Push code to go live

Whenever you change code:

**Backend:**
```bash
cd /Users/argylecryo/Documents/ghl-ai-backend
git add -A
git commit -m "Your message"
git push
```
Render will detect the push and redeploy. Env vars (including `DATABASE_URL`) are already set in Render; no need to push `.env`.

**Frontend:**
```bash
cd /Users/argylecryo/Documents/ghl-ai/frontend
git add -A
git commit -m "Your message"
git push
```
Vercel will deploy. Env vars are in Vercel; no need to push `.env.local`.

---

## 6. Don’t commit secrets

- **Backend:** `.env` should be in `.gitignore`. Never commit it. All live config is in Render → Environment.
- **Frontend:** `.env.local` should be in `.gitignore`. Never commit it. All live config is in Vercel → Environment Variables.

If `.env` or `.env.local` is not in `.gitignore`, add them and don’t commit those files.

---

## 7. Quick checklist (live only)

- [ ] Neon database created; connection string copied.
- [ ] **Render** → backend service → **Environment**: `DATABASE_URL`, `JWT_SECRET`, `FRONTEND_URL`, `BACKEND_URL`, and any API keys / OAuth keys you use.
- [ ] Ran `npx prisma db push` once (with `DATABASE_URL` in local `.env` or in the same Neon URL you use on Render).
- [ ] **Vercel** → frontend project → **Environment Variables**: `NEXT_PUBLIC_BACKEND_URL` = your Render backend URL.
- [ ] Pushed backend and frontend; Render and Vercel deployed.
- [ ] Opened **live frontend URL** in the browser; sign up / log in and confirm data persists after refresh.

You don’t need to run the backend or frontend on your computer. Just set env vars on Render and Vercel, run `prisma db push` once, then push code and use the live URLs.
