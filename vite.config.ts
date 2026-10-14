import path from 'path';
import { execSync } from 'child_process';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { logHandler } from './server/logStore.mjs';

/**
 * The web app's edit log: the app POSTs what users correct (see
 * services/editLog.ts) and the local server appends it to
 * logs/edits-YYYY-MM-DD.jsonl in the project folder, one JSON entry per
 * line. Works with `npm run dev` and `npm run preview` / `npm start`; served
 * by nginx, server/log-server.mjs does the same (see deploy/).
 */
const editLog = (): Plugin => {
  const handler = logHandler({ dir: path.resolve(__dirname, 'logs') });
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
