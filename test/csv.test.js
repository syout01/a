import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCsv, csvToObjects, decodeBytes, guessMapping, applyMapping } from '../public/csv.js';

test('クォート・改行・BOM・CRLF を処理', () => {
  const rows = parseCsv('\uFEFFa,b\r\n"x, y","li""ne\nbreak"\r\n\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'li"ne\nbreak']]);
});
test('TSV も読める', () => {
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});
test('Shift_JIS を自動判別', () => {
  const sjis = new Uint8Array([0x89, 0xef, 0x8e, 0xd0, 0x96, 0xbc, 0x2c, 0x8e, 0x81, 0x96, 0xbc, 0x0a]); // 会社名,氏名
  const { text, encoding } = decodeBytes(sjis);
  assert.equal(encoding, 'shift_jis');
  assert.equal(text.trim(), '会社名,氏名');
  assert.equal(decodeBytes(new TextEncoder().encode('会社名')).encoding, 'utf-8');
});
test('見出しからマッピングを推測し、姓名は結合', () => {
  const { headers, records } = csvToObjects(fs.readFileSync(new URL('../samples/expo_sample.csv', import.meta.url), 'utf8'));
  const m = guessMapping(headers);
  assert.equal(m.company, '会社名');
  assert.equal(m.email, 'E-mail');
  assert.equal(m.phone, 'TEL');
  assert.equal(m.title, '役職');
  assert.equal(m.department, '部署名');
  assert.equal(m.employees, '従業員規模');
  assert.equal(m.memo, '備考');
  assert.equal(m.name, '__combine_last_first__');
  const lead = applyMapping(records[0], m, headers);
  assert.equal(lead.name, '山田 太郎');
  assert.equal(lead.company, '株式会社アルファ製作所');
  assert.equal(lead.extra['興味のある製品'], 'インサイドセールス代行');
  assert.equal(lead.extra['来場者ID'], 'V0001');
});
