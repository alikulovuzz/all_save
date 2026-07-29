import { Bot, InlineKeyboard, InputFile } from "grammy";
import type { Message, InlineQueryResult } from "grammy/types";
import { createHash } from "crypto";
import { statSync } from "fs";
import { query } from "./db";
import { DownloadQueue } from "./queue";
import { extractUrl, isYouTube, isVimeo, getPlatformName } from "./link-detector";
import { listFormats, downloadMediaWithProgress, cleanupFile } from "./downloader";
import { DownloadRecord, QueueItem, VideoFormat } from "./types";
import { log } from "./logger";
import { classifyError, executeWithRetry, DEFAULT_RETRY_CONFIG } from "./retry";
import {
  ensureUser,
  isUserBanned,
  checkLimit,
  recordDownload,
  getUserStats,
  banUser,
  unbanUser,
  setUserLimit,
  getTopUsers,
} from "./rate-limiter";

// Pending YouTube selections: urlHash -> { url, chatId, userId, formats }
// Buttons carry only a format index — yt-dlp format specs are far over
// Telegram's 64-byte callback_data limit.
const pendingYouTube = new Map<
  string,
  { url: string; chatId: number; userId: number; formats: VideoFormat[] }
>();

function hashUrl(url: string): string {
  return createHash("md5").update(url).digest("hex").slice(0, 12);
}

function rateLimitMessage(used: number, limit: number, resetInMinutes: number): string {
  const hours = Math.floor(resetInMinutes / 60);
  const mins = resetInMinutes % 60;
  const timeStr = hours > 0 ? `${hours} soat ${mins} daqiqada` : `${mins} daqiqada`;
  return `⏳ Kunlik limit tugadi (${used}/${limit}). Keyingi imkoniyat: ${timeStr}.\n\nLimit: 24 soat ichida ${limit} ta yuklab olish.`;
}

