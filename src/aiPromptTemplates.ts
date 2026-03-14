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
