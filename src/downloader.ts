import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { join, dirname } from "path";
import { unlink, unlinkSync, mkdirSync, existsSync, readdirSync, statSync, renameSync, rmdirSync, rmSync } from "fs";
import { randomUUID } from "crypto";
import { VideoFormat, DownloadResult } from "./types";
import { isTikTok, isInstagram, isPinterest, isSoundCloud, isYouTubeHost } from "./link-detector";
import { log } from "./logger";

export type ProgressCallback = (percent: number, downloaded: string, speed: string) => void;

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
  log.info("listFormats start", { url });
  const listArgs: string[] = ["-j", "--no-playlist", "--js-runtimes", "node"];
  const ytCookies = process.env.YOUTUBE_COOKIES;
  if (ytCookies && isYouTubeHost(url) && existsSync(ytCookies)) {
    listArgs.push("--cookies", ytCookies);
  }
  listArgs.push(url);

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("yt-dlp", listArgs, {
      timeout: 30_000,
    }));
  } catch (err) {
    log.error("listFormats failed", { url, err });
    throw err;
  }

  const info = JSON.parse(stdout);
  const formats: YtDlpFormat[] = info.formats || [];

  const resolutionMap = new Map<string, VideoFormat & { isH264: boolean }>();

  for (const f of formats) {
    if (!f.height || f.height < 240) continue;
    if (f.acodec === "none" && f.vcodec === "none") continue;

    const resolution = `${f.height}p`;
    const existing = resolutionMap.get(resolution);

    const isVideoOnly = f.vcodec !== "none" && f.acodec === "none";
    const isVideoWithAudio = f.acodec !== "none" && f.vcodec !== "none";
    const isMp4 = (f.ext === "mp4" || f.video_ext === "mp4");
    // iOS requires H.264 (avc1) or H.265 — prefer those over VP9/AV1
    const isH264 = f.vcodec?.startsWith("avc") ?? false;

    // Build complete yt-dlp format spec with resolution-based fallback in case
    // the exact format ID becomes unavailable between listFormats and download.
    // Fallback chain prefers H.264+AAC for iOS compatibility.
    const formatSpec = isVideoOnly
      ? `${f.format_id}+bestaudio[acodec^=mp4a]/bestvideo[height<=${f.height}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[height<=${f.height}]+bestaudio`
      : `${f.format_id}/bestvideo[height<=${f.height}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[height<=${f.height}]+bestaudio`;

    const entry = {
      formatId: formatSpec,
      resolution,
      ext: f.ext || "mp4",
      filesize: f.filesize || f.filesize_approx,
      isH264,
    };

    if (!existing) {
      resolutionMap.set(resolution, entry);
    } else {
      // Prefer H.264 over VP9/AV1; among same codec, prefer combined video+audio over DASH
      const upgradeToH264 = isH264 && !existing.isH264;
      const sameCodecUpgrade = isH264 === existing.isH264 && isVideoWithAudio && isMp4;
      if (upgradeToH264 || sameCodecUpgrade) {
        resolutionMap.set(resolution, entry);
      }
    }
  }

  const result = Array.from(resolutionMap.values()).map(({ isH264: _h, ...rest }) => rest);
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
  // Pinterest: gallery-dl first, yt-dlp as fallback
  if (isPinterest(url) && !formatId) {
    try {
      return await tryGalleryDl(url, randomUUID());
    } catch {
      // fall through to yt-dlp
    }
  }

  const uid = randomUUID();
  const outputTemplate = join(TEMP_DIR, `${uid}.%(ext)s`);

  const args = ["--no-playlist"];

  if (isSoundCloud(url) && !formatId) {
    args.push(
      "--audio-quality", "0",
      "--embed-thumbnail",
      "--add-metadata",
      "--max-filesize", "2000m",
      "-o", outputTemplate,
    );
  } else {
    args.push(
      "--merge-output-format", "mp4",
      "--remux-video", "mp4",
      "--max-filesize", "2000m",
      // Parallelize HLS fragment downloads — Twitter/etc. throttle per-connection, so serial
      // fetching of a long video's fragments is what pushed large clips past the timeout.
      "--concurrent-fragments", "8",
      "-o", outputTemplate,
    );
    if (formatId) {
      args.push("-f", formatId);
    } else {
      // Prefer H.264+AAC so iOS can play without re-encoding; fall back to best available
      // Instagram/TikTok/etc. only have combined streams — include best[vcodec^=avc1] to match those.
      // width<=?1920 skips oversized variants (e.g. Twitter's 2880-wide multi-GB HLS on long videos)
      // that --max-filesize can't abort for m3u8; the `?` keeps formats whose width is unknown.
        args.push("-f", "bestvideo[vcodec^=avc1][width<=?1920]+bestaudio[acodec^=mp4a]/best[vcodec^=avc1][width<=?1920][ext=mp4]/best[vcodec^=avc1][width<=?1920]/bestvideo[width<=?1920][ext=mp4]+bestaudio/bestvideo[width<=?1920]+bestaudio/bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[vcodec^=avc1]/best");
    }
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

  const ytCookies = process.env.YOUTUBE_COOKIES;
  if (ytCookies && isYouTubeHost(url) && existsSync(ytCookies)) {
    args.unshift("--cookies", ytCookies);
  }

  args.push(url);

  let ytdlpStderr: string | null = null;
  try {
    await execFileAsync("yt-dlp", args, {
      timeout: 300_000,
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
  return ensureH264IfNeeded({ filePath, mediaType: detectMediaType(completeFiles[0]) });
}

// Parses yt-dlp --newline progress lines from stdout/stderr.
// Examples:
//   [download]  45.2% of 125.30MiB at 2.50MiB/s ETA 00:34
//   [download] 100% of 125.30MiB in 00:50
function parseProgress(line: string): { percent: number; downloaded: string; speed: string } | null {
  const match = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\w+)\s+at\s+([\d.]+\w+\/s)/);
  if (match) {
    return { percent: parseFloat(match[1]), downloaded: match[2], speed: match[3] };
  }
  const doneMatch = line.match(/\[download\]\s+100%\s+of\s+~?([\d.]+\w+)/);
  if (doneMatch) {
    return { percent: 100, downloaded: doneMatch[1], speed: "" };
  }
  return null;
}

export async function downloadMediaWithProgress(
  url: string,
  onProgress?: ProgressCallback,
  formatId?: string
): Promise<DownloadResult> {
  // Pinterest: gallery-dl first, yt-dlp as fallback
  if (isPinterest(url) && !formatId) {
    try {
      return await tryGalleryDl(url, randomUUID());
    } catch {
      // fall through to yt-dlp
    }
  }

  return new Promise<DownloadResult>((resolve, reject) => {
    const uid = randomUUID();
    const subDir = join(TEMP_DIR, uid);
    mkdirSync(subDir, { recursive: true });
    const outputTemplate = join(subDir, "%(title)s.%(ext)s");

    const args: string[] = [];

    if (isSoundCloud(url) && !formatId) {
      args.push(
        "--no-playlist",
        "--newline",
        "--audio-quality", "0",
        "--embed-thumbnail",
        "--add-metadata",
        "--max-filesize", "2000m",
        "-o", outputTemplate,
      );
    } else if (formatId === "audio") {
      args.push(
        "--no-playlist",
        "--newline",
        "-x",
        "--audio-format", "mp3",
        "--audio-quality", "0",
        "--embed-thumbnail",
        "--add-metadata",
        "--max-filesize", "2000m",
        "-o", outputTemplate,
      );
    } else {
      args.push(
        "--no-playlist",
        "--newline",
        "--merge-output-format", "mp4",
        "--remux-video", "mp4",
        "--max-filesize", "2000m",
        // Parallelize HLS fragment downloads — Twitter/etc. throttle per-connection, so serial
        // fetching of a long video's fragments is what pushed large clips past the timeout.
        "--concurrent-fragments", "8",
        "-o", outputTemplate,
      );
      if (formatId) {
        args.push("-f", formatId);
      } else {
        // Prefer H.264+AAC so iOS can play without re-encoding; fall back to best available
        // Instagram/TikTok/etc. only have combined streams — include best[vcodec^=avc1] to match those.
        // width<=?1920 skips oversized variants (e.g. Twitter's 2880-wide multi-GB HLS on long videos)
        // that --max-filesize can't abort for m3u8; the `?` keeps formats whose width is unknown.
        args.push("-f", "bestvideo[vcodec^=avc1][width<=?1920]+bestaudio[acodec^=mp4a]/best[vcodec^=avc1][width<=?1920][ext=mp4]/best[vcodec^=avc1][width<=?1920]/bestvideo[width<=?1920][ext=mp4]+bestaudio/bestvideo[width<=?1920]+bestaudio/bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[vcodec^=avc1]/best");
      }
    }

    const proxy = process.env.YTDLP_PROXY;
    if (proxy && isTikTok(url)) {
      args.unshift("--proxy", proxy);
    }

    const igCookies = process.env.INSTAGRAM_COOKIES;
    if (igCookies && isInstagram(url) && existsSync(igCookies)) {
      args.unshift("--cookies", igCookies);
    }

    const ytCookies = process.env.YOUTUBE_COOKIES;
    if (ytCookies && isYouTubeHost(url) && existsSync(ytCookies)) {
      args.unshift("--cookies", ytCookies);
    }

    // YouTube requires JS runtime to solve the n-parameter throttling challenge.
    // Without this, yt-dlp falls back to image-only streams and all format downloads fail.
    if (isYouTubeHost(url)) {
      args.unshift("--js-runtimes", "node");
    }

    args.push(url);

    log.info("yt-dlp spawn", { url, formatId, args: args.join(" ") });

    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderrBuffer = "";

    const handleLines = (text: string) => {
      if (!onProgress) return;
      for (const line of text.split("\n")) {
        const progress = parseProgress(line);
        if (progress) onProgress(progress.percent, progress.downloaded, progress.speed);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => handleLines(chunk.toString()));

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuffer += text;
      handleLines(text);
    });

    const timer = setTimeout(() => {
      child.kill();
      log.error("yt-dlp timeout", { url, formatId, stderr: stderrBuffer });
      reject(new Error("Download timed out after 300s"));
    }, 300_000);

    child.on("close", (code) => {
      clearTimeout(timer);
      log.info("yt-dlp close", { url, formatId, exitCode: code, stderr: stderrBuffer || "(none)" });

      let allFiles: string[] = [];
      try { allFiles = readdirSync(subDir); } catch {}
      const completeFiles = allFiles.filter((f) => !f.endsWith(".part"));

      for (const f of allFiles.filter((f) => f.endsWith(".part"))) {
        try { unlinkSync(join(subDir, f)); } catch {}
      }

      if (completeFiles.length === 0) {
        log.warn("yt-dlp no output, trying gallery-dl", { url, formatId });
        tryGalleryDl(url, uid).then((r) => ensureH264IfNeeded(r).then(resolve).catch(() => resolve(r))).catch(() => {
          const detail = stderrBuffer
            .split("\n")
            .reverse()
            .find((l) => l.startsWith("ERROR:")) || stderrBuffer;
          const msg = detail ? detail.slice(0, 250) : "Download failed.";
          log.error("gallery-dl also failed", { url, msg });
          reject(new Error(msg));
        });
        return;
      }

      const filePath = join(subDir, completeFiles[0]);
      const fileSize = (() => { try { return statSync(filePath).size; } catch { return 0; } })();
      log.info("yt-dlp file ready", { url, formatId, filePath, fileSize });
      ensureH264IfNeeded({ filePath, mediaType: detectMediaType(completeFiles[0]) })
        .then(resolve)
        .catch(() => resolve({ filePath, mediaType: detectMediaType(completeFiles[0]) }));
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      log.error("yt-dlp spawn error", { url, formatId, err });
      reject(err);
    });
  });
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

// Probe the video codec and re-encode to H.264/AAC if iOS can't play it (VP9, AV1, etc.).
// H.264 and HEVC files are returned as-is (no re-encode, fast path).
async function ensureH264IfNeeded(result: DownloadResult): Promise<DownloadResult> {
  if (result.mediaType !== "video") return result;

  let codec = "";
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name",
      "-of", "default=noprint_wrappers=1:nokey=1",
      result.filePath,
    ], { timeout: 15_000 });
    codec = stdout.trim().toLowerCase();
  } catch {
    return result;
  }

  log.info("codec probe", { filePath: result.filePath, codec });

  if (!codec || codec === "h264" || codec === "hevc") return result;

  // VP9, AV1, or anything else: re-encode to H.264 so iOS can play it
  const outputPath = result.filePath.replace(/(\.[^.]+)$/, "_h264.mp4");
  log.info("re-encoding to H.264", { codec, outputPath });

  try {
    await execFileAsync("ffmpeg", [
      "-i", result.filePath,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ], { timeout: 300_000 });
    try { unlinkSync(result.filePath); } catch {}
    return { filePath: outputPath, mediaType: "video" };
  } catch (err) {
    log.error("re-encode failed, using original", { err });
    return result;
  }
}

export async function cleanupFile(filePath: string): Promise<void> {
  try {
    await unlinkAsync(filePath);
    const parent = dirname(filePath);
    if (parent !== TEMP_DIR) {
      try { rmdirSync(parent); } catch {}
    }
  } catch {}
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
            if (stat.isDirectory()) {
              rmSync(p, { recursive: true, force: true });
            } else {
              unlinkSync(p);
            }
          }
        } catch {}
      }
    } catch {}
  };
  // Run once at startup, then on the interval
  sweep();
  return setInterval(sweep, intervalMs);
}
