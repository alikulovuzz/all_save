import "dotenv/config";
import { createBot } from "./bot";
import { db } from "./db";
import { startTempSweep } from "./downloader";
import { runMigrations } from "./migrate";
import { initRateLimiter, cleanupOldDownloads } from "./rate-limiter";

const TOKEN = process.env.TOKEN;
const OWNER_ID = process.env.OWNER_ID;
const ADDRESS_BOT = process.env.ADDRESS_BOT || "";

if (!TOKEN) {
  console.error("Missing TOKEN in .env");
  process.exit(1);
}

if (!OWNER_ID) {
  console.error("Missing OWNER_ID in .env");
  process.exit(1);
}

const API_ROOT = process.env.API_ROOT || undefined;

const CACHE_CHAT_ID = process.env.CACHE_CHAT_ID
  ? Number(process.env.CACHE_CHAT_ID)
  : Number(OWNER_ID);

const DAILY_LIMIT = process.env.DAILY_LIMIT ? Number(process.env.DAILY_LIMIT) : 15;

// Run DB migrations before anything else
runMigrations();

// Initialize rate limiter with owner exemption and default limit
initRateLimiter(Number(OWNER_ID), DAILY_LIMIT);

const bot = createBot(TOKEN, Number(OWNER_ID), CACHE_CHAT_ID, ADDRESS_BOT, API_ROOT);

// Sweep temp/ every hour so orphaned downloads (from crashes etc.) don't fill the disk
const tempSweepHandle = startTempSweep();

// Clean up old user_downloads records (older than 48h) every hour
const cleanupHandle = setInterval(() => {
  try {
    cleanupOldDownloads();
  } catch {}
}, 60 * 60 * 1000);

bot.start({
  onStart: (info) => {
    console.log(`Bot @${info.username} started successfully.`);
  },
});

// Graceful shutdown
const shutdown = async () => {
  console.log("Shutting down...");
  clearInterval(tempSweepHandle);
  clearInterval(cleanupHandle);
  await bot.stop();
  db.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
