# Connect OpenAI so the AI ad generation works

The backend uses **OpenAI** (e.g. gpt-4o-mini) to generate ad copy when you create an experiment with “AI-generated” creatives and when you click “Regenerate with AI.” It reads the key from the **OPENAI_API_KEY** environment variable.

Follow these steps so it works **locally** and **on Render**.

---

## Step 1 — Get an OpenAI API key (if you don’t have one)

1. In your browser, go to **https://platform.openai.com** and log in (or create an account).
2. Click your **profile icon** (top right) → **View API keys** (or go to **https://platform.openai.com/api-keys**).
3. Click **Create new secret key**.
4. Give it a name (e.g. “ghl-ai-backend”) and click **Create secret key**.
5. **Copy the key** (it starts with `sk-...`). You won’t see it again; store it somewhere safe.
6. You’ll paste this key in Step 2 (local) and Step 3 (Render). Never commit it to Git or put it in frontend code.

---

## Step 2 — Set the key locally (so AI works when you run the backend on your Mac)

1. Open your **ghl-ai-backend** folder in Cursor (or Finder).
2. In the **root** of ghl-ai-backend (same level as `package.json`), create or open a file named **`.env`** (no name before the dot, extension is `.env`).
3. Add this line, replacing the value with your real key (keep the quotes if you want; some setups allow no quotes):
   ```bash
   OPENAI_API_KEY=sk-your-actual-key-here
   ```
4. Save the file.
5. **Important:** The file **.env** should already be in **.gitignore**. If it isn’t, add a line **`.env`** to **.gitignore** so the key is never pushed to GitHub.
6. Restart your backend (stop with Ctrl+C, then run `npm run dev` or `npm start` again). When you create an experiment with “AI-generated” or click “Regenerate with AI,” the backend will use this key.

---

## Step 3 — Set the key on Render (so AI works in production)

1. In your browser, go to **https://dashboard.render.com** and log in.
2. Click the **service** that runs your backend (the one connected to **Eon7k/ghl-ai-backend**).
3. In the left sidebar, click **Environment** (or **Environment Variables**).
4. Under **Environment Variables**, click **Add Environment Variable** (or **Add Variable**).
5. **Key:** type exactly:
   ```text
   OPENAI_API_KEY
   ```
6. **Value:** paste your OpenAI API key (the same `sk-...` key from Step 1). Do not add quotes unless Render’s UI adds them.
7. Click **Save** (or **Add**).
8. **Redeploy** the service so it picks up the new variable:
   - Go to the **Manual Deploy** button (top right) → **Deploy latest commit** (or **Clear build cache & deploy** if you prefer).
   - Wait until the deploy status is **Live**.

After this, when you use the **live** app (Vercel frontend + Render backend), creating an experiment with “AI-generated” or clicking “Regenerate with AI” will use the key on Render.

---

## Step 4 — Confirm it’s working

1. Open your **live** app (Vercel URL).
2. Go to **Experiments** → **+ New Experiment**.
3. Choose **“AI-generated (from prompt below)”**, enter a short prompt (e.g. “Dental implants offer, same-day consultation”), set **10** variants, and click **Create experiment**.
4. You should land on the experiment detail page with **10 AI-generated ad copies** (not placeholders like “[Variant 1]…”).
5. Click **Regenerate with AI** on one variant; the text should change to a new AI-generated copy.

If you see an error (e.g. 500, or “Failed to generate ad copy”):

- **On Render:** Open the service → **Logs**, and look for errors mentioning “OPENAI” or “401” / “invalid_api_key”. That usually means the key is missing or wrong on Render (re-check Step 3).
- **Locally:** In the terminal where the backend is running, look for the same errors or for the warning: `OPENAI_API_KEY is not set or invalid`. If you see that, fix the **.env** file (Step 2) and restart the backend.

---

## Summary

| Where        | What to do |
|-------------|------------|
| **Your machine** | Create **.env** in **ghl-ai-backend** with `OPENAI_API_KEY=sk-...`. Keep **.env** in **.gitignore**. Restart the backend. |
| **Render**       | Add env var **OPENAI_API_KEY** with your key. Save. **Manual Deploy** → **Deploy latest commit**. Wait until **Live**. |

Once the key is set in both places, the backend is connected to OpenAI and the product can use AI ad generation and regenerate in development and production.
