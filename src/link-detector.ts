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
  "pinterest.com",
  "pin.it",
  "soundcloud.com",
  "on.soundcloud.com",
  "vimeo.com",
  "player.vimeo.com",
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

export function isTikTok(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return h === "tiktok.com" || h.endsWith(".tiktok.com");
  } catch {
    return false;
  }
}

export function isInstagram(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return h === "instagram.com" || h.endsWith(".instagram.com");
  } catch {
    return false;
  }
}

export function getPlatformName(url: string): string {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    if (h === "youtube.com" || h === "youtu.be" || h === "m.youtube.com") return "YouTube";
    if (h === "instagram.com" || h.endsWith(".instagram.com")) return "Instagram";
    if (h === "tiktok.com" || h === "vm.tiktok.com" || h.endsWith(".tiktok.com")) return "TikTok";
    if (h === "twitter.com" || h === "x.com") return "Twitter/X";
    if (h === "snapchat.com" || h === "t.snapchat.com" || h.endsWith(".snapchat.com")) return "Snapchat";
    if (h === "facebook.com" || h.endsWith(".facebook.com")) return "Facebook";
    if (h === "reddit.com" || h.endsWith(".reddit.com")) return "Reddit";
    if (h === "pinterest.com" || h.endsWith(".pinterest.com") || h === "pin.it") return "Pinterest";
    if (h === "soundcloud.com" || h.endsWith(".soundcloud.com") || h === "on.soundcloud.com") return "SoundCloud";
    if (h === "vimeo.com" || h === "player.vimeo.com" || h.endsWith(".vimeo.com")) return "Vimeo";
  } catch {}
  return "Media";
}

export function isPinterest(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return h === "pinterest.com" || h.endsWith(".pinterest.com") || h === "pin.it";
  } catch {
    return false;
  }
}

export function isSoundCloud(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return h === "soundcloud.com" || h.endsWith(".soundcloud.com") || h === "on.soundcloud.com";
  } catch {
    return false;
  }
}

export function isVimeo(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return h === "vimeo.com" || h === "player.vimeo.com" || h.endsWith(".vimeo.com");
  } catch {
    return false;
  }
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
