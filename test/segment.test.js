import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, evalCondition, toNumber, roundRobinAssign } from '../server/lib/segment.js';
import { DEFAULT_RULES } from '../server/lib/db.js';

const rules = DEFAULT_RULES.map((r, i) => ({ ...r, id: i + 1, enabled: 1 }));

test('役職に部長を含めば A', () => {
  assert.equal(classify({ title: '営業部長', company: 'X' }, rules).segment_code, 'A');
});
test('学生・大学・同業は除外ルールが最優先', () => {
  assert.equal(classify({ title: '部長', company: '○○大学' }, rules).segment_code, 'X');
  assert.equal(classify({ title: '学生', company: 'X' }, rules).segment_code, 'X');
  assert.equal(classify({ industry: 'コールセンター・BPO', title: '社長', company: 'Y' }, rules).segment_code, 'X');
});
test('メモに検討などがあれば A', () => {
  assert.equal(classify({ title: '担当', memo: '来期に導入を検討', company: 'X' }, rules).segment_code, 'A');
});
test('課長は B、それ以外は C、会社名も空なら未分類', () => {
  assert.equal(classify({ title: '課長', company: 'X' }, rules).segment_code, 'B');
  assert.equal(classify({ title: '研究員', company: 'X' }, rules).segment_code, 'C');
  assert.equal(classify({ title: '', company: '' }, rules).segment_code, 'U');
});
test('無効ルールは評価しない・優先度順に評価', () => {
  const rs = [
    { id: 1, priority: 50, segment_code: 'B', match_mode: 'all', enabled: 1, conditions: [{ field: 'title', op: 'contains', value: '長' }] },
    { id: 2, priority: 10, segment_code: 'A', match_mode: 'all', enabled: 0, conditions: [{ field: 'title', op: 'contains', value: '長' }] },
  ];
  assert.equal(classify({ title: '部長' }, rs).segment_code, 'B');
  rs[1].enabled = 1;
  assert.equal(classify({ title: '部長' }, rs).segment_code, 'A');
});
test('全角・大小・空白を正規化して比較', () => {
  assert.ok(evalCondition({ title: 'ＣＥＯ' }, { field: 'title', op: 'equals', value: 'ceo' }));
  assert.ok(evalCondition({ title: 'マネージャー' }, { field: 'title', op: 'in_list', value: '課長, マネージャー' }));
});
test('数値抽出と比較（従業員規模）', () => {
  assert.equal(toNumber('300〜999名'), 300);
  assert.equal(toNumber('1,200人'), 1200);
  assert.equal(toNumber('約５０名'), 50);
  assert.equal(toNumber('1万人'), 10000);
  assert.equal(toNumber('不明'), null);
  assert.ok(evalCondition({ employees: '300〜999名' }, { field: 'employees', op: 'gte', value: '100' }));
  assert.ok(!evalCondition({ employees: '10〜49名' }, { field: 'employees', op: 'gte', value: '100' }));
});
test('extra.列名 で未対応列も条件にできる', () => {
  assert.ok(evalCondition({ extra: { '興味のある製品': 'テレアポ代行' } }, { field: 'extra.興味のある製品', op: 'contains', value: 'テレアポ' }));
});
test('不正な正規表現は false（例外にしない）', () => {
  assert.equal(evalCondition({ title: 'x' }, { field: 'title', op: 'regex', value: '(' }), false);
});
test('ラウンドロビンは人数で平準化', () => {
  const leads = Array.from({ length: 7 }, (_, i) => ({ id: i + 1 }));
  const plan = roundRobinAssign(leads, [10, 20, 30]);
  const counts = plan.reduce((m, p) => ((m[p.member_id] = (m[p.member_id] || 0) + 1), m), {});
  assert.deepEqual(counts, { 10: 3, 20: 2, 30: 2 });
  assert.deepEqual(roundRobinAssign(leads, []), []);
});
