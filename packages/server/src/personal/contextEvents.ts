import type { ContextSuggestion, Evidence, LifeContext, LifeEvent } from './types.js'
import { contextNames, matchesContextName, nameKey } from './contextNames.js'

// Direct event links live on cards. Existing relationship links can reference an event
// as evidence, in which case both endpoints can navigate to it without a second copy.
export function indexEventContexts(cards: LifeContext[]) {
  const byEvent = new Map<string, Map<string, { card: LifeContext; direct: boolean }>>()
  const byId = new Map(cards.map(card => [card.id, card]))
  const add = (id: string, card: LifeContext, direct: boolean) => {
    const links = byEvent.get(id) ?? new Map()
    links.set(card.id, { card, direct: direct || links.get(card.id)?.direct === true })
    byEvent.set(id, links)
  }
  for (const card of cards) {
    for (const id of card.eventIds) add(id, card, true)
    for (const link of card.links) {
      const other = byId.get(link.targetId)
      if (!other) continue
      for (const id of link.eventIds ?? []) { add(id, card, false); add(id, other, false) }
    }
  }
  return byEvent
}

const mentions = (quote: string, name: string) => Boolean(nameKey(name) && nameKey(quote).includes(nameKey(name)))

// These are unselected review cues, never automatic writes or identity matches.
export function mentionedDiaryCards(evidence: Evidence[], cards: LifeContext[]) {
  const quotes = evidence.filter(e => e.kind === 'diary' || e.kind === 'saved-diary').map(e => e.quote)
  return cards.filter(card => quotes.some(quote => contextNames(card).some(name => mentions(quote, name)))).map(card => card.id)
}

export function suggestedDiaryEvents(suggestion: ContextSuggestion, events: LifeEvent[], cards: LifeContext[] = []) {
  const d = suggestion.draft
  const subjects = d.kind === 'relation' ? [d.from, d.to] : [d]
  const names = subjects.map(subject => {
    const matches = cards.filter(card => matchesContextName(card, subject))
    return matches.length === 1 ? contextNames(matches[0]) : [subject.name]
  })
  return events.filter(event => suggestion.evidence.some(source =>
    (source.kind === 'diary' || source.kind === 'saved-diary') && event.evidence.some(e =>
      e.kind === source.kind && e.id === source.id && e.index === source.index &&
      names.every(variants => variants.some(name => mentions(e.quote, name))),
    ),
  )).map(event => event.id)
}
