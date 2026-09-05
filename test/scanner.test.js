// 来場者バッジのスキャンアプリ出力（チーム独自列つき）を読めるか
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { csvToObjects, guessMapping, applyMapping, cleanHeader, normalizePhone } from '../public/csv.js';
import { openDb } from '../server/lib/db.js';
import { createApp } from '../server/index.js';
import { matchSegmentHint } from '../server/routes/exhibitions.js';

const text = fs.readFileSync(new URL('../samples/scanner_app_sample.csv', import.meta.url), 'utf8');

test('見出しの注釈を除去し、重複見出しは (2) で区別', () => {
  assert.equal(cleanHeader('姓｜例）山田'), '姓');
  assert.equal(cleanHeader('住所 ※会社住所をご記入ください（都道府県｜例）東京都）'), '住所（都道府県）');
  const { headers } = csvToObjects(text);
  assert.ok(headers.includes('ランク'));
  assert.ok(headers.includes('ランク(2)'));
  assert.ok(headers.includes('姓') && headers.includes('名'));
});

test('来場者の氏名は 姓+名、スキャンした自社側の氏名は使わない', () => {
  const { headers, records } = csvToObjects(text);
  const m = guessMapping(headers, records);
  assert.equal(m.name, '__combine_last_first__');
  assert.equal(m.last_name, '姓');
  assert.equal(m.first_name, '名');
  assert.equal(m.company, '社名');
  assert.equal(m.email, 'ログインアカウント');
  assert.equal(m.phone, '電話番号');
  assert.equal(m.title, '役職');
  assert.equal(m.employees, '従業員区分(追加情報)');
  assert.equal(m.segment, 'ランク', '1 つ目のランク（チームの手動ランク）');
  assert.equal(m.assignee, '担当');
  assert.equal(m.memo, 'メモ');
  const lead = applyMapping(records[1], m, headers);
  assert.equal(lead.name, '鈴木 健');
  assert.equal(lead.segment_hint, 'C');
  assert.equal(lead.assignee_name, '橋本');
  assert.equal(lead.extra['担当者の氏名'], '自社 二郎');
  assert.equal(lead.extra['あなたの製品導入権限は？'], '導入権限はないが、導入に関与している');
});

test('Excel で落ちた電話番号の先頭 0 を補う', () => {
  assert.equal(normalizePhone('9011112222'), '09011112222');
  assert.equal(normalizePhone('312345678'), '0312345678');
  assert.equal(normalizePhone('0312345678'), '0312345678');
  assert.equal(normalizePhone('０３−１２３４−５６７８'), '03-1234-5678');
  assert.equal(normalizePhone('03-1234-5678'), '03-1234-5678');
  assert.equal(normalizePhone(''), '');
});

test('ランク値とセグメントの突き合わせ', () => {
  const segs = [{ code: 'A', label: 'A：即架電' }, { code: 'B', label: 'B：メール後架電' }];
  assert.equal(matchSegmentHint('A', segs), 'A');
  assert.equal(matchSegmentHint('ｂ', segs), 'B');
  assert.equal(matchSegmentHint('A：即架電', segs), 'A');
  assert.equal(matchSegmentHint('S', segs), null);
  assert.equal(matchSegmentHint('', segs), null);
});

let server, base;
before(async () => {
  server = createApp(openDb(':memory:')).listen(0);
  await new Promise((res) => server.once('listening', res));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());
const j = async (url, body, method = body ? 'POST' : 'GET') => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
};

test('取り込み：既存ランクを優先、担当者を自動登録、S はルール判定に回る', async () => {
  const { data: ex } = await j('/api/exhibitions', { name: 'スキャンアプリ' });
  const { headers, records } = csvToObjects(text);
  const mapping = guessMapping(headers, records);
  const leads = records.map((r) => applyMapping(r, mapping, headers));
  const { data: r } = await j(`/api/exhibitions/${ex.id}/import`, { leads, mapping });
  assert.equal(r.imported, 4);
  assert.equal(r.duplicates, 1, '同じメールの 2 回目スキャンは重複');
  assert.equal(r.segment_from_csv, 3, 'A/B/C はそのまま採用');
  assert.deepEqual(r.segment_hint_unmatched, { S: 1 });
  assert.equal(r.bySegment.A, 2, 'S の人は導入権限あり＋本部長なのでルールで A');
  assert.deepEqual(r.members_created.sort(), ['平石', '橋本']);
  assert.equal(r.assigned_from_csv, 2);

  const { data: list } = await j(`/api/leads?exhibition_id=${ex.id}&sort=id`);
  const beta = list.items.find((l) => l.company.includes('ベータ'));
  assert.equal(beta.segment_code, 'C');
  assert.equal(beta.segment_locked, 1);
  assert.equal(beta.assignee_name, '橋本');
  assert.equal(beta.phone, '09022223333');
  assert.equal(beta.email, 'dev@sample-beta.example.co.jp');
  // 再判定しても CSV 由来のランクは守られる
  await j(`/api/exhibitions/${ex.id}/reclassify`, {});
  assert.equal((await j(`/api/leads/${beta.id}`)).data.segment_code, 'C');
});
