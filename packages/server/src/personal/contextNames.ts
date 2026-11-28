import type { LifeContext } from './types.js'

export const nameKey = (value: string) => value.normalize('NFKC').trim().toLowerCase()
export const aliasLimit = 20
export const aliasLength = 160

export function uniqueAliases(name: string, aliases: string[]) {
  const seen = new Set([nameKey(name), ''])
  return aliases.map(value => value.trim()).filter(value => {
    const key = nameKey(value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const contextNames = (card: LifeContext) => [card.name, ...(card.kind === 'person' ? card.aliases ?? [] : [])]

export function matchesContextName(card: LifeContext, subject: Pick<LifeContext, 'kind' | 'name'>) {
  const key = nameKey(subject.name)
  return !!key && card.kind === subject.kind && contextNames(card).some(value => nameKey(value) === key)
}
