// Bundles the Electron main process and the backend into one file.
// better-sqlite3 stays external: it's a native module that electron-builder
// rebuilds for each platform's Electron.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron', 'better-sqlite3'],
  sourcemap: true,
  logLevel: 'info',
});
