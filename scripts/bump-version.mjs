#!/usr/bin/env node
/**
 * Sets the same SemVer version in every place the release workflow verifies:
 * root, apps/likapcs-admin, apps/likapcs-server package.json and src-tauri/Cargo.toml
 * (src-tauri/tauri.conf.json reads its version from ../package.json).
 *
 *   pnpm release:bump 0.2.0
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: pnpm release:bump <x.y.z>');
  process.exit(1);
}
const root = resolve(new URL('..', import.meta.url).pathname);
const touched = [];

for (const rel of [
  'package.json',
  'apps/likapcs-admin/package.json',
  'apps/likapcs-server/package.json',
]) {
  const file = resolve(root, rel);
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.version = version;
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  touched.push(rel);
}

const cargo = resolve(root, 'apps/likapcs-admin/src-tauri/Cargo.toml');
const toml = readFileSync(cargo, 'utf8').replace(/^version = ".*"$/m, `version = "${version}"`);
writeFileSync(cargo, toml);
touched.push('apps/likapcs-admin/src-tauri/Cargo.toml');

console.log(`version ${version} written to:\n  ${touched.join('\n  ')}`);
console.log(
  'Next: add a "## [' +
    version +
    '] - YYYY-MM-DD" section to CHANGELOG.md, commit, tag v' +
    version +
    ', push --tags.',
);
