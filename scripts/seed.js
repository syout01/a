// サンプルデータ投入： node scripts/seed.js  （DB_PATH で対象を変更可）
// ローカルで試すための管理者アカウントも作ります（本番では使わないでください）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/lib/db.js';
import { createApp } from '../server/index.js';
import { hashPassword } from '../server/lib/auth.js';
import { csvToObjects, decodeBytes, guessMapping, applyMapping } from '../public/csv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'demo-pass-1234';

const db = openDb();
// 管理者と担当者（ログインなし）を用意
if (!db.prepare('SELECT 1 FROM members WHERE email = ?').get(ADMIN_EMAIL)) {
  db.prepare("INSERT INTO members (name, email, password_hash, role, sort_order) VALUES (?,?,?,'admin',0)").run('管理者（デモ）', ADMIN_EMAIL, hashPassword(ADMIN_PASSWORD));
}
for (const [i, name] of ['担当A', '担当B'].entries()) {
  if (!db.prepare('SELECT 1 FROM members WHERE name = ?').get(name)) db.prepare('INSERT INTO members (name, sort_order) VALUES (?,?)').run(name, i + 1);
}

const app = createApp(db);
const server = app.listen(0);
const base = `http://localhost:${server.address().port}`;
let cookie = '';
const j = async (url, body, method = body ? 'POST' : 'GET') => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const setc = r.headers.get('set-cookie'); if (setc) cookie = setc.split(';')[0];
  const d = await r.json();
  if (!r.ok) throw new Error(d.error);
  return d;
};

try {
  await j('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const csvPath = process.argv[2] || path.join(__dirname, '..', 'samples', 'expo_sample.csv');
  const { text } = decodeBytes(fs.readFileSync(csvPath));
  const { headers, records } = csvToObjects(text);
  const mapping = guessMapping(headers, records);
  const leads = records.map((r) => applyMapping(r, mapping, headers));

  const ex = await j('/api/exhibitions', { name: 'サンプル展示会 2026 秋', held_on: '2026-09-03', venue: '東京ビッグサイト' });
  const imp = await j(`/api/exhibitions/${ex.id}/import`, { leads, mapping });
  console.log('取り込み:', imp);
  const members = await j('/api/members');
  const asg = await j(`/api/exhibitions/${ex.id}/assign`, { member_ids: members.filter((m) => m.active).map((m) => m.id) });
  console.log('割当:', asg);
  const { items } = await j(`/api/leads?exhibition_id=${ex.id}&segment=A`);
  if (items[0]) await j(`/api/leads/${items[0].id}/activities`, { status: 'appointment', note: '9/12 15:00 訪問アポ' });
  if (items[1]) await j(`/api/leads/${items[1].id}/activities`, { status: 'calling', note: '担当不在。折り返し依頼', next_call_at: '2026-09-08 10:00:00' });
  console.log(`完了。展示会ID=${ex.id}`);
  console.log(`\nnpm start で http://localhost:3000 を開き、次でログインしてください（ローカル用のデモ資格情報）`);
  console.log(`  メール: ${ADMIN_EMAIL}\n  パスワード: ${ADMIN_PASSWORD}`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  server.close();
}
