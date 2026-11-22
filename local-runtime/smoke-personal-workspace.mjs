// Self-contained smoke test: in-memory Postgres, loopback fake chat API, fictional text only.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import JSZip from 'jszip'
import { Hono } from 'hono'

const requests = [], correction = '不是担心合作，是我想保留退出的自由。'
const original = '有次我拒绝无限期驻场，因为需要能自己决定什么时候退出。'
const diaryQuote = '我把水晶鸢尾工作室搬到城东，一周后重新开门。'
const secondDiary = '饮茶记录：这是另一篇不同时间的虚构原文。'
const dreamPhrase = '一只翡翠鲸鱼穿过窗框', answer = '这是一条供测试的连续回复。'
const mock = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part
  const reqBody = JSON.parse(raw); requests.push(reqBody)
  const all = JSON.stringify(reqBody.messages)
  const base = { id: 'pce-test', created: 1760000000, model: 'test-only' }
  if (reqBody.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const text of ['这是一条', '供测试的连续回复。']) res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`)
    return res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`)
  }
  const structured = reqBody.response_format || reqBody.tools
  const plainEvent = { kind: 'event', title: '搬迁水晶鸢尾工作室', content: '搬到城东并重新开门。', basis: '影响了工作地点。', counterpoint: '', category: 'life_events', eventIds: [], articleId: null, quote: diaryQuote,
    eventDraft: { date: '2023-07', cause: '原址租约结束。', outcome: '一周后重新开门。' } }
  let context
  try { context = JSON.parse(reqBody.messages.at(-1).content).context } catch {}
  const src = context?.diaryArchive?.sources.find(source => source.quote.includes(diaryQuote))
  const items = src ? [{ ...plainEvent, sourceRef: src.id }, { ...plainEvent, sourceRef: src.id, title: '错误原话', content: '不该存入的假证据', quote: '这句话来自模型编造' }] : []
  const content = structured ? JSON.stringify({ items, summary: '', focusedCorrection: all.includes(correction) ? correction : null }) : '这个梦可以让你回想哪些情境里感到惊讶；它本身不证明性格。'
  const msg = reqBody.tools ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-pce', type: 'function', function: { name: reqBody.tools[0].function.name, arguments: content } }] } : { role: 'assistant', content }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...base, choices: [{ index: 0, finish_reason: reqBody.tools ? 'tool_calls' : 'stop', message: msg }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } }))
})
mock.listen(0, '127.0.0.1'); await once(mock, 'listening')
const pg = await PGlite.create()
const socket = new PGLiteSocketServer({ db: pg, host: '127.0.0.1', port: 0 }); await socket.start()
try {
  Object.assign(process.env, { DATABASE_URL: `postgres://pce@${socket.getServerConn()}/postgres?sslmode=disable`, NODE_ENV: 'development', PCE_LOCAL: '1', OPENAI_API_KEY: 'unused-fake', OPENAI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, LLM_PROVIDER: 'openai', LLM_MODEL: 'test-only' })
  const { db, initDatabase, ensureDefaultUser, DEFAULT_USER_ID } = await import('../packages/server/src/db/client.ts')
  const { interviewDiaryBatches } = await import('../packages/server/src/db/schema.ts')
  const { personalRoute } = await import('../packages/server/src/routes/personal.ts')
  const { bookSections, eventImportance, hasTopics, turningEvents } = await import('../packages/server/src/personal/reading.ts')
  await initDatabase(); await ensureDefaultUser()
  const app = new Hono(); app.use('*', async (c, next) => { c.set('db', db); c.set('userId', DEFAULT_USER_ID); await next() }); app.route('/', personalRoute)
  const req = async (path, data, method = data ? 'POST' : 'GET') => { const r = await app.request(path, { method, ...(data && { body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } }) }); assert(r.ok, `${method} ${path} → ${r.status}: ${r.ok ? '' : await r.text()}`); return r }
  const get = async (...args) => (await req(...args)).json()
  await db.insert(interviewDiaryBatches).values({ id: 'old-fixture', userId: DEFAULT_USER_ID, entries: [{ date: '2020-01-01', filename: null, content: original }], analysis: [{ category: 'patterns', fact: '担心承诺约束', basis: '提到了退出', citations: [{ source: 1, quote: original }] }] })
  const initial = await get('/'); assert.equal(initial.proposals.length, 1); const p = initial.proposals[0]
  assert.equal((await get('/')).proposals.length, 1); assert.equal(requests.length, 0)
  assert.equal((await get('/evidence/diary/old-fixture?index=0')).content, original)
  await get('/focus', { diaryId: 'old-fixture' }); assert.equal((await get('/')).diaryFocusId, 'old-fixture')
  await get('/focus', { id: p.id })
  const turn = await (await req('/chat', { message: correction })).text()
  assert.match(turn, /"type":"delta"/); assert.match(turn, /"type":"saved"/); assert.doesNotMatch(turn, /warning/)
  assert.equal((await get('/chat')).messages.at(-1).content, answer)
  assert.equal((await get('/')).proposals[0].correction, correction)
  // Prioritize original sources, not only material that has already been analyzed.
  const rawBatch = { entries: [{ date: '2023-07-09', filename: '测试日记.txt', content: '原址租约结束。' + diaryQuote }, { date: '2024-07-09', filename: '另一篇.txt', content: secondDiary }] }
  const rawSaved = await get('/diary-sources', rawBatch)
  assert.equal(rawSaved.count, 2); assert.equal((await get('/diary-sources', rawBatch)).id, rawSaved.id)
  await get('/focus', { id: null, clearDiary: true })
  const startSourceTurn = requests.length
  const diaryTurn = await (await req('/chat', { message: '从2023年7月的日记整理水晶鸢尾工作室的搬迁事件' })).text()
  assert.match(diaryTurn, /"phase":"diary"/); assert.match(diaryTurn, /"count":1/)
  assert(JSON.stringify(requests.slice(startSourceTurn)).includes(diaryQuote)); assert(!JSON.stringify(requests.slice(startSourceTurn)).includes(secondDiary))
  const fromArchive = (await get('/')).proposals.find(x => x.title === '搬迁水晶鸢尾工作室')
  assert.equal(fromArchive.kind, 'event'); assert.equal(fromArchive.evidence[0].id, rawSaved.id); assert.equal(fromArchive.evidence[0].quote, diaryQuote)
  assert.equal((await get('/chat')).messages.at(-1).id, fromArchive.chatReplyId)
  assert.equal((await get('/')).events.length, 0, 'do not publish a draft automatically')
  for (const kind of ['article', 'event']) {
    await get('/proposals/' + fromArchive.id, { action: 'classify', kind })
    const changed = (await get('/')).proposals.find(x => x.id === fromArchive.id)
    assert.equal(changed.kind, kind); assert.deepEqual(changed.evidence, fromArchive.evidence)
  }
  const fromArchivedEvent = await get('/proposals/' + fromArchive.id, { action: 'event', event: { title: fromArchive.title, ...fromArchive.eventDraft, facts: fromArchive.content } })
  assert((await get('/')).events.some(e => e.id === fromArchivedEvent.id && e.cause === '原址租约结束。' && e.outcome === '一周后重新开门。'))
  const miss = await (await req('/chat', { message: '查一下1999年日记' })).text()
  assert.match(miss, /没有找到匹配的日记原文/)
  const ch = await get('/chapters', { title: '走出校园' })
  const e = await get('/proposals/' + p.id, { action: 'event', event: { title: '拒绝长期驻场工作', date: '2020', facts: original, chapterId: ch.id, prediction: '我可能更自由', outlook: '当时我想先保证能退出。', importance: 'milestone', topics: [' 职业选择 ', '自主性', '职业选择'] } })
  await get(`/events/${e.id}/followups`, { date: '2020-06-01', outcome: '后来找了项目制工作。' })
  const events = (await get('/')).events; const edited = events.find(x => x.id === e.id); assert.equal(edited.prediction, '我可能更自由'); assert.equal(edited.evidence[0].quote, original); assert.deepEqual(edited.topics, ['职业选择', '自主性']); assert.equal(edited.importance, 'milestone')
  const patched = await get(`/events/${e.id}`, { ...edited, importance: undefined, topics: undefined }, 'PATCH')
  assert.deepEqual(patched.topics, edited.topics); assert.equal(patched.importance, 'milestone'); assert.equal(patched.followups.length, 1)
  const follow = await get('/events', { title: '选择短期项目', date: '2020-06', facts: '为了有退出和选择的空间，我只签一个季度。', topics: ['职业选择'] })
  const lookup = await get('/search?q=' + encodeURIComponent('我希望能够自主离开工作'))
  assert.equal(lookup.mode, 'hybrid'); assert(lookup.hits.some(h => h.sourceId === e.id), 'expected local semantic recall')
  const article = { title: '决策考虑', category: 'patterns', fact: '我在合作中在意退出机制', eventIds: [e.id] }
  const a = await get('/articles', article)
  await get(`/articles/${a.id}`, { ...article, fact: '退出机制不是唯一因素' }, 'PATCH')
  await get('/review', { articleId: a.id, eventIds: [e.id] })
  assert(JSON.stringify(requests.at(-1)).includes(follow.id), 'review should include recalled related event')
  await get(`/articles/${a.id}/turning-points`, { date: '2020', before: '讨厌承诺', after: '看重退出', why: '回看选择', eventId: e.id })
  const undated = await get('/events', { title: '时间待考的经历', dateNote: '毕业那阵', chapterId: ch.id, facts: '只有阶段，没有日期。', importance: 'turning' })
  const unknown = await get('/events', { title: '没留下时间的经历', facts: '未分章也没有日期。' })
  const reading = await get('/'); const sections = bookSections(reading.events, reading.chapters)
  assert.deepEqual(sections[0].events.map(e => e.id), [e.id, undated.id]); assert.equal(sections[0].events[1].date, '')
  assert.equal(sections.at(-1).id, 'year-unknown'); assert.equal(sections.at(-1).events[0].id, unknown.id)
  assert.deepEqual(reading.events.filter(e => hasTopics(e, ['职业选择', '自主性'])).map(e => e.id), [e.id]); assert.equal(eventImportance(undated, turningEvents(reading.turningPoints)), 'turning')
  assert.equal(eventImportance({ ...e, importance: undefined }, turningEvents(reading.turningPoints)), 'turning', 'existing article turning point is reused for an unmarked event')
  const comparison = { eventId: e.id, articleId: a.id }
  const beforeFocus = requests.length; const beforeHistory = (await get('/chat')).messages.length
  await get('/focus', { comparison }); assert.equal(requests.length, beforeFocus); assert.deepEqual((await get('/')).comparisonFocus, comparison)
  const badFocus = await app.request('/focus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ comparison: { eventId: follow.id, articleId: a.id } }) })
  assert.equal(badFocus.status, 400)
  const comparisonReply = await (await req('/chat', { message: '对照这两份资料，有什么不同？' })).text(); assert.match(comparisonReply, /"type":"saved"/)
  const comparisonRequest = JSON.stringify(requests.slice(beforeFocus).find(r => r.stream))
  for (const fragment of [e.id, a.id, original, '退出机制不是唯一因素', '当时我想先保证能退出', '证据缺口']) assert(comparisonRequest.includes(fragment), 'missing explicitly selected evidence: ' + fragment)
  assert.equal((await get('/chat')).messages.length, beforeHistory + 2, 'comparison continues the existing chat')
  await get('/focus', { comparison: null }); assert.equal((await get('/')).comparisonFocus, undefined)
  await get('/focus', { comparison }); await get('/focus', { diaryId: 'old-fixture' }); assert.equal((await get('/')).comparisonFocus, undefined)
  await get('/focus', { clearDiary: true })
  await get(`/articles/${a.id}`, undefined, 'DELETE')
  assert((await get('/')).articles.find(x => x.id === a.id).deleted)
  await get(`/articles/${a.id}/restore`, { index: 0 })
  const hist = await get(`/articles/${a.id}/history`); assert.deepEqual(hist.revisions.map(r => r.action), ['create', 'edit', 'delete', 'restore']); assert.equal(hist.revisions.at(-1).fact, article.fact)
  const draftDreamPhrase = '昨晚我梦见一条橘色楼梯横在天空里';
  const beforeDream = requests.length
  const dreamTurn = await (await req('/chat', { message: draftDreamPhrase })).text()
  assert.match(dreamTurn, /dreamDraft/); assert.equal(requests.length, beforeDream + 1, 'dream turn must not run event capture'); assert.equal((await get('/')).dreams.length, 0)
  const m = (await get('/chat')).messages.at(-1); assert(m.dream && m.dreamDraft)
  const fromChatDream = await get('/chat/dream-drafts/' + m.id, { action: 'save', dream: { title: '橘色楼梯', original: draftDreamPhrase } })
  assert.equal((await get('/dreams/' + fromChatDream.id)).original, draftDreamPhrase)
  assert.equal((await get('/chat')).messages.at(-1).dreamDraft, undefined)
  const ignored = await (await req('/chat', { message: '我昨晚梦到一片反光的天空。' })).text(); assert.match(ignored, /dreamDraft/)
  const ignoreId = (await get('/chat')).messages.at(-1).id
  await get('/chat/dream-drafts/' + ignoreId, { action: 'dismiss' }); assert.equal((await get('/')).dreams.length, 1)
  await (await req('/chat', { message: '继续谈工作' })).text()
  assert(!requests.slice(-2).some(r => JSON.stringify(r).includes(draftDreamPhrase) || JSON.stringify(r).includes('反光的天空')))
  const dream = await get('/dreams', { title: '鲸鱼', original: dreamPhrase })
  assert.equal((await get(`/dreams/${dream.id}/analyze`, {})).notes.length, 1)
  await get('/focus', { dreamId: dream.id }); await (await req('/chat', { message: '聊聊这个梦' })).text()
  assert(JSON.stringify(requests.at(-1)).includes(dreamPhrase)); assert((await get('/chat')).messages.at(-1).dream)
  await get('/focus', { dreamId: null }); await (await req('/chat', { message: '现在聊工作' })).text()
  assert(!requests.slice(-2).some(r => JSON.stringify(r).includes(dreamPhrase) || JSON.stringify(r).includes('聊聊这个梦')))
  const exportText = async path => { const zip = await JSZip.loadAsync(await (await req(path)).arrayBuffer()); return (await Promise.all(Object.values(zip.files).filter(f => !f.dir).map(f => f.async('string')))).join('\n') }
  const book = await exportText('/book.zip'); assert(book.includes(original) && book.includes('走出校园') && book.includes('观点演变')); assert(!book.includes(dreamPhrase) && !book.includes(draftDreamPhrase)); assert(book.includes('原址租约结束。') && book.includes('一周后重新开门。')); assert(book.includes('大事和转折') && book.includes('职业选择、自主性') && book.includes('人生转折'))
  assert((await exportText('/book.zip?volume=dreams')).includes(dreamPhrase))
  console.log('Personal workspace: diary sources and focus, chat stream and correction, event followup, book groups, topic filtering, explicit comparisons, hybrid recall, revision/restore, dream isolation and ZIP OK.')
} finally { await socket.stop(); await pg.close(); mock.close(); }
