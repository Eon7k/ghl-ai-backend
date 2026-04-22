import axios, { type AxiosResponse } from "axios";
import type { PrismaClient } from "@prisma/client";

const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";

const LI_V2 = "https://api.linkedin.com/v2";
const LI_REST = "https://api.linkedin.com/rest";
/** Marketing API version header; must match approved product version. */
const LINKEDIN_REST_VERSION = (process.env.LINKEDIN_API_VERSION || "202502").trim();

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

/** Required for Marketing API GETs; matches launch/creative calls. */
function liMarketingGetHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-Restli-Protocol-Version": "2.0.0",
    "Linkedin-Version": LINKEDIN_REST_VERSION,
    Accept: "application/json",
  };
}

function extractElements(data: unknown): unknown[] {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  if (Array.isArray(d.elements)) return d.elements;
  if (d.value && typeof d.value === "object" && Array.isArray((d.value as { elements?: unknown[] }).elements)) {
    return (d.value as { elements: unknown[] }).elements;
  }
  return [];
}

/** Account URN may be `account` or `sponsoredAccount` depending on API version. */
function accountUrnFromElement(el: unknown): string | null {
  if (el == null) return null;
  if (typeof el === "string" && /urn:li:sponsoredAccount:\d+/i.test(el)) return el;
  if (typeof el === "object") {
    const o = el as Record<string, unknown>;
    const direct = o.account ?? o.sponsoredAccount;
    if (typeof direct === "string" && direct.includes("sponsoredAccount")) return direct;
    if (typeof direct === "string" && /urn:li:sponsoredAccount:\d+/i.test(direct)) return direct;
    if (typeof direct === "object" && direct && "sponsored" in (direct as object)) {
      const s = (direct as { sponsored?: string }).sponsored;
      if (typeof s === "string" && s.includes("sponsoredAccount")) return s;
    }
  }
  try {
    const json = JSON.stringify(el);
    const m = /urn:li:sponsoredAccount:\d+/i.exec(json);
    if (m) return m[0];
  } catch {
    /* ignore */
  }
  return null;
}

export type LinkedInAdAccountAttempt = {
  url: string;
  status: number;
  elementCount: number;
  topLevelKeys: string[];
  message?: string;
  sampleElementKeys?: string[];
};

/**
 * List sponsored ad accounts for the authenticated member (requires r_ads).
 * Calls all known `q=authenticatedUser` entry points and **merges** account ids (one endpoint may be empty
 * while another returns data depending on contract version and headers).
 */
export async function listLinkedInAdAccountsWithDiagnostics(
  accessToken: string
): Promise<{ accounts: LinkedInAdAccountRow[]; attempts: LinkedInAdAccountAttempt[] }> {
  const attempts: LinkedInAdAccountAttempt[] = [];
  const endpoints = [
    `${LI_V2}/adAccountUsersV2?q=authenticatedUser&count=100`,
    `${LI_V2}/adAccountUsersV2?q=authenticatedUser`,
    `${LI_REST}/adAccountUsers?q=authenticatedUser&count=100`,
    `${LI_REST}/adAccountUsers?q=authenticatedUser`,
  ];

  const seenIds = new Set<string>();
  const idOrder: string[] = [];

  for (const url of endpoints) {
    try {
      const res = await axios.get(url, {
        headers: liMarketingGetHeaders(accessToken),
        validateStatus: () => true,
      });
      const data = res.data;
      const topLevelKeys =
        data && typeof data === "object" ? Object.keys(data as object).slice(0, 20) : [];
      const elements = extractElements(data);
      let msg: string | undefined;
      if (res.status >= 400) {
        const d = data as { message?: string; error?: string; status?: number };
        msg = d?.message || d?.error || `HTTP ${res.status}`;
      }
      let sampleKeys: string[] | undefined;
      if (elements.length > 0 && elements[0] && typeof elements[0] === "object") {
        sampleKeys = Object.keys(elements[0] as object).slice(0, 12);
      }
      attempts.push({
        url: url.split("?")[0],
        status: res.status,
        elementCount: elements.length,
        topLevelKeys,
        message: msg,
        sampleElementKeys: sampleKeys,
      });
      if (res.status >= 400) continue;
      for (const el of elements) {
        const urn = accountUrnFromElement(el);
        if (!urn) continue;
        const id = sponsoredAccountIdFromUrn(urn);
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        idOrder.push(id);
      }
    } catch (e) {
      attempts.push({
        url: url.split("?")[0],
        status: 0,
        elementCount: 0,
        topLevelKeys: [],
        message: e instanceof Error ? e.message : "request failed",
      });
    }
  }

  const accounts: LinkedInAdAccountRow[] = [];
  for (const id of idOrder) {
    let name = `LinkedIn Ad Account ${id}`;
    try {
      const accRes = await axios.get<Record<string, unknown>>(`${LI_V2}/adAccountsV2/${encodeURIComponent(id)}`, {
        headers: liMarketingGetHeaders(accessToken),
        validateStatus: (s) => s < 500,
      });
      if (accRes.status < 400) {
        const n = localizedNameFromAdAccount(accRes.data || {});
        if (n) name = n;
      }
    } catch {
      /* keep default label */
    }
    accounts.push({ id, name, accountId: id });
  }
  return { accounts, attempts };
}

