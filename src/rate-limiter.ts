import { query } from "./db";

let _ownerId: number;
let _defaultLimit: number = 15;

export function initRateLimiter(ownerId: number, defaultLimit: number = 15): void {
  _ownerId = ownerId;
  _defaultLimit = defaultLimit;
}

export function ensureUser(telegramId: number, username?: string): void {
  query(
    `INSERT INTO users (telegram_id, username, daily_limit)
     VALUES (?, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET
       username = COALESCE(excluded.username, username)`,
    [telegramId, username ?? null, _defaultLimit]
  );
}

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  resetInMinutes: number;
  used: number;
  limit: number;
}

export function checkLimit(telegramId: number): LimitResult {
  if (telegramId === _ownerId) {
    return { allowed: true, remaining: 9999, resetInMinutes: 0, used: 0, limit: 9999 };
  }

  const userRows = query<Array<{ daily_limit: number; is_banned: number }>>(
    "SELECT daily_limit, is_banned FROM users WHERE telegram_id = ?",
    [telegramId]
  );

  if (!userRows.length) {
    return { allowed: true, remaining: _defaultLimit, resetInMinutes: 0, used: 0, limit: _defaultLimit };
  }

  const { daily_limit, is_banned } = userRows[0];

  if (is_banned) {
    return { allowed: false, remaining: 0, resetInMinutes: 0, used: daily_limit, limit: daily_limit };
  }

  const rows = query<Array<{ count: number; oldest_at: string | null }>>(
    `SELECT COUNT(*) AS count, MIN(created_at) AS oldest_at
     FROM user_downloads
     WHERE telegram_id = ? AND created_at > datetime('now', '-24 hours')`,
    [telegramId]
  );

  const used = (rows[0]?.count as number) ?? 0;

  if (used < daily_limit) {
    return { allowed: true, remaining: daily_limit - used, resetInMinutes: 0, used, limit: daily_limit };
  }

  let resetInMinutes = 0;
  const oldestAt = rows[0]?.oldest_at;
  if (oldestAt) {
    const oldestMs = new Date(oldestAt.replace(" ", "T") + "Z").getTime();
    resetInMinutes = Math.max(0, Math.ceil((oldestMs + 86_400_000 - Date.now()) / 60_000));
  }

  return { allowed: false, remaining: 0, resetInMinutes, used, limit: daily_limit };
}

export function recordDownload(telegramId: number, url: string): void {
  if (telegramId === _ownerId) return;

  query(
    "INSERT INTO user_downloads (telegram_id, url) VALUES (?, ?)",
    [telegramId, url]
  );
  query(
    "UPDATE users SET total_downloads = total_downloads + 1 WHERE telegram_id = ?",
    [telegramId]
  );
}

export function isUserBanned(telegramId: number): boolean {
  if (telegramId === _ownerId) return false;

  const rows = query<Array<{ is_banned: number }>>(
    "SELECT is_banned FROM users WHERE telegram_id = ?",
    [telegramId]
  );

  return rows.length > 0 && rows[0].is_banned === 1;
}

export function getUserStats(telegramId: number): {
  total: number;
  today: number;
  limit: number;
  remaining: number;
  isBanned: boolean;
  firstSeen: string | null;
} {
  const userRows = query<Array<{
    daily_limit: number;
    total_downloads: number;
    is_banned: number;
    first_seen: string;
  }>>(
    "SELECT daily_limit, total_downloads, is_banned, first_seen FROM users WHERE telegram_id = ?",
    [telegramId]
  );

  if (!userRows.length) {
    return { total: 0, today: 0, limit: _defaultLimit, remaining: _defaultLimit, isBanned: false, firstSeen: null };
  }

  const { daily_limit, total_downloads, is_banned, first_seen } = userRows[0];

  const todayRows = query<Array<{ count: number }>>(
    `SELECT COUNT(*) AS count FROM user_downloads
     WHERE telegram_id = ? AND created_at > datetime('now', '-24 hours')`,
    [telegramId]
  );

  const today = (todayRows[0]?.count as number) ?? 0;

  return {
    total: total_downloads,
    today,
    limit: daily_limit,
    remaining: Math.max(0, daily_limit - today),
    isBanned: is_banned === 1,
    firstSeen: first_seen,
  };
}

export function banUser(telegramId: number): void {
  query(
    `INSERT INTO users (telegram_id, is_banned, daily_limit) VALUES (?, 1, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET is_banned = 1`,
    [telegramId, _defaultLimit]
  );
}

export function unbanUser(telegramId: number): void {
  query(
    `INSERT INTO users (telegram_id, is_banned, daily_limit) VALUES (?, 0, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET is_banned = 0`,
    [telegramId, _defaultLimit]
  );
}

export function setUserLimit(telegramId: number, limit: number): void {
  query(
    `INSERT INTO users (telegram_id, daily_limit) VALUES (?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET daily_limit = excluded.daily_limit`,
    [telegramId, limit]
  );
}

export function getTopUsers(n: number = 10): Array<{
  telegram_id: number;
  username: string | null;
  total_downloads: number;
  is_banned: number;
}> {
  return query<Array<{
    telegram_id: number;
    username: string | null;
    total_downloads: number;
    is_banned: number;
  }>>(
    `SELECT telegram_id, username, total_downloads, is_banned
     FROM users
     ORDER BY total_downloads DESC
     LIMIT ?`,
    [n]
  );
}

export function cleanupOldDownloads(): void {
  query(
    "DELETE FROM user_downloads WHERE created_at < datetime('now', '-48 hours')",
    []
  );
}
