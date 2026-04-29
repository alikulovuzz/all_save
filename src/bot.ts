import { Bot, InlineKeyboard, InputFile } from "grammy";
import type { Message } from "grammy/types";
import { createHash } from "crypto";
import { statSync } from "fs";
import { query } from "./db";
import { DownloadQueue } from "./queue";
import { extractUrl, isYouTube } from "./link-detector";
import { listFormats, downloadMedia, cleanupFile } from "./downloader";
import { DownloadRecord, QueueItem } from "./types";

// Pending YouTube selections: urlHash -> { url, chatId }
const pendingYouTube = new Map<string, { url: string; chatId: number }>();

function hashUrl(url: string): string {
  return createHash("md5").update(url).digest("hex").slice(0, 12);
}

export function createBot(token: string, ownerId: number, botAddress: string, apiRoot?: string) {
  const bot = new Bot(token, apiRoot ? { client: { apiRoot } } : undefined);

  bot.catch((err) => {
    console.error("Bot error:", err.error);
  });

  const downloadQueue = new DownloadQueue(processDownload);

  // --- /start ---
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Welcome! Send me a link from YouTube, Instagram, TikTok, Twitter/X, Snapchat, Facebook, or Reddit and I'll download the media for you.\n\n" +
        "For YouTube links, you'll get to pick the resolution before downloading."
    );
  });

  // --- callback_query for YouTube resolution ---
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("dl:")) return;

    const parts = data.split(":");
    if (parts.length !== 3) return;

    const [, urlHash, formatId] = parts;
    const pending = pendingYouTube.get(urlHash);

    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Session expired. Send the link again." });
      return;
    }

    await ctx.answerCallbackQuery();
    pendingYouTube.delete(urlHash);

    // Delete the resolution picker message
    try {
      await ctx.deleteMessage();
    } catch {}

    const cacheKey = pending.url + "|" + formatId;

    // Check cache
    const cached = query<DownloadRecord[]>(
      "SELECT * FROM downloads WHERE original_url = ? LIMIT 1",
      [cacheKey]
    );

    if (cached.length > 0) {
      const record = cached[0];
      try {
        await sendCachedMedia(bot, pending.chatId, record);
        return;
      } catch {
        query("DELETE FROM downloads WHERE id = ?", [record.id]);
      }
    }

    const statusMsg = await ctx.reply("Waiting in queue...");

    const position = downloadQueue.enqueue({
      url: pending.url,
      chatId: pending.chatId,
      statusMessageId: statusMsg.message_id,
      formatId,
    });

    if (position > 1) {
      await safeEditMessage(bot, pending.chatId, statusMsg.message_id, `Waiting in queue (position ${position})...`);
    }
  });

  // --- message handler ---
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const url = extractUrl(text);
    if (!url) return;

    const chatId = ctx.chat.id;

    if (!isYouTube(url)) {
      // Check cache (for non-YouTube, key is just the url)
      const cached = query<DownloadRecord[]>(
        "SELECT * FROM downloads WHERE original_url = ? LIMIT 1",
        [url]
      );

      if (cached.length > 0) {
        const record = cached[0];
        try {
          await sendCachedMedia(bot, chatId, record);
          return;
        } catch {
          query("DELETE FROM downloads WHERE id = ?", [record.id]);
        }
      }
    }

    if (isYouTube(url)) {
      const statusMsg = await ctx.reply("Fetching available resolutions...");

      try {
        const formats = await listFormats(url);

        if (formats.length === 0) {
          await safeEditMessage(bot, chatId, statusMsg.message_id, "No downloadable formats found.");
          return;
        }

        const urlHash = hashUrl(url);
        pendingYouTube.set(urlHash, { url, chatId });

        const isOwner = chatId === ownerId;
        const keyboard = new InlineKeyboard();
        for (let i = 0; i < formats.length; i++) {
          const f = formats[i];
          const sizeMb = f.filesize ? f.filesize / 1024 / 1024 : 0;
          const tooLarge = !isOwner && sizeMb > 500;

          let label = f.resolution;
          if (f.filesize) {
            label += ` (~${sizeMb.toFixed(1)}MB)`;
          }
          if (tooLarge) continue;

          keyboard.text(label, `dl:${urlHash}:${f.formatId}`);
          if ((i + 1) % 3 === 0) keyboard.row();
        }

        await ctx.api.editMessageText(chatId, statusMsg.message_id, "Choose a resolution:", {
          reply_markup: keyboard,
        });

        // Auto-cleanup after 5 minutes
        setTimeout(() => {
          pendingYouTube.delete(urlHash);
        }, 5 * 60 * 1000);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await safeEditMessage(bot, chatId, statusMsg.message_id, `Failed to fetch formats: ${message}`);
      }

      return;
    }

    // Non-YouTube: enqueue directly
    const statusMsg = await ctx.reply("Waiting in queue...");

    const position = downloadQueue.enqueue({
      url,
      chatId,
      statusMessageId: statusMsg.message_id,
    });

    if (position > 1) {
      await safeEditMessage(bot, chatId, statusMsg.message_id, `Waiting in queue (position ${position})...`);
    }
  });

  // --- Queue processor ---
  async function processDownload(item: QueueItem): Promise<void> {
    const { url, chatId, statusMessageId, formatId } = item;
    let filePath: string | null = null;

    try {
      await safeEditMessage(bot, chatId, statusMessageId, "Downloading...");

      const result = await downloadMedia(url, formatId);
      filePath = result.filePath;

      // Check file size (2GB limit with local Bot API)
      const stat = statSync(filePath);
      if (stat.size > 2000 * 1024 * 1024) {
        await safeEditMessage(bot, chatId, statusMessageId, "File too large (>2GB).");
        return;
      }

      await safeEditMessage(bot, chatId, statusMessageId, "Uploading...");

      const cacheKey = formatId ? `${url}|${formatId}` : url;
      const caption = botAddress;

      const sentMsg = await sendMediaToOwner(bot, ownerId, filePath, result.mediaType, caption);

      const fileId = extractFileId(sentMsg, result.mediaType);

      // Save to DB
      query(
        "INSERT INTO downloads (original_url, telegram_file_id, telegram_message_id, chat_id, media_type) VALUES (?, ?, ?, ?, ?)",
        [cacheKey, fileId, sentMsg.message_id, ownerId, result.mediaType]
      );

      // If requester is not the owner, resend to them
      if (chatId !== ownerId) {
        try {
          await sendCachedMedia(bot, chatId, { telegram_file_id: fileId, media_type: result.mediaType } as DownloadRecord);
        } catch {}
      }

      await safeEditMessage(bot, chatId, statusMessageId, "Done!");
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await safeEditMessage(bot, chatId, statusMessageId, `Failed: ${errMsg.slice(0, 200)}`);
    } finally {
      if (filePath) {
        await cleanupFile(filePath);
      }
    }
  }

  return bot;
}

