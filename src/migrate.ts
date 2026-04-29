import { db } from "./db";

console.log("Running migrations...");

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

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_original_url ON downloads (original_url)
`);

console.log("Migration complete: downloads table ready.");
db.close();
process.exit(0);
