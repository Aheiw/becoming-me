import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalLan, lanInterfaces } from '../packages/server/src/personal/localLan.ts'

const address = lanInterfaces()[0]?.address
if (!address) throw new Error('This smoke test needs a private IPv4 network interface.')
const available = createServer()
await new Promise((resolve, reject) => available.listen(0, address).once('error', reject).once('listening', resolve))
const { port } = available.address()
await new Promise((resolve, reject) => available.close(error => error ? reject(error) : resolve()))
const directory = await mkdtemp(join(tmpdir(), 'becoming-me-mobile-smoke-'))
const path = join(directory, 'pairings.json')
const origin = `http://${address}:${port}`
let time = Date.now(), lan, browser
const app = request => new URL(request.url).pathname === '/'
  ? new Response('<title>测试工作台</title><p>虚构资料</p>', { headers: { 'Content-Type': 'text/html; charset=UTF-8' } })
  : Response.json({ record: 'synthetic test record' })
const newListener = () => createLocalLan(port, app, { path, now: () => time })
const request = (path, options = {}) => fetch(origin + path, { redirect: 'manual', signal: AbortSignal.timeout(3000), ...options, headers: { Connection: 'close', ...options.headers } })
const pair = (code, headers = {}) => request('/mobile-connect', { method: 'POST', headers: { Origin: origin, ...headers }, body: new URLSearchParams({ label: '测试手机', code }) })

try {
  lan = newListener()
  assert.equal(lan.status().url, null)
  const enabled = await lan.enable(address)
  assert.equal(enabled.url, `${origin}/`)
  assert.match(enabled.pairing.code, /^\d{8}$/)
  const first = await request('/')
  assert.equal(first.status, 302)
  assert.equal(first.headers.get('location'), '/mobile-connect')
  assert.equal((await request('/api/personal')).status, 401)
  assert.equal((await request('/assets/private.js')).status, 401)
  const wrongHost = await new Promise((resolve, reject) => {
    get(`${origin}/mobile-connect`, { headers: { Host: `127.0.0.1:${port}` } }, response => {
      response.resume()
      resolve(response.statusCode)
    }).once('error', reject)
  })
  assert.equal(wrongHost, 403)
  assert.equal((await request('/mobile-connect', { headers: { 'X-Forwarded-For': address } })).status, 403)
  assert.equal((await pair(enabled.pairing.code, { Origin: 'http://different.example' })).status, 403)
  const bad = enabled.pairing.code === '00000000' ? '00000001' : '00000000'
  for (let n = 0; n < 5; n++) assert.equal((await pair(bad)).status, 400)
  assert.equal((await pair(enabled.pairing.code)).status, 400)
  const expired = lan.generate().pairing.code
  time += 300_001
  assert.equal((await pair(expired)).status, 400)
  const good = lan.generate().pairing.code
  const paired = await pair(good)
  assert.equal(paired.status, 303)
  const set = paired.headers.get('set-cookie')
  assert.match(set, /HttpOnly/i)
  assert.match(set, /SameSite=Strict/i)
  const cookie = set.split(';')[0]
  const authenticated = { headers: { Cookie: cookie } }
  assert.equal((await pair(good)).status, 400)
  const auth = await request('/api/personal', authenticated)
  assert.equal(auth.status, 200)
  assert.equal(auth.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await auth.json(), { record: 'synthetic test record' })
  assert.equal(lan.status().devices[0].label, '测试手机')
  const content = await readFile(path, 'utf8')
  assert.ok(!content.includes(cookie.split('=')[1]))

  lan.close()
  lan = newListener()
  await lan.resume()
  assert.equal(lan.status().pairing, null)
  assert.equal((await request('/mobile-connect/status', authenticated)).status, 200)
  lan.disable()
  assert.equal(lan.status().devices.length, 1)
  await lan.enable(address)
  assert.equal((await request('/mobile-connect/status', authenticated)).status, 200)
  lan.revoke(lan.status().devices[0].id)
  assert.equal((await request('/api/personal', authenticated)).status, 401)

  // Optional: exercise native form submission and cookies in a real browser (no real records).
  if (process.env.SMOKE_PLAYWRIGHT && process.env.SMOKE_EDGE) {
    const { chromium } = await import(process.env.SMOKE_PLAYWRIGHT)
    browser = await chromium.launch({ executablePath: process.env.SMOKE_EDGE, headless: true, args: ['--no-proxy-server'] })
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    await page.goto(origin)
    await page.getByRole('heading', { name: '成我 · 手机配对' }).waitFor()
    await page.getByLabel('设备名称').fill('浏览器测试')
    await page.getByLabel('8 位配对码').fill(lan.generate().pairing.code)
    const pairingResponse = page.waitForResponse(res => res.request().method() === 'POST' && res.url().endsWith('/mobile-connect'))
    await page.getByRole('button', { name: '配对并打开成我' }).click()
    assert.equal((await pairingResponse).status(), 303)
    await page.getByText('虚构资料', { exact: true }).waitFor({ timeout: 5000 })
    await page.reload()
    await page.getByText('虚构资料', { exact: true }).waitFor({ timeout: 5000 })
    lan.revoke(lan.status().devices[0].id)
    await page.reload()
    await page.getByRole('heading', { name: '成我 · 手机配对' }).waitFor()
    console.log('Mobile browser form, cookie persistence and revocation passed.')
  }
  console.log('Mobile access smoke passed: opt-in, protected routes, lockout, expiry, restart, pause and revocation.')
} finally {
  await browser?.close()
  lan?.close()
  await rm(path, { force: true })
  await rmdir(directory)
}
