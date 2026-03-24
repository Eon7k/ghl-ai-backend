/**
 * Google Ads API (REST) — Display campaign + responsive display ads from variant images.
 * Requires GOOGLE_ADS_DEVELOPER_TOKEN and OAuth access with adwords scope.
 * Docs: https://developers.google.com/google-ads/api/docs/start
 */

import axios from "axios";
import type { PrismaClient } from "@prisma/client";

const API_VER = "v20";

function adsBase(customerIdDigits: string): string {
  return `https://googleads.googleapis.com/${API_VER}/customers/${customerIdDigits}`;
}

export function googleAdsApiErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "response" in err) {
    const data = (err as { response?: { data?: unknown } }).response?.data as
      | {
          error?: {
            message?: string;
            details?: Array<{ errors?: Array<{ message?: string }> }>;
          };
        }
      | undefined;
    const inner = data?.error?.details
      ?.flatMap((d) => d.errors?.map((e) => e.message) ?? [])
      .filter(Boolean)
      .join("; ");
    if (inner) return inner;
    if (data?.error?.message) return data.error.message;
  }
  return err instanceof Error ? err.message : "Google Ads API error";
}

/** Refresh access token and persist on ConnectedAccount. */
export async function refreshAndStoreGoogleAccessToken(
  prisma: PrismaClient,
  conn: { id: string; refreshToken: string | null },
  clientId: string,
  clientSecret: string
): Promise<string> {
  if (!conn.refreshToken) {
    throw new Error("Google connection has no refresh token. Reconnect Google with offline access.");
  }
  const tokenRes = await axios.post<{ access_token?: string }>(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: conn.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  const accessToken = tokenRes.data?.access_token;
  if (!accessToken) throw new Error("Google token refresh did not return access_token");
  await prisma.connectedAccount.update({
    where: { id: conn.id },
    data: { accessToken },
  });
  return accessToken;
}

type MutateResult = { results?: Array<{ resourceName?: string }> };

/** Headers for Google Ads API (optional GOOGLE_ADS_LOGIN_CUSTOMER_ID = MCC when accessing client accounts). */
export function googleAdsApiHeaders(accessToken: string, developerToken: string): Record<string, string> {
  const raw = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "").replace(/\D/g, "");
  return {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": developerToken,
    ...(raw ? { "login-customer-id": raw } : {}),
  };
}

