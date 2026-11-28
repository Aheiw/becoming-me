import { createAdaptorServer, type HttpBindings } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { Server } from 'node:http'
import { BlockList, isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'

const connectPath = '/mobile-connect'
const cookie = 'becoming_me_mobile'
const pairLifetime = 5 * 60_000
const maxDevices = 20
const privateIPv4 = new BlockList()
privateIPv4.addSubnet('10.0.0.0', 8)
privateIPv4.addSubnet('172.16.0.0', 12)
privateIPv4.addSubnet('192.168.0.0', 16)
const isPrivate = (address: string) => isIPv4(address) && privateIPv4.check(address)
const digest = (token: string) => createHash('sha256').update(token).digest('hex')
const labelSchema = z.string().trim().min(1).max(50).refine(value => !/\p{Cc}/u.test(value))
const savedSchema = z.object({
  address: z.string().refine(isPrivate).nullable(),
  devices: z.array(z.object({ id: z.string().uuid(), label: labelSchema, pairedAt: z.string().datetime(), hash: z.string().regex(/^[a-f0-9]{64}$/) })).max(maxDevices),
})
type Saved = z.infer<typeof savedSchema>
type Pairing = { code: string; expiresAt: number; attempts: number }
type Interface = { address: string; name: string; prefix: number }

export function lanInterfaces(): Interface[] {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) => (entries ?? []).flatMap(item => {
    if (item.family !== 'IPv4' || item.internal || !isPrivate(item.address) || !item.cidr) return []
    return [{ address: item.address, name, prefix: Number(item.cidr.split('/')[1]) }]
  })).sort((a, b) => Number(b.address.startsWith('192.168.')) - Number(a.address.startsWith('192.168.')) || a.name.localeCompare(b.name))
}

