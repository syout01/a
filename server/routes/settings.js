// セグメント・ルール・担当者・設定
import { Router } from 'express';
import { hydrateRule, LEAD_STATUSES } from '../lib/db.js';
import { LEAD_FIELDS, OPERATORS } from '../lib/segment.js';
import { gsheetsStatus } from '../lib/gsheets.js';

export default function settingsRoutes(db) {
  const r = Router();

  r.get('/config', (req, res) => {
    res.json({ statuses: LEAD_STATUSES, fields: LEAD_FIELDS, operators: OPERATORS, gsheets: gsheetsStatus() });
  });

  // --- 担当者 ---
  r.get('/members', (req, res) => {
    res.json(db.prepare('SELECT * FROM members ORDER BY active DESC, sort_order, id').all());
  });
  r.post('/members', (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: '名前は必須です' });
    const exists = db.prepare('SELECT id FROM members WHERE name = ?').get(name);
    if (exists) return res.status(409).json({ error: '同名の担当者がいます' });
    const max = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM members').get().m;
    const info = db.prepare('INSERT INTO members (name, sort_order) VALUES (?,?)').run(name, max + 1);
    res.status(201).json(db.prepare('SELECT * FROM members WHERE id = ?').get(info.lastInsertRowid));
  });
  r.put('/members/:id', (req, res) => {
    const m = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    const name = req.body?.name != null ? String(req.body.name).trim() : m.name;
    const active = req.body?.active != null ? (req.body.active ? 1 : 0) : m.active;
    db.prepare('UPDATE members SET name = ?, active = ? WHERE id = ?').run(name, active, m.id);
    res.json(db.prepare('SELECT * FROM members WHERE id = ?').get(m.id));
  });
  r.delete('/members/:id', (req, res) => {
    db.prepare('DELETE FROM members WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // --- セグメント ---
  r.get('/segments', (req, res) => {
    res.json(db.prepare('SELECT * FROM segments ORDER BY sort_order, id').all());
  });
  r.post('/segments', (req, res) => {
    const { code, label, action = '', color = '#888888', sort_order = 50, is_excluded = 0 } = req.body || {};
    if (!code || !label) return res.status(400).json({ error: 'コードとラベルは必須です' });
    if (db.prepare('SELECT id FROM segments WHERE code = ?').get(code)) return res.status(409).json({ error: '同じコードがあります' });
    const info = db.prepare('INSERT INTO segments (code,label,action,color,sort_order,is_excluded) VALUES (?,?,?,?,?,?)').run(code, label, action, color, sort_order, is_excluded ? 1 : 0);
    res.status(201).json(db.prepare('SELECT * FROM segments WHERE id = ?').get(info.lastInsertRowid));
  });
  r.put('/segments/:id', (req, res) => {
    const s = db.prepare('SELECT * FROM segments WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    db.prepare('UPDATE segments SET label=?, action=?, color=?, sort_order=?, is_excluded=? WHERE id=?')
      .run(b.label ?? s.label, b.action ?? s.action, b.color ?? s.color, b.sort_order ?? s.sort_order, b.is_excluded != null ? (b.is_excluded ? 1 : 0) : s.is_excluded, s.id);
    res.json(db.prepare('SELECT * FROM segments WHERE id = ?').get(s.id));
  });
  r.delete('/segments/:id', (req, res) => {
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
  r.post('/rules', (req, res) => {
    const v = validateRule(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const info = db.prepare('INSERT INTO segment_rules (name,segment_code,priority,match_mode,conditions_json,enabled) VALUES (?,?,?,?,?,?)')
      .run(v.name, v.segment_code, v.priority, v.match_mode, JSON.stringify(v.conditions), v.enabled);
    res.status(201).json(hydrateRule(db.prepare('SELECT * FROM segment_rules WHERE id = ?').get(info.lastInsertRowid)));
  });
  r.put('/rules/:id', (req, res) => {
    const cur = db.prepare('SELECT * FROM segment_rules WHERE id = ?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'not found' });
    const v = validateRule({ ...hydrateRule(cur), ...req.body });
    if (v.error) return res.status(400).json({ error: v.error });
    db.prepare('UPDATE segment_rules SET name=?, segment_code=?, priority=?, match_mode=?, conditions_json=?, enabled=? WHERE id=?')
      .run(v.name, v.segment_code, v.priority, v.match_mode, JSON.stringify(v.conditions), v.enabled, cur.id);
    res.json(hydrateRule(db.prepare('SELECT * FROM segment_rules WHERE id = ?').get(cur.id)));
  });
  r.delete('/rules/:id', (req, res) => {
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
