import "dotenv/config";
import { createBot } from "./bot";
import { db } from "./db";

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

const bot = createBot(TOKEN, Number(OWNER_ID), ADDRESS_BOT, API_ROOT);

bot.start({
  onStart: (info) => {
    console.log(`Bot @${info.username} started successfully.`);
  },
});

// Graceful shutdown
const shutdown = async () => {
  console.log("Shutting down...");
  await bot.stop();
  db.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
