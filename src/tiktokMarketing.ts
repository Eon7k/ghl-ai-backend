/**
 * TikTok Marketing API v1.3 helpers — campaign / ad group / image upload / ads.
 * Docs: https://business-api.tiktok.com/portal/docs
 */

import axios from "axios";

const BASE = "https://business-api.tiktok.com/open_api/v1.3";

export type TikTokIdentity = {
  identity_id: string;
  identity_type: string;
  display_name?: string;
};

type Envelope<T> = { code: number; message: string; data?: T; request_id?: string };

function throwIfBad<T>(label: string, res: { data: Envelope<T> }): T {
  const { code, message, data } = res.data;
  if (code !== 0) {
    throw new Error(`${label}: ${message || "TikTok API error"} (code ${code})`);
  }
  return data as T;
}

/** List identities for an advertiser (pick one for ad creatives). */
export async function tiktokListIdentities(accessToken: string, advertiserId: string): Promise<TikTokIdentity[]> {
  const res = await axios.get<Envelope<{ list?: TikTokIdentity[] }>>(`${BASE}/identity/get/`, {
    params: {
      advertiser_id: advertiserId,
      access_token: accessToken,
      page_size: 50,
    },
  });
  const data = throwIfBad("identity/get", res);
  return data?.list || [];
}

/** Pick first usable identity for standard in-feed ads. */
export async function tiktokResolveIdentity(
  accessToken: string,
  advertiserId: string,
  preferred?: { identityId: string; identityType: string }
): Promise<{ identity_id: string; identity_type: string }> {
  if (preferred?.identityId && preferred?.identityType) {
    return { identity_id: preferred.identityId, identity_type: preferred.identityType };
  }
  const list = await tiktokListIdentities(accessToken, advertiserId);
  const order = ["CUSTOMIZED_USER", "TT_USER", "AUTH_CODE", "BC_AUTH_TT"];
  for (const t of order) {
    const hit = list.find((i) => i.identity_type === t);
    if (hit) return { identity_id: hit.identity_id, identity_type: hit.identity_type };
  }
  if (list.length > 0) {
    return { identity_id: list[0].identity_id, identity_type: list[0].identity_type };
  }
  throw new Error(
    "No TikTok ad identity found for this advertiser. In TikTok Ads Manager, link a TikTok account or create a Customized identity for this ad account, then try again."
  );
}

function scheduleStartTime(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() + 3);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Upload PNG/JPEG bytes; returns TikTok image id. */
export async function tiktokUploadAdImage(
  accessToken: string,
  advertiserId: string,
  imageBuffer: Buffer,
  filename = "creative.png"
): Promise<string> {
  const form = new FormData();
  form.append("advertiser_id", advertiserId);
  form.append("upload_type", "UPLOAD_BY_FILE");
  const blob = new Blob([new Uint8Array(imageBuffer)], { type: "image/png" });
  form.append("image_file", blob, filename);

  const res = await fetch(`${BASE}/file/image/ad/upload/`, {
    method: "POST",
    headers: { "Access-Token": accessToken },
    body: form,
  });
  const json = (await res.json()) as Envelope<{ image_id?: string; id?: string }>;
  if (json.code !== 0) {
    throw new Error(`image/upload: ${json.message || "upload failed"} (code ${json.code})`);
  }
  const id = json.data?.image_id || json.data?.id;
  if (!id) throw new Error("image/upload: TikTok did not return image_id");
  return id;
}

export type TikTokLaunchInput = {
  accessToken: string;
  advertiserId: string;
  campaignName: string;
  dailyBudget: number;
  landingPageUrl: string;
  variants: { title: string; adText: string; imagePngBase64: string }[];
  dryRun: boolean;
  identityId?: string;
  identityType?: string;
  /** Override objective if your account requires another enum (see TikTok docs). */
  objectiveType?: string;
};

export type TikTokLaunchResult = { campaignId: string; adGroupId: string };

/**
 * Create TikTok campaign (traffic to website), one ad group, one ad per variant (single image).
 */
