import { build as bundle } from 'esbuild';
import { build as vite } from 'vite';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await Promise.all([
  bundle({ entryPoints: ['src/main/index.ts'], outfile: 'dist/main.cjs', bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], sourcemap: true }),
  bundle({ entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.cjs', bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], sourcemap: true }),
  vite()
]);
await copyFile('public/icon.png', 'dist/icon.png');
const notices = ['# Third-party notices', 'Electron includes its own LICENSE and LICENSES.chromium.html in the packaged application.'];
for (const [name, license] of [['react', 'LICENSE'], ['react-dom', 'LICENSE'], ['scheduler', 'LICENSE'], ['electron-squirrel-startup', 'LICENSE'], ['debug', 'LICENSE'], ['ms', 'license.md']]) {
  try { notices.push(`## ${name}\n\n${await readFile(`node_modules/${name}/${license}`, 'utf8')}`); } catch { /* Some helpers are not present in every dependency graph. */ }
}
await writeFile('dist/THIRD_PARTY_NOTICES.md', notices.join('\n\n'));
