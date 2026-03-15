export type AdPlatform = "meta" | "google" | "tiktok";

export interface AdCopyPromptInput {
  offerDescription: string;
  audienceDescription: string;
  brandVoice?: string;
  platform: AdPlatform;
  numVariants: number;
}

export function buildSystemPrompt(platform: AdPlatform): string {
  switch (platform) {
    case "meta":
      return (
        "You are an expert Meta (Facebook & Instagram) ads copywriter. " +
        "Write high-converting ad copy that follows Meta ad policies and " +
        "uses strong hooks, clear benefits, and a clear call to action."
      );
    case "google":
      return (
        "You are an expert Google Ads copywriter. " +
        "Write short, punchy headlines and clear descriptions for search ads."
      );
    case "tiktok":
      return (
        "You are an expert TikTok ads copywriter. " +
        "Write short, thumb-stopping copy with strong hooks and clear CTAs."
      );
    default:
      return "You are a performance marketing ads copywriter.";
  }
}

export function buildUserPrompt(input: AdCopyPromptInput): string {
  const { offerDescription, audienceDescription, brandVoice, platform, numVariants } =
    input;

  const voice = brandVoice
    ? `The brand voice is: ${brandVoice}.`
    : "Use a clear, persuasive, but not overly hyped tone.";

  const platformNote =
    platform === "google"
      ? "Create search ad assets: multiple headline options and description options."
      : "Create ad copy suitable for feed/short-form placements.";

  return [
    `Offer: ${offerDescription}`,
    `Target audience: ${audienceDescription}`,
    voice,
    platformNote,
    "",
    `Generate ${numVariants} distinct ad copy variants.`,
    "Respond as a JSON array of objects, each with: headline, primaryText, description (optional)."
  ].join("\n");
}

/**
 * For experiment flow: one user prompt → N fully different ad copies.
 * Strong instructions so the AI writes NEW copy (never just repeat the idea).
 */
export function buildVariantsFromOnePrompt(adIdea: string, platform: AdPlatform, count: number): string {
  const platformBrief =
    platform === "meta"
      ? "Meta (Facebook/Instagram) feed ads: hook, benefit, CTA."
      : platform === "google"
        ? "Google Ads: headlines and short descriptions."
        : "TikTok/short-form: punchy, scroll-stopping copy.";
  return [
    "Below is an ad IDEA (topic/angle). Your job: write " + count + " completely NEW ad copies inspired by this idea.",
    "CRITICAL: Do NOT copy or repeat the idea text. Write fresh headlines and body text that SELL the idea (e.g. different hooks, benefits, CTAs). Each variant must be original ad copy, not the idea pasted again.",
    "Each object must have: headline (short, catchy), primaryText (2-4 sentences of ad body). Optional: description.",
    "",
    "Ad idea (use this as inspiration only; do not repeat it):",
    adIdea,
    "",
    "Platform: " + platformBrief,
    "",
    "Return a JSON object with one key \"variants\" whose value is an array of exactly " + count + " objects. Each object: headline, primaryText. Example: {\"variants\": [{\"headline\": \"...\", \"primaryText\": \"...\"}, ...]}"
  ].join("\n");
}
