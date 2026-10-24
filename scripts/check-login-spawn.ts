/**
 * 验证 login.ts 里 startRepair 用的「文件句柄 spawn」在这台机器上真的能跑：
 * 不碰 QQ / NapCat，只用一个打印一句话的 PowerShell 子进程，确认
 *  - spawn 成功（不是 EPERM）
 *  - stdout/stderr 真的落进了日志文件
 *  - exit 事件能触发（面板据此判定 running 状态）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const logPath = path.join(os.tmpdir(), `spawn-check-${process.pid}.log`);
const fd = fs.openSync(logPath, 'w');
const child = spawn(
  'powershell.exe',
  ['-NoProfile', '-Command', 'Write-Output "hello-from-child"; [Console]::Error.WriteLine("stderr-line"); exit 0'],
  { stdio: ['ignore', fd, fd], windowsHide: true },
);
fs.closeSync(fd);

const code = await new Promise((resolve) => {
  child.on('exit', (c) => resolve(c));
  child.on('error', (e) => resolve('error: ' + e.message));
});

const text = fs.readFileSync(logPath, 'utf8');
console.log('exit:', code);
console.log('log:', JSON.stringify(text.trim().slice(0, 200)));
const pass = code === 0 && text.includes('hello-from-child') && text.includes('stderr-line');
fs.unlinkSync(logPath);
console.log(pass ? '\n✓ 文件句柄 spawn + 输出重定向 + exit 事件 全部正常' : '\n✗ 失败');
process.exit(pass ? 0 : 1);
