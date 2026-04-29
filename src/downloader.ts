import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { unlink, unlinkSync, mkdirSync, existsSync, readdirSync } from "fs";
import { randomUUID } from "crypto";
import { VideoFormat, DownloadResult } from "./types";

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

    const isVideoWithAudio = f.acodec !== "none" && f.vcodec !== "none";
    const isMp4 = (f.ext === "mp4" || f.video_ext === "mp4");

    if (!existing) {
      resolutionMap.set(resolution, {
        formatId: String(f.format_id),
        resolution,
        ext: f.ext || "mp4",
        filesize: f.filesize || f.filesize_approx,
      });
    } else {
      if (isVideoWithAudio && isMp4) {
        resolutionMap.set(resolution, {
          formatId: String(f.format_id),
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
    args.push("-f", `${formatId}+bestaudio/best`);
  }

  args.push(url);

  try {
    await execFileAsync("yt-dlp", args, {
      timeout: 120_000,
    });
  } catch {
    // yt-dlp may exit non-zero on max-filesize abort — check for output below
  }

  // Find the downloaded file by UUID prefix, ignore .part files
  const allFiles = readdirSync(TEMP_DIR).filter((f) => f.startsWith(uid));
  const completeFiles = allFiles.filter((f) => !f.endsWith(".part"));

  // Clean up any .part files
  for (const f of allFiles.filter((f) => f.endsWith(".part"))) {
    try { unlinkSync(join(TEMP_DIR, f)); } catch {}
  }

  if (completeFiles.length === 0) {
    throw new Error("File too large or download failed.");
  }

  const filePath = join(TEMP_DIR, completeFiles[0]);
  const ext = completeFiles[0].split(".").pop()?.toLowerCase() || "";
  let mediaType: DownloadResult["mediaType"];

  switch (ext) {
    case "mp3":
    case "m4a":
    case "ogg":
    case "wav":
    case "opus":
      mediaType = "audio";
      break;
    case "gif":
      mediaType = "animation";
      break;
    case "mp4":
    case "mkv":
    case "webm":
    case "mov":
      mediaType = "video";
      break;
    default:
      mediaType = "document";
      break;
  }

  return { filePath, mediaType };
}

export async function cleanupFile(filePath: string): Promise<void> {
  try {
    await unlinkAsync(filePath);
  } catch {
    // swallow
  }
}
