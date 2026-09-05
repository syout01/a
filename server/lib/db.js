// SQLite (node:sqlite) 接続とスキーマ定義
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SEGMENTS = [
  { code: 'A', label: 'A：即架電', action: '翌営業日までに架電。アポ打診まで一気に', color: '#d9534f', sort_order: 1, is_excluded: 0 },
  { code: 'B', label: 'B：架電（1週間以内）', action: 'A が一巡したら架電。1 週間以内に初回接触', color: '#f0ad4e', sort_order: 2, is_excluded: 0 },
  { code: 'C', label: 'C：架電（余力があれば）', action: '残件がなくなったら架電。2 週間で一巡', color: '#5bc0de', sort_order: 3, is_excluded: 0 },
  { code: 'X', label: 'X：除外', action: 'フォロー対象外（同業・学生など）', color: '#999999', sort_order: 9, is_excluded: 1 },
  { code: 'U', label: '未分類', action: 'ルールに当てはまらず。手動で振り分け', color: '#777777', sort_order: 99, is_excluded: 0 },
];

export const DEFAULT_RULES = [
  {
    name: '同業・競合・学生は除外',
    segment_code: 'X',
    priority: 10,
    match_mode: 'any',
    conditions: [
      { field: 'title', op: 'contains', value: '学生' },
      { field: 'company', op: 'contains', value: '大学' },
      { field: 'industry', op: 'in_list', value: 'コールセンター,テレマーケティング,BPO' },
    ],
  },
  {
    name: '導入権限あり／経営・部長クラス（アンケート）は即架電',
    segment_code: 'A',
    priority: 15,
    match_mode: 'any',
    conditions: [
      { field: 'extra.あなたの製品導入権限は？', op: 'equals', value: '導入権限がある' },
      { field: 'extra.あなたの役職レベルは？', op: 'in_list', value: '経営・役員クラス,本部長・部長クラス' },
    ],
  },
  {
    name: '決裁者クラスは即架電',
    segment_code: 'A',
    priority: 20,
    match_mode: 'any',
    conditions: [
      { field: 'title', op: 'regex', value: '(代表|社長|取締役|役員|執行役|本部長|部長|事業部長|CEO|COO|CMO)' },
    ],
  },
  {
    name: 'ブースで温度感ありは即架電',
    segment_code: 'A',
    priority: 21,
    match_mode: 'any',
    conditions: [
      { field: 'memo', op: 'regex', value: '(検討|見積|導入|興味|課題|相談)' },
    ],
  },
  {
    name: '課長・リーダー・担当は B',
    segment_code: 'B',
    priority: 30,
    match_mode: 'any',
    conditions: [
      { field: 'title', op: 'regex', value: '(課長|次長|マネージャー|マネジャー|リーダー|主任|係長|チーフ|担当)' },
      { field: 'extra.あなたの役職レベルは？', op: 'in_list', value: '課長クラス,主任クラス' },
      { field: 'extra.あなたの製品導入権限は？', op: 'contains', value: '関与している' },
    ],
  },
  {
    name: 'その他は C',
    segment_code: 'C',
    priority: 90,
    match_mode: 'all',
    conditions: [{ field: 'company', op: 'not_empty', value: '' }],
  },
];


export const LEAD_STATUSES = [
  { code: 'new', label: '未着手', touched: 0, connected: 0, closed: 0 },
  { code: 'calling', label: '架電中（不在・再コール）', touched: 1, connected: 0, closed: 0 },
  { code: 'connected', label: '通電（継続フォロー）', touched: 1, connected: 1, closed: 0 },
  { code: 'sent_docs', label: '資料送付', touched: 1, connected: 1, closed: 0 },
  { code: 'appointment', label: 'アポ獲得', touched: 1, connected: 1, closed: 1 },
  { code: 'lost', label: '見込みなし', touched: 1, connected: 1, closed: 1 },
  { code: 'excluded', label: '対象外', touched: 0, connected: 0, closed: 1 },
];

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS exhibitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  held_on TEXT,
  venue TEXT,
  mapping_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  email TEXT UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_member ON sessions(member_id);
CREATE TABLE IF NOT EXISTS auth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT, name TEXT, email TEXT, phone TEXT, scale TEXT, message TEXT,
  source_json TEXT,
  ip TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER,
  action TEXT NOT NULL,
  target TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  action TEXT,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_excluded INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS segment_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  segment_code TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  match_mode TEXT NOT NULL DEFAULT 'all',
  conditions_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exhibition_id INTEGER NOT NULL REFERENCES exhibitions(id) ON DELETE CASCADE,
  company TEXT, name TEXT, department TEXT, title TEXT,
  email TEXT, phone TEXT, industry TEXT, employees TEXT, memo TEXT,
  extra_json TEXT,
  dedupe_key TEXT,
  returning_lead_id INTEGER,
  segment_code TEXT,
  segment_locked INTEGER NOT NULL DEFAULT 0,
  matched_rule_id INTEGER,
  assignee_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'new',
  next_call_at TEXT,
  last_note TEXT,
  last_contact_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_leads_exhibition ON leads(exhibition_id);
CREATE INDEX IF NOT EXISTS idx_leads_dedupe ON leads(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_leads_assignee_status ON leads(assignee_id, status);
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  member_id INTEGER,
  member_name TEXT,
  status TEXT,
  note TEXT,
  next_call_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities(lead_id);
`;

export function openDb(dbPath = process.env.DB_PATH || 'data/app.db') {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* メモリDBでは不要 */ }
  migrate(db);
  seedDefaults(db);
  return db;
}

// 旧バージョンの DB に列を足す（存在すれば何もしない）
function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(members)').all().map((c) => c.name));
  const add = (name, ddl) => { if (!cols.has(name)) db.exec(`ALTER TABLE members ADD COLUMN ${name} ${ddl}`); };
  add('email', 'TEXT');
  add('password_hash', 'TEXT');
  add('role', "TEXT NOT NULL DEFAULT 'member'");
  add('last_login_at', 'TEXT');
  add('created_at', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_members_email ON members(email)');
}

function seedDefaults(db) {
  const segCount = db.prepare('SELECT COUNT(*) AS n FROM segments').get().n;
  if (segCount === 0) {
    const ins = db.prepare('INSERT INTO segments (code,label,action,color,sort_order,is_excluded) VALUES (?,?,?,?,?,?)');
    for (const s of DEFAULT_SEGMENTS) ins.run(s.code, s.label, s.action, s.color, s.sort_order, s.is_excluded);
  }
  const ruleCount = db.prepare('SELECT COUNT(*) AS n FROM segment_rules').get().n;
  if (ruleCount === 0) {
    const ins = db.prepare('INSERT INTO segment_rules (name,segment_code,priority,match_mode,conditions_json,enabled) VALUES (?,?,?,?,?,1)');
    for (const r of DEFAULT_RULES) ins.run(r.name, r.segment_code, r.priority, r.match_mode, JSON.stringify(r.conditions));
  }
}

// 行の JSON 列を展開するヘルパー
export function hydrateLead(row) {
  if (!row) return row;
  const out = { ...row };
  out.extra = safeJson(row.extra_json, {});
  delete out.extra_json;
  return out;
}
export function hydrateRule(row) {
  if (!row) return row;
  const out = { ...row };
  out.conditions = safeJson(row.conditions_json, []);
  delete out.conditions_json;
  return out;
}
export function safeJson(text, fallback) {
  if (text == null || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}
