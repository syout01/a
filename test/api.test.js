import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDb } from '../server/lib/db.js';
import { createApp } from '../server/index.js';
import { csvToObjects, guessMapping, applyMapping } from '../public/csv.js';

let server, base;
const j = async (url, body, method = body ? 'POST' : 'GET') => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
};

before(async () => {
  server = createApp(openDb(':memory:')).listen(0);
  await new Promise((res) => server.once('listening', res));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

test('取り込み→重複→判定→割当→フォロー→サマリー→書き出し', async () => {
  const { data: ex } = await j('/api/exhibitions', { name: 'テスト展', held_on: '2026-09-01' });
  const { headers, records } = csvToObjects(fs.readFileSync(new URL('../samples/expo_sample.csv', import.meta.url), 'utf8'));
  const mapping = guessMapping(headers);
  const leads = records.map((r) => applyMapping(r, mapping, headers));

  const dry = await j(`/api/exhibitions/${ex.id}/import`, { leads, mapping, dry_run: true });
  assert.equal(dry.data.dry_run, true);
  assert.equal(dry.data.imported, 19);
  assert.equal(dry.data.duplicates, 1);
  assert.equal((await j(`/api/leads?exhibition_id=${ex.id}`)).data.total, 0, 'dry_run では書き込まれない');

  const imp = await j(`/api/exhibitions/${ex.id}/import`, { leads, mapping });
  assert.equal(imp.data.imported, 19);
  assert.equal(imp.data.duplicates, 1);
  assert.equal(imp.data.bySegment.X, 2, '学生と同業BPOは除外');
  assert.ok(imp.data.bySegment.A >= 5);

  // 再取り込みは全件重複
  const again = await j(`/api/exhibitions/${ex.id}/import`, { leads, mapping });
  assert.equal(again.data.imported, 0);
  assert.equal(again.data.duplicates, 20);

  // 別展示会に同じ人が来たら「過去接触あり」
  const { data: ex2 } = await j('/api/exhibitions', { name: '次の展示会' });
  const ret = await j(`/api/exhibitions/${ex2.id}/import`, { leads: leads.slice(0, 3) });
  assert.equal(ret.data.returning, 3);

  // 割当（除外セグメントは配られない）
  const members = (await j('/api/members')).data;
  const asg = await j(`/api/exhibitions/${ex.id}/assign`, { member_ids: members.map((m) => m.id), segment_codes: ['A', 'B', 'C'] });
  assert.equal(asg.data.assigned, 17);
  const un = await j(`/api/leads?exhibition_id=${ex.id}&assignee_id=0`);
  assert.ok(un.data.items.every((l) => l.segment_code === 'X'));

  // 今日やるリストに入る → フォロー記録で消える
  const today = await j(`/api/leads?exhibition_id=${ex.id}&assignee_id=${members[0].id}&due=today`);
  assert.ok(today.data.total > 0);
  const lead = today.data.items[0];
  const act = await j(`/api/leads/${lead.id}/activities`, { status: 'calling', note: '不在', next_call_at: '2099-01-01 10:00:00', member_id: members[0].id });
  assert.equal(act.status, 201);
  assert.equal(act.data.status, 'calling');
  assert.equal(act.data.activities.length, 1);
  const today2 = await j(`/api/leads?exhibition_id=${ex.id}&assignee_id=${members[0].id}&due=today`);
  assert.equal(today2.data.total, today.data.total - 1, '次回コールが先の日付なら今日のリストから外れる');

  // 手動セグメント変更は固定され、再判定で上書きされない
  const patched = await j(`/api/leads/${lead.id}`, { segment_code: 'C' }, 'PATCH');
  assert.equal(patched.data.segment_locked, 1);
  const re = await j(`/api/exhibitions/${ex.id}/reclassify`, {});
  assert.equal((await j(`/api/leads/${lead.id}`)).data.segment_code, 'C');
  const re2 = await j(`/api/exhibitions/${ex.id}/reclassify`, { overwrite_locked: true });
  assert.ok(re2.data.changed >= 1);
  assert.equal((await j(`/api/leads/${lead.id}`)).data.segment_locked, 0);

  // ルール CRUD とバリデーション
  const bad = await j('/api/rules', { name: 'x', segment_code: 'A', conditions: [{ field: 'title', op: 'regex', value: '(' }] });
  assert.equal(bad.status, 400);
  const rule = await j('/api/rules', { name: '従業員 1000 名以上は A', segment_code: 'A', priority: 25, match_mode: 'all', conditions: [{ field: 'employees', op: 'gte', value: '1000' }] });
  assert.equal(rule.status, 201);
  await j(`/api/rules/${rule.data.id}`, null, 'DELETE');

  // サマリーと書き出し
  const sum = await j(`/api/exhibitions/${ex.id}/summary`);
  assert.equal(sum.data.total.total, 19);
  assert.equal(sum.data.total.touched, 1);
  const x = await fetch(`${base}/api/exhibitions/${ex.id}/export.xlsx`);
  assert.equal(x.status, 200);
  assert.ok((await x.arrayBuffer()).byteLength > 5000);
  const c = await fetch(`${base}/api/exhibitions/${ex.id}/export.csv`);
  const csvBytes = new Uint8Array(await c.arrayBuffer());
  assert.deepEqual([...csvBytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'Excel 用に BOM 付き');
  const csv = new TextDecoder().decode(csvBytes);
  assert.ok(csv.startsWith('ID,セグメント'));
  assert.equal(csv.trim().split('\r\n').length, 20);
  assert.ok(csv.split('\r\n')[0].includes('興味のある製品'), 'extra 列も書き出す');

  // Google 連携が未設定なら分かるエラー
  const g = await j(`/api/exhibitions/${ex.id}/export/gsheets`, { spreadsheet: 'abc' });
  assert.equal(g.status, 500);
  assert.match(g.data.error, /設定されていません/);
});
