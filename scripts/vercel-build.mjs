// Builds the Vercel demo in Vercel's Build Output API layout (.vercel/output):
// the web app as static files, and the server as one function that answers /api/*.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.vercel', 'output');
const fn = path.join(out, 'functions', 'api.func');
const write = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

execSync('npm run build', { cwd: root, stdio: 'inherit' });

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(fn, { recursive: true });
fs.cpSync(path.join(root, 'web', 'dist'), path.join(out, 'static'), { recursive: true });

await build({
  entryPoints: [path.join(root, 'server', 'src', 'vercel.ts')],
  outfile: path.join(fn, 'index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // PGlite loads its .wasm and extension files from its own folder, so it is copied in whole below.
  external: ['@electric-sql/pglite'],
  // Bundled CommonJS packages call require(), which an ES module does not have on its own.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
});

// Files the server reads next to its own code (import.meta.url is now index.mjs).
fs.cpSync(path.join(root, 'server', 'src', 'db', 'migrations'), path.join(fn, 'migrations'), { recursive: true });
fs.cpSync(path.join(root, 'server', 'src', 'ai', 'prompts'), path.join(fn, 'prompts'), { recursive: true });
fs.cpSync(path.join(root, 'node_modules', '@electric-sql', 'pglite'), path.join(fn, 'node_modules', '@electric-sql', 'pglite'), { recursive: true });

write(path.join(fn, '.vc-config.json'), {
  runtime: 'nodejs24.x',
  handler: 'index.mjs',
  launcherType: 'Nodejs',
  shouldAddHelpers: false,
  supportsResponseStreaming: true,
  maxDuration: 60,
});

write(path.join(out, 'config.json'), {
  version: 3,
  routes: [
    { src: '^/api/(.*)$', dest: '/api' },
    { handle: 'filesystem' },
    // Every other path is a screen of the single-page app.
    { src: '/(.*)', dest: '/index.html' },
  ],
});

console.log(`Vercel output written to ${path.relative(root, out)}`);
