import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { unlink, unlinkSync, mkdirSync, existsSync, readdirSync, statSync, renameSync, rmdirSync } from "fs";
import { randomUUID } from "crypto";
import { VideoFormat, DownloadResult } from "./types";
import { isTikTok, isInstagram } from "./link-detector";

interface YtDlpFormat {
  format_id: string;
  height?: number;
  acodec?: string;
  vcodec?: string;
  ext?: string;
  video_ext?: string;
  filesize?: number;
  filesize_approx?: number;
}

const execFileAsync = promisify(execFile);
const unlinkAsync = promisify(unlink);

const TEMP_DIR = join(__dirname, "..", "temp");

if (!existsSync(TEMP_DIR)) {
  mkdirSync(TEMP_DIR, { recursive: true });
}

export async function listFormats(url: string): Promise<VideoFormat[]> {
  const { stdout } = await execFileAsync("yt-dlp", ["-j", "--no-playlist", url], {
    timeout: 30_000,
  });

  const info = JSON.parse(stdout);
  const formats: YtDlpFormat[] = info.formats || [];

  const resolutionMap = new Map<string, VideoFormat>();

  for (const f of formats) {
    if (!f.height || f.height < 240) continue;
    if (f.acodec === "none" && f.vcodec === "none") continue;

    const resolution = `${f.height}p`;
    const existing = resolutionMap.get(resolution);

    const isVideoOnly = f.vcodec !== "none" && f.acodec === "none";
    const isVideoWithAudio = f.acodec !== "none" && f.vcodec !== "none";
    const isMp4 = (f.ext === "mp4" || f.video_ext === "mp4");

    // Build complete yt-dlp format spec so audio is always included
    const formatSpec = isVideoOnly
      ? `${f.format_id}+bestaudio`
      : String(f.format_id);

    if (!existing) {
      resolutionMap.set(resolution, {
        formatId: formatSpec,
        resolution,
        ext: f.ext || "mp4",
        filesize: f.filesize || f.filesize_approx,
      });
    } else {
      if (isVideoWithAudio && isMp4) {
        resolutionMap.set(resolution, {
          formatId: formatSpec,
          resolution,
          ext: f.ext || "mp4",
          filesize: f.filesize || f.filesize_approx,
        });
      }
    }
  }

  const result = Array.from(resolutionMap.values());
  result.sort((a, b) => {
    const aH = parseInt(a.resolution);
    const bH = parseInt(b.resolution);
    return aH - bH;
  });

  return result;
}

export async function downloadMedia(
  url: string,
  formatId?: string
): Promise<DownloadResult> {
  const uid = randomUUID();
  const outputTemplate = join(TEMP_DIR, `${uid}.%(ext)s`);

  const args = [
    "--no-playlist",
    "--merge-output-format", "mp4",
    "--remux-video", "mp4",
    "--max-filesize", "2000m",
    "-o", outputTemplate,
  ];

  if (formatId) {
    // formatId is a complete yt-dlp format spec (e.g. "137+bestaudio" or "18")
    args.push("-f", formatId);
  }

  // Route only TikTok through the proxy (e.g. Tor) — other platforms work directly
  // and the proxy adds latency. Set YTDLP_PROXY in .env to enable.
  const proxy = process.env.YTDLP_PROXY;
  if (proxy && isTikTok(url)) {
    args.unshift("--proxy", proxy);
  }

  // Instagram increasingly requires login. If a cookies file is configured, pass it.
  const igCookies = process.env.INSTAGRAM_COOKIES;
  if (igCookies && isInstagram(url) && existsSync(igCookies)) {
    args.unshift("--cookies", igCookies);
  }

  args.push(url);

  let ytdlpStderr: string | null = null;
  try {
    await execFileAsync("yt-dlp", args, {
      timeout: 120_000,
    });
  } catch (err: unknown) {
    // yt-dlp may exit non-zero on max-filesize abort but still leave a complete file —
    // we still check for output below; remember stderr in case there's none.
    const e = err as { stderr?: string; message?: string };
    ytdlpStderr = (e.stderr || e.message || String(err)).toString().trim();
  }

  // Find the downloaded file by UUID prefix, ignore .part files
  const allFiles = readdirSync(TEMP_DIR).filter((f) => f.startsWith(uid));
  const completeFiles = allFiles.filter((f) => !f.endsWith(".part"));

  // Clean up any .part files
  for (const f of allFiles.filter((f) => f.endsWith(".part"))) {
    try { unlinkSync(join(TEMP_DIR, f)); } catch {}
  }

  if (completeFiles.length === 0) {
    // yt-dlp produced nothing — try gallery-dl as a fallback for posts that
    // contain photos/audio/etc. instead of video (Instagram photo posts, Twitter
    // image tweets, etc.).
    try {
      return await tryGalleryDl(url, uid);
    } catch {
      const detail = ytdlpStderr
        ? ytdlpStderr.split("\n").reverse().find((l) => l.startsWith("ERROR:")) || ytdlpStderr
        : null;
      throw new Error(detail ? detail.slice(0, 250) : "File too large or download failed.");
    }
  }

  const filePath = join(TEMP_DIR, completeFiles[0]);
  return { filePath, mediaType: detectMediaType(completeFiles[0]) };
}

