import Database, { Database as DatabaseType } from "better-sqlite3";
import { join } from "path";

const dbPath = join(__dirname, "..", "data.db");

export const db: DatabaseType = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function query<T>(sql: string, params: (string | number | boolean | null)[] = []): T {
  const stmt = db.prepare(sql);
  if (sql.trimStart().toUpperCase().startsWith("SELECT")) {
    return stmt.all(...params) as T;
  }
  return stmt.run(...params) as T;
}
