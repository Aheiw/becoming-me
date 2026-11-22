import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
const privateKey = join(data, 'api-key.dpapi');
const configPath = join(root, 'local-runtime', 'config.local.json');
const psEnv = { ...process.env, PSModulePath: join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/Modules') };
const powershell = (command, interactive = false) => execFileSync('powershell.exe', [
  '-NoProfile', ...(interactive ? [] : ['-NonInteractive']), '-Command', command,
], { stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'ignore'], encoding: 'utf8', windowsHide: !interactive, env: psEnv });
const psPath = path => "'" + path.replaceAll("'", "''") + "'";
if (process.argv.includes('--set-key')) {
  powershell(`$ErrorActionPreference='Stop'; $s=Read-Host 'Enter new API key (hidden)' -AsSecureString; if (!$s.Length) { throw 'Empty key' }; ConvertFrom-SecureString $s | Set-Content -LiteralPath ${psPath(privateKey)} -Encoding utf8`, true);
  console.log('API 密钥已保存在本机。重启成我后生效。');
  process.exit(0);
}
if (!existsSync(join(root, 'packages', 'web', 'dist', 'index.html'))) throw Error('Build the web package first.');
if (!process.env.OPENAI_API_KEY) {
  if (!existsSync(privateKey)) throw Error('缺少 API 密钥，请先运行 set-api-key.cmd。');
  try {
    process.env.OPENAI_API_KEY = powershell(`$ErrorActionPreference='Stop'; $s=ConvertTo-SecureString ((Get-Content -LiteralPath ${psPath(privateKey)} -Raw).Trim()); [System.Net.NetworkCredential]::new('', $s).Password`).trim();
    if (!process.env.OPENAI_API_KEY) throw Error('Empty key');
  } catch { throw Error('当前 Windows 账号无法读取此密钥，请运行 set-api-key.cmd 重新设置。'); }
}
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')) : {};
const apiBase = process.env.BECOMING_ME_API_BASE_URL ?? config.apiBaseUrl;
const model = process.env.BECOMING_ME_MODEL ?? config.model;
if (!apiBase || !model) throw Error('请在 local-runtime/config.local.json 填写 API 地址和模型名。');
const url = new URL(apiBase);
if (url.protocol !== 'https:' || url.username || url.password) throw Error('The API base URL must be an HTTPS URL without credentials.');
process.env.OPENAI_BASE_URL = apiBase;
process.env.LLM_PROVIDER = 'openai';
process.env.LLM_MODEL = model;
// The local profile deliberately does not enable cloud auth or demo mode.
delete process.env.CLERK_SECRET_KEY;
if (process.argv.includes('--check-api')) {
  const { probeModel } = await import('./check-api.mjs');
  await probeModel();
  process.exit(0);
}
process.env.NODE_ENV = 'development'; // use source-relative migration files
process.env.PCE_LOCAL = '1';
process.env.PORT = process.env.BECOMING_ME_PORT ?? config.port ?? '4527';
process.env.CORS_ORIGIN = `http://127.0.0.1:${process.env.PORT}`;
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid local port');
try {
  const current = await fetch(`http://127.0.0.1:${port}/api/user`, { signal: AbortSignal.timeout(800) });
  if (current.ok) {
    console.log(`A server is already running on http://127.0.0.1:${port}/`);
    process.exit(0);
  }
  throw Error('The local port is already in use');
} catch (error) {
  if (error?.cause?.code !== 'ECONNREFUSED') throw error;
}
const db = await PGlite.create(join(data, 'pglite'));
const socket = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0 });
try {
  await socket.start();
  process.env.DATABASE_URL = `postgres://pce@${socket.getServerConn()}/postgres?sslmode=disable`;
  await import('../packages/server/src/index.ts');
} catch (error) {
  await socket.stop();
  await db.close();
  throw error;
}
