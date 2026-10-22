import { spawn } from 'node:child_process';
import { readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
const root = process.cwd();
const resultFile = path.join(root, 'work', 'windows-smoke.json');
await mkdir(path.dirname(resultFile), { recursive: true });
await rm(resultFile, { force: true });
const child = spawn(path.join(root, 'dist/windows/win-unpacked/PaperSearch.exe'), ['--smoke-test'], {
  env: { ...process.env, PAPER_SMOKE_RESULT: resultFile }, stdio: 'inherit', windowsHide: false,
});
const timer = setTimeout(() => { child.kill(); }, 45000);
try {
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error('Windows 桌面程序验证失败，退出码 ' + code);
  const result = JSON.parse(await readFile(resultFile, 'utf8'));
  if (result.event !== 'smoke.passed' || result.platform !== 'win32' || result.arch !== 'x64' || !result.packaged) throw new Error('安装包验证结果无效');
  console.log(JSON.stringify(result));
} finally { clearTimeout(timer); }
