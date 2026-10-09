#!/usr/bin/env node
/**
 * Writes a Tauri updater manifest for one installer that sits next to its minisign signature.
 *
 *   node scripts/update-manifest.mjs <version> <installer.exe> <owner/repo> <notes.md> <out.json>
 *
 * The signature file "<installer.exe>.sig" is produced by `tauri build` (createUpdaterArtifacts)
 * with the TAURI_SIGNING_PRIVATE_KEY; the updater verifies it against the public key compiled
 * into the application before anything is installed.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [version, exe, repo, notesFile, outFile] = process.argv.slice(2);
if (!version || !exe || !repo || !notesFile || !outFile) {
  console.error(
    'usage: update-manifest.mjs <version> <installer.exe> <owner/repo> <notes.md> <out.json>',
  );
  process.exit(1);
}
const signature = readFileSync(`${exe}.sig`, 'utf8').trim();
if (!signature.includes('minisign') && !/^[A-Za-z0-9+/=]+$/.test(signature)) {
  console.error(`unexpected signature content in ${exe}.sig`);
  process.exit(1);
}
const notes = readFileSync(notesFile, 'utf8').trim();
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(exe)}`,
    },
  },
};
writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n');
console.log(`${outFile}: ${manifest.platforms['windows-x86_64'].url}`);
