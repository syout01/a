import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from './lib/db.js';
import { attachUser, requireAuth, csrfGuard, securityHeaders, purgeExpired } from './lib/auth.js';
import { scheduleDailyBackup } from './lib/backup.js';
import authRoutes from './routes/auth.js';
import settingsRoutes from './routes/settings.js';
import exhibitionRoutes from './routes/exhibitions.js';
import leadRoutes from './routes/leads.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ログイン前でも配ってよいファイル（データを含まないもの）
const PUBLIC_FILES = new Set(['/login.html', '/login.js', '/styles.css', '/favicon.ico', '/lp.html']);

export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  // Render などのリバースプロキシ配下で正しい IP / https を得る
  if (process.env.TRUST_PROXY !== '0') app.set('trust proxy', 1);
  app.use(securityHeaders);
  app.use(express.json({ limit: '20mb' }));
  app.use(attachUser(db));

  // API
  app.use('/api', csrfGuard);
  app.use('/api/auth', authRoutes(db));
  app.use('/api', requireAuth);
  app.use('/api', settingsRoutes(db));
  app.use('/api/exhibitions', exhibitionRoutes(db));
  app.use('/api/leads', leadRoutes(db));
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  // 画面：未ログインならログイン画面へ
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const p = req.path === '/' ? '/index.html' : req.path;
    if (PUBLIC_FILES.has(p)) return next();
    if (!req.user) {
      if (p === '/index.html') return res.redirect('/login.html');
      return res.status(401).type('text/plain').send('ログインが必要です');
    }
    next();
  });
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', etag: false, lastModified: false }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'ファイルが大きすぎます（20MB まで）' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'リクエストの形式が不正です' });
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'server error' });
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb();
  purgeExpired(db);
  setInterval(() => purgeExpired(db), 6 * 3600 * 1000).unref();
  if (process.env.BACKUP_DISABLED !== '1') scheduleDailyBackup(db);
  const app = createApp(db);
  const port = +process.env.PORT || 3000;
  const host = process.env.HOST || '0.0.0.0';
  app.listen(port, host, () => {
    console.log(`expo-lead-followup: http://localhost:${port}`);
    if (!fs.existsSync(path.join(PUBLIC_DIR, 'login.html'))) console.warn('login.html が見つかりません');
  });
}
