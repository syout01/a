import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeKey, normalizeCompany } from '../server/lib/dedupe.js';

test('メールがあればメール優先', () => {
  assert.equal(dedupeKey({ email: ' Taro@Example.JP ', company: 'A', name: 'B' }), 'e:taro@example.jp');
});
test('法人格・空白・全角のゆれを吸収', () => {
  assert.equal(normalizeCompany('株式会社アルファ製作所'), normalizeCompany('（株）アルファ製作所'));
  assert.equal(normalizeCompany('ＡＢＣ Inc.'), normalizeCompany('abc'));
  assert.equal(dedupeKey({ company: '株式会社A', name: '山田 太郎' }), dedupeKey({ company: '(株)A', name: '山田太郎' }));
});
test('何もなければ null', () => {
  assert.equal(dedupeKey({}), null);
  assert.equal(dedupeKey({ email: 'not-an-email' }), null);
});
