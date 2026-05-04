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

export function createBot(token: string, ownerId: number, cacheChatId: number, botAddress: string, apiRoot?: string) {
  const bot = new Bot(token, apiRoot ? { client: { apiRoot } } : undefined);

  bot.catch((err) => {
    console.error("Bot error:", err.error);
  });

  // VDS can handle ~5 concurrent yt-dlp + Telegram uploads in parallel
  const downloadQueue = new DownloadQueue(processDownload, 5);

  // --- /start ---
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Xush kelibsiz! Menga YouTube, Instagram, TikTok, Twitter/X, Snapchat, Facebook yoki Reddit havolasini yuboring va men siz uchun mediani yuklab olaman.\n\n" +
        "YouTube havolalari uchun yuklab olishdan oldin sifatni (resolution) tanlash imkoniyatiga ega bo'lasiz."
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
      await ctx.answerCallbackQuery({ text: "Sessiya tugadi. Havolani qayta yuboring." });
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
        // Resolution picker only fires in private chats, so caption is always included
        await sendCachedMedia(bot, pending.chatId, record, undefined, botAddress);
        return;
      } catch {
        query("DELETE FROM downloads WHERE id = ?", [record.id]);
      }
    }

    const statusMsg = await ctx.reply("Kutilmoqda...");

    downloadQueue.enqueue({
      url: pending.url,
      chatId: pending.chatId,
      statusMessageId: statusMsg.message_id,
      formatId,
    });
  });

  // --- message handler ---
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const url = extractUrl(text);
    if (!url) return;

    const chatId = ctx.chat.id;
    const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
    const replyTo = isGroup ? ctx.message.message_id : undefined;
    // In groups, skip the resolution picker — default to best quality
    const useResolutionPicker = isYouTube(url) && !isGroup;

    if (!useResolutionPicker) {
      // Cache key is the URL (group YouTube downloads share with non-YouTube path)
      const cached = query<DownloadRecord[]>(
        "SELECT * FROM downloads WHERE original_url = ? LIMIT 1",
        [url]
      );

      if (cached.length > 0) {
        const record = cached[0];
        try {
          await sendCachedMedia(bot, chatId, record, replyTo, botAddress);
          return;
        } catch {
          query("DELETE FROM downloads WHERE id = ?", [record.id]);
        }
      }
    }

    if (useResolutionPicker) {
      const statusMsg = await ctx.reply("Mavjud sifatlar olinmoqda...");

      try {
        const formats = await listFormats(url);

        if (formats.length === 0) {
          await safeEditMessage(bot, chatId, statusMsg.message_id, "Yuklab olinadigan sifatlar topilmadi.");
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

        await ctx.api.editMessageText(chatId, statusMsg.message_id, "Sifatni tanlang:", {
          reply_markup: keyboard,
        });

        // Auto-cleanup after 5 minutes
        setTimeout(() => {
          pendingYouTube.delete(urlHash);
        }, 5 * 60 * 1000);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await safeEditMessage(bot, chatId, statusMsg.message_id, `Sifatlarni olishda xatolik: ${message}`);
      }

      return;
    }

    // Direct enqueue (non-YouTube, or YouTube in a group).
    // Groups get no status messages — only the media (or silence on failure).
    const statusMsg = isGroup ? null : await ctx.reply("Kutilmoqda...");

    let chosenFormatId: string | undefined;

    // For YouTube in groups: auto-pick highest resolution under ~1GB
    if (isGroup && isYouTube(url)) {
      try {
        const formats = await listFormats(url);
        // Leave headroom: 950 MiB cap, since DASH video-only filesize doesn't include audio,
        // and yt-dlp size estimates are approximate.
        const MAX_SIZE = 950 * 1024 * 1024;
        const eligible = formats.filter((f) => f.filesize && f.filesize < MAX_SIZE);
        if (eligible.length > 0) {
          // formats are sorted ascending by resolution; last eligible is the highest
          chosenFormatId = eligible[eligible.length - 1].formatId;
        } else if (formats.length > 0) {
          // No size info — fall back to lowest resolution to stay safely under 1GB
          chosenFormatId = formats[0].formatId;
        }
      } catch {
        // listFormats failed; proceed without a specific format
      }
    }

    downloadQueue.enqueue({
      url,
      chatId,
      statusMessageId: statusMsg?.message_id,
      replyTo,
      formatId: chosenFormatId,
      // Group YouTube uses URL as cache key (matching the lookup above) so subsequent
      // identical links in any group hit the cache instead of re-running listFormats + download.
      cacheKey: isGroup && isYouTube(url) ? url : undefined,
    });
  });

  // --- Queue processor ---
  async function processDownload(item: QueueItem): Promise<void> {
    const { url, chatId, statusMessageId, formatId, replyTo } = item;
    let filePath: string | null = null;
    const cacheKey = item.cacheKey ?? (formatId ? `${url}|${formatId}` : url);

    try {
      await safeEditMessage(bot, chatId, statusMessageId, "Yuklab olinmoqda...");

      const result = await downloadMedia(url, formatId);
      filePath = result.filePath;

      // Check file size (2GB limit with local Bot API)
      const stat = statSync(filePath);
      if (stat.size > 2000 * 1024 * 1024) {
        await safeEditMessage(bot, chatId, statusMessageId, "Fayl juda katta (>2GB).");
        return;
      }

      await safeEditMessage(bot, chatId, statusMessageId, "Yuborilmoqda...");

      // Cache chat: original URL + bot address (archival).
      // Requester (private chats AND groups): bot address as caption.
      const cacheCaption = `${url}\n${botAddress}`;
      const requesterCaption = botAddress;

      const sentMsg = await sendMediaToCache(bot, cacheChatId, filePath, result.mediaType, cacheCaption);

      const fileId = extractFileId(sentMsg, result.mediaType);

      // Save to DB
      query(
        "INSERT INTO downloads (original_url, telegram_file_id, telegram_message_id, chat_id, media_type) VALUES (?, ?, ?, ?, ?)",
        [cacheKey, fileId, sentMsg.message_id, cacheChatId, result.mediaType]
      );

      // If the request didn't come from the cache chat itself, resend to the requester
      if (chatId !== cacheChatId) {
        try {
          await sendCachedMedia(bot, chatId, { telegram_file_id: fileId, media_type: result.mediaType } as DownloadRecord, replyTo, requesterCaption);
        } catch {}
      }

    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const userFacing = isAuthError(errMsg) ? "47" : errMsg.slice(0, 200);
      await safeEditMessage(bot, chatId, statusMessageId, `Xatolik: ${userFacing}`);
    } finally {
      if (filePath) {
        await cleanupFile(filePath);
      }
    }
  }

  return bot;
}

