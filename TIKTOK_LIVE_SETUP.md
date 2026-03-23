# TikTok Ads — go live with this app

Your app already supports **Connect TikTok** (OAuth) and **listing advertisers**. After deploying the TikTok **launch** code, you can create real **campaign → ad group → single-image ads** from a draft campaign.

## 1. TikTok for Developers

1. Create / open your app (approved).
2. **Redirect URI** (exact):  
   `https://<YOUR-BACKEND>/integrations/tiktok/callback`  
   Example: `https://ghl-ai-backend.onrender.com/integrations/tiktok/callback`
3. Enable **Marketing API** permissions your product needs (campaign / ad management, asset upload).

## 2. Render (or host) — environment variables

| Variable | Description |
|----------|-------------|
| `TIKTOK_APP_ID` | App ID from TikTok for Developers |
| `TIKTOK_APP_SECRET` | Secret (same screen) |
| `BACKEND_URL` | Public `https://` URL of this API (no trailing slash) |
| `FRONTEND_URL` | Public `https://` URL of the web app (OAuth redirect after connect) |

Optional:

| Variable | Description |
|----------|-------------|
| `TIKTOK_OBJECTIVE_TYPE` | If TikTok rejects `TRAFFIC`, set another allowed objective for your account (see TikTok docs). |

## 3. Database (new columns)

After pulling the schema that adds `tiktokCampaignId` / `tiktokAdGroupId` on `Experiment`:

```bash
cd /path/to/ghl-ai-backend
npx prisma db push
```

(Use your production `DATABASE_URL` when updating production.)

## 4. Identity (required by TikTok for ads)

TikTok requires a **posting identity** on the advertiser before ads can run.

- In **TikTok Ads Manager**, open the same **advertiser** and ensure a **TikTok account / customized identity** is linked.
- In the app campaign page you can choose **Automatic** (first identity returned by the API) or pick a specific identity from the dropdown.

If launch fails with an identity error, fix identity in Ads Manager or select the correct row in the UI.

## 5. Launch flow in the product

1. User connects TikTok (**Integrations**).
2. Create a **TikTok** campaign with variants and **generated images** (single-image ads use your PNG creatives).
3. Open the campaign → **Launch to TikTok Ads**:
   - Choose **Advertiser**
   - Enter a real **landing page URL** (required; not `https://example.com`)
   - Optional: **Posting identity**
   - Select variants to include
   - **Launch (live)** or **Launch as dry run** (creates assets but keeps campaign/ad group **disabled** — verify in TikTok Ads Manager)

Targeting defaults in code: **US**, broad ages, **TikTok placement** only. Adjust in TikTok Ads Manager or extend `src/tiktokMarketing.ts` later.

## 6. Reporting

Campaign **performance numbers** in the app are still **Meta-oriented**. For TikTok, use **TikTok Ads Manager** until reporting is integrated.

## 7. Troubleshooting

- **401 / invalid token**: Reconnect TikTok from Integrations.
- **Objective / enum errors**: Set `TIKTOK_OBJECTIVE_TYPE` or update `tiktokMarketing.ts` to match your account’s allowed values.
- **Image upload errors**: Ensure images are valid PNG/JPEG bytes; size within TikTok limits.
- **502 from your backend**: Read Render logs — TikTok returns `code` + `message` in JSON; we surface that in the API error.
