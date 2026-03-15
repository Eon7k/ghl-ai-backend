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
 * Strong instructions so the AI uses the exact idea and produces varied copy.
 */
export function buildVariantsFromOnePrompt(adIdea: string, platform: AdPlatform, count: number): string {
  const platformBrief =
    platform === "meta"
      ? "Meta (Facebook/Instagram) feed ads: hook, benefit, CTA."
      : platform === "google"
        ? "Google Ads: headlines and short descriptions."
        : "TikTok/short-form: punchy, scroll-stopping copy.";
  return [
    "The user provided ONE ad idea below. Your job: generate " + count + " completely different ad copies that all use this idea.",
    "Each ad must: (1) be clearly based on the idea, (2) have different headlines and body copy, (3) use different angles or hooks (e.g. pain point, benefit, urgency, social proof).",
    "Do not repeat the same phrasing. Every variant must feel like a distinct ad.",
    "",
    "Ad idea from user:",
    "---",
    adIdea,
    "---",
    "",
    "Platform: " + platformBrief,
    "",
    "Return ONLY a valid JSON array of exactly " + count + " objects. Each object must have: headline (string), primaryText (string). Optional: description (string).",
    "Example shape: [{\"headline\": \"...\", \"primaryText\": \"...\"}, ...]"
  ].join("\n");
}
