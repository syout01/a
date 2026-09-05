// SQLite のオンラインバックアップ（node:sqlite の backup API）。日次で世代管理する
import { backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const BACKUP_KEEP = +process.env.BACKUP_KEEP || 14;

export function backupDir() {
  return process.env.BACKUP_DIR || path.join(path.dirname(process.env.DB_PATH || 'data/app.db'), 'backups');
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function runBackup(db, { dir = backupDir(), keep = BACKUP_KEEP } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `app-${stamp()}.db`);
  await backup(db, file);
  // 古い世代を消す
  const files = fs.readdirSync(dir).filter((f) => /^app-\d{8}-\d{6}\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(dir, f));
  return { file, size: fs.statSync(file).size, kept: Math.min(files.length, keep) };
}

export function listBackups(dir = backupDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^app-\d{8}-\d{6}\.db$/.test(f)).sort().reverse()
    .map((f) => ({ file: f, size: fs.statSync(path.join(dir, f)).size }));
}

// 起動時に 1 回、以後 24 時間ごと
export function scheduleDailyBackup(db, log = console.log) {
  const run = () => runBackup(db).then((r) => log(`[backup] ${r.file} (${r.size} bytes, ${r.kept} 世代保持)`)).catch((e) => console.error('[backup] 失敗:', e.message));
  setTimeout(run, 10 * 1000).unref();
  setInterval(run, 24 * 3600 * 1000).unref();
}
