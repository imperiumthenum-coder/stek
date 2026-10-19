import { fileURLToPath } from 'url';
import { startServer } from './server';

// Dev / self-hosted entry: API on :4000 for the Vite dev server to proxy to.
// Listens on all interfaces so other devices (e.g. a phone over Tailscale) can reach it.
const dataDir = process.env.STEK_DATA_DIR || fileURLToPath(new URL('../../data', import.meta.url));

const { port } = await startServer({
  dataDir,
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || '0.0.0.0',
  archiveDir: process.env.ARCHIVE_DIR,
  archiveHour: process.env.ARCHIVE_HOUR ? Number(process.env.ARCHIVE_HOUR) : undefined,
});
console.log(`Stek backend running on http://0.0.0.0:${port} (data: ${dataDir})`);