export async function listLinkedInAdAccounts(accessToken: string): Promise<LinkedInAdAccountRow[]> {
  const { accounts } = await listLinkedInAdAccountsWithDiagnostics(accessToken);
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
  if (body && typeof body === "object" && body !== null) {
    const o = body as Record<string, unknown>;
    for (const k of ["value", "entity"]) {
      const inner = o[k];
      if (inner && typeof inner === "object" && inner !== null && "id" in inner) {
        const id = (inner as { id: unknown }).id;
        if (typeof id === "number" || typeof id === "string") return String(id);
      }
    }
  }
  return null;
}

const URN_ID_PATTERNS: Record<"sponsoredCampaignGroup" | "sponsoredCampaign" | "ugcPost" | "sponsoredCreative", RegExp> = {
  sponsoredCampaignGroup: /urn:li:sponsoredCampaignGroup:([0-9]+)/i,
  sponsoredCampaign: /urn:li:sponsoredCampaign:([0-9]+)/i,
  // UGC id is typically numeric; allow common variants in the URN string
  ugcPost: /urn:li:ugcPost:([^\s)]+)/i,
  sponsoredCreative: /urn:li:sponsoredCreative:([0-9]+)/i,
};

/**
 * Rest.li create often returns the entity only in `X-RestLi-Id` (and sometimes `Location`), not in JSON `id`.
 * Header value may look like: (urn:li:sponsoredCampaignGroup:12345)
 */