function detectMediaType(filename: string): DownloadResult["mediaType"] {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "mp3":
    case "m4a":
    case "ogg":
    case "wav":
    case "opus":
      return "audio";
    case "gif":
      return "animation";
    case "mp4":
    case "mkv":
    case "webm":
    case "mov":
      return "video";
    case "jpg":
    case "jpeg":
    case "png":
    case "webp":
    case "heic":
      return "photo";
    default:
      return "document";
  }
}

// Fallback for sites where yt-dlp finds no video. gallery-dl handles photo posts,
// carousels, audio-only posts, etc. Downloads to a per-uid subdirectory, picks
// the first file, moves it next to other temp files for the standard cleanup.
async function tryGalleryDl(url: string, uid: string): Promise<DownloadResult> {
  const subdir = join(TEMP_DIR, `gd-${uid}`);
  mkdirSync(subdir, { recursive: true });

  const args = ["-D", subdir, url];
  const proxy = process.env.YTDLP_PROXY;
  if (proxy && isTikTok(url)) {
    args.unshift("--proxy", proxy);
  }
  const igCookies = process.env.INSTAGRAM_COOKIES;
  if (igCookies && isInstagram(url) && existsSync(igCookies)) {
    args.unshift("--cookies", igCookies);
  }

  let ranOk = false;
  try {
    await execFileAsync("gallery-dl", args, { timeout: 120_000 });
    ranOk = true;
  } catch {
    // gallery-dl may also leave partial files — fall through and check what's present
  }

  let files: string[] = [];
  try {
    files = readdirSync(subdir);
  } catch {}

  if (files.length === 0) {
    try { rmdirSync(subdir); } catch {}
    throw new Error(ranOk ? "gallery-dl produced no files" : "gallery-dl failed");
  }

  // Move the first file out of the subdir so the standard cleanupFile() works,
  // then drop the subdir + any extras (Instagram carousels, etc.).
  const first = files[0];
  const ext = first.split(".").pop() || "bin";
  const finalPath = join(TEMP_DIR, `${uid}.${ext}`);
  renameSync(join(subdir, first), finalPath);

  for (const f of files.slice(1)) {
    try { unlinkSync(join(subdir, f)); } catch {}
  }
  try { rmdirSync(subdir); } catch {}

  return { filePath: finalPath, mediaType: detectMediaType(first) };
}

export async function cleanupFile(filePath: string): Promise<void> {
  try {
    await unlinkAsync(filePath);
  } catch {
    // swallow
  }
}

// Sweep stale leftovers (orphaned .part files, files from a crash, etc.).
// Files newer than maxAgeMs are skipped to avoid touching in-flight downloads.
export function startTempSweep(
  intervalMs: number = 60 * 60 * 1000,
  maxAgeMs: number = 30 * 60 * 1000
): NodeJS.Timeout {
  const sweep = () => {
    try {
      const now = Date.now();
      for (const f of readdirSync(TEMP_DIR)) {
        const p = join(TEMP_DIR, f);
        try {
          const stat = statSync(p);
          if (now - stat.mtimeMs > maxAgeMs) {
            unlinkSync(p);
          }
        } catch {}
      }
    } catch {}
  };
  // Run once at startup, then on the interval
  sweep();
  return setInterval(sweep, intervalMs);
}
