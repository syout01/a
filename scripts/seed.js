// サンプルデータ投入： node scripts/seed.js  （DB_PATH で対象を変更可）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/lib/db.js';
import { createApp } from '../server/index.js';
import { csvToObjects, decodeBytes, guessMapping, applyMapping } from '../public/csv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = openDb();
const app = createApp(db);
const server = app.listen(0);
const base = `http://localhost:${server.address().port}`;
const j = async (url, body, method = 'POST') => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error);
  return d;
};

try {
  const csvPath = process.argv[2] || path.join(__dirname, '..', 'samples', 'expo_sample.csv');
  const { text } = decodeBytes(fs.readFileSync(csvPath));
  const { headers, records } = csvToObjects(text);
  const mapping = guessMapping(headers);
  const leads = records.map((r) => applyMapping(r, mapping, headers));

  const ex = await j('/api/exhibitions', { name: 'サンプル展示会 2026 秋', held_on: '2026-09-03', venue: '東京ビッグサイト' });
  const imp = await j(`/api/exhibitions/${ex.id}/import`, { leads, mapping });
  console.log('取り込み:', imp);
  const members = await j('/api/members', null, 'GET');
  const asg = await j(`/api/exhibitions/${ex.id}/assign`, { member_ids: members.filter((m) => m.active).map((m) => m.id) });
  console.log('割当:', asg);
  // 少しフォロー記録も入れておく
  const { items } = await j(`/api/leads?exhibition_id=${ex.id}&segment=A`, null, 'GET');
  if (items[0]) await j(`/api/leads/${items[0].id}/activities`, { status: 'appointment', note: '9/12 15:00 訪問アポ', member_id: items[0].assignee_id });
  if (items[1]) await j(`/api/leads/${items[1].id}/activities`, { status: 'calling', note: '担当不在。折り返し依頼', next_call_at: '2026-09-08 10:00:00', member_id: items[1].assignee_id });
  console.log(`完了。展示会ID=${ex.id}  → npm start で http://localhost:3000 を開いてください`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  server.close();
}
