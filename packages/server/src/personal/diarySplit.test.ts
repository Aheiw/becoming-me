import { expect, it } from 'vitest'
import { detectBodyDate, filenameDate, splitDiaryCollection } from '../../../web/src/lib/diarySplit.js'

it('extracts valid dates from filenames and body headers while rejecting invalid dates', () => {
  expect(filenameDate('2025年3月5日随笔.md')).toBe('2025-03-05')
  expect(filenameDate('2026-02-30.txt')).toBeNull()
  expect(detectBodyDate('\n\n# 2025.11.08 星期六\n今天去了河边散步。')).toBe('2025-11-08')
  expect(detectBodyDate('今天只是回想起了 2020-05-01 的那次旅行。\n当时天气很好。')).toBeNull()
})

it('splits a dated collection into entries without splitting single diaries mentioning dates', () => {
  const collection = [
    '# 2025-03-10',
    '决定先梳理一下工作节奏。',
    '',
    '2025年3月14日 星期五',
    '这周开始每天留一小时写复盘，感觉踏实多了。',
  ].join('\n')

  const parts = splitDiaryCollection('三月合集.md', collection)
  expect(parts).toHaveLength(2)
  expect(parts[0]).toMatchObject({ filename: '三月合集.md #1', date: '2025-03-10' })
  expect(parts[1]).toMatchObject({ filename: '三月合集.md #2', date: '2025-03-14' })

  const single = '2025-03-10\n今天想起了2021年的旧事，也记得2022年换了团队。'
  expect(splitDiaryCollection('单篇.txt', single)).toEqual([])
})
