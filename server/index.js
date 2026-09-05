import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './lib/db.js';
import settingsRoutes from './routes/settings.js';
import exhibitionRoutes from './routes/exhibitions.js';
import leadRoutes from './routes/leads.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50mb' }));

  app.use('/api', settingsRoutes(db));
  app.use('/api/exhibitions', exhibitionRoutes(db));
  app.use('/api/leads', leadRoutes(db));
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'server error' });
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb();
  const app = createApp(db);
  const port = +process.env.PORT || 3000;
  app.listen(port, () => console.log(`expo-lead-followup: http://localhost:${port}`));
}
