// Postgres: connection and schema. The schema is created/updated on startup (idempotent statements).
import pg from 'pg';

/** On the Mac (`npm run dev` via `railway run`) the private network isn't reachable, so use the public URL. */
const url = process.env.FLOC_LOCAL ? process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL : process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL ontbreekt. Start lokaal met `npm run dev` (gebruikt `railway run`).');

export const pool = new pg.Pool({ connectionString: url, max: 10 });

export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params)).rows as T[];
}
export async function one<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
  return ((await pool.query(sql, params)).rows[0] as T) ?? null;
}

/** Runs fn in one transaction. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export const INTERNAL_ORG = 'floc (intern)';

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL UNIQUE,
      name text NOT NULL DEFAULT '',
      password_hash text NOT NULL,
      is_staff boolean NOT NULL DEFAULT false,
      created timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS organizations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      created timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS memberships (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      role text NOT NULL DEFAULT 'viewer',
      PRIMARY KEY (user_id, org_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind text NOT NULL,
      created timestamptz NOT NULL DEFAULT now(),
      expires timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id text PRIMARY KEY,
      org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
      name text NOT NULL,
      meta jsonb NOT NULL,
      facilities jsonb NOT NULL DEFAULT '[]',
      revision integer NOT NULL DEFAULT 1,
      thumb jsonb,
      created timestamptz NOT NULL DEFAULT now(),
      updated timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS project_layers (
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      layer_id text NOT NULL,
      features jsonb NOT NULL,
      hash text NOT NULL DEFAULT '',
      PRIMARY KEY (project_id, layer_id)
    );
    CREATE TABLE IF NOT EXISTS releases (
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      version integer NOT NULL,
      published_by uuid REFERENCES users(id) ON DELETE SET NULL,
      published timestamptz NOT NULL DEFAULT now(),
      manifest jsonb NOT NULL,
      PRIMARY KEY (project_id, version)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value jsonb NOT NULL
    );
  `);
  await pool.query('INSERT INTO organizations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [INTERNAL_ORG]);
  await pool.query('DELETE FROM sessions WHERE expires < now()');
}

export async function internalOrgId(): Promise<string> {
  return (await one<{ id: string }>('SELECT id FROM organizations WHERE name = $1', [INTERNAL_ORG]))!.id;
}
