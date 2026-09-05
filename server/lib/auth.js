// 認証・セッション・トークン・保護ミドルウェア（外部依存なし）
import crypto from 'node:crypto';

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
export const SESSION_DAYS = 14;
export const INVITE_HOURS = 24 * 7;
export const RESET_HOURS = 24;
export const PASSWORD_MIN = 10;

// ---- パスワード ----
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [algo, N, r, p, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const salt = Buffer.from(saltB64, 'base64url');
  const expected = Buffer.from(keyB64, 'base64url');
  const key = crypto.scryptSync(password, salt, expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}
export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) return `パスワードは ${PASSWORD_MIN} 文字以上にしてください`;
  if (pw.length > 200) return 'パスワードが長すぎます';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'パスワードは英字と数字を両方含めてください';
  return null;
}

// ---- 乱数トークン（DB にはハッシュだけ保存） ----
export const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const plus = (hours) => {
  const d = new Date(Date.now() + hours * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// ---- セッション ----
export function createSession(db, memberId, req) {
  const sid = randomToken();
  db.prepare('INSERT INTO sessions (id, member_id, expires_at, ip, user_agent) VALUES (?,?,?,?,?)')
    .run(sha256(sid), memberId, plus(SESSION_DAYS * 24), clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200));
  return sid;
}
export function findSession(db, sid) {
  if (!sid) return null;
  const row = db.prepare(`SELECT s.id AS sid, s.expires_at, s.last_seen_at, m.* FROM sessions s JOIN members m ON m.id = s.member_id
    WHERE s.id = ? AND s.expires_at > datetime('now','localtime') AND m.active = 1`).get(sha256(sid));
  if (!row) return null;
  // 1 時間に 1 回だけ最終アクセスを更新し、有効期限を伸ばす
  if (Date.now() - new Date(row.last_seen_at.replace(' ', 'T')).getTime() > 3600 * 1000) {
    db.prepare("UPDATE sessions SET last_seen_at = datetime('now','localtime'), expires_at = ? WHERE id = ?").run(plus(SESSION_DAYS * 24), row.sid);
  }
  return row;
}
export function destroySession(db, sid) { if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(sid)); }
export function destroyMemberSessions(db, memberId) { db.prepare('DELETE FROM sessions WHERE member_id = ?').run(memberId); }
export function purgeExpired(db) {
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now','localtime')").run();
  db.prepare("DELETE FROM auth_tokens WHERE expires_at <= datetime('now','-30 day','localtime')").run();
}

// ---- 招待・再設定トークン ----
export function issueToken(db, memberId, kind, createdBy) {
  db.prepare("UPDATE auth_tokens SET used_at = datetime('now','localtime') WHERE member_id = ? AND kind = ? AND used_at IS NULL").run(memberId, kind);
  const token = randomToken();
  db.prepare('INSERT INTO auth_tokens (member_id, kind, token_hash, expires_at, created_by) VALUES (?,?,?,?,?)')
    .run(memberId, kind, sha256(token), plus(kind === 'invite' ? INVITE_HOURS : RESET_HOURS), createdBy ?? null);
  return token;
}
export function consumeToken(db, token) {
  const row = db.prepare(`SELECT t.*, m.email, m.name FROM auth_tokens t JOIN members m ON m.id = t.member_id
    WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > datetime('now','localtime')`).get(sha256(token || ''));
  return row || null;
}
export function markTokenUsed(db, id) { db.prepare("UPDATE auth_tokens SET used_at = datetime('now','localtime') WHERE id = ?").run(id); }

// ---- Cookie ----
export const COOKIE = 'sid';
export function cookieOptions(req) {
  return { httpOnly: true, sameSite: 'lax', secure: isSecure(req), path: '/', maxAge: SESSION_DAYS * 24 * 3600 * 1000 };
}
export function isSecure(req) { return req.secure || req.headers['x-forwarded-proto'] === 'https'; }
export function clientIp(req) { return (req.ip || '').replace(/^::ffff:/, ''); }
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function setCookie(res, req, value) {
  const o = cookieOptions(req);
  const parts = [`${COOKIE}=${encodeURIComponent(value)}`, `Path=${o.path}`, `Max-Age=${Math.floor(o.maxAge / 1000)}`, 'HttpOnly', `SameSite=${o.sameSite[0].toUpperCase()}${o.sameSite.slice(1)}`];
  if (o.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
export function clearCookie(res) { res.append('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`); }

// アプリの外部 URL（招待リンク用）。APP_URL が無ければリクエストから組み立てる
export function appUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const proto = isSecure(req) ? 'https' : 'http';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

// ---- ログイン試行の制限（メモリ内。IP とメールの両方で数える） ----
const attempts = new Map();
export function rateLimit(key, max = 10, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const rec = attempts.get(key) || { count: 0, reset: now + windowMs };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + windowMs; }
  rec.count++;
  attempts.set(key, rec);
  if (attempts.size > 10000) for (const [k, v] of attempts) if (now > v.reset) attempts.delete(k);
  return rec.count <= max;
}
export function rateLimitReset(key) { attempts.delete(key); }

// ---- ミドルウェア ----
export function attachUser(db) {
  return (req, res, next) => {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    req.sid = sid || null;
    req.user = findSession(db, sid);
    next();
  };
}
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'ログインが必要です', code: 'unauthenticated' });
  next();
}
export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'ログインが必要です', code: 'unauthenticated' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: '管理者のみ実行できます' });
  next();
}
// CSRF: 状態を変える API は fetch から送ったことを示すヘッダを必須にし、Origin も確認する
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-requested-with'] !== 'fetch') return res.status(403).json({ error: '不正なリクエストです（CSRF）' });
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    try { if (new URL(origin).host !== host) return res.status(403).json({ error: '不正なリクエスト元です' }); } catch { return res.status(403).json({ error: '不正なリクエスト元です' }); }
  }
  next();
}
export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
  if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}
export function audit(db, req, action, target) {
  try { db.prepare('INSERT INTO audit_log (member_id, action, target, ip) VALUES (?,?,?,?)').run(req.user?.id ?? null, action, target == null ? null : String(target), clientIp(req)); } catch { /* 監査ログは失敗しても処理を止めない */ }
}
export function publicMember(m) {
  if (!m) return m;
  const { password_hash, sid, expires_at, last_seen_at, ...rest } = m;
  return { ...rest, has_login: !!password_hash };
}
