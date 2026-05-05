import { appendFileSync, mkdirSync, existsSync, statSync, truncateSync } from "fs";
import { join } from "path";

const LOG_DIR = join(__dirname, "..", "logs");

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

function logFile(): string {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return join(LOG_DIR, `bot-${date}.log`);
}

function write(level: string, message: string, extra?: unknown): void {
  const ts = new Date().toISOString();
  let line = `[${ts}] [${level}] ${message}`;

  if (extra !== undefined) {
    const extraStr =
      extra instanceof Error
        ? `${extra.message}${extra.stack ? "\n" + extra.stack : ""}`
        : typeof extra === "object"
        ? JSON.stringify(extra, null, 2)
        : String(extra);
    line += "\n" + extraStr;
  }

  line += "\n";

  try {
    const path = logFile();
    // Keep each daily file under 20 MB — truncate oldest half when exceeded
    if (existsSync(path) && statSync(path).size > 20 * 1024 * 1024) {
      truncateSync(path, 0);
      appendFileSync(path, `[${new Date().toISOString()}] [INFO] Log truncated (size limit)\n`);
    }
    appendFileSync(path, line);
  } catch {}

  if (level === "ERROR") {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

export const log = {
  info:  (msg: string, extra?: unknown) => write("INFO",  msg, extra),
  warn:  (msg: string, extra?: unknown) => write("WARN",  msg, extra),
  error: (msg: string, extra?: unknown) => write("ERROR", msg, extra),
};
