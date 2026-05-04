import "dotenv/config";
import { createBot } from "./bot";
import { db } from "./db";
import { startTempSweep } from "./downloader";

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

// Where downloaded media is uploaded for caching (file_ids stored in DB).
// Falls back to the owner's chat for backward compatibility.
const CACHE_CHAT_ID = process.env.CACHE_CHAT_ID
  ? Number(process.env.CACHE_CHAT_ID)
  : Number(OWNER_ID);

const bot = createBot(TOKEN, Number(OWNER_ID), CACHE_CHAT_ID, ADDRESS_BOT, API_ROOT);

// Sweep temp/ every hour so orphaned downloads (from crashes etc.) don't fill the disk
const tempSweepHandle = startTempSweep();

bot.start({
  onStart: (info) => {
    console.log(`Bot @${info.username} started successfully.`);
  },
});

// Graceful shutdown
const shutdown = async () => {
  console.log("Shutting down...");
  clearInterval(tempSweepHandle);
  await bot.stop();
  db.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
