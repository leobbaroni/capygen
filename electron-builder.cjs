/** Local-only invocation always supplies --publish never. Repository identity is explicit. */
const path = require('node:path');
module.exports = {
  appId: 'com.capygen.desktop', productName: 'capygen',
  directories: { app: path.join(__dirname, 'release/stage'), output: path.join(__dirname, 'release/artifacts') },
  electronVersion: require('./apps/desktop/node_modules/electron/package.json').version,
  // Physical runtime paths keep SDK executables, PTY helpers and utility children concrete.
  asar: false,
  files: ['desktop/dist/**', 'renderer/dist/**', 'legal/**', 'package.json', 'runtime-manifest.json', 'node_modules/**', '!**/*.map'],
  npmRebuild: false, nodeGypRebuild: false, forceCodeSigning: false,
  publish: [{ provider: 'github', owner: 'leobbaroni', repo: 'capygen', private: true, releaseType: 'draft', updaterCacheDirName: 'capygen-updater' }],
  win: { target: [{ target: 'nsis', arch: ['x64'] }, { target: 'portable', arch: ['x64'] }], icon: path.join(__dirname, 'assets/icons/icon.ico'), signAndEditExecutable: true, signExecutable: false, verifyUpdateCodeSignature: false },
  nsis: { artifactName: 'capygen-${version}-setup.exe', oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, runAfterFinish: false, deleteAppDataOnUninstall: false },
  portable: { artifactName: 'capygen-${version}-portable.exe', requestExecutionLevel: 'user' },
};
