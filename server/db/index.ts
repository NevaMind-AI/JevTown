import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * The database, and nothing else.
 *
 * docs/11 §4.1 is the rule this file exists to keep: **the backend stores, it never executes
 * simulation logic.** There is no engine here and no `tick`, because a second copy of the
 * simulation is a second world state that can disagree with the browser's silently. If
 * determinism needs testing — and it does — that comes from a headless replay driving the same
 * frontend engine module, never from here.
 */

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL;
}

export function db(): pg.Pool {
  if (!pool) {
    const url = databaseUrl();
    if (!url) {
      throw new Error('DATABASE_URL is not set; the storage routes are unavailable.');
    }
    pool = new Pool({ connectionString: url, max: Number(process.env.PGPOOL_MAX) || 8 });
  }
  return pool;
}

export async function closeDb() {
  if (pool) {
    const closing = pool;
    pool = null;
    await closing.end();
  }
}

/**
 * Apply the schema.
 *
 * Every file in this directory, in name order. Each is idempotent by construction — every
 * statement is `IF NOT EXISTS` — so all of them run on every boot rather than needing a table of
 * applied migrations. That holds only while every file can be written that way; the first one
 * that cannot is the day this becomes a real migration table.
 */
export async function migrate() {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(here)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await db().query(readFileSync(join(here, file), 'utf8'));
  }
}

/**
 * Run `work` in one transaction.
 *
 * A batch is all-or-nothing: docs/11 §4.3 makes a batch boundary the only moment the world is
 * consistent, so half a batch on disk would be a world that never existed.
 */
export async function transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