// --- Helpers ---

async function safeEditMessage(bot: Bot, chatId: number, messageId: number, text: string) {
  try {
    await bot.api.editMessageText(chatId, messageId, text);
  } catch {}
}

async function sendMediaToOwner(
  bot: Bot,
  ownerId: number,
  filePath: string,
  mediaType: string,
  caption: string
) {
  const inputFile = new InputFile(filePath);

  switch (mediaType) {
    case "video":
      return bot.api.sendVideo(ownerId, inputFile, { caption, supports_streaming: true });
    case "audio":
      return bot.api.sendAudio(ownerId, inputFile, { caption });
    case "animation":
      return bot.api.sendAnimation(ownerId, inputFile, { caption });
    default:
      return bot.api.sendDocument(ownerId, inputFile, { caption });
  }
}

function extractFileId(msg: Message, mediaType: string): string {
  switch (mediaType) {
    case "video":
      return msg.video?.file_id || "";
    case "audio":
      return msg.audio?.file_id || "";
    case "animation":
      return msg.animation?.file_id || "";
    default:
      return msg.document?.file_id || "";
  }
}

async function sendCachedMedia(bot: Bot, chatId: number, record: DownloadRecord): Promise<void> {
  const fileId = record.telegram_file_id;

  switch (record.media_type) {
    case "video":
      await bot.api.sendVideo(chatId, fileId);
      break;
    case "audio":
      await bot.api.sendAudio(chatId, fileId);
      break;
    case "animation":
      await bot.api.sendAnimation(chatId, fileId);
      break;
    default:
      await bot.api.sendDocument(chatId, fileId);
      break;
  }
}
