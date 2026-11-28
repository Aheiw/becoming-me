export function findQuoteRange(text: string, quote: string): { start: number; end: number } | null {
  if (!text || !quote) return null
  const exact = text.indexOf(quote)
  if (exact >= 0) return { start: exact, end: exact + quote.length }

  const trimmed = quote.trim()
  if (!trimmed) return null
  const exactTrimmed = text.indexOf(trimmed)
  if (exactTrimmed >= 0) return { start: exactTrimmed, end: exactTrimmed + trimmed.length }

  // Map normalized whitespace indices back to the original string so CRLF/wrapped lines still highlight.
  let normText = ''
  const map: number[] = []
  let prevSpace = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (/\s/u.test(ch)) {
      if (!prevSpace && normText.length > 0) {
        normText += ' '
        map.push(i)
      }
      prevSpace = true
    } else {
      normText += ch
      map.push(i)
      prevSpace = false
    }
  }
  const normQuote = trimmed.replace(/\s+/gu, ' ')
  const pos = normText.indexOf(normQuote)
  if (pos < 0) return null
  const start = map[pos]
  const lastIdx = pos + normQuote.length - 1
  const end = (map[lastIdx] ?? start) + 1
  return { start, end }
}
