// リード検索・更新・フォロー記録
import { Router } from 'express';
import { hydrateLead, LEAD_STATUSES } from '../lib/db.js';
import { dedupeKey } from '../lib/dedupe.js';
import { nowLocal } from './exhibitions.js';
import { requireAdmin, audit } from '../lib/auth.js';

const STATUS_CODES = new Set(LEAD_STATUSES.map((s) => s.code));
const EDITABLE = ['company', 'name', 'department', 'title', 'email', 'phone', 'industry', 'employees', 'memo'];

export default function leadRoutes(db) {
  const r = Router();

  const getLead = (id) => hydrateLead(db.prepare(`
    SELECT l.*, m.name AS assignee_name, s.label AS segment_label, s.color AS segment_color
    FROM leads l LEFT JOIN members m ON m.id = l.assignee_id LEFT JOIN segments s ON s.code = l.segment_code
    WHERE l.id = ?`).get(id));

  // 一覧。?exhibition_id&assignee_id(=0で未割当)&segment&status&q&due=today|overdue&limit&offset&sort
  r.get('/', (req, res) => {
    const q = req.query;
    const where = [];
    const params = [];
    if (q.exhibition_id) { where.push('l.exhibition_id = ?'); params.push(+q.exhibition_id); }
    if (q.assignee_id != null && q.assignee_id !== '') {
      if (+q.assignee_id === 0) where.push('l.assignee_id IS NULL'); else { where.push('l.assignee_id = ?'); params.push(+q.assignee_id); }
    }
    if (q.segment) { const codes = String(q.segment).split(','); where.push(`l.segment_code IN (${codes.map(() => '?').join(',')})`); params.push(...codes); }
    if (q.status) { const codes = String(q.status).split(','); where.push(`l.status IN (${codes.map(() => '?').join(',')})`); params.push(...codes); }
    if (q.due === 'today') {
      // 今日やる: 未完了で、次回コールが未設定 or 今日中
      const endOfToday = nowLocal().slice(0, 10) + ' 23:59:59';
      where.push("l.status NOT IN ('appointment','lost','excluded')");
      where.push('(l.next_call_at IS NULL OR l.next_call_at <= ?)'); params.push(endOfToday);
    } else if (q.due === 'overdue') {
      where.push("l.status NOT IN ('appointment','lost','excluded')");
      where.push('l.next_call_at IS NOT NULL AND l.next_call_at < ?'); params.push(nowLocal());
    }
    if (q.q) {
      const like = `%${String(q.q).trim()}%`;
      where.push('(l.company LIKE ? OR l.name LIKE ? OR l.email LIKE ? OR l.phone LIKE ? OR l.department LIKE ? OR l.title LIKE ? OR l.memo LIKE ? OR l.last_note LIKE ?)');
      params.push(like, like, like, like, like, like, like, like);
    }
    const limit = Math.min(+q.limit || 200, 1000);
    const offset = +q.offset || 0;
    const sortMap = {
      priority: 'COALESCE(s.sort_order, 99), (l.next_call_at IS NULL), l.next_call_at, l.id',
      updated: 'l.updated_at DESC, l.id DESC',
      company: 'l.company, l.id',
      id: 'l.id',
    };
    const order = sortMap[q.sort] || sortMap.priority;
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM leads l ${whereSql}`).get(...params).n;
    const rows = db.prepare(`
      SELECT l.*, m.name AS assignee_name, s.label AS segment_label, s.color AS segment_color
      FROM leads l LEFT JOIN members m ON m.id = l.assignee_id LEFT JOIN segments s ON s.code = l.segment_code
      ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset).map(hydrateLead);
    res.json({ total, limit, offset, items: rows });
  });

  r.get('/:id', (req, res) => {
    const lead = getLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'not found' });
    lead.activities = db.prepare('SELECT * FROM activities WHERE lead_id = ? ORDER BY created_at DESC, id DESC').all(lead.id);
    if (lead.returning_lead_id) {
      lead.returning = hydrateLead(db.prepare('SELECT l.*, e.name AS exhibition_name FROM leads l JOIN exhibitions e ON e.id = l.exhibition_id WHERE l.id = ?').get(lead.returning_lead_id));
    }
    res.json(lead);
  });

  // 部分更新（セグメント手動変更は固定フラグを立てる）
  r.patch('/:id', (req, res) => {
    const cur = getLead(req.params.id);
    if (!cur) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const sets = [];
    const params = [];
    for (const f of EDITABLE) if (b[f] !== undefined) { sets.push(`${f} = ?`); params.push(b[f] == null ? '' : String(b[f]).trim()); }
    if (b.segment_code !== undefined) {
      if (!db.prepare('SELECT id FROM segments WHERE code = ?').get(b.segment_code)) return res.status(400).json({ error: 'セグメントが不正です' });
      sets.push('segment_code = ?', 'segment_locked = 1', 'matched_rule_id = NULL'); params.push(b.segment_code);
    }
    if (b.segment_locked !== undefined) { sets.push('segment_locked = ?'); params.push(b.segment_locked ? 1 : 0); }
    if (b.assignee_id !== undefined) { sets.push('assignee_id = ?'); params.push(b.assignee_id ? +b.assignee_id : null); }
    if (b.status !== undefined) { if (!STATUS_CODES.has(b.status)) return res.status(400).json({ error: 'ステータスが不正です' }); sets.push('status = ?'); params.push(b.status); }
    if (b.next_call_at !== undefined) { sets.push('next_call_at = ?'); params.push(b.next_call_at || null); }
    if (!sets.length) return res.json(cur);
    if (['company', 'name', 'email'].some((f) => b[f] !== undefined)) {
      const merged = { ...cur, ...b };
      sets.push('dedupe_key = ?'); params.push(dedupeKey(merged));
    }
    sets.push("updated_at = datetime('now','localtime')");
    db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...params, cur.id);
    res.json(getLead(cur.id));
  });

  // 一括更新 { ids, assignee_id?, segment_code?, status? }
  r.post('/bulk', requireAdmin, (req, res) => {
    const ids = (req.body?.ids || []).map(Number).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'ids が空です' });
    const b = req.body;
    const sets = [];
    const params = [];
    if (b.assignee_id !== undefined) { sets.push('assignee_id = ?'); params.push(b.assignee_id ? +b.assignee_id : null); }
    if (b.segment_code !== undefined) { sets.push('segment_code = ?', 'segment_locked = 1', 'matched_rule_id = NULL'); params.push(b.segment_code); }
    if (b.status !== undefined && STATUS_CODES.has(b.status)) { sets.push('status = ?'); params.push(b.status); }
    if (!sets.length) return res.status(400).json({ error: '更新内容がありません' });
    sets.push("updated_at = datetime('now','localtime')");
    const stmt = db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`);
    db.exec('BEGIN');
    try { for (const id of ids) stmt.run(...params, id); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.json({ updated: ids.length });
  });

  // フォロー記録 { status, note, next_call_at, member_id }
  r.post('/:id/activities', (req, res) => {
    const cur = getLead(req.params.id);
    if (!cur) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const status = b.status && STATUS_CODES.has(b.status) ? b.status : cur.status;
    const note = b.note ? String(b.note).trim() : '';
    const next = b.next_call_at || null;
    // 記録者はログインしている本人に固定（クライアントからの member_id は使わない）
    const member = req.user;
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO activities (lead_id, member_id, member_name, status, note, next_call_at) VALUES (?,?,?,?,?,?)')
        .run(cur.id, member?.id ?? null, member?.name ?? null, status, note, next);
      db.prepare(`UPDATE leads SET status = ?, next_call_at = ?, last_note = CASE WHEN ? != '' THEN ? ELSE last_note END,
        last_contact_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?`)
        .run(status, next, note, note, cur.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    const lead = getLead(cur.id);
    lead.activities = db.prepare('SELECT * FROM activities WHERE lead_id = ? ORDER BY created_at DESC, id DESC').all(cur.id);
    res.status(201).json(lead);
  });

  r.delete('/:id', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
    audit(db, req, 'lead_delete', req.params.id);
    res.json({ ok: true });
  });

  return r;
}