// --- Helpers ---

async function safeEditMessage(bot: Bot, chatId: number, messageId: number | undefined, text: string) {
  if (!messageId) return;
  try {
    await bot.api.editMessageText(chatId, messageId, text);
  } catch {}
}

// Hide login/cookie/rate-limit details from end users — these are operator concerns,
// not something users can act on. Show them a short opaque code instead.
function isAuthError(errMsg: string): boolean {
  const m = errMsg.toLowerCase();
  return (
    m.includes("login required") ||
    m.includes("login is required") ||
    m.includes("rate-limit") ||
    m.includes("rate limit") ||
    m.includes("--cookies") ||
    m.includes("cookies-from-browser") ||
    m.includes("sign in to confirm") ||
    m.includes("authentication")
  );
}

async function sendMediaToCache(
  bot: Bot,
  cacheChatId: number,
  filePath: string,
  mediaType: string,
  caption?: string
) {
  const inputFile = new InputFile(filePath);

  switch (mediaType) {
    case "video":
      return bot.api.sendVideo(cacheChatId, inputFile, { caption, supports_streaming: true });
    case "audio":
      return bot.api.sendAudio(cacheChatId, inputFile, { caption });
    case "animation":
      return bot.api.sendAnimation(cacheChatId, inputFile, { caption });
    case "photo":
      return bot.api.sendPhoto(cacheChatId, inputFile, { caption });
    default:
      return bot.api.sendDocument(cacheChatId, inputFile, { caption });
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
    case "photo":
      // Telegram returns multiple sizes — pick the largest (last entry)
      return msg.photo?.[msg.photo.length - 1]?.file_id || "";
    default:
      return msg.document?.file_id || "";
  }
}

async function sendCachedMedia(
  bot: Bot,
  chatId: number,
  record: DownloadRecord,
  replyTo?: number,
  caption?: string
): Promise<void> {
  const fileId = record.telegram_file_id;
  const opts: Record<string, unknown> = {};
  if (replyTo) opts.reply_parameters = { message_id: replyTo };
  if (caption) opts.caption = caption;

  switch (record.media_type) {
    case "video":
      await bot.api.sendVideo(chatId, fileId, opts);
      break;
    case "audio":
      await bot.api.sendAudio(chatId, fileId, opts);
      break;
    case "animation":
      await bot.api.sendAnimation(chatId, fileId, opts);
      break;
    case "photo":
      await bot.api.sendPhoto(chatId, fileId, opts);
      break;
    default:
      await bot.api.sendDocument(chatId, fileId, opts);
      break;
  }
}
