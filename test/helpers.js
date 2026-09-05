// テスト用：メモリ DB でアプリを起動し、管理者を作ってログイン済みのクライアントを返す
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDb } from '../server/lib/db.js';
import { createApp } from '../server/index.js';

// テストのバックアップはリポジトリ外に書く
process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-backup-'));

export async function startApp() {
  const db = openDb(':memory:');
  const server = createApp(db).listen(0);
  await new Promise((res) => server.once('listening', res));
  const base = `http://localhost:${server.address().port}`;
  const client = makeClient(base);
  return { db, server, base, client, close: () => server.close() };
}

export function makeClient(base) {
  let cookie = '';
  const j = async (url, body, method = body ? 'POST' : 'GET', extraHeaders = {}) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Cookie: cookie, ...extraHeaders }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const setc = r.headers.get('set-cookie');
    if (setc) cookie = setc.split(';')[0];
    let data = {};
    try { data = await r.clone().json(); } catch { data = {}; }
    return { status: r.status, data, res: r, headers: r.headers };
  };
  j.raw = (url, opts = {}) => fetch(base + url, { ...opts, headers: { 'X-Requested-With': 'fetch', Cookie: cookie, ...(opts.headers || {}) }, redirect: 'manual' });
  j.cookie = () => cookie;
  j.reset = () => { cookie = ''; };
  return j;
}

export async function setupAdmin(client, { email = 'admin@example.com', name = '管理者', password = 'Passw0rd-secure' } = {}) {
  const r = await client('/api/auth/setup', { email, name, password });
  if (r.status !== 201) throw new Error(`setup failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.user;
}

export async function addMembers(client, names = ['担当A', '担当B']) {
  const out = [];
  for (const name of names) out.push((await client('/api/members', { name })).data);
  return out;
}
