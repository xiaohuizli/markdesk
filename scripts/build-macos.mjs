import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rgPath } from '@vscode/ripgrep';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') throw new Error('此构建脚本需要 macOS 和 Xcode Command Line Tools');
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const version = '24.19.0';
const appVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const work = path.join(root, 'work', 'desktop-build'); mkdirSync(work, { recursive: true });
const run = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { const failure = new Error(`${path.basename(cmd)} failed: ${String(error.stderr || error.message).slice(0, 5000)}`); failure.stderr = error.stderr; throw failure; }
};
let node = process.env.PAPER_NODE_BINARY;
if (!node) {
  const runtime = path.join(work, 'node-runtime');
  node = path.join(runtime, 'bin/node');
  if (!existsSync(node)) {
    const filename = `node-v${version}-darwin-${arch}.tar.gz`, archive = path.join(work, filename);
    const base = `https://nodejs.org/dist/v${version}/`;
    console.log('下载官方 Node.js 运行时…');
    run('/usr/bin/curl', ['--fail', '--location', '--silent', '--show-error', base + filename, '-o', archive]);
    const sums = run('/usr/bin/curl', ['--fail', '--location', '--silent', '--show-error', base + 'SHASUMS256.txt']);
    const expected = sums.split('\n').find((line) => line.trim().endsWith(' ' + filename))?.split(/\s+/)[0];
    const observed = createHash('sha256').update(readFileSync(archive)).digest('hex');
    if (!expected || expected !== observed) throw new Error('官方 Node.js 运行时校验失败');
    mkdirSync(runtime, { recursive: true }); run('/usr/bin/tar', ['-xzf', archive, '-C', runtime, '--strip-components=1']);
  }
}
node = path.resolve(node);
if (run(node, ['--version']).trim() !== 'v' + version) throw new Error(`桌面包要求独立 Node.js ${version} 运行时`);
const dependencies = run('/usr/bin/otool', ['-L', node]).split('\n').slice(1).map((line) => line.trim().split(' ')[0]).filter(Boolean);
if (dependencies.some((name) => !name.startsWith('/usr/lib/') && !name.startsWith('/System/Library/'))) throw new Error('Node.js 依赖外部动态库；请使用官方独立发行版');
const wanted = arch === 'arm64' ? 'arm64' : 'x86_64';
if (!run('/usr/bin/lipo', ['-archs', node]).split(/\s+/).includes(wanted)) throw new Error('Node.js 运行时架构不匹配');
// Sign outside file-provider managed folders, which can add Finder metadata mid-build.
const scratch = mkdtempSync(path.join(tmpdir(), 'paper-macos-build-'));
const app = path.join(scratch, 'Paper Search.app');
const contents = path.join(app, 'Contents'), resources = path.join(contents, 'Resources'), payload = path.join(resources, 'app');
mkdirSync(path.join(contents, 'MacOS'), { recursive: true }); mkdirSync(path.join(resources, 'runtime'), { recursive: true }); mkdirSync(payload, { recursive: true });
for (const folder of ['src', 'public', 'demo']) cpSync(path.join(root, folder), path.join(payload, folder), { recursive: true });
cpSync(path.join(root, 'package.json'), path.join(payload, 'package.json'));
for (const name of ['ripgrep', `ripgrep-darwin-${arch === 'arm64' ? 'arm64' : 'x64'}`]) {
  const dest = path.join(payload, 'node_modules', '@vscode', name); mkdirSync(path.dirname(dest), { recursive: true }); cpSync(path.join(root, 'node_modules', '@vscode', name), dest, { recursive: true });
}
const bundledNode = path.join(resources, 'runtime/node'); cpSync(node, bundledNode); chmodSync(bundledNode, 0o755);
cpSync(path.join(root, 'vendor/licenses'), path.join(resources, 'Licenses'), { recursive: true });
console.log('编译原生 macOS 宿主…');
run('/usr/bin/xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', `${wanted}-apple-macosx13.0`, '-framework', 'AppKit', '-framework', 'WebKit', path.join(root, 'desktop/Main.swift'), '-o', path.join(contents, 'MacOS/PaperSearch')]);
const icon = path.join(root, 'desktop/assets/icon.png'), iconset = path.join(work, 'AppIcon.iconset'); mkdirSync(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) run('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), icon, '--out', path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'AppIcon.icns')]);
const plist = { CFBundleExecutable: 'PaperSearch', CFBundleIdentifier: 'io.papersearch.desktop', CFBundleName: 'Paper Search', CFBundleDisplayName: 'Paper Search', CFBundlePackageType: 'APPL', CFBundleShortVersionString: appVersion, CFBundleVersion: '6', CFBundleIconFile: 'AppIcon', NSPrincipalClass: 'NSApplication', LSMinimumSystemVersion: '13.0', NSHighResolutionCapable: true, NSRequiresAquaSystemAppearance: true, NSAppTransportSecurity: { NSAllowsLocalNetworking: true }, CFBundleDevelopmentRegion: 'zh-Hans', CFBundleLocalizations: ['zh-Hans', 'en'] };
plist.CFBundleDocumentTypes = [{ CFBundleTypeName: 'Markdown / Text', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['net.daringfireball.markdown', 'public.plain-text'], CFBundleTypeExtensions: ['md','markdown','mdx','mdown','mkd','txt','text','rmd','qmd'] }];
plist.UTImportedTypeDeclarations = [{ UTTypeIdentifier: 'net.daringfireball.markdown', UTTypeDescription: 'Markdown document', UTTypeConformsTo: ['public.plain-text'], UTTypeTagSpecification: { 'public.filename-extension': ['md','markdown','mdx','mdown','mkd','rmd','qmd'], 'public.mime-type': 'text/markdown' } }];
const plistJSON = path.join(work, 'Info.json'); writeFileSync(plistJSON, JSON.stringify(plist)); run('/usr/bin/plutil', ['-convert', 'xml1', '-o', path.join(contents, 'Info.plist'), plistJSON]);
// Remove Finder decoration from this newly generated bundle before signing.
for (const attribute of ['com.apple.FinderInfo', 'com.apple.ResourceFork']) {
  try { run('/usr/bin/xattr', ['-d', '-r', attribute, app]); }
  catch (error) { if (!String(error.stderr).includes('No such xattr')) throw error; }
}
for (const binary of [bundledNode, path.join(payload, 'node_modules', '@vscode', `ripgrep-darwin-${arch}`, 'bin/rg')]) run('/usr/bin/codesign', ['--force', '--sign', '-', binary]);
run('/usr/bin/codesign', ['--force', '--sign', '-', app]); run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const bundledRg = path.join(payload, 'node_modules', '@vscode', `ripgrep-darwin-${arch}`, 'bin/rg');
const manifest = { product: 'Paper Search', version: appVersion, arch, minimumMacOS: '13.0', host: 'AppKit + WKWebView', bundledNode: { version, sha256: hash(bundledNode), dependencies }, bundledRg: { version: run(bundledRg, ['--version']).split('\n')[0], sha256: hash(bundledRg) }, hostSha256: hash(path.join(contents, 'MacOS/PaperSearch')), signing: 'local ad-hoc; not Developer ID notarized' };
mkdirSync(path.join(root, 'dist'), { recursive: true });
// Distribute immutable archives so sync-provider metadata cannot alter the app bundle.
rmSync(path.join(root, 'dist', 'Paper Search.app'), { recursive: true, force: true });
const destination = path.join(root, 'dist', `Paper Search-mac-${arch}.dmg`);
const applicationZIP = path.join(root, 'dist', `Paper Search-mac-${arch}.app.zip`);
symlinkSync('/Applications', path.join(scratch, 'Applications'));
run('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', '--noextattr', app, applicationZIP]);
console.log('生成 DMG 安装包…');
run('/usr/bin/hdiutil', ['create', '-ov', '-format', 'UDZO', '-volname', 'Paper Search', '-srcfolder', scratch, destination]);
manifest.artifacts = { dmg: path.basename(destination), appZIP: path.basename(applicationZIP), dmgSha256: hash(destination), appZIPsha256: hash(applicationZIP) };
writeFileSync(path.join(root, 'dist/build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
rmSync(scratch, { recursive: true, force: true });
console.log(destination);
