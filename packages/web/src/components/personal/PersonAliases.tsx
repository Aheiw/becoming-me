import { useId } from 'react'
import { aliasLength, aliasLimit, nameKey, uniqueAliases } from '../../../../server/src/personal/contextNames.js'
import styles from './Personal.module.css'

export type AliasDraft = { names: string[]; input: string }
export const aliasDraft = (names: string[] = []): AliasDraft => ({ names, input: '' })
const split = (input: string) => input.split(/[、，,；;\r\n]+/u)
export function personAliases(name: string, draft: AliasDraft) {
  const values = uniqueAliases(name, [...draft.names, ...split(draft.input)])
  return { values, invalid: values.length > aliasLimit || values.some(value => value.length > aliasLength) }
}

export function AliasField({ name, value, change, disabled }: { name: string; value: AliasDraft; change: (value: AliasDraft) => void; disabled?: boolean }) {
  const id = useId()
  const { values, invalid } = personAliases(name, value)
  const added = uniqueAliases(name, value.names)
  const pending = values.filter(alias => !added.some(a => nameKey(a) === nameKey(alias)))
  const accept = () => { if (!invalid) change(aliasDraft(values)) }
  return <div className={styles.stack}>
    <label htmlFor={id}>别名（可选）</label>
    {added.length > 0 && <div aria-label="已有别名" className={styles.actions}>{added.map(alias => <button key={alias} className={styles.aliasChip} disabled={disabled} type="button" aria-label={`移除别名：${alias}`} onClick={() => change({ ...value, names: value.names.filter(a => nameKey(a) !== nameKey(alias)) })}>{alias} <span aria-hidden="true">×</span></button>)}</div>}
    <div className={styles.actions}><input id={id} autoComplete="off" disabled={disabled} value={value.input} aria-invalid={invalid} aria-describedby={`${id}-hint`} placeholder="输入一个，或粘贴多个" onChange={e => change({ ...value, input: e.target.value })}
      onPaste={e => { const pasted = e.clipboardData.getData('text'); if (!/[、，,；;\r\n]/u.test(pasted)) return; e.preventDefault(); change({ ...value, input: [value.input, pasted].filter(Boolean).join('、').slice(0, 5000) }) }}
      onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && value.input.trim()) { e.preventDefault(); accept() } }} />
      <button type="button" disabled={disabled || invalid || !value.input.trim()} onClick={accept}>添加别名</button></div>
    {pending.length > 0 && <div className={styles.actions}><small>将分别保存：</small>{pending.map(a => <span className={styles.aliasPreview} key={a}>{a}</span>)}</div>}
    <small id={`${id}-hint`}>{invalid ? `最多 ${aliasLimit} 个别名，每个不超过 ${aliasLength} 字。` : '每个别名单独保存，可单独删除。批量粘贴用顿号、逗号或换行；名字里的空格会保留。'}</small>
  </div>
}
