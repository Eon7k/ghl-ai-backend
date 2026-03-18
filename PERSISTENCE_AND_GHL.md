# Persistent logins + GHL integration

## 1. Persistent logins and data (required)

The backend now uses **PostgreSQL** (via Prisma) so that:

- **Accounts persist** – You don’t have to create an account every time; login works across restarts.
- **Data is saved** – Campaigns, creatives, integrations (Meta/TikTok/Google), and variants are stored in the database.

### Setup

1. **Create a PostgreSQL database**
   - **Local:** [Postgres.app](https://postgresapp.com/) or Docker: `docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres`
   - **Cloud (free tiers):** [Neon](https://neon.tech), [Supabase](https://supabase.com), or [Render PostgreSQL](https://render.com/docs/databases)

2. **Set `DATABASE_URL`**
   - In **backend** `.env` (and on Render → Environment):
   ```bash
   DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE_NAME?sslmode=require
   ```
   - Example (Neon): `postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require`

3. **Create tables**
   From the backend folder:
   ```bash
   npx prisma db push
   ```
   Or for migrations:
   ```bash
   npx prisma migrate dev --name init
   ```

4. **Run the backend**
   ```bash
   npm run dev
   ```
   You should see `[DB] Connected to database.` and `Backend listening on port 4000`.

After this, sign up and log in once; your user and all campaigns/creatives/integrations will persist across restarts and deploys.

---

## 2. GoHighLevel (GHL) integration – campaigns working seamlessly

The app is built to run **inside GoHighLevel** (e.g. as a Custom Page in an iframe) and to work with your GHL account.

### Embed in GHL

1. **Custom Page / iframe**
   - In GHL, create a **Custom Page** or **Custom Application** that loads your app URL in an iframe.
   - Use your **frontend** URL (e.g. `https://your-app.vercel.app`).
   - The frontend already uses a **same-origin API proxy** (`/api/proxy`) so that when embedded in GHL, requests go to your domain and are proxied to the backend without CORS issues.

2. **Optional: pass GHL context**
   - GHL can pass location/user context via URL parameters or template variables (e.g. `{{location.id}}`, `{{user.id}}`).
   - You can append these to the app URL when embedding, e.g.:
     `https://your-app.vercel.app?location_id={{location.id}}`
   - The frontend can read `location_id` (or similar) from the URL and send it to the backend if you add an endpoint to associate the session with a GHL location (for future features like “campaigns for this location”).

### Optional: GHL OAuth (for deeper integration)

To link the app to a GHL **location** or **agency** (e.g. manage contacts, pipelines, or sync campaign results):

1. **Create an app in the GHL Marketplace**
   - [App Creation Guide](https://marketplace.gohighlevel.com/docs/oauth/AppCreationGuide)
   - Set redirect/callback URL to your backend, e.g. `https://your-backend.onrender.com/ghl/callback`

2. **Environment variables (backend)**
   ```bash
   GHL_CLIENT_ID=your-ghl-client-id
   GHL_CLIENT_SECRET=your-ghl-client-secret
   GHL_REDIRECT_URI=https://your-backend.onrender.com/ghl/callback
   ```

3. **Backend routes (you can add later)**
   - `GET /ghl/connect` – redirect user to GHL OAuth.
   - `GET /ghl/callback` – exchange code for tokens, store per user/location, then redirect back to the frontend.

4. **Use GHL APIs**
   - With an access token you can call [GHL APIs](https://marketplace.gohighlevel.com/docs) (contacts, opportunities, etc.) so campaigns can use or update GHL data.

For “campaigns working as seamlessly as possible” with GHL today:

- **Embed** the app in GHL (Custom Page/iframe) so users never leave GHL.
- **Optionally** pass `location_id` (or similar) in the URL so the app knows which GHL location is open.
- Add **GHL OAuth** when you need to read/write GHL data (contacts, pipelines) from the app.
