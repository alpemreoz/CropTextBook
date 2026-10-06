import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The web app's edit log: the app POSTs what users correct (see
 * services/editLog.ts) and the local server appends it to
 * logs/edits-YYYY-MM-DD.jsonl in the project folder, one JSON entry per
 * line. Works with `npm run dev` and `npm run preview`.
 */
const editLog = (): Plugin => {
  const MAX_BODY = 5 * 1024 * 1024;
  const handler = (req: any, res: any, next: () => void) => {
    if (req.url !== '/__qcrop/log' || req.method !== 'POST') return next();
    let body = '';
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      if (body.length > MAX_BODY) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return;
      let entries: unknown;
      try { entries = JSON.parse(body); } catch { entries = null; }
      if (!Array.isArray(entries)) { res.statusCode = 400; res.end(); return; }
      const dir = path.resolve(__dirname, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      const lines = entries.filter(e => e && typeof e === 'object').map(e => JSON.stringify(e));
      if (lines.length) fs.appendFileSync(path.join(dir, `edits-${day}.jsonl`), lines.join('\n') + '\n');
      res.statusCode = 204;
      res.end();
    });
  };
  return {
    name: 'qcrop-edit-log',
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
};

// The code version each log entry was made with (to compare detection
// before and after a change).
const commit = (() => {
  try { return execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return 'unknown'; }
})();

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: Number(process.env.PORT) || 3000,
        host: '0.0.0.0',
      },
      plugins: [react(), editLog()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        __QCROP_COMMIT__: JSON.stringify(commit),
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