function getTargetUserId(text: string, replyFromId?: number): number | null {
  if (replyFromId) return replyFromId;
  const parts = text.trim().split(/\s+/);
  if (parts.length >= 2) {
    const id = parseInt(parts[1], 10);
    if (!isNaN(id)) return id;
  }
  return null;
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
      "Xush kelibsiz! Menga quyidagi platformalardan havola yuboring va men siz uchun mediani yuklab olaman:\n\n" +
        "🎬 YouTube, Vimeo — video (sifat tanlash imkoniyati bilan)\n" +
        "📸 Instagram, Pinterest — rasm va video\n" +
        "🎵 SoundCloud — audio (muqova rasmi bilan)\n" +
        "🎞 TikTok, Twitter/X, Snapchat, Facebook, Reddit — video va rasm\n\n" +
        "💡 Inline rejim: Istalgan chatda @" + botAddress.replace("@", "") + " va havolani yozing."
    );
  });

  // --- /mystats ---
  bot.command("mystats", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    ensureUser(userId, ctx.from?.username);
    const stats = getUserStats(userId);

    await ctx.reply(
      `📊 Sizning statistikangiz:\n` +
      `Bugun: ${stats.today}/${stats.limit} yuklab olish\n` +
      `Umumiy: ${stats.total} ta yuklab olish\n` +
      `Qolgan: ${stats.remaining} ta`
    );
  });

  // --- Admin: /ban ---
  bot.command("ban", async (ctx) => {
    if (ctx.from?.id !== ownerId) return;

    const targetId = getTargetUserId(
      ctx.message?.text || "",
      ctx.message?.reply_to_message?.from?.id
    );
    if (!targetId) {
      await ctx.reply("Foydalanuvchi ID sini kiriting yoki xabarga javob bering.");
      return;
    }
    if (targetId === ownerId) {
      await ctx.reply("Adminni bloklab bo'lmaydi.");
      return;
    }
    banUser(targetId);
    const targetUsername = ctx.message?.reply_to_message?.from?.username;
    const name = targetUsername ? `@${targetUsername}` : String(targetId);
    await ctx.reply(`✅ ${name} bloklandi.`);
  });

  // --- Admin: /unban ---
  bot.command("unban", async (ctx) => {
    if (ctx.from?.id !== ownerId) return;
    const targetId = getTargetUserId(
      ctx.message?.text || "",
      ctx.message?.reply_to_message?.from?.id
    );
    if (!targetId) {
      await ctx.reply("Foydalanuvchi ID sini kiriting yoki xabarga javob bering.");
      return;
    }
    unbanUser(targetId);
    await ctx.reply(`✅ Foydalanuvchi ${targetId} blokdan chiqarildi.`);
  });

  // --- Admin: /setlimit <user_id> <limit> ---
  bot.command("setlimit", async (ctx) => {
    if (ctx.from?.id !== ownerId) return;
    const parts = (ctx.message?.text || "").trim().split(/\s+/);
    if (parts.length < 3) {
      await ctx.reply("Ishlatish: /setlimit <user_id> <limit>");
      return;
    }
    const targetId = parseInt(parts[1], 10);
    const newLimit = parseInt(parts[2], 10);
    if (isNaN(targetId) || isNaN(newLimit) || newLimit < 1) {
      await ctx.reply("Noto'g'ri parametrlar. Limit musbat son bo'lishi kerak.");
      return;
    }
    setUserLimit(targetId, newLimit);
    await ctx.reply(`✅ Foydalanuvchi ${targetId} uchun limit ${newLimit} ga o'zgartirildi.`);
  });

  // --- Admin: /userinfo <user_id or reply> ---
  bot.command("userinfo", async (ctx) => {
    if (ctx.from?.id !== ownerId) return;
    const targetId = getTargetUserId(
      ctx.message?.text || "",
      ctx.message?.reply_to_message?.from?.id
    );
    if (!targetId) {
      await ctx.reply("Foydalanuvchi ID sini kiriting yoki xabarga javob bering.");
      return;
    }
    const stats = getUserStats(targetId);
    if (stats.firstSeen === null) {
      await ctx.reply(`Foydalanuvchi ${targetId} topilmadi.`);
      return;
    }
    const banStatus = stats.isBanned ? "🚫 Bloklangan" : "✅ Faol";
    await ctx.reply(
      `👤 ID: ${targetId}\n` +
      `📅 Birinchi kirish: ${stats.firstSeen}\n` +
      `📊 Bugun: ${stats.today}/${stats.limit}\n` +
      `📦 Jami: ${stats.total} ta\n` +
      `⚡ Qolgan: ${stats.remaining} ta\n` +
      `${banStatus}`
    );
  });

  // --- Admin: /users ---
  bot.command("users", async (ctx) => {
    if (ctx.from?.id !== ownerId) return;
    const users = getTopUsers(10);
    if (users.length === 0) {
      await ctx.reply("Hali foydalanuvchilar yo'q.");
      return;
    }
    const lines = users.map((u, i) => {
      const name = u.username ? `@${u.username}` : `#${u.telegram_id}`;
      const banned = u.is_banned ? " 🚫" : "";
      return `${i + 1}. ${name}${banned} — ${u.total_downloads} ta`;
    });
    await ctx.reply("🏆 Top 10 faol foydalanuvchilar:\n\n" + lines.join("\n"));
  });

  // --- inline_query handler ---
  bot.on("inline_query", async (ctx) => {
    try {
      const url = extractUrl(ctx.inlineQuery.query.trim());

      if (!url) {
        await ctx.answerInlineQuery([], { cache_time: 5 });
        return;
      }

      const userId = ctx.from.id;

      if (isUserBanned(userId)) {
        await ctx.answerInlineQuery([], { cache_time: 5, is_personal: true });
        return;
      }

      const limitResult = checkLimit(userId);
      if (!limitResult.allowed) {
        const hours = Math.floor(limitResult.resetInMinutes / 60);
        const mins = limitResult.resetInMinutes % 60;
        const timeStr = hours > 0 ? `${hours} soat ${mins} daqiqada` : `${mins} daqiqada`;
        const rateLimitArticle: InlineQueryResult = {
          type: "article",
          id: "rate-limited",
          title: "⏳ Limit tugadi",
          description: `Keyingi imkoniyat: ${timeStr}`,
          input_message_content: { message_text: `⏳ Kunlik limit tugadi. Keyingi imkoniyat: ${timeStr}.` },
        };
        await ctx.answerInlineQuery([rateLimitArticle], { cache_time: 0, is_personal: true });
        return;
      }

      const cached = query<DownloadRecord[]>(
        "SELECT * FROM downloads WHERE original_url = ? LIMIT 1",
        [url]
      );

      if (cached.length > 0) {
        const record = cached[0];
        const result = buildInlineCachedResult(record, botAddress);
        if (result) {
          await ctx.answerInlineQuery([result], { cache_time: 300, is_personal: true });
          return;
        }
      }

      const platform = getPlatformName(url);
      const description = (isYouTube(url) || isVimeo(url))
        ? "Chatda sifat tanlash imkoniyati bilan yuklab olish"
        : "Havolani chatga yuborish va yuklab olish";

      const articleResult: InlineQueryResult = {
        type: "article",
        id: "dl-" + hashUrl(url),
        title: `Yuklab olish: ${platform}`,
        description,
        input_message_content: { message_text: url },
      };
      await ctx.answerInlineQuery([articleResult], { cache_time: 0, is_personal: true });
    } catch (err) {
      console.error("inline_query error:", err);
      try { await ctx.answerInlineQuery([], { cache_time: 5 }); } catch {}
    }
  });

  // --- callback_query for YouTube resolution ---
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("dl:")) return;

    const parts = data.split(":");
    if (parts.length !== 3) return;

    const [, urlHash, formatKey] = parts;
    const pending = pendingYouTube.get(urlHash);

    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Sessiya tugadi. Havolani qayta yuboring." });
      return;
    }

    const formatId =
      formatKey === "audio" ? "audio" : pending.formats[Number(formatKey)]?.formatId;
    if (!formatId) {
      await ctx.answerCallbackQuery({ text: "Sessiya tugadi. Havolani qayta yuboring." });
      return;
    }

    await ctx.answerCallbackQuery();
    pendingYouTube.delete(urlHash);

    try {
      await ctx.deleteMessage();
    } catch {}

    const cacheKey = pending.url + "|" + formatId;
    const userId = pending.userId;

    // Check cache first — cache hits bypass rate limiting
    const cached = query<DownloadRecord[]>(
      "SELECT * FROM downloads WHERE original_url = ? LIMIT 1",
      [cacheKey]
    );

    if (cached.length > 0) {
      const record = cached[0];
      // Still enforce ban for cache hits
      if (isUserBanned(userId)) {
        await ctx.api.sendMessage(pending.chatId, "🚫 Sizga botdan foydalanish taqiqlangan. Admin bilan bog'laning.");
        return;
      }
      try {
        await sendCachedMedia(bot, pending.chatId, record, undefined, botAddress);
        return;
      } catch {
        query("DELETE FROM downloads WHERE id = ?", [record.id]);
      }
    }

    // Cache miss: check ban and limit before downloading
    if (isUserBanned(userId)) {
      await ctx.api.sendMessage(pending.chatId, "🚫 Sizga botdan foydalanish taqiqlangan. Admin bilan bog'laning.");
      return;
    }

    const limitResult = checkLimit(userId);
    if (!limitResult.allowed) {
      await ctx.api.sendMessage(
        pending.chatId,
        rateLimitMessage(limitResult.used, limitResult.limit, limitResult.resetInMinutes)
      );
      return;
    }

    const statusMsg = await ctx.reply("Kutilmoqda...");

    downloadQueue.enqueue({
      url: pending.url,
      chatId: pending.chatId,
      statusMessageId: statusMsg.message_id,
      formatId,
      userId,
    });
  });

  // --- message handler ---
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const url = extractUrl(text);
    if (!url) return;

    const userId = ctx.from?.id;
    if (!userId) return;

    const username = ctx.from?.username;

    // Register user and check ban (applies to all requests, including cache hits)
    ensureUser(userId, username);

    if (isUserBanned(userId)) {
      await ctx.reply("🚫 Sizga botdan foydalanish taqiqlangan. Admin bilan bog'laning.");
      return;
    }

    const chatId = ctx.chat.id;
    const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
    const replyTo = isGroup ? ctx.message.message_id : undefined;
    const useResolutionPicker = (isYouTube(url) || isVimeo(url)) && !isGroup;

    if (!useResolutionPicker) {
      // Check cache — cache hits don't count against the limit
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

      // Cache miss: check rate limit before downloading
      const limitResult = checkLimit(userId);
      if (!limitResult.allowed) {
        await ctx.reply(rateLimitMessage(limitResult.used, limitResult.limit, limitResult.resetInMinutes));
        return;
      }
    }

    if (useResolutionPicker) {
      // Check rate limit before showing resolution picker (early rejection)
      const limitResult = checkLimit(userId);
      if (!limitResult.allowed) {
        await ctx.reply(rateLimitMessage(limitResult.used, limitResult.limit, limitResult.resetInMinutes));
        return;
      }

      const statusMsg = await ctx.reply("Mavjud sifatlar olinmoqda...");

      try {
        const formats = await listFormats(url);

        if (formats.length === 0) {
          await safeEditMessage(bot, chatId, statusMsg.message_id, "Yuklab olinadigan sifatlar topilmadi.");
          return;
        }

        const urlHash = hashUrl(url);
        pendingYouTube.set(urlHash, { url, chatId, userId, formats });

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

          keyboard.text(label, `dl:${urlHash}:${i}`);
          if ((i + 1) % 3 === 0) keyboard.row();
        }

        keyboard.row();
        keyboard.text("🎵 Audio (MP3)", `dl:${urlHash}:audio`);

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
    const statusMsg = isGroup ? null : await ctx.reply("Kutilmoqda...");

    let chosenFormatId: string | undefined;

    // For YouTube/Vimeo in groups: auto-pick highest resolution under ~1GB
    if (isGroup && (isYouTube(url) || isVimeo(url))) {
      try {
        const formats = await listFormats(url);
        const MAX_SIZE = 950 * 1024 * 1024;
        const eligible = formats.filter((f) => f.filesize && f.filesize < MAX_SIZE);
        if (eligible.length > 0) {
          chosenFormatId = eligible[eligible.length - 1].formatId;
        } else if (formats.length > 0) {
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
      cacheKey: isGroup && (isYouTube(url) || isVimeo(url)) ? url : undefined,
      userId,
    });
  });

  // --- Queue processor ---
  async function processDownload(item: QueueItem): Promise<void> {
    const { url, chatId, statusMessageId, formatId, replyTo } = item;
    let filePath: string | null = null;
    const cacheKey = item.cacheKey ?? (formatId ? `${url}|${formatId}` : url);

    // Progress updates — throttled to 1 edit per 3 s to stay within Telegram rate limits.
    let lastProgressUpdate = 0;
    let lastPercent = -1;
    const THROTTLE_MS = 3000;

    const onProgress = statusMessageId
      ? async (percent: number, downloaded: string, speed: string) => {
          const now = Date.now();
          const roundedPercent = Math.floor(percent);
          if (
            roundedPercent === lastPercent ||
            (now - lastProgressUpdate < THROTTLE_MS && percent < 100)
          ) return;

          lastPercent = roundedPercent;
          lastProgressUpdate = now;

          const filled = Math.round(roundedPercent / 5);
          const bar = "▓".repeat(filled) + "░".repeat(20 - filled);
          const progressLabel = formatId === "audio" ? "Audio yuklab olinmoqda..." : "Yuklab olinmoqda...";
          let text = `${progressLabel}\n${bar} ${roundedPercent}%`;
          if (downloaded) text += `\n📦 ${downloaded}`;
          if (speed) text += ` • ⚡ ${speed}`;

          await safeEditMessage(bot, chatId, statusMessageId, text);
        }
      : undefined;

    log.info("processDownload start", { url, formatId, chatId, userId: item.userId, cacheKey });

    try {
      await safeEditMessage(bot, chatId, statusMessageId, formatId === "audio" ? "Audio yuklab olinmoqda..." : "Yuklab olinmoqda...");

      let downloadAttemptCount = 0;
      const result = await executeWithRetry(
        async () => {
          downloadAttemptCount++;
          if (downloadAttemptCount > 1) {
            const label = formatId === "audio" ? "Audio yuklab olinmoqda..." : "Yuklab olinmoqda...";
            await safeEditMessage(bot, chatId, statusMessageId, `${label} (${downloadAttemptCount}-urinish)`);
            lastPercent = -1;
            lastProgressUpdate = 0;
          }
          return downloadMediaWithProgress(url, onProgress, formatId);
        },
        DEFAULT_RETRY_CONFIG,
        async (attempt, maxAttempts, delayMs) => {
          const delaySec = Math.round(delayMs / 1000);
          await safeEditMessage(
            bot, chatId, statusMessageId,
            `⚠️ Xatolik yuz berdi. Qayta urinish ${attempt}/${maxAttempts - 1}...\n` +
            `⏳ ${delaySec} soniyadan keyin qayta yuklab olinadi.`
          );
        }
      );
      filePath = result.filePath;

      // Check file size (2GB limit with local Bot API)
      const stat = statSync(filePath);
      log.info("file downloaded", { url, formatId, filePath, sizeMB: (stat.size / 1024 / 1024).toFixed(1), mediaType: result.mediaType });

      if (stat.size > 2000 * 1024 * 1024) {
        log.warn("file too large, aborting", { url, sizeMB: (stat.size / 1024 / 1024).toFixed(1) });
        await safeEditMessage(bot, chatId, statusMessageId, "Fayl juda katta (>2GB).");
        return;
      }

      await safeEditMessage(bot, chatId, statusMessageId, "Yuborilmoqda...");

      const cacheCaption = `${url}\n${botAddress}`;
      const requesterCaption = botAddress;

      log.info("uploading to cache chat", { cacheChatId, mediaType: result.mediaType });
      const sentMsg = await executeWithRetry(
        () => sendMediaToCache(bot, cacheChatId, filePath!, result.mediaType, cacheCaption),
        {
          maxAttempts: 2,
          baseDelayMs: 3000,
          maxDelayMs: 10000,
          backoffMultiplier: 2,
          jitterMs: 1000,
        },
        async () => {
          await safeEditMessage(bot, chatId, statusMessageId, "⚠️ Yuborishda xatolik. Qayta urinish...");
        }
      );

      const fileId = extractFileId(sentMsg, result.mediaType);
      log.info("uploaded to cache", { cacheKey, fileId, mediaType: result.mediaType });

      // Save to DB
      query(
        "INSERT INTO downloads (original_url, telegram_file_id, telegram_message_id, chat_id, media_type) VALUES (?, ?, ?, ?, ?)",
        [cacheKey, fileId, sentMsg.message_id, cacheChatId, result.mediaType]
      );

      // Record this fresh download against the user's rate limit
      if (item.userId) {
        recordDownload(item.userId, cacheKey);
      }

      if (chatId !== cacheChatId) {
        try {
          await sendCachedMedia(bot, chatId, { telegram_file_id: fileId, media_type: result.mediaType } as DownloadRecord, replyTo, requesterCaption);
          log.info("sent to user", { chatId, mediaType: result.mediaType });
        } catch (sendErr) {
          log.error("send to user failed", { chatId, mediaType: result.mediaType, sendErr });
        }
      }

    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("processDownload error", { url, formatId, chatId, userId: item.userId, errMsg, stack: err instanceof Error ? err.stack : undefined });

      const errorType = classifyError(errMsg);
      let userMessage: string;
      switch (errorType) {
        case "auth_required":
          userMessage = "🔐 Autentifikatsiya xatosi. Video/rasm shaxsiy yoki kirish talab qilinadi.";
          break;
        case "non_retryable":
          userMessage = "❌ " + errMsg.slice(0, 200);
          break;
        default:
          userMessage = `❌ ${DEFAULT_RETRY_CONFIG.maxAttempts} marta urinildi, lekin yuklab bo'lmadi.\n` + errMsg.slice(0, 150);
      }
      await safeEditMessage(bot, chatId, statusMessageId, userMessage);
    } finally {
      if (filePath) {
        await cleanupFile(filePath);
      }
    }
  }

  return bot;
}

// --- Helpers ---

function buildInlineCachedResult(record: DownloadRecord, caption: string): InlineQueryResult | null {
  const id = String(record.id ?? Date.now());
  const fid = record.telegram_file_id;
  switch (record.media_type) {
    case "video":
      return { type: "video", id, video_file_id: fid, title: "Video", caption };
    case "audio":
      return { type: "audio", id, audio_file_id: fid, title: "Audio", caption };
    case "animation":
      return { type: "gif", id, gif_file_id: fid, title: "Animation", caption };
    case "photo":
      return { type: "photo", id, photo_file_id: fid, caption };
    default:
      return { type: "document", id, document_file_id: fid, title: "File", caption };
  }
}

async function safeEditMessage(bot: Bot, chatId: number, messageId: number | undefined, text: string) {
  if (!messageId) return;
  try {
    await bot.api.editMessageText(chatId, messageId, text);
  } catch {}
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
