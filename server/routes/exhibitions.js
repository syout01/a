// 展示会・取り込み・再判定・割当・書き出し
import { Router } from 'express';
import { hydrateLead, hydrateRule, safeJson } from '../lib/db.js';
import { classify, roundRobinAssign } from '../lib/segment.js';
import { dedupeKey } from '../lib/dedupe.js';
import { toXlsxBuffer, toCsv, toSheetValues, buildSummary } from '../lib/export.js';
import { writeSheets } from '../lib/gsheets.js';

export default function exhibitionRoutes(db) {
  const r = Router();

  const getEx = (id) => db.prepare('SELECT * FROM exhibitions WHERE id = ?').get(id);
  const loadRules = () => db.prepare('SELECT * FROM segment_rules WHERE enabled = 1 ORDER BY priority, id').all().map(hydrateRule);
  const loadSegments = () => db.prepare('SELECT * FROM segments ORDER BY sort_order, id').all();
  const loadMembers = () => db.prepare('SELECT * FROM members ORDER BY sort_order, id').all();
  const loadLeads = (exId) => db.prepare('SELECT * FROM leads WHERE exhibition_id = ? ORDER BY id').all(exId).map(hydrateLead);
  const loadActivities = (exId) => db.prepare(`
    SELECT a.*, l.company, l.name FROM activities a JOIN leads l ON l.id = a.lead_id
    WHERE l.exhibition_id = ? ORDER BY a.created_at DESC, a.id DESC`).all(exId);

  r.get('/', (req, res) => {
    const rows = db.prepare(`
      SELECT e.*, (SELECT COUNT(*) FROM leads l WHERE l.exhibition_id = e.id) AS lead_count
      FROM exhibitions e ORDER BY COALESCE(e.held_on, e.created_at) DESC, e.id DESC`).all();
    res.json(rows.map((e) => ({ ...e, mapping: safeJson(e.mapping_json, null), mapping_json: undefined })));
  });

  r.post('/', (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: '展示会名は必須です' });
    const info = db.prepare('INSERT INTO exhibitions (name, held_on, venue) VALUES (?,?,?)').run(name, req.body.held_on || null, req.body.venue || null);
    res.status(201).json(getEx(info.lastInsertRowid));
  });

  r.put('/:id', (req, res) => {
    const e = getEx(req.params.id);
    if (!e) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    db.prepare('UPDATE exhibitions SET name=?, held_on=?, venue=? WHERE id=?').run(b.name ?? e.name, b.held_on ?? e.held_on, b.venue ?? e.venue, e.id);
    res.json(getEx(e.id));
  });

  r.delete('/:id', (req, res) => {
    db.prepare('DELETE FROM exhibitions WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // 取り込み。body: { mapping, leads: [{company,name,...,extra}] }
  r.post('/:id/import', (req, res) => {
    const e = getEx(req.params.id);
    if (!e) return res.status(404).json({ error: 'not found' });
    const leads = Array.isArray(req.body?.leads) ? req.body.leads : [];
    if (!leads.length) return res.status(400).json({ error: '取り込む行がありません' });
    const rules = loadRules();
    const findSame = db.prepare('SELECT id FROM leads WHERE exhibition_id = ? AND dedupe_key = ? LIMIT 1');
    const findPrev = db.prepare('SELECT id, exhibition_id FROM leads WHERE exhibition_id != ? AND dedupe_key = ? ORDER BY id DESC LIMIT 1');
    const ins = db.prepare(`INSERT INTO leads (exhibition_id, company, name, department, title, email, phone, industry, employees, memo, extra_json, dedupe_key, returning_lead_id, segment_code, matched_rule_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const result = { imported: 0, duplicates: 0, returning: 0, skipped_empty: 0, bySegment: {} };
    const seenInBatch = new Set();
    db.exec('BEGIN');
    try {
      for (const raw of leads) {
        const lead = normalizeLeadInput(raw);
        if (!lead.company && !lead.name && !lead.email) { result.skipped_empty++; continue; }
        const key = dedupeKey(lead);
        if (key && (seenInBatch.has(key) || findSame.get(e.id, key))) { result.duplicates++; continue; }
        if (key) seenInBatch.add(key);
        const prev = key ? findPrev.get(e.id, key) : null;
        if (prev) result.returning++;
        const c = classify(lead, rules);
        ins.run(e.id, lead.company, lead.name, lead.department, lead.title, lead.email, lead.phone, lead.industry, lead.employees, lead.memo,
          JSON.stringify(lead.extra || {}), key, prev ? prev.id : null, c.segment_code, c.rule_id);
        result.imported++;
        result.bySegment[c.segment_code] = (result.bySegment[c.segment_code] || 0) + 1;
      }
      if (req.body.mapping) db.prepare('UPDATE exhibitions SET mapping_json = ? WHERE id = ?').run(JSON.stringify(req.body.mapping), e.id);
      // dry_run のときは集計だけ返して書き込まない（取り込み前プレビュー用）
      if (req.body.dry_run) { db.exec('ROLLBACK'); return res.json({ ...result, dry_run: true }); }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    res.json(result);
  });

  // ルール再判定（手動で固定したものは overwrite_locked=true のときだけ上書き）
  r.post('/:id/reclassify', (req, res) => {
    const e = getEx(req.params.id);
    if (!e) return res.status(404).json({ error: 'not found' });
    const rules = loadRules();
    const overwriteLocked = !!req.body?.overwrite_locked;
    const upd = db.prepare('UPDATE leads SET segment_code = ?, matched_rule_id = ?, segment_locked = 0, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?');
    let changed = 0, total = 0;
    const bySegment = {};
    db.exec('BEGIN');
    try {
      for (const lead of loadLeads(e.id)) {
        total++;
        if (lead.segment_locked && !overwriteLocked) { bySegment[lead.segment_code] = (bySegment[lead.segment_code] || 0) + 1; continue; }
        const c = classify(lead, rules);
        bySegment[c.segment_code] = (bySegment[c.segment_code] || 0) + 1;
        if (c.segment_code !== lead.segment_code || c.rule_id !== lead.matched_rule_id) { upd.run(c.segment_code, c.rule_id, lead.id); changed++; }
      }
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    res.json({ total, changed, bySegment });
  });

  // 担当割当。body: { member_ids, segment_codes?, mode: 'unassigned'|'all' }
  r.post('/:id/assign', (req, res) => {
    const e = getEx(req.params.id);
    if (!e) return res.status(404).json({ error: 'not found' });
    const memberIds = (req.body?.member_ids || []).map(Number).filter(Boolean);
    if (!memberIds.length) return res.status(400).json({ error: '担当者を選んでください' });
    const segCodes = Array.isArray(req.body?.segment_codes) && req.body.segment_codes.length ? req.body.segment_codes : null;
    const mode = req.body?.mode === 'all' ? 'all' : 'unassigned';
    const excluded = new Set(loadSegments().filter((s) => s.is_excluded).map((s) => s.code));
    const segOrder = Object.fromEntries(loadSegments().map((s) => [s.code, s.sort_order]));
    let leads = loadLeads(e.id).filter((l) => !excluded.has(l.segment_code) && l.status !== 'excluded');
    if (segCodes) leads = leads.filter((l) => segCodes.includes(l.segment_code));
    if (mode === 'unassigned') leads = leads.filter((l) => !l.assignee_id);
    // セグメント優先度順に並べてから配ると、A ランクも人ごとに均等になる
    leads.sort((a, b) => (segOrder[a.segment_code] ?? 99) - (segOrder[b.segment_code] ?? 99) || a.id - b.id);
    const plan = roundRobinAssign(leads, memberIds);
    const upd = db.prepare('UPDATE leads SET assignee_id = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?');
    db.exec('BEGIN');
    try { for (const p of plan) upd.run(p.member_id, p.lead_id); db.exec('COMMIT'); } catch (err) { db.exec('ROLLBACK'); throw err; }
    const perMember = {};
    for (const p of plan) perMember[p.member_id] = (perMember[p.member_id] || 0) + 1;
    res.json({ assigned: plan.length, perMember });
  });

  r.get('/:id/summary', (req, res) => {
    const e = getEx(req.params.id);
    if (!e) return res.status(404).json({ error: 'not found' });
    const leads = loadLeads(e.id);
    const segments = loadSegments();
    const members = loadMembers();
    const activities = loadActivities(e.id);
    const summary = buildSummary({ leads, segments, members, activities });
    // 日別のアクティビティ件数（直近 14 日）
    const daily = db.prepare(`
      SELECT substr(a.created_at,1,10) AS day, COUNT(*) AS calls,
        SUM(CASE WHEN a.status IN ('connected','sent_docs','appointment','lost') THEN 1 ELSE 0 END) AS connected,
        SUM(CASE WHEN a.status = 'appointment' THEN 1 ELSE 0 END) AS appointments
      FROM activities a JOIN leads l ON l.id = a.lead_id WHERE l.exhibition_id = ?
      GROUP BY day ORDER BY day DESC LIMIT 14`).all(e.id).reverse();
    const overdue = leads.filter((l) => l.next_call_at && l.next_call_at < nowLocal() && !['appointment', 'lost', 'excluded'].includes(l.status)).length;
    res.json({ exhibition: e, ...summary, daily, overdue, segments, members });
  });

  r.get('/:id/export.xlsx', async (req, res) => {
    const e = getEx(req.params.id);
    if (!e) return res.status(404).json({ error: 'not found' });
    const buf = await toXlsxBuffer({ exhibition: e, leads: loadLeads(e.id), segments: loadSegments(), members: loadMembers(), activities: loadActivities(e.id) });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileBase(e))}.xlsx`);
    res.send(buf);
  });

  r.get('/:id/export.csv', (req, res) => {
    const e = getEx(req.params.id);
    if (!e) return res.status(404).json({ error: 'not found' });
    const csv = toCsv({ exhibition: e, leads: loadLeads(e.id), segments: loadSegments(), members: loadMembers() });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileBase(e))}.csv`);
    res.send(csv);
  });

  r.post('/:id/export/gsheets', async (req, res) => {
    const e = getEx(req.params.id);
    if (!e) return res.status(404).json({ error: 'not found' });
    const target = req.body?.spreadsheet;
    if (!target) return res.status(400).json({ error: 'スプレッドシートの URL か ID を入れてください' });
    const values = toSheetValues({ exhibition: e, leads: loadLeads(e.id), segments: loadSegments(), members: loadMembers(), activities: loadActivities(e.id) });
    const out = await writeSheets(target, values);
    res.json(out);
  });

  return r;
}

function normalizeLeadInput(raw = {}) {
  const s = (v) => (v == null ? '' : String(v).trim());
  return {
    company: s(raw.company), name: s(raw.name), department: s(raw.department), title: s(raw.title),
    email: s(raw.email), phone: s(raw.phone), industry: s(raw.industry), employees: s(raw.employees), memo: s(raw.memo),
    extra: raw.extra && typeof raw.extra === 'object' ? raw.extra : {},
  };
}

function fileBase(e) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${e.name.replace(/[\\/:*?"<>|]/g, '_')}_リード_${stamp}`;
}

export function nowLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
