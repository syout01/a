import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, makeClient, setupAdmin } from './helpers.js';

let app, admin, base;
before(async () => { app = await startApp(); admin = app.client; base = app.base; await setupAdmin(admin); });
after(() => app.close());

test('LP と相談フォーム：未ログインで開けて送信でき、管理者だけが一覧を見られる', async () => {
  const anon = makeClient(base);
  assert.equal((await anon.raw('/lp.html')).status, 200);
  assert.equal((await anon.raw('/lp-thanks.html')).status, 200);
  assert.equal((await anon.raw('/lp.js')).status, 200);
  const lp = await anon.raw('/lp.html');
  assert.match(lp.headers.get('content-security-policy'), /googletagmanager/);
  assert.ok(!(await lp.text()).includes('gtm.js?id='), 'GTM_ID 未設定なら差し込まれない');

  const bad = await anon('/api/public/inquiry', { company: 'テスト社', name: '太郎', consent: true });
  assert.equal(bad.status, 400, '連絡先なしは拒否');
  const noConsent = await anon('/api/public/inquiry', { company: 'テスト社', name: '太郎', email: 't@example.com' });
  assert.equal(noConsent.status, 400);
  const bot = await anon('/api/public/inquiry', { company: 'x', name: 'y', email: 'b@example.com', consent: true, website: 'http://spam' });
  assert.equal(bot.status, 200, 'ハニーポットは黙って成功を返す');
  const ok = await anon('/api/public/inquiry', { company: 'テスト社', name: '太郎', email: 'T@Example.com', scale: '100〜300 枚', message: '来月の展示会', consent: true, utm_source: 'google', utm_campaign: 'test', gclid: 'abc' });
  assert.equal(ok.status, 201);

  assert.equal((await anon('/api/inquiries')).status, 401);
  const list = await admin('/api/inquiries');
  assert.equal(list.data.length, 1, 'bot の分は保存されない');
  assert.equal(list.data[0].email, 't@example.com');
  assert.equal(list.data[0].source.utm_source, 'google');
  const upd = await admin(`/api/inquiries/${list.data[0].id}`, { status: 'contacted' }, 'PATCH');
  assert.equal(upd.data.status, 'contacted');

  // 1 時間に 5 件まで
  let last;
  for (let i = 0; i < 6; i++) last = await anon('/api/public/inquiry', { company: 'c', name: 'n', email: `r${i}@example.com`, consent: true });
  assert.equal(last.status, 429);
});
