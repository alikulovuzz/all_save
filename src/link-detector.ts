const SUPPORTED_DOMAINS = [
  "youtube.com",
  "youtu.be",
  "instagram.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "vm.tiktok.com",
  "snapchat.com",
  "t.snapchat.com",
  "facebook.com",
  "reddit.com",
];

const URL_REGEX = /https?:\/\/[^\s<>\"']+/gi;

export function extractUrl(text: string): string | null {
  const matches = text.match(URL_REGEX);
  if (!matches) return null;

  for (const match of matches) {
    try {
      const url = new URL(match);
      const hostname = url.hostname.replace(/^www\./, "");
      if (SUPPORTED_DOMAINS.some((d) => hostname === d || hostname.endsWith("." + d))) {
        return match;
      }
    } catch {
      continue;
    }
  }

  return null;
}

export function isYouTube(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, "");
    if (hostname !== "youtube.com" && hostname !== "youtu.be" && hostname !== "m.youtube.com") {
      return false;
    }
    // Shorts are short-form — skip resolution picker
    if (parsed.pathname.startsWith("/shorts/")) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
