import MobileAccess from './MobileAccess.js'
import { useEffect, useState, type FormEvent } from 'react'
import { forgetMaintenanceNotice, maintenanceNotice, reloadRecords } from '../../lib/localMaintenance.js'
import { api, body, Field, Page, stamp } from './shared.js'
import styles from './Personal.module.css'

type Config = { model: string; apiBaseUrl: string; keyConfigured: boolean; embeddingModel: string; embeddingsEnabled: boolean }
type Check = { state: 'disabled' | 'ready' | 'unavailable' }
type Target = 'chat' | 'embedding'
type Backup = { name: string; reason: string; createdAt: string }
type Backups = { folder: string; backups: Backup[] }
type BackupResult = { backup: Backup & { path: string } }
type Job = Target | 'detect' | 'save' | 'backup' | 'restore' | 'prepare' | 'clear'
const backupLabel: Record<string, string> = { manual: '手动备份', 'before-clear': '清除前自动备份', 'before-restore': '恢复前自动备份' }

export default function Settings({ allowDiary, setAllowDiary, openDiaryLibrary }: { allowDiary: boolean; setAllowDiary: (value: boolean) => void; openDiaryLibrary: () => void }) {
  const [config, setConfig] = useState<Config>()
  const [endpoint, setEndpoint] = useState(''), [apiKey, setKey] = useState(''), [model, setModel] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [backups, setBackups] = useState<Backups>(), [selected, setSelected] = useState(''), [confirmRestore, setConfirmRestore] = useState(false)
  const [clear, setClear] = useState<{ token: string; until: number }>(), [remaining, setRemaining] = useState(0)
  const [error, setError] = useState(''), [dataError, setDataError] = useState('')
  const [notice, setNotice] = useState(''), [dataNotice, setDataNotice] = useState(maintenanceNotice)
  const [busy, setBusy] = useState<Job>(), [checks, setChecks] = useState<Partial<Record<Target, Check['state']>>>({})
  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    forgetMaintenanceNotice()
    api<Config>('/settings', { signal }).then(value => {
      setConfig(value); setEndpoint(value.apiBaseUrl); setModel(value.model)
    }).catch(() => { if (!signal.aborted) setError('模型设置暂时无法读取。') })
    api<Backups>('/settings/backups', { signal }).then(setBackups)
      .catch(() => { if (!signal.aborted) setDataError('暂时无法读取本地备份列表。') })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (!clear) return
    const tick = () => setRemaining(Math.max(0, Math.ceil((clear.until - performance.now()) / 1000)))
    tick()
    const timer = window.setInterval(tick, 100)
    return () => window.clearInterval(timer)
  }, [clear])

  async function run(job: Job, task: () => Promise<void>) {
    if (busy) return
    const dataJob = ['backup', 'restore', 'prepare', 'clear'].includes(job)
    const reportError = dataJob ? setDataError : setError
    reportError(''); (dataJob ? setDataNotice : setNotice)(''); setBusy(job)
    try { await task() }
    catch (err) { reportError((err as Error).message || '操作未完成，请稍后重试。') }
    finally { setBusy(undefined) }
  }
  const draft = () => ({ apiBaseUrl: endpoint.trim(), ...(apiKey.trim() && { apiKey: apiKey.trim() }) })
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void run('save', async () => {
      const value = await api<Config>('/settings/ai', body({ ...draft(), model: model.trim() }))
      setConfig(value); setEndpoint(value.apiBaseUrl); setModel(value.model); setKey('')
      setChecks(current => ({ ...current, chat: undefined })); setNotice('模型设置已保存，下一条对话或分析会使用新配置。')
    })
  }
  const detect = () => run('detect', async () => {
    setModels([])
    const { models } = await api<{ models: string[] }>('/settings/models', body(draft()))
    setModels(models); setNotice(`找到 ${models.length} 个模型，可以从列表选择，也可以手动填写。`)
  })
  const check = (target: Target) => run(target, async () => {
    const { state } = await api<Check>('/settings/check', body({ target }))
    setChecks(value => ({ ...value, [target]: state }))
  })
  const backup = () => run('backup', async () => {
    const { backup } = await api<BackupResult>('/settings/backups', body({}))
    setDataNotice(`备份已保存：${backup.path}`); setSelected(backup.name)
    setBackups(current => ({ folder: current?.folder ?? backup.path.slice(0, -(backup.name.length + 1)), backups: [backup, ...(current?.backups ?? [])] }))
  })
  const restore = () => run('restore', async () => {
    const { backup } = await api<BackupResult>('/settings/restore', body({ name: selected }))
    reloadRecords(`记录已恢复。恢复前的记录另存于：${backup.path}`)
  })
  const prepare = () => run('prepare', async () => {
    const { token, delayMs } = await api<{ token: string; delayMs: number }>('/settings/clear/prepare', body({}))
    setConfirmRestore(false); setRemaining(Math.ceil(delayMs / 1000)); setClear({ token, until: performance.now() + delayMs })
  })
  const erase = () => clear && run('clear', async () => {
    const { backup } = await api<BackupResult>('/settings/clear', body({ token: clear.token }))
    reloadRecords(`所有记录已清除。自动备份：${backup.path}`)
  })
  const changed = !!config && (endpoint.trim() !== config.apiBaseUrl || model.trim() !== config.model || !!apiKey.trim())
  const chosen = backups?.backups.find(item => item.name === selected)
  return <Page kicker="成我 / 设置" title="模型、资料与隐私" hint="档案保存在本机。需要 AI 工作时，相关内容才会发送给你配置的 API。">
    <MobileAccess />
    <div className={styles.grid}>
      <form className={styles.card} onSubmit={save} autoComplete="off"><h2>对话与分析模型</h2>
        <Field label="API 端点"><input type="url" required maxLength={2048} placeholder="https://你的服务地址/v1" value={endpoint} onChange={e => { setEndpoint(e.target.value); setModels([]) }} disabled={!config || !!busy} /></Field>
        <Field label="API 密钥"><input type="password" maxLength={4096} autoComplete="new-password" value={apiKey} onChange={e => { setKey(e.target.value); setModels([]) }} disabled={!config || !!busy} placeholder={config?.keyConfigured ? '已保存，留空保留' : '输入密钥'} /></Field>
        <p className={styles.muted}>密钥加密保存在当前 Windows 账户下，不会回显。更换端点时请填写该端点的密钥，不会把旧密钥发过去。</p>
        <div className={styles.search}>
          <Field label="模型名称"><input required maxLength={250} value={model} placeholder="输入服务商提供的模型 ID" onChange={e => setModel(e.target.value)} disabled={!config || !!busy} /></Field>
          <button type="button" onClick={() => void detect()} disabled={!endpoint.trim() || !!busy}>{busy === 'detect' ? '正在检测…' : '检测模型'}</button>
        </div>
        {!!models.length && <Field label="从检测结果选择模型"><select value={models.includes(model) ? model : ''} onChange={e => { if (e.target.value) setModel(e.target.value) }} disabled={!!busy}><option value="">选择模型，也可在上方手填</option>{models.map(id => <option key={id}>{id}</option>)}</select></Field>}
        <div className={styles.actions}>
          <button className={styles.primary} type="submit" disabled={!changed || !endpoint.trim() || !model.trim() || !!busy}>{busy === 'save' ? '正在保存…' : '保存模型设置'}</button>
          <button type="button" disabled={!config?.model || !config?.apiBaseUrl || changed || !!busy} onClick={() => void check('chat')}>{busy === 'chat' ? '正在测试…' : '测试已保存的连接'}</button>
        </div>
        <p className={styles.muted}>检测模型只读取模型列表；连接测试只发送一条虚构文本，不发送私人记录。</p>
        {!changed && checks.chat && <p role="status">{checks.chat === 'ready' ? '模型连接正常。' : '未收到有效回复，请检查端点、密钥和模型名称。'}</p>}
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
      </form>
      <section className={styles.card}><h2>本地向量检索</h2><p>{config?.embeddingModel ?? '正在读取配置…'}</p>
        <p className={styles.muted}>向量由本机 Ollama 计算；不可用时仍能用关键词查找。</p>
        <div className={styles.actions}><button type="button" disabled={!config?.embeddingsEnabled || !!busy} onClick={() => void check('embedding')}>{busy === 'embedding' ? '正在测试…' : '测试本地向量'}</button><span role="status">{config?.embeddingsEnabled === false ? '已关闭，使用关键词检索' : checks.embedding === 'ready' ? '本地向量可用' : checks.embedding === 'unavailable' ? '当前不可用，使用关键词检索' : ''}</span></div>
      </section>
    </div>
    <section className={styles.card}><h2>备份与恢复</h2>
      <p className={styles.muted}>备份包括长期对话、旧访谈、日记原文、分析、事件、百科修订、人物与环境、梦境等记录，不含 API 密钥或模型设置。备份文件未加密，请妥善保管。</p>
      {backups && <p className={`${styles.muted} ${styles.settingsPath}`}>备份文件夹：<code>{backups.folder}</code></p>}
      <div className={styles.actions}><button type="button" className={styles.primary} disabled={!!busy || !!clear || confirmRestore} onClick={() => void backup()}>{busy === 'backup' ? '正在备份…' : '一键备份'}</button></div>
      {backups?.backups.length ? <div className={styles.search}>
        <Field label="选择要恢复的备份"><select value={selected} disabled={!!busy || confirmRestore || !!clear} onChange={e => setSelected(e.target.value)}><option value="">请选择备份</option>{backups.backups.map(item => <option key={item.name} value={item.name}>{stamp(item.createdAt)} · {backupLabel[item.reason]} · {item.name.slice(-13, -5)}</option>)}</select></Field>
        <button type="button" disabled={!chosen || !!busy || confirmRestore || !!clear} onClick={() => { setDataError(''); setConfirmRestore(true) }}>一键恢复</button>
      </div> : backups && <p className={styles.muted}>还没有可恢复的备份。也可将「成我」生成的备份文件放回此目录，再刷新页面。</p>}
      {confirmRestore && chosen && <div className={`${styles.card} ${styles.settingsWarning}`} role="group" aria-label="确认恢复记录">
        <p>用 {stamp(chosen.createdAt)} 的备份替换当前记录？当前记录会先另存为备份，不会合并。</p>
        <div className={styles.actions}><button type="button" className={styles.dangerButton} disabled={!!busy} onClick={() => void restore()}>{busy === 'restore' ? '正在恢复…' : '确认恢复'}</button><button type="button" disabled={!!busy} onClick={() => { setConfirmRestore(false); setDataError('') }}>取消</button></div>
      </div>}
    </section>
    <section className={styles.card}><h2>对话何时能查日记</h2>
      <label className={styles.actions}><input type="checkbox" checked={allowDiary} onChange={e => setAllowDiary(e.target.checked)} />允许长期对话按需调取日记原文</label>
      <p className={styles.muted}>关闭后，对话不再新查日记，也不附带选中的日记分析；不会抹去既有对话或引文。主动点「综合分析」仍会发送所选日记，梦境不进入普通聊天的上下文。</p>
      <div className={styles.actions}><button type="button" onClick={openDiaryLibrary}>打开日记资料库</button><a className={styles.button} href="/api/personal/book.zip">导出人生书</a><a className={styles.button} href="/api/personal/book.zip?volume=dreams">单独导出梦境簿</a></div>
    </section>
    <section className={`${styles.card} ${styles.settingsWarning}`}><h2>删除所有记录</h2>
      <p>会清空包含长期对话和旧访谈在内的所有本地个人记录。先自动备份，成功后才删除。不会删除磁盘上的日记原文件、现有备份或模型配置。</p>
      {!clear ? <div className={styles.actions}><button type="button" className={styles.dangerButton} disabled={!!busy || confirmRestore} onClick={() => void prepare()}>{busy === 'prepare' ? '正在准备…' : '删除所有记录…'}</button></div>
        : <div className={styles.stack} role="group" aria-label="再次确认清除记录">
          <p role="status">{remaining > 0 ? `请再等 ${remaining} 秒，然后确认。` : '现在可以确认。备份失败则不会删除。'}</p>
          <div className={styles.actions}><button type="button" className={styles.dangerButton} disabled={remaining > 0 || !!busy} onClick={() => void erase()}>{busy === 'clear' ? '正在备份并清除…' : '确认删除所有记录'}</button><button type="button" disabled={!!busy} onClick={() => { setClear(undefined); setDataError('') }}>取消</button></div>
        </div>}
    </section>
    {dataError && <p role="alert" className={styles.error}>{dataError}</p>}
    {dataNotice && <p role="status" className={`${styles.card} ${styles.settingsPath}`}>{dataNotice}</p>}
  </Page>
}
