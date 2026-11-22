// Accounts, sessions and permissions.
// Studio (browser): httpOnly cookie. App: `Authorization: Bearer <token>`.
import express from 'express';
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { one, q, tx } from './db';
import { HttpError } from './store';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const COOKIE = 'floc_session';
const DAYS = { web: 30, app: 365 };

export interface User { id: string; email: string; name: string; is_staff: boolean }
declare global { namespace Express { interface Request { user?: User } } }

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const [, salt, key] = stored.split('$');
  if (!salt || !key) return false;
  const want = Buffer.from(key, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), want.length);
  return timingSafeEqual(want, got);
}

const sha = (t: string) => createHash('sha256').update(t).digest('hex');

export function validatePassword(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Wachtwoord moet minstens 8 tekens hebben');
  return pw;
}
export function normEmail(e: unknown): string {
  const s = String(e ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new HttpError(400, 'Ongeldig e-mailadres');
  return s;
}

async function startSession(userId: string, kind: 'web' | 'app'): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await q(`INSERT INTO sessions (token_hash, user_id, kind, expires) VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)`, [sha(token), userId, kind, String(DAYS[kind])]);
  return token;
}

function cookieToken(req: express.Request): string | null {
  const m = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  return m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : null;
}

function setCookie(res: express.Response, token: string | null) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', token
    ? `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS.web * 86400}${secure}`
    : `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

/** Attaches req.user when a valid session is present. */
export async function loadUser(req: express.Request, _res: express.Response, next: express.NextFunction) {
  try {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const token = bearer ?? cookieToken(req);
    if (token) {
      const u = await one<User>(
        `SELECT u.id, u.email, u.name, u.is_staff FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires > now()`, [sha(token)]);
      if (u) req.user = u;
    }
    next();
  } catch (e) {
    next(e);
  }
}

export function requireUser(req: express.Request): User {
  if (!req.user) throw new HttpError(401, 'Log eerst in');
  return req.user;
}
export function requireStaff(req: express.Request): User {
  const u = requireUser(req);
  if (!u.is_staff) throw new HttpError(403, 'Alleen het floc-team mag dit');
  return u;
}

/** 'edit' for staff, 'view' for members of the map's organisation, otherwise refused. */
export async function projectAccess(req: express.Request, pid: string): Promise<'edit' | 'view'> {
  const u = requireUser(req);
  if (u.is_staff) return 'edit';
  const ok = await one(
    `SELECT 1 FROM projects p JOIN memberships m ON m.org_id = p.org_id WHERE p.id = $1 AND m.user_id = $2`, [pid, u.id]);
  if (!ok) throw new HttpError(404, 'Kaart niet gevonden');
  return 'view';
}

async function orgsOf(userId: string) {
  return q<{ id: string; name: string; role: string }>(
    `SELECT o.id, o.name, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY o.name`, [userId]);
}

type H = (req: express.Request, res: express.Response) => Promise<unknown>;

export function authRoutes(h: (fn: H) => express.RequestHandler): express.Router {
  const r = express.Router();

  r.post('/auth/login', h(async (req, res) => {
    const email = normEmail(req.body?.email);
    const u = await one<User & { password_hash: string }>('SELECT * FROM users WHERE email = $1', [email]);
    if (!u || !(await checkPassword(String(req.body?.password ?? ''), u.password_hash))) throw new HttpError(401, 'E-mail of wachtwoord klopt niet');
    const kind = req.body?.client === 'app' ? 'app' : 'web';
    const token = await startSession(u.id, kind);
    if (kind === 'web') setCookie(res, token);
    return { user: { id: u.id, email: u.email, name: u.name, isStaff: u.is_staff }, ...(kind === 'app' ? { token } : {}) };
  }));

  // Visitors sign up in the app. Organiser accounts are made by the floc team (admin routes).
  r.post('/auth/register', h(async (req, res) => {
    const email = normEmail(req.body?.email);
    const pw = validatePassword(req.body?.password);
    const name = String(req.body?.name ?? '').trim().slice(0, 80);
    if (await one('SELECT 1 FROM users WHERE email = $1', [email])) throw new HttpError(409, 'Er is al een account met dit e-mailadres');
    const u = (await one<User>('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name, is_staff', [email, name, await hashPassword(pw)]))!;
    const kind = req.body?.client === 'web' ? 'web' : 'app';
    const token = await startSession(u.id, kind);
    if (kind === 'web') setCookie(res, token);
    return { user: { id: u.id, email: u.email, name: u.name, isStaff: false }, ...(kind === 'app' ? { token } : {}) };
  }));

  r.post('/auth/logout', h(async (req, res) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const token = bearer ?? cookieToken(req);
    if (token) await q('DELETE FROM sessions WHERE token_hash = $1', [sha(token)]);
    setCookie(res, null);
  }));

  r.get('/auth/me', h(async (req) => {
    const u = requireUser(req);
    return { user: { id: u.id, email: u.email, name: u.name, isStaff: u.is_staff }, orgs: await orgsOf(u.id) };
  }));

  r.post('/auth/password', h(async (req) => {
    const u = requireUser(req);
    const row = (await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [u.id]))!;
    if (!(await checkPassword(String(req.body?.current ?? ''), row.password_hash))) throw new HttpError(400, 'Huidig wachtwoord klopt niet');
    await q('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, await hashPassword(validatePassword(req.body?.password))]);
  }));

  // ---------- admin (floc team) ----------
  r.get('/admin', h(async (req) => {
    requireStaff(req);
    const orgs = await q('SELECT id, name FROM organizations ORDER BY name');
    const users = await q(
      `SELECT u.id, u.email, u.name, u.is_staff AS "isStaff", u.created,
              coalesce(json_agg(json_build_object('id', o.id, 'name', o.name, 'role', m.role)) FILTER (WHERE o.id IS NOT NULL), '[]') AS orgs
         FROM users u LEFT JOIN memberships m ON m.user_id = u.id LEFT JOIN organizations o ON o.id = m.org_id
        GROUP BY u.id ORDER BY u.is_staff DESC, u.email`);
    const projects = await q(
      `SELECT p.id, p.name, p.org_id AS "orgId", (SELECT max(version) FROM releases r WHERE r.project_id = p.id) AS version
         FROM projects p ORDER BY p.name`);
    return { orgs, users, projects };
  }));

  r.post('/admin/orgs', h(async (req) => {
    requireStaff(req);
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Geef de organisatie een naam');
    if (await one('SELECT 1 FROM organizations WHERE name = $1', [name])) throw new HttpError(409, 'Die organisatie bestaat al');
    return one('INSERT INTO organizations (name) VALUES ($1) RETURNING id, name', [name]);
  }));

  r.delete('/admin/orgs/:id', h(async (req) => {
    requireStaff(req);
    if (await one('SELECT 1 FROM projects WHERE org_id = $1', [req.params.id])) throw new HttpError(400, 'Deze organisatie heeft nog kaarten. Verplaats die eerst.');
    await q('DELETE FROM organizations WHERE id = $1', [req.params.id]);
  }));

  r.post('/admin/users', h(async (req) => {
    requireStaff(req);
    const email = normEmail(req.body?.email);
    const pw = validatePassword(req.body?.password);
    if (await one('SELECT 1 FROM users WHERE email = $1', [email])) throw new HttpError(409, 'Er is al een account met dit e-mailadres');
    return tx(async (c) => {
      const u = (await c.query('INSERT INTO users (email, name, password_hash, is_staff) VALUES ($1, $2, $3, $4) RETURNING id',
        [email, String(req.body?.name ?? '').trim(), await hashPassword(pw), !!req.body?.isStaff])).rows[0];
      if (req.body?.orgId) await c.query('INSERT INTO memberships (user_id, org_id) VALUES ($1, $2)', [u.id, req.body.orgId]);
      return u;
    });
  }));

  r.patch('/admin/users/:id', h(async (req) => {
    const me = requireStaff(req);
    const id = String(req.params.id);
    const b = req.body ?? {};
    if (b.password != null) {
      await q('UPDATE users SET password_hash = $2 WHERE id = $1', [id, await hashPassword(validatePassword(b.password))]);
      await q('DELETE FROM sessions WHERE user_id = $1', [id]);
    }
    if (b.isStaff != null) {
      if (id === me.id && !b.isStaff) throw new HttpError(400, 'Je kunt jezelf geen teamlid-af maken');
      await q('UPDATE users SET is_staff = $2 WHERE id = $1', [id, !!b.isStaff]);
    }
    if (b.name != null) await q('UPDATE users SET name = $2 WHERE id = $1', [id, String(b.name).trim()]);
    if (b.addOrg) await q('INSERT INTO memberships (user_id, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, b.addOrg]);
    if (b.removeOrg) await q('DELETE FROM memberships WHERE user_id = $1 AND org_id = $2', [id, b.removeOrg]);
  }));

  r.delete('/admin/users/:id', h(async (req) => {
    const me = requireStaff(req);
    if (req.params.id === me.id) throw new HttpError(400, 'Je kunt jezelf niet verwijderen');
    await q('DELETE FROM users WHERE id = $1', [req.params.id]);
  }));

  r.patch('/admin/projects/:id', h(async (req) => {
    requireStaff(req);
    await q('UPDATE projects SET org_id = $2 WHERE id = $1', [req.params.id, req.body?.orgId ?? null]);
  }));

  return r;
}
