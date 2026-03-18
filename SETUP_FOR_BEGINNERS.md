# Complete setup guide (beginner-friendly)

This guide explains **everything** you need to do so that:
1. **Logins and data are saved** – You don’t have to create an account every time; your campaigns and creatives stay after you close the app or restart the server.
2. **The app can work with GoHighLevel (GHL)** – You can embed it in GHL and (optionally) connect it to your GHL account later.

---

## Part 1: What changed and why

**Before:** The app kept users and campaigns only in the server’s memory. When you restarted the backend or redeployed, everything was lost.

**Now:** The app uses a **database** (PostgreSQL). When you sign up, log in, create campaigns, or connect Meta/TikTok/Google, that information is stored in the database and stays there until you delete it.

To use this, you need to:
1. Create a database (or use one from a hosting provider).
2. Tell the backend how to connect to it using a **connection string** in your `.env` file.
3. Run a one-time command so the backend creates the right tables in the database.

---

## Part 2: Get a PostgreSQL database

PostgreSQL is the type of database the app uses. You need **one** of these options.

### Option A: Free cloud database (easiest if you’re not sure)

1. Go to **[Neon](https://neon.tech)** (or [Supabase](https://supabase.com)).
2. Sign up (free).
3. Create a new project (e.g. name it `ghl-ai`).
4. After it’s created, the site will show a **connection string**. It looks like:
   ```text
   postgresql://username:password@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
5. **Copy that whole string** – you’ll paste it into your backend `.env` in Part 3.

### Option B: Database on Render (if your backend is on Render)

1. In [Render](https://render.com), open your **backend** service.
2. Click **New +** → **PostgreSQL**.
3. Create the database (name it e.g. `ghl_ai`).
4. Open the new database; Render shows **Internal Database URL** (and sometimes **External**).
5. **Copy the Internal Database URL** – you’ll use it in Render’s environment (see Part 3).

### Option C: PostgreSQL on your computer (local only)

- Install [Postgres.app](https://postgresapp.com/) (Mac) or [PostgreSQL](https://www.postgresql.org/download/) (Windows).
- Create a database, e.g. in a terminal:
  ```bash
  createdb ghl_ai
  ```
- Your connection string will look like:
  ```text
  postgresql://localhost:5432/ghl_ai
  ```
  (If you set a username/password, include them: `postgresql://USER:PASSWORD@localhost:5432/ghl_ai`.)

---

## Part 3: Tell the backend how to connect to the database

The backend reads the connection string from an environment variable named **`DATABASE_URL`**.

### If you run the backend on your computer (local)

1. Open the **backend** project folder: `ghl-ai-backend`.
2. Open the file named **`.env`** (create it if it doesn’t exist).
3. Add **exactly** this line (replace the value with your real connection string from Part 2):

   ```env
   DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE_NAME?sslmode=require
   ```

   Example (Neon):

   ```env
   DATABASE_URL=postgresql://myuser:abc123xyz@ep-cool-name-12345.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

4. Save the file.  
   **Important:** Don’t share this file or put it in Git; it contains secrets.

### If you run the backend on Render (or another host)

1. Open your **backend** service on Render.
2. Go to **Environment** (left sidebar).
3. Click **Add Environment Variable**.
4. **Key:** `DATABASE_URL`  
   **Value:** paste your full connection string (from Part 2, e.g. the Internal Database URL if you created the DB on Render).
5. Save. Render will redeploy; that’s normal.

---

## Part 4: Install dependencies and create the tables

Do this **once** after you’ve set `DATABASE_URL`.

1. Open a **terminal** (Mac: Terminal app; Windows: Command Prompt or PowerShell).
2. Go into the backend folder. For example:

   ```bash
   cd /Users/argylecryo/Documents/ghl-ai-backend
   ```

   (If your folder is somewhere else, use that path instead.)

3. Install packages (this includes Prisma and the database driver):

   ```bash
   npm install
   ```

4. Create the tables in your database:

   ```bash
   npx prisma db push
   ```

   You should see something like: “Your database is now in sync with your schema.”  
   If you see an error about `DATABASE_URL`, go back to Part 3 and fix the `.env` (or Render env).

5. Start the backend:

   ```bash
   npm run dev
   ```

   You should see:
   - `[DB] Connected to database.`
   - `Backend listening on port 4000`

   If you see **“DATABASE_URL is required”** or **“Database connection failed”**, the connection string is missing or wrong. Double-check Part 2 and Part 3.

---

## Part 5: Test that logins and data are saved

1. In the browser, open your **frontend** (e.g. `http://localhost:3000` or your Vercel URL).
2. **Sign up** with an email and password (at least 8 characters).
3. You should be logged in. Create a campaign or upload a creative if you want.
4. **Stop the backend** (in the terminal press `Ctrl+C`).
5. **Start it again:** `npm run dev`.
6. Open the app again and **log in** with the same email and password.  
   Your account and any campaigns/creatives should still be there.  
   That means the database is working and logins/data are persistent.

---

## Part 6: GoHighLevel (GHL) – making campaigns work with GHL

The app is built so it can run **inside** GoHighLevel (e.g. as a page or tab that loads your app in an iframe).

### What “working with GHL” means here

- **Embedding:** Your app (frontend) is loaded inside GHL so users don’t leave GHL to use it.
- **Same behavior:** Creating campaigns, connecting Meta/TikTok/Google, and using the Creative library work the same; the frontend already talks to your backend through a proxy so it works in an iframe.
- **Optional later:** You can add a GHL OAuth connection so the app can read/write GHL data (contacts, pipelines, etc.); that’s described in `PERSISTENCE_AND_GHL.md` when you’re ready.

### Steps to embed the app in GHL

1. **Deploy your frontend** to a public URL (e.g. Vercel). You should already have a URL like `https://your-app.vercel.app`.
2. In **GoHighLevel**, create a **Custom Page** or **Custom Application** (or use your product’s “iframe” / “embed” option).
3. Set the **URL** of that page to your frontend URL, e.g.  
   `https://your-app.vercel.app`
4. When users open that page in GHL, they’ll see your app inside GHL. They can sign up, log in, create campaigns, and connect ad accounts as usual.  
   Logins and data are still stored in **your** backend and database (from Part 1–5), not in GHL’s database.

### Optional: pass GHL context (e.g. location) into the app

- Some GHL setups let you add query parameters to the URL, e.g.  
  `https://your-app.vercel.app?location_id=123`
- Your frontend can read `location_id` from the URL and send it to the backend if you later add an endpoint that uses it (e.g. to associate campaigns with a GHL location).  
  You don’t have to do this for basic “campaigns working seamlessly” inside GHL; it’s for when you want tighter GHL integration.

---

## Part 7: Checklist

Use this to make sure you didn’t skip anything.

- [ ] I have a PostgreSQL database (Neon, Supabase, Render, or local).
- [ ] I copied the **full** connection string (starts with `postgresql://`).
- [ ] I added **`DATABASE_URL`** to:
  - [ ] **Local:** `ghl-ai-backend/.env`
  - [ ] **Render (or other host):** the service’s Environment variables
- [ ] I ran **`npm install`** in the backend folder.
- [ ] I ran **`npx prisma db push`** in the backend folder (and it said the database is in sync).
- [ ] I started the backend with **`npm run dev`** and saw **`[DB] Connected to database.`** and **`Backend listening on port 4000`**.
- [ ] I signed up in the app, then restarted the backend, then logged in again and saw my data still there.
- [ ] (Optional) I embedded my frontend URL in GHL so the app opens inside GHL.

---

## Part 8: If something goes wrong

### “DATABASE_URL is required”
- You didn’t add `DATABASE_URL` to `.env` (local) or to the host’s environment (e.g. Render).  
- Fix: Add it exactly as in Part 3, with no spaces around the `=`.

### “Database connection failed” or “Connection refused”
- The connection string is wrong, or the database isn’t running, or your IP isn’t allowed.  
- Fix: Copy the string again from Neon/Supabase/Render; for cloud DBs, make sure you’re using the URL they give you (sometimes “external” vs “internal” on Render).

### “npm install” or “npx prisma” not found
- Node/npm aren’t installed or aren’t in your PATH.  
- Fix: Install [Node.js](https://nodejs.org) (LTS), then open a **new** terminal and try again from the backend folder.

### Tables already exist / “schema drift”
- If you changed the schema and see errors, you can try:  
  `npx prisma db push --accept-data-loss`  
  (Only if you’re okay losing data in that database. For a new DB, `npx prisma db push` is enough.)

### I’m stuck
- Re-read the step that’s failing (Part 2, 3, or 4).  
- Check `PERSISTENCE_AND_GHL.md` in the backend for a shorter, non-beginner version and links (e.g. Neon, GHL docs).

---

## Quick reference: commands you’ll use

Run these from the **backend** folder (`ghl-ai-backend`):

| What you want to do              | Command              |
|----------------------------------|----------------------|
| Install packages                 | `npm install`        |
| Create/update database tables   | `npx prisma db push` |
| Start the backend (development) | `npm run dev`        |

Your **frontend** doesn’t need a database. It only needs to point to your backend URL (e.g. in the frontend’s `.env.local`: `NEXT_PUBLIC_BACKEND_URL` or `NEXT_PUBLIC_API_URL`).  
Once `DATABASE_URL` is set and the backend connects, logins and all campaign/creative/integration data are saved in the database and persist across restarts and deploys.
