import { useEffect, useState } from 'react'
import { api, body, Field, stamp } from './shared.js'
import styles from './Personal.module.css'

type State = {
  address: string | null; url: string | null; warning: string | null
  interfaces: { address: string; name: string }[]
  devices: { id: string; label: string; pairedAt: string }[]
  pairing: { code: string; expiresAt: number } | null
}

export default function MobileAccess() {
  const [state, setState] = useState<State>(), [selected, select] = useState('')
  const [qr, setQr] = useState(''), [now, setNow] = useState(Date.now), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [revokeId, setRevokeId] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    api<State>('/settings/mobile', { signal: controller.signal }).then(value => {
      setState(value); select(value.interfaces.find(entry => entry.address === value.address)?.address ?? value.interfaces[0]?.address ?? '')
    }).catch(() => { if (!controller.signal.aborted) setError('暂时无法读取手机连接设置。') })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    let cancelled = false
    setQr('')
    const url = state?.url
    if (url) void import('qrcode').then(({ default: QRCode }) => QRCode.toDataURL(url, { width: 224, margin: 3 }))
      .then(value => { if (!cancelled) setQr(value) }).catch(() => { /* address remains usable */ })
    return () => { cancelled = true }
  }, [state?.url])
  useEffect(() => {
    if (!state?.pairing) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [state?.pairing])
  const ttl = state?.pairing ? Math.max(0, Math.ceil((state.pairing.expiresAt - now) / 1000)) : 0

  async function refresh() {
    try { setState(await api<State>('/settings/mobile')); setError('') }
    catch { setError('暂时无法读取配对状态。') }
  }
  useEffect(() => {
    if (!ttl || !state?.url) return
    const controller = new AbortController()
    const timer = window.setInterval(() => {
      void api<State>('/settings/mobile', { signal: controller.signal }).then(value => {
        if (!controller.signal.aborted) setState(previous => previous?.pairing?.code === state.pairing?.code ? value : previous)
      }).catch(() => {})
    }, 3500)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [Boolean(ttl), state?.url, state?.pairing?.code])

  async function change(action: 'enable' | 'disable' | 'generate' | 'revoke', extra = {}) {
    setBusy(true); setError(''); setNotice('')
    try {
      setState(await api<State>('/settings/mobile', body({ action, ...extra }))); setNow(Date.now()); setRevokeId('')
      if (action === 'revoke') setNotice('已撤销设备。再次访问需要重新配对。')
      if (action === 'disable') setNotice('已暂停局域网访问；之前配对的设备授权仍然保留。')
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  return <section className={styles.card}>
    <h2>手机连接</h2>
    <p className={styles.muted}>手机和电脑连到同一个路由器。手机上写的日记、聊过的话，都进入电脑上的同一份资料库。</p>
    {state?.warning && <p role="status" className={styles.notice}>{state.warning}</p>}
    {state && !state.url && (state.interfaces.length ? <div className={styles.actions}>
      <Field label="电脑的局域网地址"><select disabled={busy} value={selected} onChange={e => select(e.target.value)}>{state.interfaces.map(entry => <option key={entry.address} value={entry.address}>{entry.name} · {entry.address}</option>)}</select></Field>
      <button className={styles.primary} type="button" disabled={busy || !selected} onClick={() => void change('enable', { address: selected })}>开启手机连接</button>
    </div> : <p>没有检测到可用的局域网地址。请先把电脑连到路由器，再刷新页面。</p>)}
    {state?.url && <div className={styles.mobileLink}>
      {qr && <img src={qr} width={156} height={156} alt="手机访问成我的网址二维码，不包含配对码" />}
      <div className={styles.stack}>
        <div><p><strong>已开启</strong> · 手机扫码，或在手机浏览器输入以下地址：</p><p className={styles.settingsPath}><code>{state.url}</code></p></div>
        {ttl > 0 && state.pairing
          ? <div aria-live="off"><p>一次性配对码 · 剩余 {Math.floor(ttl / 60)} 分 {String(ttl % 60).padStart(2, '0')} 秒</p><p className={styles.mobileCode}>{state.pairing.code}</p></div>
          : <p className={styles.muted}>已配对的浏览器直接打开；要添加新设备，再生成一次配对码。</p>}
        <div className={styles.actions}><button type="button" disabled={busy} onClick={() => void change('generate')}>{ttl ? '重新生成配对码' : '生成配对码'}</button><button type="button" disabled={busy} onClick={() => void change('disable')}>暂停手机连接</button></div>
      </div>
    </div>}
    {state && <div className={styles.stack}>
      <div className={styles.actions}><h3>已配对设备 · {state.devices.length}</h3><button type="button" disabled={busy} onClick={() => void refresh()}>刷新列表</button></div>
      {!state.devices.length && <p className={styles.muted}>还没有设备配对。</p>}
      {state.devices.map(item => <div className={styles.compare} key={item.id}>
        <p><strong>{item.label}</strong> · {stamp(item.pairedAt)}</p>
        {revokeId === item.id ? <div className={styles.actions}><button type="button" className={styles.dangerButton} disabled={busy} onClick={() => void change('revoke', { id: item.id })}>确认撤销此设备</button><button type="button" disabled={busy} onClick={() => setRevokeId('')}>取消</button></div> : <button type="button" disabled={busy} onClick={() => setRevokeId(item.id)}>撤销设备</button>}
      </div>)}
    </div>}
    {!state && !error && <p role="status">正在读取手机连接设置…</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <p className={styles.muted}>授权重启后仍有效。清除手机浏览器数据、改用其他浏览器、电脑 IP 改变，或浏览器清理了很久未使用的登录时，需要重新配对。局域网连接使用未加密的 HTTP；只在信任的网络开启，不要设置公网端口映射。</p>
  </section>
}
