import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outdir = resolve(root, 'dist/server');
const outfile = resolve(outdir, 'tool-handlers.mjs');

await mkdir(outdir, { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(root, 'server/tool-handlers.ts')],
  outdir,
  naming: 'tool-handlers.mjs',
  target: 'node',
  packages: 'bundle',
  minify: true,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error('BGM backend bundle failed');
}

// Bun preserves the absolute location of CommonJS packages when it synthesizes
// __dirname/__filename. TypeScript only needs a stable module identity for the
// parser APIs used by this extension, so remove the build-machine prefix from
// those generated literals before the bundle enters the release pipeline.
const require = createRequire(import.meta.url);
const typescriptFile = require.resolve('typescript');
const typescriptDir = dirname(typescriptFile);
const encodedFile = JSON.stringify(typescriptFile).slice(1, -1);
const encodedDir = JSON.stringify(typescriptDir).slice(1, -1);
let bundle = await readFile(outfile, 'utf8');
const original = bundle;
bundle = bundle
  .replaceAll(encodedFile, 'node_modules/typescript/lib/typescript.js')
  .replaceAll(encodedDir, 'node_modules/typescript/lib');

if (bundle === original) {
  throw new Error('BGM backend bundle did not contain the expected TypeScript module paths');
}

const localAbsolutePath = /(?:^|[\s"'`=:])(?:\/(?:Users|home|root|Volumes)(?:\/|$)|[A-Z]:[\\/](?:Users|Documents and Settings)[\\/])[^\s"'`),;]*/u;
if (localAbsolutePath.test(bundle)) {
  throw new Error('BGM backend bundle contains a build-machine absolute path');
}

await writeFile(outfile, bundle);
console.log(`Bundled BGM backend: ${outfile}`);
