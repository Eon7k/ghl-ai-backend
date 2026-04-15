/**
 * Expansion “products” — toggled per account by admin. Keys are stored on User.enabledProductKeys.
 * null = not set (legacy): all products allowed. [] = none. Non-empty = explicit allowlist.
 */

export const EXPANSION_PRODUCT_KEYS = [
  "white_label",
  "kits",
  "landing_pages",
  "reports",
  "dfy",
  "competitors",
] as const;

export type ExpansionProductKey = (typeof EXPANSION_PRODUCT_KEYS)[number];

export const EXPANSION_PRODUCT_META: Record<
  ExpansionProductKey,
  { label: string; short: string }
> = {
  white_label: { label: "White label", short: "Custom branding & domains" },
  kits: { label: "Vertical kits", short: "Industry template packs" },
  landing_pages: { label: "Landing pages", short: "Landing page builder" },
  reports: { label: "Reports", short: "Scheduled client reports" },
  dfy: { label: "DFY", short: "Done-for-you services module" },
  competitors: { label: "Competitors", short: "Competitor intelligence" },
};

const ALL_SET = new Set<string>([...EXPANSION_PRODUCT_KEYS]);

export function isValidProductKey(key: string): key is ExpansionProductKey {
  return ALL_SET.has(key);
}

/** Resolve effective allowlist: null/undefined => full catalog (legacy rows). */
export function productKeySet(enabledProductKeys: string[] | null | undefined): Set<string> {
  if (enabledProductKeys == null) return new Set(ALL_SET);
  return new Set(enabledProductKeys.filter((k) => isValidProductKey(k)));
}

export function userHasProduct(
  enabledProductKeys: string[] | null | undefined,
  productKey: string
): boolean {
  return productKeySet(enabledProductKeys).has(productKey);
}

/** Coerce Prisma Json / API value to string[] | null (null = unrestricted). */
export function enabledProductKeysFromDb(raw: unknown): string[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null;
  return raw.filter((x): x is string => typeof x === "string");
}

/** Normalize admin PATCH: only known keys, deduped. null = full access. undefined = omit (no change). */
export function normalizeAdminProductKeys(
  raw: unknown
): { ok: true; value: string[] | null } | { ok: false; message: string } {
  if (raw === null) return { ok: true, value: null };
  if (raw === undefined) return { ok: false, message: "enabledProductKeys must be an array or null" };
  if (!Array.isArray(raw)) return { ok: false, message: "enabledProductKeys must be an array or null" };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (typeof x !== "string") continue;
    const k = x.trim();
    if (!isValidProductKey(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return { ok: true, value: out };
}
