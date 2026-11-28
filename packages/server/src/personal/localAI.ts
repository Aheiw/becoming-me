import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'

const settingsPath = () => resolve('data', 'ai-settings.local.json')
const savedAI = z.object({ apiBaseUrl: z.string(), model: z.string(), encryptedKey: z.string().nullable() })

export function normalizeEndpoint(input: string) {
  const url = new URL(input.trim())
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new Error('请输入不带账号、参数或片段的 HTTPS API 地址；本机服务可以使用 HTTP。')
  }
  return url.origin + url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses|models)$/, '')
}

function dpapi(value: string, decrypt: boolean): Promise<string> {
  const input = '$ErrorActionPreference="Stop"; [Console]::InputEncoding=[Text.Encoding]::UTF8; $v=[Console]::In.ReadToEnd(); '
  const script = input + (decrypt
    ? '$s=ConvertTo-SecureString $v; [Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::Write([System.Net.NetworkCredential]::new("", $s).Password)'
    : 'ConvertFrom-SecureString (ConvertTo-SecureString $v -AsPlainText -Force)')
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: { ...process.env, PSModulePath: join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/Modules') },
    })
    let output = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('本机密钥加密超时。')) }, 10_000)
    child.stdout.setEncoding('utf8').on('data', part => { output += part })
    child.on('error', () => { clearTimeout(timer); reject(new Error('无法使用本机 Windows 密钥加密。')) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0 && output.trim()) resolve(output.trim())
      else reject(new Error('当前 Windows 账户无法加密或读取该密钥。'))
    })
    child.stdin.on('error', () => { /* handled by the child exit status */ })
    child.stdin.end(value, 'utf8')
  })
}

export async function loadLocalAI() {
  try { return savedAI.parse(JSON.parse(await readFile(settingsPath(), 'utf8'))) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
}

export async function writeLocalAI(value: z.infer<typeof savedAI>) {
  const path = settingsPath(), temporary = `${path}.${randomUUID()}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }).catch(() => {}) }
}

export function applyLocalAI(apiBaseUrl: string, model: string, apiKey?: string) {
  if (apiBaseUrl) process.env.OPENAI_BASE_URL = normalizeEndpoint(apiBaseUrl)
  else delete process.env.OPENAI_BASE_URL
  process.env.LLM_MODEL = model
  if (apiKey) process.env.OPENAI_API_KEY = apiKey
  else delete process.env.OPENAI_API_KEY
  process.env.LLM_PROVIDER = 'openai'
}

export async function applySavedLocalAI(settings: z.infer<typeof savedAI>) {
  let key: string | undefined
  if (settings.encryptedKey) {
    try { key = await dpapi(settings.encryptedKey, true) }
    catch { console.warn('未能读取本机 API 密钥；请打开成我设置重新填写。') }
  }
  applyLocalAI(settings.apiBaseUrl, settings.model, key)
}

export async function saveLocalAI(apiBaseUrl: string, model: string, key?: string) {
  await writeLocalAI({ apiBaseUrl, model, encryptedKey: key ? await dpapi(key, false) : null })
  applyLocalAI(apiBaseUrl, model, key)
}

// A blank key reuses the saved one only for the exact same normalized endpoint.
export function keyForEndpoint(endpoint: string, entered: string | undefined) {
  if (entered) return entered
  const saved = process.env.OPENAI_BASE_URL
  if (saved && endpoint === normalizeEndpoint(saved)) return process.env.OPENAI_API_KEY
  return undefined
}
