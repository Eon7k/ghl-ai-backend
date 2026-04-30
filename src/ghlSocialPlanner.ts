/**
 * Go High Level (LeadConnector) Social Planner — Basic CSV layout and optional API upload.
 * Column header line must match HighLevel's Basic sample (see help center "Prerequisite for Bulk CSV").
 */

const BASIC_CSV_HEADER =
  "postAtSpecificTime (YYYY-MM-DD HH:mm:ss),content,link (OGmetaUrl),imageUrls,gifUrl,videoUrls";

const GHL_API_BASE_DEFAULT = "https://services.leadconnectorhq.com";
/** API version header required by LeadConnector (override with GHL_API_VERSION). */
const GHL_VERSION_DEFAULT = "2021-07-28";

export function ghlApiBaseUrl(): string {
  return (process.env.GHL_API_BASE_URL || GHL_API_BASE_DEFAULT).replace(/\/$/, "");
}

export function ghlApiVersion(): string {
  return (process.env.GHL_API_VERSION || GHL_VERSION_DEFAULT).trim() || GHL_VERSION_DEFAULT;
}

export type GhlCsvRow = {
  postAtSpecificTime: string;
  content: string;
  link?: string;
  imageUrls?: string;
  gifUrl?: string;
  videoUrls?: string;
};

/** RFC 4180-style field escaping for GHL CSV imports. */
export function escapeCsvField(value: string): string {
  const s = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Build CSV string (UTF-8) for Basic template: one header row + data rows. */
export function buildGhlBasicCsv(rows: GhlCsvRow[]): string {
  const lines: string[] = [BASIC_CSV_HEADER];
  for (const r of rows) {
    const cells = [
      escapeCsvField((r.postAtSpecificTime || "").trim()),
      escapeCsvField((r.content || "").trim()),
      escapeCsvField((r.link ?? "").trim()),
      escapeCsvField((r.imageUrls ?? "").trim()),
      escapeCsvField((r.gifUrl ?? "").trim()),
      escapeCsvField((r.videoUrls ?? "").trim()),
    ];
    lines.push(cells.join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * POST multipart CSV to LeadConnector. After success, finish account selection + finalize in Social Planner UI
 * unless you also call finalize (optional; depends on HighLevel workflow for your workspace).
 */
export async function uploadGhlSocialPlannerCsv(params: {
  locationId: string;
  privateIntegrationToken: string;
  csvUtf8: string;
  /** File name shown in HighLevel import list */
  filename?: string;
}): Promise<{ ok: true; status: number; body: unknown }> {
  const base = ghlApiBaseUrl();
  const url = `${base}/social-media-posting/${encodeURIComponent(params.locationId.trim())}/csv`;
  const buf = Buffer.from(params.csvUtf8, "utf8");
  const filename = (params.filename || "content-plan.csv").replace(/[^\w.\-]+/g, "_") || "content-plan.csv";

  const form = new FormData();
  form.append("file", new Blob([buf], { type: "text/csv" }), filename);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.privateIntegrationToken.trim()}`,
      Version: ghlApiVersion(),
      Accept: "application/json",
    },
    body: form,
  });

  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg =
      typeof body === "object" && body !== null && "message" in body
        ? String((body as { message?: unknown }).message)
        : text.slice(0, 500);
    throw new Error(`Go High Level CSV upload failed (${res.status}): ${msg || res.statusText}`);
  }
  return { ok: true, status: res.status, body };
}

/**
 * Optional: finalize a CSV import so posts are scheduled (PATCH). `csvImportId` must come from upload response or GET status.
 */
export async function finalizeGhlCsvImport(params: {
  locationId: string;
  privateIntegrationToken: string;
  csvImportId: string;
}): Promise<{ ok: true; status: number; body: unknown }> {
  const base = ghlApiBaseUrl();
  const url = `${base}/social-media-posting/${encodeURIComponent(params.locationId.trim())}/csv/${encodeURIComponent(params.csvImportId.trim())}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${params.privateIntegrationToken.trim()}`,
      Version: ghlApiVersion(),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg =
      typeof body === "object" && body !== null && "message" in body
        ? String((body as { message?: unknown }).message)
        : text.slice(0, 500);
    throw new Error(`Go High Level finalize failed (${res.status}): ${msg || res.statusText}`);
  }
  return { ok: true, status: res.status, body };
}

/** Try to read an id from LeadConnector upload JSON (field names vary by version). */
export function extractCsvImportIdFromUploadBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const candidates = ["id", "csvId", "importId", "uploadId"];
  for (const k of candidates) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const nested = o.data ?? o.import;
  if (nested && typeof nested === "object") {
    const n = nested as Record<string, unknown>;
    for (const k of candidates) {
      const v = n[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}
