// セグメント・ルール・担当者・設定
import { Router } from 'express';
import { hydrateRule, LEAD_STATUSES } from '../lib/db.js';
import { LEAD_FIELDS, OPERATORS } from '../lib/segment.js';
import { gsheetsStatus } from '../lib/gsheets.js';
import { requireAdmin, issueToken, appUrl, destroyMemberSessions, audit, publicMember } from '../lib/auth.js';
import { normEmail } from './auth.js';
import { runBackup, listBackups, backupDir } from '../lib/backup.js';
import path from 'node:path';
const safeJsonParse = (t) => { try { return t ? JSON.parse(t) : {}; } catch { return {}; } };

export default function settingsRoutes(db) {
  const r = Router();

  r.get('/config', (req, res) => {
    res.json({ statuses: LEAD_STATUSES, fields: LEAD_FIELDS, operators: OPERATORS, gsheets: gsheetsStatus() });
  });

  // --- メンバー（担当者。ログインの有無は任意） ---
  r.get('/members', (req, res) => {
    res.json(db.prepare('SELECT * FROM members ORDER BY active DESC, sort_order, id').all().map(publicMember));
  });
  r.post('/members', requireAdmin, (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: '名前は必須です' });
    const email = req.body?.email ? normEmail(req.body.email) : null;
    if (req.body?.email && !email) return res.status(400).json({ error: 'メールアドレスが不正です' });
    const role = req.body?.role === 'admin' ? 'admin' : 'member';
    if (db.prepare('SELECT id FROM members WHERE name = ?').get(name)) return res.status(409).json({ error: '同名のメンバーがいます' });
    if (email && db.prepare('SELECT id FROM members WHERE email = ?').get(email)) return res.status(409).json({ error: 'このメールアドレスは登録済みです' });
    const max = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM members').get().m;
    const info = db.prepare('INSERT INTO members (name, email, role, sort_order) VALUES (?,?,?,?)').run(name, email, role, max + 1);
    audit(db, req, 'member_create', info.lastInsertRowid);
    res.status(201).json(publicMember(db.prepare('SELECT * FROM members WHERE id = ?').get(info.lastInsertRowid)));
  });
  r.put('/members/:id', requireAdmin, (req, res) => {
    const m = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const name = b.name != null ? String(b.name).trim() : m.name;
    let email = m.email;
    if (b.email !== undefined) {
      email = b.email ? normEmail(b.email) : null;
      if (b.email && !email) return res.status(400).json({ error: 'メールアドレスが不正です' });
      if (email && db.prepare('SELECT id FROM members WHERE email = ? AND id != ?').get(email, m.id)) return res.status(409).json({ error: 'このメールアドレスは登録済みです' });
    }
    const role = b.role != null ? (b.role === 'admin' ? 'admin' : 'member') : m.role;
    const active = b.active != null ? (b.active ? 1 : 0) : m.active;
    // 自分の管理者権限・有効状態は落とせない。最後の管理者も守る
    if (m.id === req.user.id && (role !== 'admin' || !active)) return res.status(400).json({ error: '自分自身の管理者権限や有効状態は変更できません' });
    if (m.role === 'admin' && (role !== 'admin' || !active)) {
      const admins = db.prepare("SELECT COUNT(*) AS n FROM members WHERE role = 'admin' AND active = 1 AND password_hash IS NOT NULL").get().n;
      if (admins <= 1 && m.password_hash) return res.status(400).json({ error: '最後の管理者は降格・停止できません' });
    }
    db.prepare('UPDATE members SET name = ?, email = ?, role = ?, active = ? WHERE id = ?').run(name, email, role, active, m.id);
    if (!active || role !== m.role) destroyMemberSessions(db, m.id);
    audit(db, req, 'member_update', m.id);
    res.json(publicMember(db.prepare('SELECT * FROM members WHERE id = ?').get(m.id)));
  });
  r.delete('/members/:id', requireAdmin, (req, res) => {
    if (+req.params.id === req.user.id) return res.status(400).json({ error: '自分自身は削除できません' });
    db.prepare('DELETE FROM members WHERE id = ?').run(req.params.id);
    audit(db, req, 'member_delete', req.params.id);
    res.json({ ok: true });
  });
  // 招待リンク／パスワード再設定リンクの発行（管理者がコピーして本人に渡す）
  r.post('/members/:id/invite', requireAdmin, (req, res) => {
    const m = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    if (!m.email) return res.status(400).json({ error: '先にメールアドレスを設定してください' });
    const kind = m.password_hash ? 'reset' : 'invite';
    const token = issueToken(db, m.id, kind, req.user.id);
    audit(db, req, `token_${kind}`, m.id);
    res.json({ kind, url: `${appUrl(req)}/login.html#token=${token}`, expires_hours: kind === 'invite' ? 24 * 7 : 24 });
  });
  // LP からの相談
  r.get('/inquiries', requireAdmin, (req, res) => {
    res.json(db.prepare('SELECT * FROM inquiries ORDER BY id DESC LIMIT 500').all().map((i) => ({ ...i, source: safeJsonParse(i.source_json), source_json: undefined })));
  });
  r.patch('/inquiries/:id', requireAdmin, (req, res) => {
    const cur = db.prepare('SELECT * FROM inquiries WHERE id = ?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'not found' });
    const status = ['new', 'contacted', 'meeting', 'closed', 'spam'].includes(req.body?.status) ? req.body.status : cur.status;
    const note = req.body?.note != null ? String(req.body.note).slice(0, 2000) : cur.note;
    db.prepare('UPDATE inquiries SET status = ?, note = ? WHERE id = ?').run(status, note, cur.id);
    res.json(db.prepare('SELECT * FROM inquiries WHERE id = ?').get(cur.id));
  });
  // 監査ログ（直近）
  r.get('/audit', requireAdmin, (req, res) => {
    res.json(db.prepare(`SELECT a.*, m.name AS member_name FROM audit_log a LEFT JOIN members m ON m.id = a.member_id ORDER BY a.id DESC LIMIT 200`).all());
  });
  // バックアップ
  r.get('/backups', requireAdmin, (req, res) => res.json({ dir: backupDir(), files: listBackups() }));
  r.post('/backups', requireAdmin, async (req, res) => { const out = await runBackup(db); audit(db, req, 'backup_run'); res.json(out); });
  r.get('/backups/download', requireAdmin, async (req, res) => {
    const out = await runBackup(db);
    audit(db, req, 'backup_download');
    res.download(out.file, path.basename(out.file));
  });

  // --- セグメント ---
  r.get('/segments', (req, res) => {
    res.json(db.prepare('SELECT * FROM segments ORDER BY sort_order, id').all());
  });
  r.post('/segments', requireAdmin, (req, res) => {
    const { code, label, action = '', color = '#888888', sort_order = 50, is_excluded = 0 } = req.body || {};
    if (!code || !label) return res.status(400).json({ error: 'コードとラベルは必須です' });
    if (db.prepare('SELECT id FROM segments WHERE code = ?').get(code)) return res.status(409).json({ error: '同じコードがあります' });
    const info = db.prepare('INSERT INTO segments (code,label,action,color,sort_order,is_excluded) VALUES (?,?,?,?,?,?)').run(code, label, action, color, sort_order, is_excluded ? 1 : 0);
    res.status(201).json(db.prepare('SELECT * FROM segments WHERE id = ?').get(info.lastInsertRowid));
  });
  r.put('/segments/:id', requireAdmin, (req, res) => {
    const s = db.prepare('SELECT * FROM segments WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    db.prepare('UPDATE segments SET label=?, action=?, color=?, sort_order=?, is_excluded=? WHERE id=?')
      .run(b.label ?? s.label, b.action ?? s.action, b.color ?? s.color, b.sort_order ?? s.sort_order, b.is_excluded != null ? (b.is_excluded ? 1 : 0) : s.is_excluded, s.id);
    res.json(db.prepare('SELECT * FROM segments WHERE id = ?').get(s.id));
  });
  r.delete('/segments/:id', requireAdmin, (req, res) => {
    const s = db.prepare('SELECT * FROM segments WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    if (s.code === 'U') return res.status(400).json({ error: '未分類は削除できません' });
    db.prepare("UPDATE leads SET segment_code = 'U' WHERE segment_code = ?").run(s.code);
    db.prepare('DELETE FROM segment_rules WHERE segment_code = ?').run(s.code);
    db.prepare('DELETE FROM segments WHERE id = ?').run(s.id);
    res.json({ ok: true });
  });

  // --- 振り分けルール ---
  r.get('/rules', (req, res) => {
    res.json(db.prepare('SELECT * FROM segment_rules ORDER BY priority, id').all().map(hydrateRule));
  });
  r.post('/rules', requireAdmin, (req, res) => {
    const v = validateRule(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const info = db.prepare('INSERT INTO segment_rules (name,segment_code,priority,match_mode,conditions_json,enabled) VALUES (?,?,?,?,?,?)')
      .run(v.name, v.segment_code, v.priority, v.match_mode, JSON.stringify(v.conditions), v.enabled);
    res.status(201).json(hydrateRule(db.prepare('SELECT * FROM segment_rules WHERE id = ?').get(info.lastInsertRowid)));
  });
  r.put('/rules/:id', requireAdmin, (req, res) => {
    const cur = db.prepare('SELECT * FROM segment_rules WHERE id = ?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'not found' });
    const v = validateRule({ ...hydrateRule(cur), ...req.body });
    if (v.error) return res.status(400).json({ error: v.error });
    db.prepare('UPDATE segment_rules SET name=?, segment_code=?, priority=?, match_mode=?, conditions_json=?, enabled=? WHERE id=?')
      .run(v.name, v.segment_code, v.priority, v.match_mode, JSON.stringify(v.conditions), v.enabled, cur.id);
    res.json(hydrateRule(db.prepare('SELECT * FROM segment_rules WHERE id = ?').get(cur.id)));
  });
  r.delete('/rules/:id', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM segment_rules WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  function validateRule(b = {}) {
    const name = String(b.name || '').trim();
    if (!name) return { error: 'ルール名は必須です' };
    if (!b.segment_code || !db.prepare('SELECT id FROM segments WHERE code = ?').get(b.segment_code)) return { error: 'セグメントが不正です' };
    const conditions = Array.isArray(b.conditions) ? b.conditions.filter((c) => c && c.field && c.op) : [];
    if (!conditions.length) return { error: '条件を 1 つ以上入れてください' };
    for (const c of conditions) {
      if (c.op === 'regex') { try { new RegExp(c.value || '', 'iu'); } catch { return { error: `正規表現が不正です: ${c.value}` }; } }
    }
    return {
      name, segment_code: b.segment_code,
      priority: Number.isFinite(+b.priority) ? +b.priority : 100,
      match_mode: b.match_mode === 'any' ? 'any' : 'all',
      conditions: conditions.map((c) => ({ field: c.field, op: c.op, value: c.value ?? '' })),
      enabled: b.enabled === false || b.enabled === 0 ? 0 : 1,
    };
  }

  return r;
}
