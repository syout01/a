// Google スプレッドシート連携（サービスアカウント）。設定がなければ無効
import fs from 'node:fs';

let authClientPromise = null;

export function gsheetsConfig() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  try {
    if (json) return JSON.parse(json);
    if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('[gsheets] 認証情報の読み込みに失敗:', e.message);
  }
  return null;
}

export function gsheetsStatus() {
  const cfg = gsheetsConfig();
  return { enabled: !!cfg, serviceAccountEmail: cfg?.client_email || null };
}

async function getAuth() {
  const cfg = gsheetsConfig();
  if (!cfg) throw new Error('Google スプレッドシート連携が設定されていません（.env を確認）');
  if (!authClientPromise) {
    authClientPromise = import('google-auth-library').then(({ JWT }) => new JWT({
      email: cfg.client_email,
      key: cfg.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    }));
  }
  return authClientPromise;
}

async function api(auth, method, url, body) {
  const { token } = await auth.getAccessToken();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sheets API ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

// URL でも ID でも受け付ける
export function extractSpreadsheetId(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : s;
}

// { タブ名: 2次元配列 } を書き込む。タブがなければ作成し、あればクリアして上書き
export async function writeSheets(spreadsheetIdOrUrl, sheetsValues) {
  const auth = await getAuth();
  const spreadsheetId = extractSpreadsheetId(spreadsheetIdOrUrl);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  const meta = await api(auth, 'GET', `${base}?fields=spreadsheetUrl,sheets.properties`);
  const existing = new Set((meta.sheets || []).map((s) => s.properties.title));
  const toCreate = Object.keys(sheetsValues).filter((t) => !existing.has(t));
  if (toCreate.length) {
    await api(auth, 'POST', `${base}:batchUpdate`, { requests: toCreate.map((title) => ({ addSheet: { properties: { title } } })) });
  }
  for (const title of Object.keys(sheetsValues)) {
    await api(auth, 'POST', `${base}/values/${encodeURIComponent(`'${title}'`)}:clear`, {});
  }
  await api(auth, 'POST', `${base}/values:batchUpdate`, {
    valueInputOption: 'USER_ENTERED',
    data: Object.entries(sheetsValues).map(([title, values]) => ({ range: `'${title}'!A1`, values })),
  });
  return { spreadsheetId, spreadsheetUrl: meta.spreadsheetUrl, sheets: Object.keys(sheetsValues), rows: Object.fromEntries(Object.entries(sheetsValues).map(([k, v]) => [k, v.length - 1])) };
}