export function allowedLanRequest(request: Request, host: string) {
  const headers = request.headers
  const origin = headers.get('origin')
  if (headers.get('host') !== host || headers.get('sec-fetch-site') === 'cross-site' ||
      ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'].some(key => headers.has(key))) return false
  return !origin || origin === `http://${host}`
}

function save(path: string, value: Saved) {
  const temp = `${path}.${randomUUID()}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
    renameSync(temp, path)
  } finally { rmSync(temp, { force: true }) }
}

function pairPage(message = '') {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>成我 · 手机配对</title>
<style>body{background:#f5f2eb;color:#1d2723;font:16px/1.55 system-ui,sans-serif;margin:0;padding:12vh 20px 24px}main{box-sizing:border-box;background:#fffdf8;border:1px solid #d8ded5;border-radius:20px;max-width:420px;margin:auto;padding:26px}h1{margin:0 0 12px;font-size:26px}label{display:block;margin:16px 0}input,button{font:inherit;box-sizing:border-box;width:100%;min-height:46px;margin-top:5px;padding:8px 12px;border:1px solid #aaa;border-radius:8px}button{border:0;background:#204d3c;color:white;font-weight:bold}small{display:block;color:#4e5e55;margin-top:16px}[role=alert]{color:#923517}</style>
<main><h1>成我 · 手机配对</h1><p>在电脑的「设置 → 手机连接」生成配对码，再在这里输入。</p>${message ? `<p role="alert">${message}</p>` : ''}
<form method="post" action="${connectPath}"><label>设备名称<input name="label" placeholder="例如：我的手机" maxlength="50" autocomplete="off"></label><label>8 位配对码<input name="code" type="text" inputmode="numeric" pattern="[0-9]{8}" minlength="8" maxlength="8" autocomplete="off" required></label><button type="submit">配对并打开成我</button></form><small>授权后，这个浏览器可以访问和编辑电脑上的私人记录。仅在你信任的局域网使用。</small></main></html>`
}

export function createLocalLan(port: number, dispatch: (request: Request, env: HttpBindings) => Response | Promise<Response>, options: {
  path?: string; interfaces?: () => Interface[]; now?: () => number
} = {}) {
  const path = options.path ?? resolve('data', 'mobile-access.local.json')
  const interfaces = options.interfaces ?? lanInterfaces
  const now = options.now ?? Date.now
  let saved: Saved = { address: null, devices: [] }
  let loadError = false
  try { saved = savedSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') loadError = true }
  let listener: Server | undefined
  let bound: Interface | undefined
  let pairing: Pairing | undefined
  let starting = false
  const commit = (value: Saved) => {
    if (loadError) throw new Error('手机授权文件无法读取。')
    save(path, value)
    saved = value
  }
  const pendingCode = () => pairing && pairing.expiresAt > now() && pairing.attempts < 5 ? pairing : undefined
  const disconnected = () => {
    const server = listener
    listener = undefined
    bound = undefined
    pairing = undefined
    server?.close()
    server?.closeAllConnections()
  }
  const status = () => {
    const code = pendingCode()
    return {
      address: bound?.address ?? saved.address, url: bound ? `http://${bound.address}:${port}/` : null,
      interfaces: interfaces().map(({ address, name }) => ({ address, name })),
      devices: saved.devices.map(({ id, label, pairedAt }) => ({ id, label, pairedAt })),
      pairing: code ? { code: code.code, expiresAt: code.expiresAt } : null,
      warning: loadError ? '手机授权文件无法读取，暂时不会开放访问。' : saved.address && !bound ? '上次的局域网地址目前不可用，请重新选择地址。' : null,
    }
  }
  const issue = () => { pairing = { code: String(randomInt(100_000_000)).padStart(8, '0'), attempts: 0, expiresAt: now() + pairLifetime } }

  // Separate listener: a LAN socket can never be mistaken for the desktop listener.
  const gateway = (host: string, isPeer: (env: HttpBindings) => boolean) => {
    type Env = { Bindings: HttpBindings; Variables: { device?: Saved['devices'][number] } }
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      if (!isPeer(c.env) || !allowedLanRequest(c.req.raw, host)) return c.text('仅允许同一局域网访问。', 403)
      if (!['GET', 'HEAD'].includes(c.req.method) && c.req.header('origin') !== `http://${host}`) return c.text('只接受来自成我页面的操作。', 403)
      c.header('Cache-Control', 'no-store')
      c.header('Referrer-Policy', 'same-origin')
      c.header('X-Frame-Options', 'DENY')
      c.header('X-Content-Type-Options', 'nosniff')
      const token = getCookie(c, cookie)
      if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
        const hash = digest(token)
        const device = saved.devices.find(row => row.hash === hash)
        if (device) {
          c.set('device', device)
          // Browsers cap persistent cookies. Refresh on reopening and authorization checks.
          if (c.req.method === 'GET' && (c.req.path === '/' || c.req.path === `${connectPath}/status`)) {
            setCookie(c, cookie, token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 400 * 86400 })
          }
        }
      }
      await next()
    })
    app.get(connectPath, c => c.get('device') ? c.redirect('/') : c.html(pairPage()))
    app.post(connectPath, bodyLimit({ maxSize: 2048 }), async c => {
      if (c.get('device')) return c.redirect('/', 303)
      const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>))
      const active = pendingCode()
      if (!active) return c.html(pairPage('配对码不可用。请回到电脑重新生成。'), 400)
      if (typeof form.code !== 'string' || !/^\d{8}$/.test(form.code) || !timingSafeEqual(Buffer.from(active.code), Buffer.from(form.code))) {
        active.attempts++
        return c.html(pairPage(active.attempts >= 5 ? '尝试次数已用完，请回到电脑重新生成。' : '配对码不正确。'), 400)
      }
      const name = typeof form.label === 'string' ? form.label.trim() || '手机浏览器' : '手机浏览器'
      const label = labelSchema.safeParse(name)
      if (!label.success) return c.html(pairPage('请填写 1–50 个字符的设备名称。'), 400)
      if (saved.devices.length >= maxDevices) return c.html(pairPage('已达到设备上限，请先在电脑撤销不用的设备。'), 409)
      const token = randomBytes(32).toString('base64url')
      try { commit({ ...saved, devices: [...saved.devices, { id: randomUUID(), label: label.data, pairedAt: new Date(now()).toISOString(), hash: digest(token) }] }) }
      catch { return c.html(pairPage('授权未能保存，请检查电脑上的数据目录。'), 500) }
      pairing = undefined
      setCookie(c, cookie, token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 400 * 86400 })
      return c.redirect('/', 303)
    })
    app.post(`${connectPath}/logout`, c => {
      const device = c.get('device')
      try { if (device) commit({ ...saved, devices: saved.devices.filter(row => row.id !== device.id) }) }
      catch { return c.text('暂时无法退出，请回到电脑撤销这台设备。', 500) }
      deleteCookie(c, cookie, { httpOnly: true, sameSite: 'Strict', path: '/' })
      return c.redirect(connectPath, 303)
    })
    app.all('*', async c => {
      if (!c.get('device')) {
        if (c.req.method === 'GET' && c.req.path === '/') return c.redirect(connectPath)
        c.header('X-Becoming-Me-Pairing', 'required')
        return c.json({ error: '请先在手机上配对。' }, 401)
      }
      if (c.req.path === `${connectPath}/status` && c.req.method === 'GET') return c.json({ connected: true })
      // Materialize the gateway headers before assigning the delegated response.
      void c.res
      return await dispatch(c.req.raw, c.env)
    })
    return app
  }

  async function listen(address: string) {
    if (starting || listener) throw new Error('请先关闭当前手机连接。')
    const iface = interfaces().find(item => item.address === address)
    if (!iface || loadError) throw new Error('没有可用的局域网地址。')
    const subnet = new BlockList()
    subnet.addSubnet(iface.address, iface.prefix)
    const app = gateway(`${address}:${port}`, env => {
      const socket = env.incoming.socket
      return bound === iface && socket.localAddress === address && !!socket.remoteAddress && isPrivate(socket.remoteAddress) && subnet.check(socket.remoteAddress)
    })
    const server = createAdaptorServer({ fetch: app.fetch })
    if (!(server instanceof Server)) throw new Error('局域网监听类型不受支持。')
    starting = true
    try {
      await new Promise<void>((accept, reject) => {
        const failed = (error: Error) => reject(error)
        server.once('error', failed)
        server.listen(port, address, () => { server.off('error', failed); accept() })
      })
      listener = server
      bound = iface
      server.on('error', () => { if (listener === server) disconnected() })
    } finally { starting = false }
  }

  return {
    async resume() {
      if (saved.address) {
        try { await listen(saved.address) }
        catch { console.warn('未能恢复手机连接；可在成我设置重新开启。') }
      }
    },
    close: disconnected,
    status,
    async enable(address: string) {
      await listen(address)
      try { commit({ ...saved, address }) }
      catch (error) { disconnected(); throw error }
      issue()
      return status()
    },
    disable() {
      if (starting) throw new Error('正在启动手机连接。')
      disconnected()
      commit({ ...saved, address: null })
      return status()
    },
    generate() {
      if (!listener) throw new Error('请先开启手机连接。')
      issue()
      return status()
    },
    revoke(id: string) {
      commit({ ...saved, devices: saved.devices.filter(device => device.id !== id) })
      return status()
    },
  }
}
