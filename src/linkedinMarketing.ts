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