function extractIdFromCreateResponse(
  res: Pick<AxiosResponse, "data" | "headers" | "status">,
  entity: "sponsoredCampaignGroup" | "sponsoredCampaign" | "ugcPost" | "sponsoredCreative"
): string | null {
  const fromBody = extractLiId(res.data);
  if (fromBody) return fromBody;

  const pat = URN_ID_PATTERNS[entity];
  const scan = (s: string): string | null => {
    const cleaned = s.replace(/^\(|\)$/g, "").trim();
    const m = pat.exec(cleaned);
    return m ? m[1] : null;
  };

  const rawHeaders = res.headers;
  if (rawHeaders && typeof rawHeaders === "object") {
    const h = rawHeaders as Record<string, string | string[] | undefined>;
    for (const key of Object.keys(h)) {
      if (key.toLowerCase() === "x-restli-id") {
        const v = h[key];
        const s = Array.isArray(v) ? v[0] : v;
        if (typeof s === "string") {
          const id = scan(s);
          if (id) return id;
        }
      }
    }
    for (const locKey of ["location", "Location"]) {
      const loc = h[locKey];
      const s = Array.isArray(loc) ? loc[0] : loc;
      if (typeof s === "string") {
        const id = scan(s);
        if (id) return id;
        const tail = /\/([0-9]+)\s*$/i.exec(s);
        if (tail) return tail[1];
      }
    }
  }

  try {
    const s = JSON.stringify(res.data);
    const m = pat.exec(s);
    if (m) return m[1];
  } catch {
    /* ignore */
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
  /**
   * LinkedIn rejects POST body `status: PAUSED` on new entities ("cannot be changed from null to PAUSED").
   * Dry run: omit `status` so LinkedIn uses its default (typically DRAFT / not yet active — no spend until you activate in CM).
   * Live: `ACTIVE` on create.
   */
  const liveStatus = "ACTIVE";

  const groupBody: Record<string, unknown> = {
    account: accountUrn,
    name: `${campaignName} — group`.slice(0, 256),
    runSchedule: { start: schedule.start, end: schedule.end },
  };
  if (!dryRun) {
    groupBody.status = liveStatus;
  }

  const cgRes = await axios.post(`${LI_V2}/adCampaignGroupsV2`, groupBody, {
    headers: liJsonHeaders(accessToken),
    validateStatus: () => true,
  });
  if (cgRes.status >= 400) {
    const d = cgRes.data as { message?: string; errorDetails?: unknown };
    throw new Error(d?.message || `LinkedIn campaign group failed (${cgRes.status})`);
  }
  const campaignGroupId = extractIdFromCreateResponse(cgRes, "sponsoredCampaignGroup");
  if (!campaignGroupId) {
    const hint = cgRes.data != null ? JSON.stringify(cgRes.data).slice(0, 200) : "";
    const hdr = cgRes.headers && (cgRes.headers as Record<string, unknown>)["x-restli-id"];
    throw new Error(
      `LinkedIn did not return a campaign group id (body or X-RestLi-Id). HTTP ${cgRes.status}. ${
        hdr != null ? `X-RestLi-Id: ${String(hdr).slice(0, 120)}. ` : ""
      }${hint ? `Body: ${hint}` : ""}`.trim()
    );
  }

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
  };
  if (!dryRun) {
    campaignBody.status = liveStatus;
  }

  const cRes = await axios.post(`${LI_V2}/adCampaignsV2`, campaignBody, {
    headers: liJsonHeaders(accessToken),
    validateStatus: () => true,
  });
  if (cRes.status >= 400) {
    const d = cRes.data as { message?: string };
    throw new Error(d?.message || `LinkedIn campaign failed (${cRes.status})`);
  }
  const campaignId = extractIdFromCreateResponse(cRes, "sponsoredCampaign");
  if (!campaignId) {
    const hdr = cRes.headers && (cRes.headers as Record<string, unknown>)["x-restli-id"];
    throw new Error(
      `LinkedIn did not return a campaign id. HTTP ${cRes.status}. ${
        hdr != null ? `X-RestLi-Id: ${String(hdr).slice(0, 120)}. ` : ""
      }`.trim()
    );
  }

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
    const ugcId = extractIdFromCreateResponse(ugcRes, "ugcPost");
    if (!ugcId) throw new Error(`LinkedIn did not return ugcPost id for variant ${i + 1}.`);
    const ugcUrn = `urn:li:ugcPost:${ugcId}`;

    const crBody: Record<string, unknown> = {
      campaign: campaignUrn,
      reference: ugcUrn,
      type: "SPONSORED_STATUS_UPDATE",
    };
    if (!dryRun) {
      crBody.status = liveStatus;
    }

    const crRes = await axios.post(`${LI_V2}/adCreativesV2`, crBody, {
      headers: liJsonHeaders(accessToken),
      validateStatus: () => true,
    });
    if (crRes.status >= 400) {
      const d = crRes.data as { message?: string };
      throw new Error(d?.message || `LinkedIn creative (${i + 1}) HTTP ${crRes.status}`);
    }
    const crId = extractIdFromCreateResponse(crRes, "sponsoredCreative") ?? extractLiId(crRes.data);
    if (crId) creativeIds.push(crId);
  }

  return { campaignGroupId, campaignId, creativeIds };
}
