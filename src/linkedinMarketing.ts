import axios from "axios";
import type { PrismaClient } from "@prisma/client";

const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";

export type LinkedInAdAccountRow = { id: string; name: string; accountId: string };

function sponsoredAccountIdFromUrn(urn: string): string | null {
  const m = /^urn:li:sponsoredAccount:(.+)$/i.exec(String(urn).trim());
  return m ? m[1].trim() : null;
}

/** Exchange refresh token and persist new access (and refresh if LinkedIn rotates it). */
export async function refreshAndStoreLinkedInAccessToken(
  prisma: PrismaClient,
  conn: { id: string; refreshToken: string | null },
  clientId: string,
  clientSecret: string
): Promise<string> {
  if (!conn.refreshToken) {
    throw new Error("No LinkedIn refresh token stored; reconnect LinkedIn in Integrations.");
  }
  const res = await axios.post<{
    access_token?: string;
    refresh_token?: string;
  }>(
    LINKEDIN_TOKEN_URL,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: conn.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  const accessToken = res.data?.access_token;
  if (!accessToken) {
    throw new Error("LinkedIn refresh did not return an access token");
  }
  const newRefresh = res.data?.refresh_token;
  await prisma.connectedAccount.update({
    where: { id: conn.id },
    data: { accessToken, ...(newRefresh ? { refreshToken: newRefresh } : {}) },
  });
  return accessToken;
}

function localizedNameFromAdAccount(data: Record<string, unknown>): string | null {
  const name = data.name;
  if (name && typeof name === "object" && name !== null && "localized" in name) {
    const loc = (name as { localized?: Record<string, string> }).localized;
    if (loc && typeof loc === "object") {
      const en = loc.en_US || loc.en || Object.values(loc).find((v) => typeof v === "string" && v.trim());
      if (typeof en === "string" && en.trim()) return en.trim();
    }
  }
  if (typeof data.localizedName === "string" && data.localizedName.trim()) {
    return data.localizedName.trim();
  }
  return null;
}

/** List sponsored ad accounts for the authenticated member (requires Marketing API / r_ads). */
export async function listLinkedInAdAccounts(accessToken: string): Promise<LinkedInAdAccountRow[]> {
  const url = "https://api.linkedin.com/v2/adAccountUsersV2?q=authenticatedUser";
  const res = await axios.get<{ elements?: Array<{ account?: string }> }>(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Restli-Protocol-Version": "2.0.0",
    },
  });
  const elements = res.data?.elements || [];
  const accounts: LinkedInAdAccountRow[] = [];
  for (const el of elements) {
    const urn = el.account;
    if (typeof urn !== "string") continue;
    const id = sponsoredAccountIdFromUrn(urn);
    if (!id) continue;
    let name = `LinkedIn Ad Account ${id}`;
    try {
      const accRes = await axios.get<Record<string, unknown>>(
        `https://api.linkedin.com/v2/adAccountsV2/${encodeURIComponent(id)}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "X-Restli-Protocol-Version": "2.0.0",
          },
        }
      );
      const n = localizedNameFromAdAccount(accRes.data || {});
      if (n) name = n;
    } catch {
      /* keep default label */
    }
    accounts.push({ id, name, accountId: id });
  }
  return accounts;
}

export function linkedInApiErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data as { message?: string; error?: string; error_description?: string } | undefined;
    const msg = data?.message || data?.error_description || data?.error || err.message;
    if (status === 401) return "LinkedIn rejected the token (401). Reconnect LinkedIn or refresh permissions.";
    if (status === 403) {
      return String(
        msg ||
          "LinkedIn returned 403. Ensure your LinkedIn app has Marketing API / Advertising access and approved scopes (e.g. r_ads, rw_ads)."
      );
    }
    return typeof msg === "string" ? msg : `LinkedIn API error${status ? ` (${status})` : ""}`;
  }
  return err instanceof Error ? err.message : "LinkedIn API error";
}

const LI_V2 = "https://api.linkedin.com/v2";
const LINKEDIN_REST_VERSION = (process.env.LINKEDIN_API_VERSION || "202502").trim();

function liJsonHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "X-Restli-Protocol-Version": "2.0.0",
    "Linkedin-Version": LINKEDIN_REST_VERSION,
    "Content-Type": "application/json",
  };
}

/** Accept numeric org id or full urn:li:organization:… */
export function normalizeLinkedInOrganizationUrn(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  if (/^urn:li:organization:\d+$/i.test(t)) return t;
  if (/^\d+$/.test(t)) return `urn:li:organization:${t}`;
  return t;
}

function sponsoredAccountUrn(sponsoredAccountId: string): string {
  const id = sponsoredAccountId.replace(/\D/g, "");
  if (!id) throw new Error("Invalid LinkedIn sponsored account id");
  return `urn:li:sponsoredAccount:${id}`;
}

function liRunSchedule(): { start: number; end: number } {
  const start = Date.now() + 15 * 60 * 1000;
  const end = start + 90 * 24 * 60 * 60 * 1000;
  return { start, end };
}

function extractLiId(body: unknown): string | null {
  if (body && typeof body === "object" && "id" in body) {
    const id = (body as { id: unknown }).id;
    if (typeof id === "number" || typeof id === "string") return String(id);
  }
  return null;
}

export type LinkedInLaunchVariant = { copy: string; imageBase64: string };

export type LaunchLinkedInCampaignInput = {
  accessToken: string;
  sponsoredAccountId: string;
  organizationUrn: string;
  campaignName: string;
  dailyBudgetUsd: number;
  landingPageUrl: string;
  variants: LinkedInLaunchVariant[];
  dryRun: boolean;
};

export type LaunchLinkedInCampaignResult = {
  campaignGroupId: string;
  campaignId: string;
  creativeIds: string[];
};

/**
 * Website-traffic style launch: campaign group + campaign + image UGC posts + sponsored creatives.
 * Requires rw_ads, an ad account the user can manage, and a Company Page URN (organization) for image + post authoring.
 * Optional env: LINKEDIN_API_VERSION (default 202502) — set to match LinkedIn developer portal API version.
 */
export async function launchLinkedInCampaign(input: LaunchLinkedInCampaignInput): Promise<LaunchLinkedInCampaignResult> {
  const {
    accessToken,
    sponsoredAccountId,
    organizationUrn: orgRaw,
    campaignName,
    dailyBudgetUsd,
    landingPageUrl,
    variants,
    dryRun,
  } = input;

  if (variants.length === 0) throw new Error("No variants with creatives to launch on LinkedIn.");

  const organizationUrn = normalizeLinkedInOrganizationUrn(orgRaw);
  if (!organizationUrn || !/^urn:li:organization:\d+$/i.test(organizationUrn)) {
    throw new Error(
      "LinkedIn launch requires linkedInOrganizationUrn: your Company Page id (numeric) or urn:li:organization:123456789. Find it in Campaign Manager or your Page admin URL."
    );
  }

  const accountUrn = sponsoredAccountUrn(sponsoredAccountId);
  const schedule = liRunSchedule();
  const groupAndCampaignStatus = dryRun ? "PAUSED" : "ACTIVE";

  const groupBody = {
    account: accountUrn,
    name: `${campaignName} — group`.slice(0, 256),
    status: groupAndCampaignStatus,
    runSchedule: { start: schedule.start, end: schedule.end },
  };

  const cgRes = await axios.post(`${LI_V2}/adCampaignGroupsV2`, groupBody, {
    headers: liJsonHeaders(accessToken),
    validateStatus: () => true,
  });
  if (cgRes.status >= 400) {
    const d = cgRes.data as { message?: string; errorDetails?: unknown };
    throw new Error(d?.message || `LinkedIn campaign group failed (${cgRes.status})`);
  }
  const campaignGroupId = extractLiId(cgRes.data);
  if (!campaignGroupId) throw new Error("LinkedIn did not return a campaign group id.");

  const dailyStr = Math.max(10, Math.round(Number(dailyBudgetUsd) * 100) / 100).toFixed(2);
  const campaignBody: Record<string, unknown> = {
    account: accountUrn,
    campaignGroup: `urn:li:sponsoredCampaignGroup:${campaignGroupId}`,
    name: campaignName.slice(0, 256),
    type: "SPONSORED_UPDATES",
    objectiveType: "WEBSITE_VISIT",
    format: "STANDARD_UPDATE",
    costType: "CPC",
    creativeSelection: "OPTIMIZED",
    offsiteDeliveryEnabled: false,
    audienceExpansionEnabled: false,
    runSchedule: { start: schedule.start, end: schedule.end },
    dailyBudget: { amount: dailyStr, currencyCode: "USD" },
    unitCost: { amount: "3.50", currencyCode: "USD" },
    locale: { country: "US", language: "en" },
    targetingCriteria: {
      include: {
        and: [
          {
            or: {
              "urn:li:adTargetingFacet:locations": ["urn:li:country:us"],
            },
          },
        ],
      },
    },
    politicalIntent: "NOT_POLITICAL",
    status: groupAndCampaignStatus,
  };

  const cRes = await axios.post(`${LI_V2}/adCampaignsV2`, campaignBody, {
    headers: liJsonHeaders(accessToken),
    validateStatus: () => true,
  });
  if (cRes.status >= 400) {
    const d = cRes.data as { message?: string };
    throw new Error(d?.message || `LinkedIn campaign failed (${cRes.status})`);
  }
  const campaignId = extractLiId(cRes.data);
  if (!campaignId) throw new Error("LinkedIn did not return a campaign id.");

  const campaignUrn = `urn:li:sponsoredCampaign:${campaignId}`;
  const creativeIds: string[] = [];

  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const rawB64 = v.imageBase64.replace(/^data:image\/[a-z]+;base64,/, "");
    const buf = Buffer.from(rawB64, "base64");
    if (!buf.length) throw new Error(`Variant ${i + 1}: missing image bytes for LinkedIn.`);

    const regRes = await axios.post(
      `${LI_V2}/assets?action=registerUpload`,
      {
        registerUploadRequest: {
          owner: organizationUrn,
          recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
          serviceRelationships: [
            {
              relationshipType: "OWNER",
              identifier: "urn:li:userGeneratedContent",
            },
          ],
          supportedUploadMechanism: ["SYNCHRONOUS_UPLOAD"],
        },
      },
      { headers: liJsonHeaders(accessToken), validateStatus: () => true }
    );
    if (regRes.status >= 400) {
      const d = regRes.data as { message?: string };
      throw new Error(d?.message || `LinkedIn image register (${i + 1}) HTTP ${regRes.status}`);
    }
    const val = (regRes.data as { value?: Record<string, unknown> })?.value;
    const upload = val?.uploadMechanism as
      | { "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"?: { uploadUrl?: string; headers?: Record<string, string[]> } }
      | undefined;
    const httpReq = upload?.["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"];
    const uploadUrl = httpReq?.uploadUrl;
    const assetUrn = val?.asset as string | undefined;
    if (!uploadUrl || !assetUrn) {
      throw new Error(`LinkedIn did not return upload URL/asset for variant ${i + 1}.`);
    }
    const uploadHeaders: Record<string, string> = {};
    const h = httpReq?.headers;
    if (h && typeof h === "object") {
      for (const [k, arr] of Object.entries(h)) {
        if (Array.isArray(arr) && arr[0]) uploadHeaders[k] = String(arr[0]);
      }
    }
    await axios.put(uploadUrl, buf, { headers: uploadHeaders, maxBodyLength: Infinity, maxContentLength: Infinity });

    const headline = (v.copy || campaignName).replace(/\n/g, " ").trim().slice(0, 200) || `Ad ${i + 1}`;
    const bodyText = (v.copy || headline).replace(/\n/g, " ").trim().slice(0, 3000);

    const ugcBody = {
      author: organizationUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: bodyText },
          shareMediaCategory: "IMAGE",
          media: [
            {
              status: "READY",
              description: { text: headline },
              media: assetUrn,
              title: { text: headline },
              originalUrl: landingPageUrl,
            },
          ],
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "CONTAINER" },
    };

    const ugcRes = await axios.post(`${LI_V2}/ugcPosts`, ugcBody, {
      headers: liJsonHeaders(accessToken),
      validateStatus: () => true,
    });
    if (ugcRes.status >= 400) {
      const d = ugcRes.data as { message?: string };
      throw new Error(d?.message || `LinkedIn UGC post (${i + 1}) HTTP ${ugcRes.status}`);
    }
    const ugcId = extractLiId(ugcRes.data);
    if (!ugcId) throw new Error(`LinkedIn did not return ugcPost id for variant ${i + 1}.`);
    const ugcUrn = `urn:li:ugcPost:${ugcId}`;

    const crBody = {
      campaign: campaignUrn,
      reference: ugcUrn,
      type: "SPONSORED_STATUS_UPDATE",
      status: groupAndCampaignStatus,
    };

    const crRes = await axios.post(`${LI_V2}/adCreativesV2`, crBody, {
      headers: liJsonHeaders(accessToken),
      validateStatus: () => true,
    });
    if (crRes.status >= 400) {
      const d = crRes.data as { message?: string };
      throw new Error(d?.message || `LinkedIn creative (${i + 1}) HTTP ${crRes.status}`);
    }
    const crId = extractLiId(crRes.data);
    if (crId) creativeIds.push(crId);
  }

  return { campaignGroupId, campaignId, creativeIds };
}
