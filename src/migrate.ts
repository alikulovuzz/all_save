import { db } from "./db";

export function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_url TEXT NOT NULL,
      telegram_file_id TEXT NOT NULL,
      telegram_message_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_original_url ON downloads (original_url)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT,
      first_seen DATETIME DEFAULT (datetime('now')),
      is_banned INTEGER DEFAULT 0,
      daily_limit INTEGER DEFAULT 15,
      total_downloads INTEGER DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL REFERENCES users(telegram_id),
      url TEXT NOT NULL,
      created_at DATETIME DEFAULT (datetime('now'))
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_ud_telegram_id ON user_downloads (telegram_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ud_created_at ON user_downloads (created_at)`);
}

// Script entry point: npm run migrate
if (require.main === module) {
  console.log("Running migrations...");
  runMigrations();
  console.log("Migration complete.");
  db.close();
  process.exit(0);
}
