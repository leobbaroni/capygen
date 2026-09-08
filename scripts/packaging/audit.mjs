import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const updaterRequire = createRequire(path.join(root, 'apps/desktop/node_modules/electron-updater/package.json'));
const yaml = updaterRequire('js-yaml');
const artifacts = path.join(root, 'release/artifacts');
const resources = path.join(artifacts, 'win-unpacked/resources');
const app = path.join(resources, 'app');
const stage = path.join(root, 'release/stage');
const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'runtime-manifest.json'), 'utf8'));
const sha = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const files = fs.readdirSync(app, { recursive: true }).map((file) => String(file).replaceAll('\\', '/')); 
for (const name of files) {
  if (/(?:^|\/)(?:\.env(?:\..*)?|\.claude|\.codex|test|tests|fixtures|reference|coverage)(?:\/|$)|\.(?:map|pdb|log)$/.test(name)) throw new Error(`Forbidden archive path: ${name}`);
}
for (const [name, expected] of Object.entries(manifest.hashes)) {
  const bytes = fs.readFileSync(path.join(app, name));
  if (sha(bytes) !== expected) throw new Error(`Packaged identity mismatch: ${name}`);
}
for (const file of ['legal/FONT-NOTICE.md', 'legal/OMNIGENT-LICENSE', 'legal/OMNIGENT-NOTICE', 'legal/DEPENDENCY-NOTICES.txt']) fs.readFileSync(path.join(app, file));
const updateConfig = yaml.load(fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8'));
if (updateConfig.owner !== 'leobbaroni' || updateConfig.repo !== 'capygen' || updateConfig.updaterCacheDirName !== 'capygen-updater' || updateConfig.publisherName || updateConfig.token) throw new Error('Unexpected packaged update configuration.');
const feedPath = path.join(artifacts, 'latest.yml');
const feed = yaml.load(fs.readFileSync(feedPath, 'utf8'));
if (feed.version !== manifest.version) throw new Error('Metadata and runtime versions differ.');
const entries = ['setup', 'portable'].map((target) => {
  const url = `capygen-${manifest.version}-${target}.exe`; const bytes = fs.readFileSync(path.join(artifacts, url));
  return { url, sha512: sha(bytes, 'sha512', 'base64'), size: bytes.length };
});
// Keep the NSIS installer first for NsisUpdater; portable consumers explicitly select the second file.
feed.files = entries; feed.path = entries[0].url; feed.sha512 = entries[0].sha512;
fs.writeFileSync(feedPath, yaml.dump(feed, { lineWidth: -1 }));
const report = { sourceCommit: manifest.sourceCommit, sourceDirty: manifest.sourceDirty, version: manifest.version, unsigned: true, publisherIdentityVerified: false, runtimeEntries: files.length,
  artifacts: entries.map((entry) => ({ ...entry, sha256: sha(fs.readFileSync(path.join(artifacts, entry.url))) })),
  speechSha256: manifest.hashes['desktop/dist/speech/capygen-speech.exe'], checks: ['runtime allowlist', 'required physical executables', 'font identity', 'notices', 'explicit private repository', 'two-artifact feed checksums'] };
fs.writeFileSync(path.join(artifacts, 'artifact-audit.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
