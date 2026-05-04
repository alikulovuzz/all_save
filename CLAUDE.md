# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — run from `src/` with ts-node (no build step)
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run `dist/index.js` (what PM2 runs)
- `npm run migrate` — create the `downloads` table in `data.db`

## Deployment shape

The bot **runs under PM2** on the host (process name `all-save-bot`, see `pm2 list`). Despite what `README.md` suggests, Docker is NOT used to run the bot itself in this deployment — `docker-compose.yml`'s `bot` service is unused here. Only the `telegram-bot-api` container is used, providing the local Bot API server at `http://telegram-bot-api:8081` (or `http://localhost:8081`) which raises the file size limit from 50MB to 2GB.

After editing source: **always `npm run build` before `pm2 reload all-save-bot`** — PM2 runs `dist/`, not `src/`. Forgetting the build is a common footgun.

After editing `.env`: `pm2 reload all-save-bot --update-env` (plain `reload` does not pick up env changes).

## Host requirements

`yt-dlp` and `ffmpeg` must be installed **on the host** (not just inside the Dockerfile), because the Node process calls them via `execFile` directly. Missing host-side `ffmpeg` is silent and shows up as **YouTube videos downloading without audio**: yt-dlp can't merge separate DASH video+audio streams, the error is swallowed by the try/catch in `downloadMedia`, and a video-only file is sent.

Verify with `which ffmpeg && which yt-dlp`.

## Architecture

**Owner-first send pattern (`src/bot.ts`).** When a non-cached link arrives, the file is downloaded locally, then `sendMediaToOwner` uploads it to `OWNER_ID`. The resulting Telegram `file_id` is stored in SQLite. Subsequent requests — including from other users — are served by sending that `file_id` (no re-upload, no re-download). This is why every send goes through the owner's chat first.

**Cache key.** For non-YouTube URLs the key is the URL itself. For YouTube the key is `${url}|${formatId}` so different resolutions are cached independently (`src/bot.ts:59,198`).

**YouTube format flow.** YouTube has a two-step flow because DASH streams are common:
1. `listFormats` (`src/downloader.ts`) calls `yt-dlp -j`, groups by resolution, and produces a **complete yt-dlp format spec per resolution**: `${id}+bestaudio` for video-only DASH formats, plain `${id}` for combined formats. This spec is stored as `formatId` and sent through Telegram callback data.
2. On user selection, `downloadMedia` passes the spec straight to `yt-dlp -f`. Do not append `+bestaudio/best` again — that fallback can silently pick a video-only stream and produce muted output.

YouTube Shorts (`/shorts/...`) skip the resolution picker — `isYouTube` returns `false` for them so they go through the direct-enqueue path (`src/link-detector.ts:44`).

**Serial queue (`src/queue.ts`).** All downloads are processed one-at-a-time by `DownloadQueue`. Concurrent `yt-dlp` runs were crashing the bot; do not parallelize without revisiting this.

**Non-owner size cap.** Resolution buttons are filtered out for non-owners when `filesize > 500MB` (`src/bot.ts:136`). Owner has no cap (Telegram local API limit is 2GB).

**Pending YouTube selections** live in an in-memory `Map` keyed by a 12-char URL hash (`src/bot.ts:12`), with a 5-minute TTL. Restarting the bot clears them; users get a "Session expired" callback answer.

## Database

SQLite via `better-sqlite3` at `data.db` (WAL mode). Single table: `downloads(original_url, telegram_file_id, telegram_message_id, chat_id, media_type)`. To force re-downloads, delete rows from `downloads` — `data.db` has no `sqlite3` CLI on this host; use `node -e` with `better-sqlite3` instead.

## Environment variables (.env)

`TOKEN`, `OWNER_ID`, `ADDRESS_BOT` (caption text, e.g. `@my_bot`), `API_ROOT` (local Bot API URL), `API_ID`, `API_HASH` (only consumed by the `telegram-bot-api` container).
