module.exports = {
  appId: 'io.papersearch.desktop',
  productName: 'Paper Search',
  executableName: 'PaperSearch',
  directories: { output: 'dist/windows', buildResources: 'desktop/assets' },
  asar: false,
  npmRebuild: false,
  files: ['desktop/electron/**', 'desktop/assets/**', 'src/**', 'public/**', 'demo/**', 'vendor/licenses/**', 'package.json'],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'desktop/assets/icon.png',
    artifactName: 'Paper-Search-${version}-win-${arch}-setup.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Paper Search',
    uninstallDisplayName: 'Paper Search',
  },
};