async function mutate(
  customerIdDigits: string,
  path: string,
  body: Record<string, unknown>,
  accessToken: string,
  developerToken: string
): Promise<MutateResult> {
  const url = `${adsBase(customerIdDigits)}/${path}:mutate`;
  const res = await axios.post<MutateResult>(url, body, {
    headers: {
      ...googleAdsApiHeaders(accessToken, developerToken),
      "Content-Type": "application/json",
    },
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    throw new Error(googleAdsApiErrorMessage({ response: { data: res.data } }));
  }
  return res.data;
}

function firstResourceName(r: MutateResult): string {
  const name = r.results?.[0]?.resourceName;
  if (!name) throw new Error("Google Ads mutate returned no resourceName");
  return name;
}

function parseIdFromResource(resourceName: string, kind: "campaignBudgets" | "campaigns" | "adGroups"): string {
  const re = new RegExp(`/${kind}/([^/]+)$`);
  const m = resourceName.match(re);
  return m ? m[1] : resourceName;
}

function yyyymmddUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/** Headlines / descriptions for ResponsiveDisplayAd (minimum counts). */
function buildAdTextAssets(copy: string, experimentName: string): {
  headlines: { text: string }[];
  longHeadline: { text: string };
  descriptions: { text: string }[];
} {
  const lines = copy
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const base = lines[0] || experimentName || "Discover more";
  const h1 = base.slice(0, 30);
  const h2 = (lines[1] || `${base} — offer`).slice(0, 30);
  const h3 = (lines[2] || "Learn more today").slice(0, 30);
  const long = (lines.slice(0, 3).join(" ") || base).slice(0, 90);
  const d1 = (lines[0] || base).slice(0, 90);
  const d2 = (lines[1] || `${experimentName} — tap to visit`).slice(0, 90);
  return {
    headlines: [{ text: h1 || "Learn more" }, { text: h2 || "Shop now" }, { text: h3 || "Visit site" }],
    longHeadline: { text: long || h1 },
    descriptions: [{ text: d1 || "See details on our site." }, { text: d2 || "Limited time." }],
  };
}

export type GoogleLaunchVariant = {
  copy: string;
  imageBase64: string;
};

export type LaunchGoogleDisplayResult = {
  campaignId: string;
  adGroupId: string;
};

/**
 * Creates a paused Display campaign, one ad group, and one responsive display ad per variant.
 * If dryRun: leaves everything PAUSED (no enable step).
 */
export async function launchGoogleDisplayCampaign(opts: {
  customerIdDigits: string;
  accessToken: string;
  developerToken: string;
  campaignName: string;
  dailyBudgetUsd: number;
  finalUrl: string;
  businessName: string;
  experimentName: string;
  variants: GoogleLaunchVariant[];
  dryRun: boolean;
}): Promise<LaunchGoogleDisplayResult> {
  const {
    customerIdDigits,
    accessToken,
    developerToken,
    campaignName,
    dailyBudgetUsd,
    finalUrl,
    businessName,
    experimentName,
    variants,
    dryRun,
  } = opts;

  if (variants.length === 0) {
    throw new Error("No variants with images to push to Google Ads.");
  }

  const amountMicros = Math.max(1_000_000, Math.round(Number(dailyBudgetUsd) * 1_000_000));

  const budgetRes = await mutate(
    customerIdDigits,
    "campaignBudgets",
    {
      operations: [
        {
          create: {
            name: `${campaignName} — budget`.slice(0, 255),
            amountMicros: String(amountMicros),
            deliveryMethod: "STANDARD",
            explicitlyShared: false,
          },
        },
      ],
    },
    accessToken,
    developerToken
  );
  const budgetRn = firstResourceName(budgetRes);

  const liveStatus = dryRun ? "PAUSED" : "ENABLED";

  const campaignRes = await mutate(
    customerIdDigits,
    "campaigns",
    {
      operations: [
        {
          create: {
            name: campaignName.slice(0, 255),
            status: liveStatus,
            advertisingChannelType: "DISPLAY",
            campaignBudget: budgetRn,
            containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
            startDate: yyyymmddUtc(new Date()),
          },
        },
      ],
    },
    accessToken,
    developerToken
  );
  const campaignRn = firstResourceName(campaignRes);

  const adGroupRes = await mutate(
    customerIdDigits,
    "adGroups",
    {
      operations: [
        {
          create: {
            name: `${campaignName} — ad group`.slice(0, 255),
            campaign: campaignRn,
            status: liveStatus,
            type: "DISPLAY_STANDARD",
          },
        },
      ],
    },
    accessToken,
    developerToken
  );
  const adGroupRn = firstResourceName(adGroupRes);

  // One logo image (reuse first variant image) — many accounts accept one asset in logo + marketing slots.
  const logoBytes = variants[0].imageBase64;
  const logoAssetRes = await mutate(
    customerIdDigits,
    "assets",
    {
      operations: [
        {
          create: {
            name: `${campaignName} — logo`.slice(0, 255),
            type: "IMAGE",
            imageAsset: { data: logoBytes },
          },
        },
      ],
    },
    accessToken,
    developerToken
  );
  const logoRn = firstResourceName(logoAssetRes);

  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const marketingAssetRes = await mutate(
      customerIdDigits,
      "assets",
      {
        operations: [
          {
            create: {
              name: `${campaignName} — image ${i + 1}`.slice(0, 255),
              type: "IMAGE",
              imageAsset: { data: v.imageBase64 },
            },
          },
        ],
      },
      accessToken,
      developerToken
    );
    const marketingRn = firstResourceName(marketingAssetRes);
    const text = buildAdTextAssets(v.copy, experimentName);

    await mutate(
      customerIdDigits,
      "adGroupAds",
      {
        operations: [
          {
            create: {
              adGroup: adGroupRn,
              status: liveStatus,
              ad: {
                name: `${campaignName} — ad ${i + 1}`.slice(0, 255),
                finalUrls: [finalUrl],
                responsiveDisplayAd: {
                  headlines: text.headlines,
                  longHeadline: text.longHeadline,
                  descriptions: text.descriptions,
                  businessName: businessName.slice(0, 25) || "Brand",
                  marketingImages: [{ asset: marketingRn }],
                  squareMarketingImages: [{ asset: marketingRn }],
                  logoImages: [{ asset: logoRn }],
                },
              },
            },
          },
        ],
      },
      accessToken,
      developerToken
    );
  }

  return {
    campaignId: parseIdFromResource(campaignRn, "campaigns"),
    adGroupId: parseIdFromResource(adGroupRn, "adGroups"),
  };
}
