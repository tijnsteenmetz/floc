// Creates (or resets) a floc-team account. Usage: npm run create-staff -- <email> [name]
// Prints a random password once; change it in the studio under Beheer.
import { randomBytes } from 'node:crypto';
import { migrate, one, pool, q } from '../db';
import { hashPassword, normEmail } from '../auth';

const [email, ...nameParts] = process.argv.slice(2);
if (!email) { console.error('Gebruik: npm run create-staff -- <email> [naam]'); process.exit(1); }
await migrate();
const e = normEmail(email);
// No look-alike characters (I/l/1, O/0), so the password can be typed over without mistakes.
const ALPHA = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const pw = Array.from(randomBytes(12), (b) => ALPHA[b % ALPHA.length]).join('');
const hash = await hashPassword(pw);
const existing = await one('SELECT id FROM users WHERE email = $1', [e]);
if (existing) await q('UPDATE users SET password_hash = $2, is_staff = true WHERE email = $1', [e, hash]);
else await q('INSERT INTO users (email, name, password_hash, is_staff) VALUES ($1, $2, $3, true)', [e, nameParts.join(' '), hash]);
console.log(`\n  ${existing ? 'Wachtwoord opnieuw ingesteld' : 'Teamaccount aangemaakt'}: ${e}\n  Wachtwoord: ${pw}\n`);
await pool.end();
