import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

mkdirSync(dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS reads (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  resolved TEXT,
  verdict TEXT,
  card_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | complete | failed
  paid_tx TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE VIEW IF NOT EXISTS sales AS
  SELECT id, query, paid_tx, cost_usd, created_at
  FROM reads WHERE paid_tx IS NOT NULL;
`);

// --- cache layer: every external call goes through here first, keyed (endpoint, argsHash)

import { createHash } from "node:crypto";

export function cacheKey(endpoint: string, args: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16);
  return `${endpoint}:${hash}`;
}

export function cacheGet<T>(key: string): T | undefined {
  const row = db
    .prepare("SELECT value FROM cache WHERE key = ? AND expires_at > unixepoch()")
    .get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export function cacheSet(key: string, value: unknown, ttlSeconds = config.cacheTtlSeconds): void {
  db.prepare(
    "INSERT INTO cache (key, value, expires_at) VALUES (?, ?, unixepoch() + ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at"
  ).run(key, JSON.stringify(value), ttlSeconds);
}

/** Cache-first wrapper: hot narratives make repeat reads nearly free. */
export async function cached<T>(endpoint: string, args: unknown, fetcher: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
  const key = cacheKey(endpoint, args);
  const existing = cacheGet<T>(key);
  if (existing !== undefined) return { value: existing, hit: true };
  const value = await fetcher();
  if (value !== undefined) cacheSet(key, value);
  return { value, hit: false };
}

// --- reads

export interface ReadRow {
  id: string;
  query: string;
  resolved: string | null;
  verdict: string | null;
  card_url: string | null;
  status: string;
  paid_tx: string | null;
  cost_usd: number;
  created_at: string;
}

export function insertRead(id: string, query: string): void {
  db.prepare("INSERT INTO reads (id, query) VALUES (?, ?)").run(id, query);
}

export function completeRead(id: string, resolved: unknown, verdict: unknown, cardUrl: string | null, costUsd: number): void {
  db.prepare(
    "UPDATE reads SET resolved = ?, verdict = ?, card_url = ?, status = 'complete', cost_usd = ? WHERE id = ?"
  ).run(JSON.stringify(resolved), JSON.stringify(verdict), cardUrl, costUsd, id);
}

export function failRead(id: string, costUsd: number): void {
  db.prepare("UPDATE reads SET status = 'failed', cost_usd = ? WHERE id = ?").run(costUsd, id);
}

export function getRead(id: string): ReadRow | undefined {
  return db.prepare("SELECT * FROM reads WHERE id = ?").get(id) as ReadRow | undefined;
}

// --- kv: small durable state (the watchlist's last run, etc.)

export function kvGet<T>(key: string): T | undefined {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export function kvSet(key: string, value: unknown): void {
  db.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(key, JSON.stringify(value));
}

export function kvDel(key: string): void {
  db.prepare("DELETE FROM kv WHERE key = ?").run(key);
}
