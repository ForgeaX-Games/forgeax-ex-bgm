import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(root, 'forgeax-extension.json'), 'utf8'));
const expectedRepository = 'git+https://github.com/ForgeaX-Games/forgeax-ex-bgm.git';
const forbiddenDependencySpec = /^(?:file:|link:|workspace:|git(?:\+|:))/u;

if (packageJson.name !== '@forgeax-extension/bgm' || manifest.id !== packageJson.name) {
  throw new Error('package and extension manifest must use @forgeax-extension/bgm');
}
if (packageJson.version !== manifest.version) {
  throw new Error('package and extension manifest versions must match');
}
if (packageJson.private !== false) {
  throw new Error('release package must not be private');
}
if (packageJson.repository?.url !== expectedRepository) {
  throw new Error(`release package repository must be ${expectedRepository}`);
}
if (packageJson.publishConfig?.access !== 'public' || packageJson.publishConfig?.provenance !== undefined) {
  throw new Error('release package must publish publicly without npm provenance');
}

for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  for (const [name, spec] of Object.entries(packageJson[field] ?? {})) {
    if (typeof spec !== 'string' || forbiddenDependencySpec.test(spec)) {
      throw new Error(`${field}.${name} must use a registry version, received ${JSON.stringify(spec)}`);
    }
  }
}

for (const relativePath of [
  manifest.entry.frontend,
  manifest.entry.backend,
  ...manifest.contributes.tools.map((tool) => tool.args),
  ...manifest.contributes.skills.map((skill) => skill.entry),
]) {
  if (!existsSync(resolve(root, relativePath))) {
    throw new Error(`manifest-owned release file is missing: ${relativePath}`);
  }
}

const backendUrl = new URL(manifest.entry.backend, `file://${root}/`);
const backendSource = readFileSync(backendUrl, 'utf8');
const localAbsolutePath = /(?:^|[\s"'`=:])(?:\/(?:Users|home|root|Volumes)(?:\/|$)|[A-Z]:[\\/](?:Users|Documents and Settings)[\\/])[^\s"'`),;]*/u;
if (localAbsolutePath.test(backendSource)) {
  throw new Error('manifest backend contains a build-machine absolute path');
}
const backend = await import(`${backendUrl.href}?release-contract=${Date.now()}`);
if (!backend.default || typeof backend.default !== 'object') {
  throw new Error('manifest backend must default-export the tool handler map');
}
for (const toolId of ['get-audio-project', 'list-starter-audio']) {
  if (typeof backend.default[toolId] !== 'function') {
    throw new Error(`published backend is missing tool handler: ${toolId}`);
  }
}

console.log(`${packageJson.name}@${packageJson.version} release contract is complete`);
