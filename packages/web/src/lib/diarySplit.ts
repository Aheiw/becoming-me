export type SplitEntry = { filename: string | null; date: string | null; content: string }

function toIsoDate(year: string, month: string, day: string): string | null {
  const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === date ? date : null
}

export function filenameDate(name: string): string | null {
  const parts = name.match(/(?<!\d)(\d{4})(?:[-_.年](\d{1,2})[-_.月](\d{1,2})|(\d{2})(\d{2}))(?!\d)/)
  if (!parts) return null
  return toIsoDate(parts[1], parts[2] ?? parts[4], parts[3] ?? parts[5])
}

// Match standalone date header lines such as "# 2025-03-14", "2025年3月14日 星期五", "2025.03.14".
const HEADER_DATE_RE = /^(?:#{1,6}\s*)?(?:【|\[)?(\d{4})(?:[-_./年](\d{1,2})[-_./月](\d{1,2})日?|(\d{2})(\d{2}))(?:】|\])?(?:\s*(?:星期[一二三四五六日天]|周[一二三四五六日天]|[晴阴雨雪多云]|[-—|:：\s].{0,40})?)?$/

function parseHeaderDate(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.length > 64) return null
  const m = trimmed.match(HEADER_DATE_RE)
  if (!m) return null
  return toIsoDate(m[1], m[2] ?? m[4], m[3] ?? m[5])
}

export function detectBodyDate(content: string): string | null {
  const lines = content.split(/\r?\n/)
  let checked = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const found = parseHeaderDate(trimmed)
    if (found) return found
    checked++
    if (checked >= 4) break
  }
  return null
}

export function splitDiaryCollection(filename: string | null, content: string): SplitEntry[] {
  const lines = content.split(/\r?\n/)
  const sections: { date: string | null; lines: string[] }[] = []
  let current: { date: string | null; lines: string[] } | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (/^(?:-{3,}|={3,}|\*{3,})$/.test(trimmed)) {
      if (current && current.lines.some(l => l.trim())) {
        sections.push(current)
        current = null
      }
      continue
    }
    const headerDate = parseHeaderDate(trimmed)
    if (headerDate) {
      if (current && current.lines.some(l => l.trim())) sections.push(current)
      current = { date: headerDate, lines: [line] }
      continue
    }
    if (!current) current = { date: null, lines: [] }
    current.lines.push(line)
  }
  if (current && current.lines.some(l => l.trim())) sections.push(current)

  const datedSections = sections.filter(s => s.date !== null)
  if (datedSections.length < 2) return []

  const nonEmpty = sections
    .map((s, idx) => ({
      filename: filename ? `${filename} #${idx + 1}` : null,
      date: s.date,
      content: s.lines.join('\n').trim(),
    }))
    .filter(s => s.content.length > 0 && (s.date !== null || s.content.length >= 12))

  return nonEmpty.length >= 2 ? nonEmpty : []
}
