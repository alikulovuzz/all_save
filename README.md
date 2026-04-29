# All Save Bot

Telegram bot that downloads media from YouTube, Instagram, TikTok, Twitter/X, Snapchat, Facebook, and Reddit. Supports files up to 2GB via a local Telegram Bot API server.

## Features

- Downloads video/audio from supported platforms via yt-dlp
- YouTube resolution picker (inline keyboard)
- YouTube Shorts download without resolution prompt
- Caches downloads in SQLite to avoid re-downloading
- Serial download queue to prevent crashes
- Files up to 2GB via local Telegram Bot API
- Non-owner users limited to 500MB per video

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- Telegram Bot Token from [@BotFather](https://t.me/BotFather)
- Telegram API ID and API Hash from [my.telegram.org](https://my.telegram.org)

## Installation

### 1. Clone the repository

```bash
git clone <repo-url>
cd all_save_bot
```

### 2. Create `.env` file

```env
TOKEN=your_bot_token
OWNER_ID=your_telegram_user_id
ADDRESS_BOT=@your_bot_username
API_ID=your_api_id
API_HASH=your_api_hash
API_ROOT=http://telegram-bot-api:8081
```

| Variable | Description |
|----------|-------------|
| `TOKEN` | Bot token from @BotFather |
| `OWNER_ID` | Your Telegram user ID (get it from @userinfobot) |
| `ADDRESS_BOT` | Bot username for captions (e.g., `@my_bot`) |
| `API_ID` | Telegram API ID from my.telegram.org |
| `API_HASH` | Telegram API Hash from my.telegram.org |
| `API_ROOT` | Local Bot API URL (keep as `http://telegram-bot-api:8081` for Docker) |

### 3. Log out from official Telegram API

Before using a local Bot API server, you must log out from the official one:

```bash
curl https://api.telegram.org/bot<TOKEN>/logOut
```

### 4. Start with Docker Compose

```bash
docker compose up -d --build
```

### 5. Check logs

```bash
docker compose logs -f bot
```

## Local Development (without Docker)

### Prerequisites

- Node.js 20+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`pip install yt-dlp`)
- [ffmpeg](https://ffmpeg.org/download.html)

### Setup

```bash
npm install
```

For local development, change `API_ROOT` in `.env` to `http://localhost:8081` and run the local Bot API server separately:

```bash
docker run -d -p 8081:8081 \
  -e TELEGRAM_API_ID=your_api_id \
  -e TELEGRAM_API_HASH=your_api_hash \
  aiogram/telegram-bot-api:latest
```

### Run database migration

```bash
npm run migrate
```

### Start the bot

```bash
npm run dev
```

## Usage

1. Send a link from any supported platform to the bot
2. For YouTube videos, pick a resolution from the inline keyboard
3. The bot downloads and sends the media to the owner chat
4. Subsequent requests for the same link are served from cache

## Project Structure

```
src/
  index.ts          - Entry point
  bot.ts            - grammY bot setup and handlers
  db.ts             - SQLite database helper
  migrate.ts        - Database schema setup
  queue.ts          - Serial download queue
  downloader.ts     - yt-dlp wrapper
  link-detector.ts  - URL extraction and platform detection
  types.ts          - TypeScript interfaces
```
