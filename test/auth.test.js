import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, makeClient, setupAdmin } from './helpers.js';

let app, admin, base;
before(async () => { app = await startApp(); admin = app.client; base = app.base; });
after(() => app.close());

test('未セットアップ → セットアップ → ログイン必須', async () => {
  const st = await admin('/api/auth/status');
  assert.equal(st.data.needs_setup, true);
  assert.equal((await admin('/api/exhibitions')).status, 401, '未ログインは 401');
  const top = await admin.raw('/');
  assert.equal(top.status, 302, '未ログインでトップを開くとログイン画面へ');
  assert.equal(top.headers.get('location'), '/login.html');
  assert.equal((await admin.raw('/login.html')).status, 200);
  assert.equal((await admin.raw('/app.js')).status, 401, 'アプリ本体は未ログインでは配らない');

  const weak = await admin('/api/auth/setup', { email: 'a@example.com', name: 'A', password: 'short' });
  assert.equal(weak.status, 400);
  await setupAdmin(admin);
  assert.equal((await admin('/api/auth/setup', { email: 'b@example.com', name: 'B', password: 'Passw0rd-secure' })).status, 409, '2 回目のセットアップは拒否');
  const me = await admin('/api/auth/me');
  assert.equal(me.data.user.role, 'admin');
  assert.equal(me.data.user.password_hash, undefined, 'ハッシュは返さない');
  assert.equal((await admin.raw('/')).status, 200);
});

test('Cookie 属性・セキュリティヘッダ・CSRF', async () => {
  const c = makeClient(base);
  const r = await c('/api/auth/login', { email: 'admin@example.com', password: 'Passw0rd-secure' });
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  assert.ok(!/Secure/.test(sc), 'http のテストでは Secure を付けない');
  const h = r.headers;
  assert.match(h.get('content-security-policy'), /default-src 'self'/);
  assert.equal(h.get('x-frame-options'), 'DENY');
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  // https 経由なら Secure と HSTS
  const rs = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ email: 'admin@example.com', password: 'Passw0rd-secure' }) });
  assert.match(rs.headers.get('set-cookie'), /Secure/);
  assert.ok(rs.headers.get('strict-transport-security'));
  // CSRF: ヘッダなし POST は拒否、他オリジンも拒否
  const noHdr = await fetch(`${base}/api/exhibitions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: c.cookie() }, body: JSON.stringify({ name: 'x' }) });
  assert.equal(noHdr.status, 403);
  const badOrigin = await c('/api/exhibitions', { name: 'x' }, 'POST', { Origin: 'https://evil.example' });
  assert.equal(badOrigin.status, 403);
  const good = await c('/api/exhibitions', { name: 'ok' }, 'POST', { Origin: `http://localhost:${new URL(base).port}` });
  assert.equal(good.status, 201);
});

test('ログイン失敗の応答とレート制限', async () => {
  const c = makeClient(base);
  const bad = await c('/api/auth/login', { email: 'admin@example.com', password: 'wrong-pass-1' });
  assert.equal(bad.status, 401);
  const ghost = await c('/api/auth/login', { email: 'nobody@example.com', password: 'wrong-pass-1' });
  assert.equal(ghost.status, 401);
  assert.equal(ghost.data.error, bad.data.error, '存在しないメールでも同じメッセージ');
  let last;
  for (let i = 0; i < 12; i++) last = await c('/api/auth/login', { email: 'victim@example.com', password: 'x' });
  assert.equal(last.status, 429);
});

test('招待 → 有効化 → 担当者の権限 → 再設定 → 停止', async () => {
  const m = (await admin('/api/members', { name: '担当X', email: 'x@example.com' })).data;
  assert.equal(m.has_login, false);
  const inv = await admin(`/api/members/${m.id}/invite`, {});
  assert.equal(inv.data.kind, 'invite');
  const token = inv.data.url.split('#token=')[1];
  assert.ok(token);

  const u = makeClient(base);
  const info = await u(`/api/auth/token/${token}`);
  assert.equal(info.data.email, 'x@example.com');
  const act = await u(`/api/auth/token/${token}`, { name: '担当 X', password: 'MemberPass99' });
  assert.equal(act.status, 200);
  assert.equal((await u(`/api/auth/token/${token}`)).status, 404, 'トークンは 1 回限り');

  // 担当者は閲覧とフォローはできるが管理操作はできない
  assert.equal((await u('/api/exhibitions')).status, 200);
  assert.equal((await u('/api/exhibitions', { name: 'x' })).status, 403);
  assert.equal((await u('/api/rules', { name: 'r', segment_code: 'A', conditions: [{ field: 'title', op: 'contains', value: 'a' }] })).status, 403);
  assert.equal((await u('/api/members', { name: 'y' })).status, 403);
  assert.equal((await u('/api/backups')).status, 403);
  const ex = (await admin('/api/exhibitions', { name: '権限テスト' })).data;
  await admin(`/api/exhibitions/${ex.id}/import`, { leads: [{ company: 'テスト社', name: '太郎', title: '部長' }] });
  const lead = (await u(`/api/leads?exhibition_id=${ex.id}`)).data.items[0];
  const a = await u(`/api/leads/${lead.id}/activities`, { status: 'connected', note: '担当者が記録' });
  assert.equal(a.status, 201);
  assert.equal(a.data.activities[0].member_name, '担当 X');

  // パスワード変更は現在のパスワードが必要
  assert.equal((await u('/api/auth/password', { current: 'wrong', password: 'NewPass12345' })).status, 400);
  assert.equal((await u('/api/auth/password', { current: 'MemberPass99', password: 'NewPass12345' })).status, 200);

  // 再設定リンク
  const rs = await admin(`/api/members/${m.id}/invite`, {});
  assert.equal(rs.data.kind, 'reset');
  const u2 = makeClient(base);
  assert.equal((await u2(`/api/auth/token/${rs.data.url.split('#token=')[1]}`, { password: 'ResetPass777' })).status, 200);
  assert.equal((await u('/api/auth/me')).status, 401, '再設定すると既存セッションは切れる');
  assert.equal((await u2('/api/auth/me')).status, 200);

  // 停止するとログインできない・セッションも切れる
  await admin(`/api/members/${m.id}`, { active: false }, 'PUT');
  assert.equal((await u2('/api/auth/me')).status, 401);
  assert.equal((await makeClient(base)('/api/auth/login', { email: 'x@example.com', password: 'ResetPass777' })).status, 401);

  // 自分の降格・最後の管理者の停止は拒否
  const meId = (await admin('/api/auth/me')).data.user.id;
  assert.equal((await admin(`/api/members/${meId}`, { role: 'member' }, 'PUT')).status, 400);
  assert.equal((await admin(`/api/members/${meId}`, {}, 'DELETE')).status, 400);

  // 監査ログとバックアップ
  const audit = await admin('/api/audit');
  assert.ok(audit.data.some((r) => r.action === 'token_invite'));
  const bk = await admin('/api/backups', {});
  assert.equal(bk.status, 200);
  assert.ok(bk.data.file.endsWith('.db'));
  const dl = await admin.raw('/api/backups/download');
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  await admin('/api/auth/logout', {});
  assert.equal((await admin('/api/auth/me')).status, 401);
});