export async function launchTikTokCampaign(input: TikTokLaunchInput): Promise<TikTokLaunchResult> {
  const {
    accessToken,
    advertiserId,
    campaignName,
    dailyBudget,
    landingPageUrl,
    variants,
    dryRun,
    objectiveType = process.env.TIKTOK_OBJECTIVE_TYPE?.trim() || "TRAFFIC",
  } = input;

  if (variants.length === 0) throw new Error("No variants with creatives to launch.");

  const identity = await tiktokResolveIdentity(accessToken, advertiserId, {
    identityId: input.identityId || "",
    identityType: input.identityType || "",
  });

  const opHold = "DISABLE";
  const adCreativeStatus = dryRun ? "DISABLE" : "ENABLE";

  // 1) Campaign — infinite budget at campaign level; spend controlled by ad group
  const campBody = {
    advertiser_id: advertiserId,
    campaign_name: campaignName.slice(0, 512),
    objective_type: objectiveType,
    budget_mode: "BUDGET_MODE_INFINITE",
    operation_status: opHold,
  };

  const campRes = await axios.post<Envelope<{ campaign_id?: string }>>(`${BASE}/campaign/create/`, campBody, {
    headers: { "Access-Token": accessToken, "Content-Type": "application/json" },
  });
  const campData = throwIfBad("campaign/create", campRes);
  const campaignId = campData?.campaign_id;
  if (!campaignId) throw new Error("campaign/create: missing campaign_id");

  try {
    const budget = Math.max(1, Math.round(dailyBudget * 100) / 100);
    const adgroupBody: Record<string, unknown> = {
      advertiser_id: advertiserId,
      campaign_id: campaignId,
      adgroup_name: `${campaignName} - Ad group`.slice(0, 512),
      budget_mode: "BUDGET_MODE_DAY",
      budget,
      schedule_type: "SCHEDULE_FROM_NOW",
      schedule_start_time: scheduleStartTime(),
      pacing: "PACING_MODE_SMOOTH",
      optimization_goal: "CLICK",
      billing_event: "CPC",
      bid_type: "BID_TYPE_NO_BID",
      promotion_type: "WEBSITE",
      placement_type: "PLACEMENT_TYPE_NORMAL",
      placements: ["PLACEMENT_TIKTOK"],
      location_ids: ["6252001"],
      gender: "GENDER_UNLIMITED",
      age_groups: ["AGE_18_24", "AGE_25_34", "AGE_35_44", "AGE_45_54", "AGE_55_100"],
      operation_status: opHold,
    };

    const agRes = await axios.post<Envelope<{ adgroup_id?: string }>>(`${BASE}/adgroup/create/`, adgroupBody, {
      headers: { "Access-Token": accessToken, "Content-Type": "application/json" },
    });
    const agData = throwIfBad("adgroup/create", agRes);
    const adGroupId = agData?.adgroup_id;
    if (!adGroupId) throw new Error("adgroup/create: missing adgroup_id");

    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      const raw = v.imagePngBase64.replace(/^data:image\/[a-z]+;base64,/, "");
      const buf = Buffer.from(raw, "base64");
      const imageId = await tiktokUploadAdImage(accessToken, advertiserId, buf, `variant-${i + 1}.png`);

      const creative = {
        ad_name: `${campaignName} - Ad ${i + 1}`.slice(0, 512),
        identity_type: identity.identity_type,
        identity_id: identity.identity_id,
        display_name: campaignName.slice(0, 40),
        ad_format: "SINGLE_IMAGE",
        image_ids: [imageId],
        landing_page_url: landingPageUrl,
        ad_text: v.adText.slice(0, 2200),
        call_to_action: "LEARN_MORE",
        operation_status: adCreativeStatus,
      };

      const adBody = {
        advertiser_id: advertiserId,
        adgroup_id: adGroupId,
        creatives: [creative],
      };

      const adRes = await axios.post<Envelope<unknown>>(`${BASE}/ad/create/`, adBody, {
        headers: { "Access-Token": accessToken, "Content-Type": "application/json" },
      });
      throwIfBad(`ad/create (#${i + 1})`, adRes);
    }

    if (!dryRun) {
      const upCamp = await axios.post<Envelope<unknown>>(
        `${BASE}/campaign/update/`,
        {
          advertiser_id: advertiserId,
          campaign_id: campaignId,
          operation_status: "ENABLE",
        },
        { headers: { "Access-Token": accessToken, "Content-Type": "application/json" } }
      );
      throwIfBad("campaign/update (enable)", upCamp);

      const upAg = await axios.post<Envelope<unknown>>(
        `${BASE}/adgroup/update/`,
        {
          advertiser_id: advertiserId,
          adgroup_id: adGroupId,
          operation_status: "ENABLE",
        },
        { headers: { "Access-Token": accessToken, "Content-Type": "application/json" } }
      );
      throwIfBad("adgroup/update (enable)", upAg);
    }

    return { campaignId, adGroupId };
  } catch (e) {
    console.error("[TikTok launch] failed after campaign created; campaign id:", campaignId, e);
    throw e;
  }
}
