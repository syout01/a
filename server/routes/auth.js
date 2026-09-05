// ログイン・ログアウト・初期セットアップ・招待の受諾・パスワード変更
import { Router } from 'express';
import {
  hashPassword, verifyPassword, validatePassword, createSession, destroySession, destroyMemberSessions,
  consumeToken, markTokenUsed, setCookie, clearCookie, rateLimit, rateLimitReset, clientIp, audit, publicMember,
} from '../lib/auth.js';

export default function authRoutes(db) {
  const r = Router();
  const hasAdmin = () => !!db.prepare("SELECT 1 FROM members WHERE role = 'admin' AND password_hash IS NOT NULL AND active = 1 LIMIT 1").get();

  // 初回セットアップが必要か（ログイン画面が最初に呼ぶ）
  r.get('/status', (req, res) => {
    res.json({ needs_setup: !hasAdmin(), user: req.user ? publicMember(req.user) : null });
  });

  // 最初の管理者を作る（管理者が 1 人もいないときだけ）
  r.post('/setup', (req, res) => {
    if (hasAdmin()) return res.status(409).json({ error: 'すでにセットアップ済みです' });
    const { email, name, password } = req.body || {};
    const e = normEmail(email);
    if (!e) return res.status(400).json({ error: 'メールアドレスが不正です' });
    if (!String(name || '').trim()) return res.status(400).json({ error: '名前は必須です' });
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const existing = db.prepare('SELECT id FROM members WHERE email = ? OR name = ?').get(e, String(name).trim());
    let id;
    if (existing) {
      db.prepare("UPDATE members SET email = ?, name = ?, password_hash = ?, role = 'admin', active = 1 WHERE id = ?").run(e, String(name).trim(), hashPassword(password), existing.id);
      id = existing.id;
    } else {
      id = Number(db.prepare("INSERT INTO members (name, email, password_hash, role, sort_order) VALUES (?,?,?,'admin',0)").run(String(name).trim(), e, hashPassword(password)).lastInsertRowid);
    }
    const sid = createSession(db, id, req);
    setCookie(res, req, sid);
    req.user = { id };
    audit(db, req, 'setup', id);
    res.status(201).json({ user: publicMember(db.prepare('SELECT * FROM members WHERE id = ?').get(id)) });
  });

  r.post('/login', (req, res) => {
    const e = normEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const ipKey = `ip:${clientIp(req)}`;
    const emailKey = `email:${e}`;
    if (!rateLimit(ipKey, 30) || !rateLimit(emailKey, 10)) {
      return res.status(429).json({ error: 'ログイン試行が多すぎます。15 分ほど待ってから再試行してください' });
    }
    const m = e ? db.prepare('SELECT * FROM members WHERE email = ?').get(e) : null;
    const ok = m && m.active && m.password_hash && verifyPassword(password, m.password_hash);
    if (!ok) {
      // 存在しないメールでも同じ応答にする
      if (!m?.password_hash) verifyPassword(password, hashPassword('dummy-timing-pad'));
      return res.status(401).json({ error: 'メールアドレスまたはパスワードが違います' });
    }
    rateLimitReset(emailKey);
    const sid = createSession(db, m.id, req);
    db.prepare("UPDATE members SET last_login_at = datetime('now','localtime') WHERE id = ?").run(m.id);
    setCookie(res, req, sid);
    req.user = m;
    audit(db, req, 'login', m.id);
    res.json({ user: publicMember(m) });
  });

  r.post('/logout', (req, res) => {
    if (req.sid) destroySession(db, req.sid);
    clearCookie(res);
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'ログインが必要です', code: 'unauthenticated' });
    res.json({ user: publicMember(req.user) });
  });

  // 招待／再設定リンクの内容確認
  r.get('/token/:token', (req, res) => {
    const t = consumeToken(db, req.params.token);
    if (!t) return res.status(404).json({ error: 'リンクが無効か期限切れです。管理者に再発行を依頼してください' });
    res.json({ kind: t.kind, email: t.email, name: t.name });
  });

  // 招待の受諾・パスワード再設定（同じ処理。名前は招待時のみ変更可）
  r.post('/token/:token', (req, res) => {
    if (!rateLimit(`token:${clientIp(req)}`, 20)) return res.status(429).json({ error: '試行が多すぎます' });
    const t = consumeToken(db, req.params.token);
    if (!t) return res.status(404).json({ error: 'リンクが無効か期限切れです。管理者に再発行を依頼してください' });
    const pwErr = validatePassword(req.body?.password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const name = t.kind === 'invite' && req.body?.name ? String(req.body.name).trim() : null;
    db.exec('BEGIN');
    try {
      if (name) db.prepare('UPDATE members SET name = ? WHERE id = ?').run(name, t.member_id);
      db.prepare('UPDATE members SET password_hash = ?, active = 1 WHERE id = ?').run(hashPassword(req.body.password), t.member_id);
      markTokenUsed(db, t.id);
      destroyMemberSessions(db, t.member_id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    const sid = createSession(db, t.member_id, req);
    setCookie(res, req, sid);
    req.user = { id: t.member_id };
    audit(db, req, t.kind === 'invite' ? 'activate' : 'password_reset', t.member_id);
    res.json({ user: publicMember(db.prepare('SELECT * FROM members WHERE id = ?').get(t.member_id)) });
  });

  // ログイン中の本人がパスワードを変える
  r.post('/password', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'ログインが必要です' });
    const m = db.prepare('SELECT * FROM members WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(req.body?.current || ''), m.password_hash)) return res.status(400).json({ error: '現在のパスワードが違います' });
    const pwErr = validatePassword(req.body?.password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    db.prepare('UPDATE members SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), m.id);
    // 他の端末のセッションは切る（今の端末は残す）
    db.prepare('DELETE FROM sessions WHERE member_id = ? AND id != ?').run(m.id, req.user.sid);
    audit(db, req, 'password_change', m.id);
    res.json({ ok: true });
  });

  return r;
}

export function normEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
}
