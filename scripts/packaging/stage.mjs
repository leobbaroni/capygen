import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const stage = path.join(root, 'release/stage');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Packaging requires native Windows x64.');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const rootPackage = readJson(path.join(root, 'package.json'));
const desktopPackage = readJson(path.join(root, 'apps/desktop/package.json'));
if (rootPackage.version !== desktopPackage.version) throw new Error('Root and desktop versions differ.');
fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true });
function copyTree(source, destination, include) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name); const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected package-internal link: ${entry.name}`);
    if (!include(from, entry)) continue;
    if (entry.isDirectory()) copyTree(from, to, include); else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}
const deny = /(?:^|[\\/])(?:test|tests|__tests__|fixtures|\.git|\.github|\.claude|\.codex|reference|coverage|node_modules)(?:[\\/]|$)|\.(?:map|pdb|ts|tsx|cs|log)$/i;
copyTree(path.join(root, 'apps/desktop/dist'), path.join(stage, 'desktop/dist'), (file) => !deny.test(path.relative(path.join(root, 'apps/desktop/dist'), file)));
copyTree(path.join(root, 'apps/renderer/dist'), path.join(stage, 'renderer/dist'), (file) => !deny.test(path.relative(path.join(root, 'apps/renderer/dist'), file)));
fs.mkdirSync(path.join(stage, 'legal'));
fs.copyFileSync(path.join(root, 'docs/font-provenance.md'), path.join(stage, 'legal/FONT-NOTICE.md'));
for (const name of ['LICENSE', 'NOTICE']) fs.copyFileSync(path.join(root, 'reference/omnigent', name), path.join(stage, 'legal', `OMNIGENT-${name}`));
const installed = new Map(); const copied = []; const notices = []; const rootModules = path.join(stage, 'node_modules');
function resolvePackage(name, from) {
  let at = from;
  while (true) { const candidate = path.join(at, 'node_modules', name, 'package.json'); if (fs.existsSync(candidate)) return path.dirname(fs.realpathSync(candidate)); const parent = path.dirname(at); if (parent === at) throw new Error(`Missing production dependency ${name}`); at = parent; }
}
function add(name, from, parentDestination = stage, ancestry = new Map()) {
  const source = resolvePackage(name, from); const pkg = readJson(path.join(source, 'package.json'));
  if (pkg.os && !pkg.os.includes('win32') || pkg.cpu && !pkg.cpu.includes('x64')) return;
  if (ancestry.get(name) === source) return;
  let destination = path.join(rootModules, name);
  if (installed.has(destination) && installed.get(destination) !== source) destination = path.join(parentDestination, 'node_modules', name);
  if (installed.get(destination) === source) return;
  installed.set(destination, source);
  copyTree(source, destination, (file, entry) => {
    const relative = path.relative(source, file).replaceAll('\\', '/');
    if (deny.test(relative) || /(?:^|\/)(?:src|scripts|typings|docs|example|examples)(?:\/|$)/.test(relative)) return false;
    if (name === 'node-pty' && relative.startsWith('prebuilds/') && !relative.startsWith('prebuilds/win32-x64') && relative !== 'prebuilds') return false;
    return entry.isDirectory() || /\.(?:js|cjs|mjs|json|node|exe|dll|wasm|dat|bin|pem|crt|zst|md|txt)$/i.test(entry.name) || /^(?:LICENSE|LICENCE|NOTICE|COPYING)(?:\..*)?$/i.test(entry.name);
  });
  for (const filename of fs.readdirSync(source)) {
    if (/^(?:LICENSE|LICENCE|NOTICE|COPYING)(?:\..*)?$/i.test(filename) || name === '@anthropic-ai/claude-agent-sdk' && filename === 'README.md') {
      const file = path.join(source, filename); if (fs.statSync(file).isFile() && fs.statSync(file).size <= 1024 * 1024) notices.push(`\n===== ${name}@${pkg.version}: ${filename} =====\n${fs.readFileSync(file, 'utf8')}`);
    }
  }
  copied.push({ name, version: pkg.version, path: path.relative(stage, destination).replaceAll('\\', '/') });
  const chain = new Map(ancestry).set(name, source);
  for (const dependency of Object.keys(pkg.dependencies ?? {})) add(dependency, source, destination, chain);
  for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) {
    if (dependency.startsWith('@anthropic-ai/claude-agent-sdk-') && !dependency.endsWith('win32-x64')) continue;
    try { add(dependency, source, destination, chain); } catch (error) { if (!String(error).includes('Missing production dependency')) throw error; }
  }
  for (const dependency of Object.keys(pkg.peerDependencies ?? {})) {
    if (pkg.peerDependenciesMeta?.[dependency]?.optional) continue;
    add(dependency, source, destination, chain);
  }
}
const dependencies = {};
for (const name of ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk', 'node-pty', 'electron-updater']) {
  add(name, path.join(root, 'apps/desktop'));
  dependencies[name] = readJson(path.join(resolvePackage(name, path.join(root, 'apps/desktop')), 'package.json')).version;
}
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'capygen', packageManager: 'traversal@0', version: rootPackage.version, private: true, description: 'Local AI workspace', author: 'capygen contributors', main: 'desktop/dist/main.cjs', dependencies }, null, 2));
const required = ['desktop/dist/main.cjs', 'desktop/dist/preload.cjs', 'desktop/dist/extension-preload.cjs', 'desktop/dist/importWorker.cjs', 'desktop/dist/shareWorker.cjs', 'desktop/dist/speech/capygen-speech.exe', 'renderer/dist/index.html', 'node_modules/node-pty/prebuilds/win32-x64/conpty.node', 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe', 'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'];
for (const file of required) if (!fs.existsSync(path.join(stage, file))) throw new Error(`Required runtime missing: ${file}`);
const hash = (file) => createHash('sha256').update(fs.readFileSync(path.join(stage, file))).digest('hex');
const font = 'renderer/dist/fonts/CheGuevaraBarry-Brown.ttf';
if (hash(font) !== 'f121fa2c8d8d9005d212f3738b1a8464bf5c26b2edd7bddee4a3fbf8d0a21141') throw new Error('Font identity changed.');
fs.writeFileSync(path.join(stage, 'legal/DEPENDENCY-NOTICES.txt'), notices.join('\n'));
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true, encoding: 'utf8' }).trim();
const sourceDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, windowsHide: true, encoding: 'utf8' }).trim().length > 0;
fs.writeFileSync(path.join(stage, 'runtime-manifest.json'), JSON.stringify({ sourceCommit, sourceDirty, version: rootPackage.version, packages: copied, hashes: Object.fromEntries([...required, font].map((file) => [file, hash(file)])) }, null, 2));
console.log(`Staged runtime allowlist: ${copied.length} production packages; version ${rootPackage.version}.`);
