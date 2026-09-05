import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from './lib/db.js';
import { attachUser, requireAuth, csrfGuard, securityHeaders, purgeExpired } from './lib/auth.js';
import { scheduleDailyBackup } from './lib/backup.js';
import authRoutes from './routes/auth.js';
import publicRoutes from './routes/public.js';
import settingsRoutes from './routes/settings.js';
import exhibitionRoutes from './routes/exhibitions.js';
import leadRoutes from './routes/leads.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ログイン前でも配ってよいファイル（データを含まないもの）
const PUBLIC_FILES = new Set(['/login.html', '/login.js', '/styles.css', '/favicon.ico', '/lp.html', '/lp.js', '/lp-thanks.html', '/robots.txt', '/sitemap.xml', '/og.png']);
const LP_PAGES = new Set(['/lp.html', '/lp-thanks.html']);

// LP だけは広告計測タグ（GTM / Google 広告 / GA4 / Meta）を許可する
const LP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.google-analytics.com https://googleads.g.doubleclick.net https://www.google.com https://connect.facebook.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: https:",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' https://www.google-analytics.com https://*.google-analytics.com https://www.googletagmanager.com https://*.analytics.google.com https://stats.g.doubleclick.net https://www.google.com https://www.facebook.com",
  "frame-src https://www.googletagmanager.com https://td.doubleclick.net https://www.google.com",
  "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'",
].join('; ');

function gtmSnippets(id) {
  if (!id) return { head: '', body: '' };
  const safe = String(id).replace(/[^A-Z0-9-]/gi, '');
  return {
    head: `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${safe}');</script>\n`,
    body: `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${safe}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>\n`,
  };
}
const lpCache = new Map();
function renderLp(file) {
  const key = `${file}:${process.env.GTM_ID || ''}`;
  if (lpCache.has(key) && process.env.NODE_ENV === 'production') return lpCache.get(key);
  let html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  const { head, body } = gtmSnippets(process.env.GTM_ID);
  html = html.replace('</head>', `${head}</head>`).replace(/<body([^>]*)>/, `<body$1>\n${body}`);
  lpCache.set(key, html);
  return html;
}

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
  app.use('/api/public', publicRoutes(db));
  app.use('/api', requireAuth);
  app.use('/api', settingsRoutes(db));
  app.use('/api/exhibitions', exhibitionRoutes(db));
  app.use('/api/leads', leadRoutes(db));
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  // LP（公開ページ）は計測タグを差し込んで配る
  app.get([...LP_PAGES], (req, res) => {
    res.setHeader('Content-Security-Policy', LP_CSP);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('html').send(renderLp(req.path.slice(1)));
  });

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
