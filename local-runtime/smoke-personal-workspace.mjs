// Self-contained smoke test: in-memory Postgres, loopback fake chat API, fictional text only.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import JSZip from 'jszip'
import { Hono } from 'hono'
import { indexEventContexts, mentionedDiaryCards, suggestedDiaryEvents } from '../packages/server/src/personal/contextEvents.ts'

const requests = [], correction = '不是担心合作，是我想保留退出的自由。'
const original = '有次我拒绝无限期驻场，因为需要能自己决定什么时候退出。'
const chatSelf = '在决定是否接下项目时，我更看重能否自己安排时间。'
const profileReply = '不是喜欢尝鲜，是原工作室租约结束。我宁愿留在熟悉的地方。'
const diaryQuote = '我把水晶鸢尾工作室搬到城东，一周后重新开门。'
const oldChatQuote = '我接下青榆协作项目，是因为每季度都能重新谈合作方式。'
const hypothesisPrompt = '我拒绝过两次长期合作，但有一次主动续约。可以帮我看看差别吗？'
const hypothesisText = '不是一概排斥长期合作，能不能重新谈条件会不会才是区别？'
const hypothesisCounterpoint = '主动续约是反例：有时即使长期合作，我也愿意继续。'
const topicCorrection = '不是重谈条件，我当时其实不信任那个负责人。'
const topicDiary = '续约之前我先要求写清楚变更工作范围时的流程。'
let topicFixture
const oldChatPrompt = '能查证我以前是怎样决定合作的吗？'
const chatSearchPhrase = '查对话原文：青榆协作'
const secondDiary = '饮茶记录：这是另一篇不同时间的虚构原文。'
const dreamPhrase = '一只翡翠鲸鱼穿过窗框', answer = '这是一条供测试的连续回复。'
const batchA = '我第一次搬家是为了离学校近一点。'
const batchB = '我第二次搬家想换一个生活环境。'
let failSecondSegment = true
let refuseDiaries = false
const profileDiary = '搬家让我想了很久：以前我遇到陌生的地方，会先看看是不是能够适应再决定。'
const summaryRequests = []
const fakeFindings = (source, quote) => ({ articleId: null, chapter: null, hypothesis: false, counterpoint: null, title: '搬家的考虑', profileDraft: null, contextDraft: null, eventDraft: null, fact: '不同阶段搬家的理由不同。', category: 'patterns', basis: '作者说了自己的原因。', citations: [{ source, quote }] })
const contextLine = '小林和阿禾一起把我介绍进星桥团队，后来星桥团队并入远山团队。'
const person = name => ({ kind: 'person', name, role: '合作者', period: '2025', description: '参与介绍。' })
const env = name => ({ kind: 'environment', name, role: '团队', period: '2025', description: '虚构团队。' })
const relation = (from, to, label) => ({ kind: 'relation', from: { kind: from.kind, name: from.name }, to: { kind: to.kind, name: to.name }, label, period: '2025' })
const drafts = [person('小林'), person('阿禾'), env('星桥团队'), env('远山团队'), relation(person('小林'), person('阿禾'), '一起介绍'), relation(person('小林'), env('星桥团队'), '帮我加入'), relation(env('星桥团队'), env('远山团队'), '并入')]
const discovery = []
const mock = createServer(async (req, res) => {
  if (req.url.endsWith('/models')) {
    discovery.push({ url: req.url, authorization: req.headers.authorization })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'test-choice' }, { id: 'test-only' }, { id: 'test-choice' }] }))
  }
  let raw = ''; for await (const part of req) raw += part
  const reqBody = JSON.parse(raw)
  if (req.url.endsWith('/responses')) {
    summaryRequests.push(reqBody)
    res.writeHead(404, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: { message: 'Responses not supported by fixture' } }))
  }
  requests.push(reqBody)
  const all = JSON.stringify(reqBody.messages)
  const base = { id: 'becoming-me-test', created: 1760000000, model: 'test-only' }
  const system = reqBody.messages.find(m => m.role === 'system')?.content ?? ''
  const isRead = system.includes('你在同一次请求中拿到整批日记')
  const isMerge = system.includes('不同段材料的编辑草稿')
  if (system.includes('用户已经挑选同一主题的旧条目')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ...base, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '长期合作的选择有例外，须结合信任和当时的约束。' } }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } }))
  }
  if (isRead || isMerge) {
    const input = JSON.parse(reqBody.messages.filter(m => m.role === 'user').at(-1).content)
    const payload = JSON.stringify(input.diaries ?? input)
    if (isRead && refuseDiaries) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'must-not-leak-provider-detail', code: 'invalid_api_key' } }))
    }
    if (isRead && payload.includes(batchB) && failSecondSegment) {
      failSecondSegment = false
      res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'synthetic failure' } }))
    }
    const items = JSON.stringify({ elements: isMerge ? [{ ...fakeFindings(1, batchA), citations: [{ source: 1, quote: batchA }, { source: 2, quote: batchB }] }]
      : payload.includes(contextLine) ? [...drafts.map(contextDraft => ({ ...fakeFindings(1, contextLine), contextDraft })), { ...fakeFindings(1, '伪造引文'), contextDraft: person('假名') }]
      : payload.includes(topicDiary) ? [
          { ...fakeFindings(1, topicDiary), articleId: input.articleIndex.find(a => a.id === topicFixture.articleId)?.id ?? null, title: '变更范围的流程', fact: '一次续约前，我特意要求写清楚工作范围的变更流程。' },
        ] : payload.includes(profileDiary) ? [
          { ...fakeFindings(1, profileDiary), title: '搬家与探索新环境', fact: '搬家经历提示需要区分探索和适应。', profileDraft: { targetId: null, theme: 'openness', kind: 'observation', limits: '仅针对搬家；不是人格结论。', question: '搬工作室到城东时，是想试新环境，还是有现实原因？' } },
          { ...fakeFindings(1, profileDiary), title: '陌生环境的考量', fact: '本人以前会先看能不能适应。', profileDraft: { targetId: null, theme: 'environment', kind: 'self', limits: '说的是以前。', question: '' } },
          { ...fakeFindings(1, '模型伪造的日记原话'), title: '伪造画像', profileDraft: { targetId: null, theme: 'values', kind: 'self', limits: '', question: '' } },
        ] : [fakeFindings(1, payload.includes(batchA) ? batchA : batchB)] })
    const finish_reason = reqBody.tools ? 'tool_calls' : 'stop'
    const toolFunction = reqBody.tools && { name: reqBody.tools[0].function.name, arguments: items }
    const message = { role: 'assistant', ...(toolFunction ? { content: null, tool_calls: [{ id: 'fixture-tool', type: 'function', function: toolFunction }] } : { content: items }) }
    const usage = { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 }
    if (!reqBody.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ...base, choices: [{ index: 0, finish_reason, message }], usage }))
    }
    if (toolFunction) message.tool_calls[0].index = 0
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = (delta, reason, usage) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: reason }], usage })}\n\n`
    return res.end(chunk(message, null) + chunk({}, finish_reason, usage) + 'data: [DONE]\n\n')
  }
  if (reqBody.stream) {
    const userMessage = reqBody.messages.filter(m => m.role === 'user').at(-1)?.content
    if ((userMessage === '测试不支持工具的对话服务' || userMessage === chatSearchPhrase) && reqBody.tools) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'tools are not supported by this model' } }))
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (userMessage === '我以前有哪些重要搬迁？' && reqBody.tools?.some(t => t.function.name === 'search_diary') && !reqBody.messages.some(m => m.role === 'tool')) {
      const delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'call-diary', type: 'function', function: { name: 'search_diary', arguments: JSON.stringify({ query: '水晶鸢尾工作室', scope: 'all' }) } }] }
      const chunk = choices => `data: ${JSON.stringify({ ...base, choices })}\n\n`
      res.write(chunk([{ index: 0, delta, finish_reason: null }]))
      return res.end(chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]) + 'data: [DONE]\n\n')
    }
    if (userMessage === oldChatPrompt && reqBody.tools?.some(t => t.function.name === 'search_chat_history') && !reqBody.messages.some(m => m.role === 'tool')) {
      const delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'call-chat-history', type: 'function', function: { name: 'search_chat_history', arguments: JSON.stringify({ query: '青榆协作', period: '2019-04' }) } }] }
      res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
      return res.end('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n')
    }
    const replyText = userMessage === oldChatPrompt || userMessage === chatSearchPhrase
      ? ['你说过「' + oldChatQuote + '」【对话原文-1】。', '【对话原文-99】'] : ['这是一条', '供测试的连续回复。']
    for (const text of replyText) res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`)
    return res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`)
  }
  const structured = reqBody.response_format || reqBody.tools
  const plainEvent = { kind: 'event', title: '搬迁水晶鸢尾工作室', content: '搬到城东并重新开门。', basis: '影响了工作地点。', counterpoint: '', category: 'life_events', eventIds: [], articleId: null, chapter: null, quote: diaryQuote,
    eventDraft: { date: '2023-07', cause: '原址租约结束。', outcome: '一周后重新开门。' } }
  let context
  try { context = JSON.parse(reqBody.messages.at(-1).content).context } catch {}
  const src = context?.diaryArchive?.sources.find(source => source.quote.includes(diaryQuote))
  const items = src ? [{ ...plainEvent, sourceRef: src.id }, { ...plainEvent, sourceRef: src.id, title: '错误原话', content: '不该存入的假证据', quote: '这句话来自模型编造' }] : []
  const updates = []
  let lastUserMessage
  try { lastUserMessage = JSON.parse(reqBody.messages.at(-1).content).user } catch {}
  if (lastUserMessage === oldChatPrompt) {
    const historical = context?.chatArchive?.sources.find(source => source.quote.includes(oldChatQuote))
    if (historical) items.push({ ...plainEvent, kind: 'article', title: '决策考虑', content: '青榆协作中可重新谈判是一个考虑。', quote: oldChatQuote,
      sourceRef: historical.id, articleId: context.comparison?.selected.find(d => d.kind === 'article')?.id ?? null, eventDraft: null },
    { ...plainEvent, kind: 'question', title: '伪造历史原话', content: '拒绝伪造的旧引文。', quote: '青榆协作是假引文', sourceRef: historical.id, eventDraft: null })
  }
  if (lastUserMessage === hypothesisPrompt) items.push({ ...plainEvent, kind: 'question', title: '长期合作的条件', content: hypothesisText,
    basis: '两次拒绝和一次续约可以对照。', counterpoint: hypothesisCounterpoint, category: 'patterns', eventIds: topicFixture.eventIds,
    articleId: topicFixture.articleId, quote: hypothesisPrompt, sourceRef: null, eventDraft: null })
  if (lastUserMessage === topicCorrection && context?.revisionBase?.sourceId === topicFixture?.articleId) items.push({ ...plainEvent, kind: 'article',
    title: '长期合作的条件', content: '长期合作并不总是被拒绝。在那次拒绝里，对负责人的信任才是主要因素。',
    basis: '本人更正了我的解释。', counterpoint: '只适用于那次拒绝，其他案例还待核对。', category: 'patterns',
    eventIds: topicFixture.eventIds, articleId: topicFixture.articleId, quote: topicCorrection, sourceRef: null, eventDraft: null })
  const target = context?.profile?.find(f => f.theme === 'openness')
  if (structured && lastUserMessage === chatSelf) updates.push({ targetId: null, theme: 'values', kind: 'self', title: '时间自主权', observation: '接项目时，重视能自己安排时间。', limits: '针对选择项目。', question: '', reason: '本轮明确自述。', quote: chatSelf })
  if (structured && target && lastUserMessage === profileReply) updates.push({ targetId: target.id, theme: target.theme,
    kind: 'correct', title: '搬家是适应租约变化', observation: '本人澄清搬家并不是为了探索；那次更愿意留在熟悉的地方。',
    limits: '仅指这次搬家。', question: '', reason: '本人补上了租约结束这一实际原因。', quote: profileReply })
  if (structured && lastUserMessage === profileReply) updates.push({ targetId: null, theme: 'openness', kind: 'self',
    title: '伪造引用', observation: '编造的说法。', limits: '', question: '', reason: '', quote: '并不存在的原话' })
  const content = structured ? JSON.stringify({ items, summary: '', focusedCorrection: lastUserMessage === topicCorrection ? topicCorrection : all.includes(correction) ? correction : null, profileUpdates: updates }) : '这个梦可以让你回想哪些情境里感到惊讶；它本身不证明性格。'
  const msg = reqBody.tools ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-becoming-me', type: 'function', function: { name: reqBody.tools[0].function.name, arguments: content } }] } : { role: 'assistant', content }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...base, choices: [{ index: 0, finish_reason: reqBody.tools ? 'tool_calls' : 'stop', message: msg }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } }))
})
mock.listen(0, '127.0.0.1'); await once(mock, 'listening')
const pg = await PGlite.create()
const socket = new PGLiteSocketServer({ db: pg, host: '127.0.0.1', port: 0 }); await socket.start()
try {
  Object.assign(process.env, { DATABASE_URL: `postgres://becoming_me@${socket.getServerConn()}/postgres?sslmode=disable`, NODE_ENV: 'development', BECOMING_ME_LOCAL: '1', OPENAI_API_KEY: 'unused-fake', OPENAI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, LLM_PROVIDER: 'openai', LLM_MODEL: 'test-only' })
  const { db, initDatabase, ensureDefaultUser, DEFAULT_USER_ID } = await import('../packages/server/src/db/client.ts')
  const { interviewDiaryBatches, personalVectors } = await import('../packages/server/src/db/schema.ts')
  const { personalRoute } = await import('../packages/server/src/routes/personal.ts')
  const { diaryRoute } = await import('../packages/server/src/routes/diary.ts')
  const { interviewHistoryRoute } = await import('../packages/server/src/routes/interviewHistory.ts')
  const { getState, hash } = await import('../packages/server/src/personal/store.ts')
  const { bookSections, eventImportance, hasTopics, turningEvents } = await import('../packages/server/src/personal/reading.ts')
  await initDatabase(); await ensureDefaultUser()
  const app = new Hono(); app.use('*', async (c, next) => { c.set('db', db); c.set('userId', DEFAULT_USER_ID); await next() }); app.route('/diary', diaryRoute); app.route('/history', interviewHistoryRoute); app.route('/', personalRoute)
  const req = async (path, data, method = data ? 'POST' : 'GET') => { const r = await app.request(path, { method, ...(data && { body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } }) }); assert(r.ok, `${method} ${path} → ${r.status}: ${r.ok ? '' : await r.text()}`); return r }
  const get = async (...args) => (await req(...args)).json()
  const noProfileSource = await app.request('/profile/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"includeDiaries":false}' })
  assert.equal(noProfileSource.status, 404)
  assert.equal((await get('/profile')).report, null)
  const settings = await get('/settings')
  assert.deepEqual(settings, { model: 'test-only', apiBaseUrl: process.env.OPENAI_BASE_URL, keyConfigured: true, embeddingModel: 'bge-m3:latest', embeddingsEnabled: true })
  assert.equal((await get('/settings/check', { target: 'chat' })).state, 'ready')
  assert.match(JSON.stringify(requests.pop()), /虚构的连通性测试/)
  assert.equal((await get('/settings/check', { target: 'embedding' })).state, 'ready')
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
  const retrievalStart = requests.length
  const implicit = await (await req('/chat', { message: '我以前有哪些重要搬迁？', mode: 'event' })).text()
  const retrievalRequests = requests.slice(retrievalStart).filter(r => r.stream)
  assert.equal(retrievalRequests.length, 2)
  assert(!JSON.stringify(retrievalRequests[0]).includes(diaryQuote), 'send archive only after retrieval')
  assert(retrievalRequests[1].messages.some(m => m.role === 'tool' && m.content.includes(diaryQuote)))
  assert.match(implicit, /"phase":"diary"/); assert.match(implicit, /"type":"saved"/)
  assert((await get('/chat')).messages.at(-1).evidence.some(e => e.quote.includes(diaryQuote)))
  const blockedStart = requests.length
  const blocked = await (await req('/chat', { message: '查找2023年日记中的搬迁', mode: 'chat', allowDiary: false })).text()
  assert.doesNotMatch(blocked, /"phase":"diary"/)
  assert(!requests[blockedStart].tools.some(t => t.function.name === 'search_diary'))
  const idle = await (await req('/chat', { message: '你好，随便聊聊', mode: 'chat' })).text()
  assert.doesNotMatch(idle, /"phase":"(?:diary|memory)"/)
  const fallback = await (await req('/chat', { message: '测试不支持工具的对话服务' })).text()
  assert.match(fallback, /"type":"saved"/)
  assert.match(fallback, /不支持模型自主检索/)
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
  const environment = await get('/contexts', { kind: 'environment', name: '城东社区工坊', period: '2020–2021', eventIds: [e.id] })
  const person = await get('/contexts', { kind: 'person', name: '虚构师傅', aliases: [' 工坊老陈 ', '虚构师傅', 'Ｔｅｓｔ', 'test'], role: '项目导师', eventIds: [e.id, e.id], links: [{ targetId: environment.id, label: '在工坊认识' }] })
  assert.deepEqual(person.eventIds, [e.id])
  assert.deepEqual(person.aliases, ['工坊老陈', 'Ｔｅｓｔ'])
  const aliasLookup = await get('/search?q=' + encodeURIComponent('工坊老陈'))
  assert(aliasLookup.hits.some(h => h.sourceId === person.id && h.kind === 'context'), 'aliases should be searchable')
  const revised = await get(`/contexts/${person.id}`, { ...person, aliases: undefined, impact: '让我试着接独立项目。' }, 'PATCH')
  assert.equal(revised.impact, '让我试着接独立项目。')
  assert.deepEqual(revised.aliases, person.aliases, 'omitted aliases preserve confirmed names')
  const bad = await app.request(`/contexts/${person.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...person, links: [{ targetId: person.id, label: '自身关联' }] }) })
  assert.equal(bad.status, 400)
  const contextLookup = await get('/search?q=' + encodeURIComponent('城东社区工坊'))
  assert(contextLookup.hits.some(h => h.sourceId === environment.id && h.kind === 'context' && h.relatedEventIds.includes(e.id)))
  const scopedEvent = await get('/events', { title: '在工坊参加活动', facts: '第一次参加课程。', contextIds: [person.id, environment.id, person.id] })
  const linkedCards = async () => (await get('/')).contexts.filter(c => c.eventIds.includes(scopedEvent.id)).map(c => c.id).sort()
  assert.deepEqual(await linkedCards(), [person.id, environment.id].sort(), 'event creates a canonical link on each selected card')
  await get('/events/' + scopedEvent.id, { ...scopedEvent, outcome: '后来继续参加' }, 'PATCH')
  assert.deepEqual(await linkedCards(), [person.id, environment.id].sort(), 'unrelated event edits preserve links')
  const invalid = await app.request('/events/' + scopedEvent.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...scopedEvent, contextIds: ['missing'] }) })
  assert.equal(invalid.status, 404)
  assert.deepEqual(await linkedCards(), [person.id, environment.id].sort(), 'invalid updates change nothing')
  await get('/events/' + scopedEvent.id, { ...scopedEvent, contextIds: [] }, 'PATCH')
  assert.deepEqual(await linkedCards(), [], 'clearing event links does not delete the records')
  const relatedState = await get('/')
  assert(relatedState.events.some(event => event.id === scopedEvent.id))
  assert(relatedState.contexts.find(c => c.id === person.id).eventIds.includes(e.id), 'other events remain attached')
  const direct = await get('/events/' + scopedEvent.id, { ...scopedEvent, date: '2020-05', contextIds: [person.id] }, 'PATCH')
  await get('/contexts/' + person.id, { ...revised, eventIds: [e.id, direct.id], links: [{ ...revised.links[0], eventIds: [direct.id] }] }, 'PATCH')
  const links = indexEventContexts((await get('/')).contexts).get(scopedEvent.id)
  assert.equal(links.get(person.id).direct, true)
  assert.equal(links.get(environment.id).direct, false, 'the other end can navigate through a confirmed relationship')
  const scopedLookup = await get('/search?q=' + encodeURIComponent('参加活动 城东社区工坊'))
  assert(scopedLookup.hits.some(h => h.sourceId === scopedEvent.id && h.text.includes('城东社区工坊')))
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
  const separate = requests.length
  await (await req('/chat', { mode: 'chat', message: '现在显式切回工作' })).text()
  assert(!requests.slice(separate).some(r => JSON.stringify(r).includes(dreamPhrase)))
  assert.equal((await get('/chat')).messages.at(-1).dream, false)
  await get('/focus', { dreamId: null }); await (await req('/chat', { message: '现在聊工作' })).text()
  assert(!requests.slice(-2).some(r => JSON.stringify(r).includes(dreamPhrase) || JSON.stringify(r).includes('聊聊这个梦')))
  const exportText = async path => { const zip = await JSZip.loadAsync(await (await req(path)).arrayBuffer()); return (await Promise.all(Object.values(zip.files).filter(f => !f.dir).map(f => f.async('string')))).join('\n') }
  const book = await exportText('/book.zip'); assert(book.includes(original) && book.includes('走出校园') && book.includes('观点演变')); assert(!book.includes(dreamPhrase) && !book.includes(draftDreamPhrase)); assert(book.includes('原址租约结束。') && book.includes('一周后重新开门。')); assert(book.includes('大事和转折') && book.includes('职业选择、自主性') && book.includes('人生转折'))
  assert((await exportText('/book.zip?volume=dreams')).includes(dreamPhrase))
  assert(book.includes('城东社区工坊') && book.includes('虚构师傅') && book.includes('让我试着接独立项目。'))
  assert(book.includes('工坊老陈'), 'aliases are exported in the person card')
  await req(`/contexts/${environment.id}`, undefined, 'DELETE')
  assert(!(await get('/')).contexts.find(c => c.id === person.id).links.length)
  assert((await get('/')).events.some(x => x.id === e.id), 'deleting card does not delete events')
  const longArchive = { entries: [
    { date: '2025-01-04', content: batchA + '甲'.repeat(13_000) },
    { date: '2026-03-08', content: batchB + '乙'.repeat(6_500) },
  ] }
  const savedLong = await get('/diary-sources', longArchive)
  const beforeBrowsing = requests.length
  const written = await get('/diary-sources', { origin: 'journal', entries: [
    { date: '2025-01-04', filename: '当天的第二篇', content: ' 中\n 文　🙂' },
    { date: null, filename: '未知日期', content: '这篇不会出现在月历' },
  ] })
  const calendar = await get('/history/diary-calendar?month=2025-01')
  const january = calendar.entries.filter(entry => entry.date === '2025-01-04')
  assert.deepEqual(january.find(entry => entry.batchId === written.id), {
    date: '2025-01-04', batchId: written.id, index: 0, filename: '当天的第二篇', characters: 3,
  })
  assert.equal(january.find(entry => entry.batchId === savedLong.id).characters, Array.from(longArchive.entries[0].content.replace(/\s/gu, '')).length)
  assert(!calendar.entries.some(entry => Object.hasOwn(entry, 'content') || entry.filename === '未知日期'))
  assert(!calendar.entries.some(entry => entry.date === '2026-03-08'))
  assert.equal((await app.request('/history/diary-calendar?month=2025-13')).status, 400)
  const catalog = await get('/history')
  assert.equal(catalog.diaries.find(batch => batch.id === written.id).origin, 'journal')
  assert.equal(catalog.diaries.find(batch => batch.id === savedLong.id).origin, 'import')
  assert.equal(catalog.diaries.find(batch => batch.id === savedLong.id).count, 2)
  assert.equal(catalog.diaries.find(batch => batch.id === savedLong.id).hasAnalysis, false)
  const stored = await get(`/history/diaries/${savedLong.id}`)
  assert.deepEqual(stored.entries.map(entry => entry.content), longArchive.entries.map(entry => entry.content))
  assert.equal(stored.analysis, null)
  assert.equal(requests.length, beforeBrowsing, 'reading the diary library does not call the model')
  const fail = await app.request('/diary/analyze?workspace=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchId: savedLong.id }) })
  assert.equal(fail.status, 502)
  assert.deepEqual(Object.keys((await getState(db, DEFAULT_USER_ID)).diaryJobs[savedLong.id]), ['read:0'])
  assert.equal((await get('/evidence/diary/' + savedLong.id + '?index=0')).content, longArchive.entries[0].content)
  const beforeResume = requests.length
  const streamResponse = await app.request('/diary/analyze?workspace=1', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ batchId: savedLong.id }) })
  assert.match(streamResponse.headers.get('content-type'), /application\/x-ndjson/)
  const lines = (await streamResponse.text()).trim().split('\n').map(line => JSON.parse(line))
  assert(lines.some(event => event.type === 'progress' && event.phase === 'read'))
  assert(lines.some(event => event.type === 'progress' && event.phase === 'merge'))
  assert.equal(summaryRequests.length, 1, 'resume attempts public summary only for the unread segment')
  assert.equal(summaryRequests[0].reasoning.summary, 'auto')
  assert.equal(lines.at(-1).type, 'result', JSON.stringify(lines))
  const { id: resumedId, suggestions } = lines.at(-1)
  const resumed = { id: resumedId, suggestions, profileChanged: 0 }
  assert.equal(resumed.id, savedLong.id)
  assert.equal(requests.slice(beforeResume).length, 2, 'only unread segment and cross-segment merge')
  assert.deepEqual(resumed.suggestions[0].citations.map(c => c.source), [1, 2])
  assert.equal((await getState(db, DEFAULT_USER_ID)).diaryJobs?.[savedLong.id], undefined)
  const beforeRepeat = requests.length
  assert.deepEqual(await get('/diary/analyze?workspace=1', { batchId: savedLong.id }), resumed)
  assert.equal(requests.length, beforeRepeat, 'existing results are reused')
  assert.equal((await get('/')).proposals.filter(p => p.originId === savedLong.id).length, 1)
  const abandoned = await get('/diary-sources', { entries: longArchive.entries.map(entry => ({ ...entry, filename: '临时副本' })) })
  failSecondSegment = true
  const unfinished = await app.request('/diary/analyze?workspace=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchId: abandoned.id }) })
  assert.equal(unfinished.status, 502)
  assert((await getState(db, DEFAULT_USER_ID)).diaryJobs[abandoned.id]['read:0'])
  assert.equal((await req(`/history/diaries/${abandoned.id}`, undefined, 'DELETE')).status, 204)
  assert.equal((await getState(db, DEFAULT_USER_ID)).diaryJobs[abandoned.id], undefined)
  assert.equal((await app.request('/evidence/diary/' + abandoned.id + '?index=0')).status, 404)
  assert.equal((await app.request('/profile/big-five', { method: 'POST' })).status, 404)
  assert.equal((await app.request('/profile/attributes', { method: 'POST' })).status, 404)
  assert.equal((await app.request('/profile/revise', { method: 'POST' })).status, 404)
  assert.equal((await get('/profile')).report, null, 'plain fixture chat and isolated dreams did not invent a profile')
  const profileSource = await get('/diary-sources', { entries: [{ date: '2025-08-18', filename: '画像测试.txt', content: profileDiary }] })
  const diaryRequests = requests.length
  assert.deepEqual(await get('/diary/analyze?workspace=1', { batchId: profileSource.id }), { id: profileSource.id, suggestions: [], profileChanged: 2 })
  assert.equal(requests.length - diaryRequests, 1, 'profile drafts share the existing diary reading call')
  const { report: p2 } = await get('/profile')
  assert.deepEqual(p2.findings.map(f => f.theme), ['openness', 'environment'], 'fabricated quotes must not create findings')
  assert.equal(p2.findings[0].status, 'observation')
  assert.equal(p2.findings[0].evidence[0].quote, profileDiary)
  assert.equal((await get('/history/diaries/' + profileSource.id)).analysis.length, 0)
  assert.equal((await get('/')).proposals.filter(p => p.originId === profileSource.id).length, 0, 'profile drafts do not enter the inbox')
  assert.equal((await get('/diary/analyze?workspace=1', { batchId: profileSource.id })).profileChanged, 0)
  assert.equal(requests.length - diaryRequests, 1, 'the previously analysed diary is not sent again')
  const countBeforeProfile = (await get('/chat')).messages.length
  const discussion = await get('/profile/discuss', { reportId: p2.id, findingId: p2.findings[0].id })
  assert.match(discussion.question, /城东/)
  assert.equal((await get('/chat')).messages.length, countBeforeProfile, 'opening a question does not create a new thread or a fake message')
  assert.equal(requests.length - diaryRequests, 1, 'opening a discussion makes no model call')
  const profileTurn = await (await req('/chat', { message: profileReply })).text()
  assert.match(profileTurn, /"type":"saved"/)
  assert.match(profileTurn, /"profileChanged":1/)
  assert.equal(requests.length - diaryRequests, 3, 'profile revision shares ordinary chat plus its existing editorial pass')
  const history = (await get('/chat')).messages
  assert.equal(history.length, countBeforeProfile + 2)
  assert.equal(history.at(-2).content, profileReply)
  const revisedReport = (await get('/profile')).report
  assert.equal(revisedReport.id, p2.id)
  assert.equal(revisedReport.findings.length, 2)
  const revisedFinding = revisedReport.findings.find(f => f.id === p2.findings[0].id)
  assert(revisedReport.updatedAt)
  assert.match(revisedFinding.observation, /不是为了探索/)
  assert.equal(revisedFinding.status, 'self')
  assert(revisedFinding.evidence.some(e => e.kind === 'chat' && e.id === history.at(-2).id && e.quote === profileReply))
  assert.equal(revisedFinding.history.at(-1).evidence[0].quote, profileDiary)
  assert.equal((await req(`/history/diaries/${profileSource.id}`, undefined, 'DELETE')).status, 204)
  const profileAfterDelete = (await get('/profile')).report
  assert.deepEqual(profileAfterDelete.findings.map(f => f.id), [revisedFinding.id], 'deletion drops diary-derived findings, but keeps the independent chat correction')
  assert.deepEqual(profileAfterDelete.findings[0].history, [])
  assert.equal((await get('/')).focusId, discussion.id, 'the corrected discussion survives with independent evidence')
  const focusAfterDelete = (await get('/')).proposals.find(p => p.id === discussion.id)
  assert(focusAfterDelete.evidence.every(e => e.kind === 'chat'))
  const beforeSelf = requests.length
  const selfTurn = await (await req('/chat', { message: chatSelf })).text()
  assert.match(selfTurn, /"profileChanged":1/)
  assert.equal(requests.length - beforeSelf, 2)
  assert((await get('/profile')).report.findings.some(f => f.status === 'self' && f.evidence.some(e => e.quote === chatSelf)))
  const denied = await get('/diary-sources', { entries: [{ date: '2025-09-18', filename: '鉴权测试.txt', content: '鉴权测试的虚构文本。' }] })
  refuseDiaries = true
  const denial = await app.request('/diary/analyze?workspace=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchId: denied.id }) })
  refuseDiaries = false
  assert.equal(denial.status, 502)
  const denialBody = await denial.json()
  assert.match(denialBody.error, /401/)
  assert.doesNotMatch(denialBody.error, /must-not-leak-provider-detail/)
  assert.equal((await get('/evidence/diary/' + denied.id + '?index=0')).content, '鉴权测试的虚构文本。')
  const source = await get('/diary-sources', { entries: [{ date: '2025-01-07', filename: '关系资料.txt', content: contextLine }] })
  const beforeCards = (await get('/')).contexts.length
  assert.equal((await get('/diary/analyze?workspace=1', { batchId: source.id })).suggestions.length, 7)
  const suggested = (await get('/')).contextSuggestions.filter(item => item.originId === source.id)
  assert.equal(suggested.length, 7)
  assert.equal((await get('/')).contexts.length, beforeCards, 'analysis must not create formal cards')
  assert(suggested.every(s => s.evidence[0].quote === contextLine && s.evidence[0].date === '2025-01-07'))
  const sample = suggested[0], reference = { id: 'sample', evidence: sample.evidence }
  const unrelated = { ...reference, id: 'unrelated', evidence: sample.evidence.map(e => ({ ...e, index: 9 })) }
  assert.deepEqual(suggestedDiaryEvents(sample, [reference, unrelated]), [reference.id])
  const ids = new Map()
  for (const s of suggested.filter(s => s.draft.kind !== 'relation')) {
    const name = s.draft.name === '小林' ? '林同学' : s.draft.name
    if (s.draft.name === '阿禾') {
      const existing = await get('/contexts', { kind: 'person', name: '禾同学', aliases: ['阿禾'] })
      const input = { ...s.draft, name, action: 'card' }
      const conflict = await app.request('/context-suggestions/' + s.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
      assert.equal(conflict.status, 409, 'an alias match requires explicit confirmation of the existing card')
      const saved = await get('/context-suggestions/' + s.id, { ...input, name: existing.name, target: existing.id })
      assert.equal(saved.id, existing.id)
      assert.deepEqual((await get('/')).contexts.find(c => c.id === saved.id).aliases, ['阿禾'])
      ids.set(s.draft.name, saved.id)
    } else ids.set(s.draft.name, (await get('/context-suggestions/' + s.id, { ...s.draft, name, action: 'card' })).id)
  }
  const namedCards = mentionedDiaryCards(sample.evidence, (await get('/')).contexts)
  assert(namedCards.includes(ids.get('阿禾')) && namedCards.includes(ids.get('星桥团队')))
  assert(!namedCards.includes(ids.get('小林')), 'renamed cards are not assumed to be the same person')
  const lin = (await get('/')).contexts.find(c => c.id === ids.get('小林'))
  const aliasCard = await get('/contexts/' + lin.id, { ...lin, aliases: ['小林', '阿禾'] }, 'PATCH')
  const aliasCards = (await get('/')).contexts
  assert(mentionedDiaryCards(sample.evidence, aliasCards).includes(lin.id), 'confirmed aliases are review cues')
  assert.deepEqual(suggestedDiaryEvents(sample, [{ ...reference, evidence: sample.evidence.map(e => ({ ...e, quote: '林同学介绍我入职。' })) }], aliasCards), [reference.id])
  const cleared = await get('/contexts/' + lin.id, { ...aliasCard, aliases: [] }, 'PATCH')
  assert.deepEqual(cleared.aliases, [])
  for (const s of suggested.filter(s => s.draft.kind === 'relation')) {
    const fromId = ids.get(s.draft.from.name), toId = ids.get(s.draft.to.name)
    const input = { action: 'relation', fromId, toId, label: s.draft.label + '（核对后）', period: '2025年初' }
    const same = await app.request('/context-suggestions/' + s.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, toId: fromId }) })
    assert.equal(same.status, 400)
    await get('/context-suggestions/' + s.id, input)
    const link = (await get('/')).contexts.find(c => c.id === fromId).links.find(l => l.targetId === toId)
    assert.equal(link.label, input.label); assert.equal(link.evidence[0].quote, contextLine)
  }
  assert.equal((await get('/evidence/diary/' + source.id + '?index=0')).content, contextLine)
  const draftId = (await get('/')).proposals.find(p => p.originId === savedLong.id).id
  const keys = [`日记原文-${hash(['2025-01-04',longArchive.entries[0].content])}-0`, `日记分析-${draftId}`]
  for (const documentId of keys) await db.insert(personalVectors).values({ userId: DEFAULT_USER_ID, documentId, signature: 'test-fixture', embedding: [1] }).onConflictDoNothing()
  await get('/focus', { diaryId: savedLong.id })
  await req('/history/diaries/' + savedLong.id, undefined, 'DELETE')
  const afterDelete = await get('/')
  assert(!afterDelete.proposals.some(p => p.id === draftId)); assert.equal(afterDelete.diaryFocusId, undefined)
  assert(!(await db.select().from(personalVectors)).some(v => keys.includes(v.documentId)))
  assert((await get('/history')).diaries.some(d => d.id === written.id))
  await req('/history/diaries/' + source.id, undefined, 'DELETE')
  assert.equal((await get('/')).contexts.length, beforeCards + 4, 'confirmed cards and relationships are retained')
  // Use synthetic old messages outside the recent window. None comes from the real local database.
  const { personalSession, saveTurn } = await import('../packages/server/src/personal/store.ts')
  const { rawLogs: chatLogs } = await import('../packages/server/src/db/schema.ts')
  const fixtureSession = personalSession(DEFAULT_USER_ID)
  const assistantOnly = '青榆协作：这句话只有助手说过。'
  const wrongDate = '青榆协作：这是别的月份说的话。'
  const privateOnly = '昨晚梦见青榆协作：这是隔离的梦境。'
  const recalledId = 'old-chat-quote-fixture'
  const longOriginal = '（旧消息的前文）' + '略。'.repeat(600) + oldChatQuote + '（后续上下文）'
  await db.insert(chatLogs).values([
    { id: recalledId, userId: DEFAULT_USER_ID, sessionId: fixtureSession, role: 'user', content: longOriginal, createdAt: new Date('2019-04-04T18:00:00Z') },
    { id: 'old-chat-assistant-fixture', userId: DEFAULT_USER_ID, sessionId: fixtureSession, role: 'assistant', content: assistantOnly, createdAt: new Date('2019-04-05T00:00:00Z') },
    { id: 'wrong-date-chat-fixture', userId: DEFAULT_USER_ID, sessionId: fixtureSession, role: 'user', content: wrongDate, createdAt: new Date('2019-05-05T00:00:00Z') },
  ])
  await saveTurn(db, DEFAULT_USER_ID, privateOnly, '隔离梦境回复', [], undefined, true)
  await get('/focus', { comparison: { articleId: a.id, eventId: e.id } })
  const oldChatStart = requests.length
  const chaptersBefore = (await get('/')).articles.length
  const oldChatResult = (await (await req('/chat', { message: oldChatPrompt })).text()).trim().split('\n').map(line => JSON.parse(line))
  const historicalCalls = requests.slice(oldChatStart).filter(r => r.stream)
  assert.equal(historicalCalls.length, 2)
  assert(!JSON.stringify(historicalCalls[0]).includes(oldChatQuote), 'old turns are not sent before the model asks')
  const toolMessage = historicalCalls[1].messages.find(m => m.role === 'tool')
  assert(toolMessage.content.includes(oldChatQuote) && toolMessage.content.includes('2019-04-05'))
  for (const excluded of [assistantOnly, wrongDate, privateOnly]) assert(!toolMessage.content.includes(excluded))
  assert(oldChatResult.some(frame => frame.type === 'progress' && frame.phase === 'chat-history'))
  const oldChatSaved = oldChatResult.find(frame => frame.type === 'saved')
  const linkedQuote = oldChatSaved.evidence.find(e => e.label === '对话原文-1')
  assert.equal(linkedQuote.kind, 'chat'); assert.equal(linkedQuote.id, recalledId)
  assert(!oldChatSaved.evidence.some(e => e.label === '对话原文-99'))
  assert.equal((await get('/evidence/chat/' + linkedQuote.id)).content, longOriginal)
  assert.deepEqual((await get('/chat')).messages.at(-1).evidence, oldChatSaved.evidence)
  const afterChatRecall = await get('/')
  const articleDraft = afterChatRecall.proposals.find(p => p.chatReplyId === oldChatSaved.id)
  assert.equal(articleDraft.articleId, a.id)
  assert.deepEqual(articleDraft.evidence[0], { kind: 'chat', id: recalledId, quote: oldChatQuote, date: '2019-04-05' })
  assert(!afterChatRecall.proposals.some(p => p.title === '伪造历史原话'))
  assert.equal(afterChatRecall.articles.length, chaptersBefore, 'historical evidence cannot automatically save an article')
  assert((await db.select().from(personalVectors)).some(v => v.documentId.startsWith('对话原文-' + recalledId)), 'history uses the local embedding model')
  await get('/search?q=' + encodeURIComponent('合作考虑'))
  assert((await db.select().from(personalVectors)).some(v => v.documentId.startsWith('对话原文-' + recalledId)), 'archive search does not delete chat vectors')
  // The editor proposes hypotheses, keeps discussion in the same chat and cannot overwrite a newer article.
  const cases = await Promise.all(['拒绝合作一', '拒绝合作二', '主动续约'].map((title, i) => get('/events', { title, date: `2025-0${i + 1}`, facts: `${title}，这是测试事件。` })))
  const topicBase = { title: '长期合作的条件', category: 'patterns', chapter: 'decisions', fact: '我试过拒绝长期合作，也试过主动续约。', eventIds: cases.map(e => e.id) }
  const topic = await get('/articles', topicBase)
  topicFixture = { articleId: topic.id, eventIds: topicBase.eventIds }
  const beforeTopic = (await get('/')).articles.length
  const hypothesisTurn = await (await req('/chat', { message: hypothesisPrompt })).text()
  assert.doesNotMatch(hypothesisTurn, /warning/)
  const hypothesis = (await get('/')).proposals.find(p => p.title === '长期合作的条件' && p.kind === 'question')
  assert.equal(hypothesis.articleId, topic.id)
  assert.equal(hypothesis.counterpoint, hypothesisCounterpoint)
  assert.deepEqual(hypothesis.eventIds, topicBase.eventIds)
  assert.equal(hypothesis.evidence[0].quote, hypothesisPrompt)
  const chatBeforeFocus = (await get('/chat')).messages
  await get('/focus', { id: hypothesis.id })
  assert.deepEqual((await get('/chat')).messages, chatBeforeFocus, 'opening a hypothesis does not start a new conversation or insert synthetic messages')
  const firstVersion = (await get('/')).articles.find(a => a.id === topic.id).version
  const correctionTurn = await (await req('/chat', { message: topicCorrection })).text()
  assert.doesNotMatch(correctionTurn, /warning/)
  const afterCorrection = await get('/')
  const topicDraft = afterCorrection.proposals.find(p => p.articleId === topic.id && p.operation === 'revise')
  assert.equal(afterCorrection.proposals.find(p => p.id === hypothesis.id).correction, topicCorrection)
  assert.equal(topicDraft.baseVersion, firstVersion)
  assert.equal(topicDraft.evidence[0].quote, topicCorrection)
  assert.equal((await get('/evidence/chat/' + topicDraft.evidence[0].id)).content, topicCorrection)
  assert.equal((await get(`/articles/${topic.id}/history`)).revisions.length, 1)
  const proposalBody = { action: 'article', target: topic.id, article: topicBase }
  await get(`/articles/${topic.id}`, { ...topicBase, fact: '我手动更新了对这几次合作的描述。', version: firstVersion }, 'PATCH')
  for (const quick of [true, false]) {
    const stale = await app.request('/proposals/' + topicDraft.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...proposalBody, quick }) })
    assert.equal(stale.status, 409, 'neither approval path can overwrite a manual edit with a stale replacement')
  }
  const latest = (await get('/')).articles.find(a => a.id === topic.id)
  assert.equal(latest.fact, '我手动更新了对这几次合作的描述。')
  await req('/chat', { message: topicCorrection }).then(r => r.text())
  const redraft = (await get('/')).proposals.find(p => p.articleId === topic.id && p.operation === 'revise' && p.baseVersion === latest.version)
  await get('/proposals/' + redraft.id, { ...proposalBody, quick: true })
  const savedTopic = (await get('/')).articles.find(a => a.id === topic.id)
  assert.equal(savedTopic.fact, redraft.content)
  assert.equal((await get('/')).articles.length, beforeTopic)
  assert.equal((await get(`/articles/${topic.id}/history`)).revisions.length, 3)
  const topicSource = await get('/diary-sources', { entries: [{ date: '2025-03-15', filename: '续约.txt', content: topicDiary }] })
  await get('/diary/analyze?workspace=1', { batchId: topicSource.id })
  const topicSupplement = (await get('/')).proposals.find(p => p.originId === topicSource.id)
  assert.equal(topicSupplement.articleId, topic.id)
  assert.equal(topicSupplement.operation, 'supplement')
  await get('/proposals/' + topicSupplement.id, { ...proposalBody, target: undefined, quick: true })
  const supplemented = (await get('/')).articles.find(a => a.id === topic.id)
  assert.equal(supplemented.fact, `${savedTopic.fact}\n\n${topicSupplement.content}`)
  assert.equal((await get('/')).articles.length, beforeTopic)
  const mergeIds = [topic.id, a.id]
  const beforePreview = (await get('/')).articles
  const preview = await get('/articles/merge-preview', { ids: mergeIds })
  assert.deepEqual((await get('/')).articles, beforePreview, 'preview is read only')
  await get(`/articles/${a.id}`, { ...article, fact: '归并预览后发生了一次手动修改。' }, 'PATCH')
  const mergeBody = { ids: mergeIds, mark: preview.mark, title: preview.article.title, fact: preview.article.fact }
  const invalidMerge = await app.request('/articles/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mergeBody) })
  assert.equal(invalidMerge.status, 409)
  assert.equal((await get('/')).articles.find(row => row.id === a.id).deleted, false)
  const freshPreview = await get('/articles/merge-preview', { ids: mergeIds })
  assert.equal((await get('/articles/merge', { ...mergeBody, mark: freshPreview.mark })).id, topic.id)
  const afterMerge = (await get('/')).articles
  const mergedTopic = afterMerge.find(row => row.id === topic.id)
  assert.deepEqual(mergedTopic.eventIds, [...topicBase.eventIds, e.id])
  assert(mergedTopic.evidence.some(e => e.id === topicSource.id && e.quote === topicDiary))
  assert(mergedTopic.evidence.some(e => e.quote === topicCorrection))
  assert.equal(afterMerge.find(row => row.id === a.id).deleted, true)
  const mergedAway = (await get(`/articles/${a.id}/history`)).revisions
  await get(`/articles/${a.id}/restore`, { index: mergedAway.length - 2 })
  assert.equal((await get('/')).articles.find(row => row.id === a.id).fact, '归并预览后发生了一次手动修改。')
  const oldEmbeddingSetting = process.env.BECOMING_ME_EMBEDDINGS
  process.env.BECOMING_ME_EMBEDDINGS = '0'
  try {
    const directChatResult = await (await req('/chat', { message: chatSearchPhrase })).text()
    assert.match(directChatResult, /"phase":"chat-history"/)
    assert.match(directChatResult, /不支持模型自主检索/)
    assert((await get('/chat')).messages.at(-1).evidence.some(e => e.id === recalledId), 'explicit keyword lookup still works without tools or embeddings')
  } finally { if (oldEmbeddingSetting === undefined) delete process.env.BECOMING_ME_EMBEDDINGS; else process.env.BECOMING_ME_EMBEDDINGS = oldEmbeddingSetting }
  const chatDreamStart = requests.length
  await (await req('/chat', { mode: 'dream', message: chatSearchPhrase })).text()
  assert(!requests[chatDreamStart].tools && !JSON.stringify(requests[chatDreamStart]).includes(oldChatQuote), 'dream mode does not search normal history')

  // Exercise maintenance with private storage redirected to a fresh temporary project.
  const cwd = process.cwd(), tempRoot = tmpdir(), temp = await mkdtemp(join(tempRoot, 'becoming-me-test-'))
  try {
    process.chdir(temp)
    const base = settings.apiBaseUrl
    const { loadLocalAI, applySavedLocalAI } = await import('../packages/server/src/personal/localAI.ts')
    const { trackLocalRequest } = await import('../packages/server/src/personal/maintenance.ts')
    const { sessions, rawLogs, users } = await import('../packages/server/src/db/schema.ts')
    assert.deepEqual((await get('/settings/models', { apiBaseUrl: base + '/chat/completions' })).models, ['test-choice', 'test-only'])
    assert.equal(discovery.at(-1).authorization, 'Bearer unused-fake')
    await get('/settings/models', { apiBaseUrl: base + '/other' })
    assert.equal(discovery.at(-1).authorization, undefined, 'do not reuse a key for a different endpoint')
    const suppliedKey = 'smoke-new-test-api-key'
    const detected = await get('/settings/models', { apiBaseUrl: base, apiKey: suppliedKey })
    assert.equal(discovery.at(-1).authorization, 'Bearer ' + suppliedKey)
    assert(!JSON.stringify(detected).includes(suppliedKey))
    const updated = await get('/settings/ai', { apiBaseUrl: base, apiKey: suppliedKey, model: 'test-choice' })
    assert.equal(updated.model, 'test-choice'); assert(!JSON.stringify(updated).includes(suppliedKey))
    assert(!String(await readFile(join('data', 'ai-settings.local.json'), 'utf8')).includes(suppliedKey))
    delete process.env.OPENAI_API_KEY; process.env.LLM_MODEL = 'unset-before-reload'
    await applySavedLocalAI(await loadLocalAI())
    assert.equal(process.env.OPENAI_API_KEY, suppliedKey); assert.equal(process.env.LLM_MODEL, 'test-choice')
    assert.equal((await get('/settings/check', { target: 'chat' })).state, 'ready')
    assert.equal(requests.at(-1).model, 'test-choice')

    const priorChat = (await get('/chat')).messages
    assert(priorChat.length > 0)
    const oldSession = 'fixture-old-interview', otherUser = 'fixture-other-profile'
    await db.insert(users).values({ id: otherUser })
    await db.insert(sessions).values([{ id: oldSession, userId: DEFAULT_USER_ID }, { id: 'fixture-other-interview', userId: otherUser }])
    await db.insert(rawLogs).values([{ id: 'fixture-old-interview-msg', userId: DEFAULT_USER_ID, sessionId: oldSession, role: 'user', content: '旧访谈原文' },
      { id: 'fixture-other-msg', userId: otherUser, sessionId: 'fixture-other-interview', role: 'user', content: '另一账户不应被改动' }])
    const manual = (await get('/settings/backups', {})).backup
    const rawBackup = await readFile(manual.path, 'utf8')
    assert(!rawBackup.includes(suppliedKey) && !rawBackup.includes('另一账户不应被改动'))
    const saved = JSON.parse(rawBackup)
    assert(saved.records.raw_logs.some(x => x.content === '旧访谈原文'))
    assert(saved.records.personal_workspaces.length && saved.records.interview_diary_batches.length)
    assert((await get('/settings/backups')).backups.some(x => x.name === manual.name))
    const { token } = await get('/settings/clear/prepare', {})
    const status = async (path, data) => (await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).status
    assert.equal(await status('/settings/clear', { token }), 409, 'server rejects early confirmation')
    await delay(5100)
    const finishInFlight = trackLocalRequest()
    try { assert.equal(await status('/settings/clear', { token }), 409, 'ongoing requests prevent wiping') }
    finally { finishInFlight() }
    // If backup cannot be written, wiping must leave all data untouched.
    const dir = join('data', 'backups'), moved = join('data', 'backups-held-for-test')
    await rename(dir, moved)
    await writeFile(dir, '')
    try { assert.equal(await status('/settings/clear', { token }), 500) }
    finally { await rm(dir); await rename(moved, dir) }
    assert.deepEqual((await get('/chat')).messages, priorChat)
    const preClear = (await get('/settings/clear', { token })).backup
    assert.equal(preClear.reason, 'before-clear')
    assert.equal((await get('/chat')).messages.length, 0)
    assert.equal((await get('/history')).diaries.length, 0)
    assert.equal((await get('/')).contexts.length, 0)
    assert.equal((await get('/')).events.length, 0)
    assert.equal((await get('/')).articles.length, 0)
    assert.equal((await get('/')).dreams.length, 0)
    assert.equal((await db.select().from(personalVectors)).length, 0)
    assert.deepEqual((await db.select().from(rawLogs)).map(row => row.id), ['fixture-other-msg'])
    assert.equal((await get('/settings')).model, 'test-choice', 'configuration survives clear')
    assert.equal(await status('/settings/clear', { token }), 400, 'confirmation is not reusable')
    assert.equal(await status('/settings/restore', { name: '../../untrusted.json' }), 400)
    const preRestore = (await get('/settings/restore', { name: preClear.name })).backup
    assert.equal(preRestore.reason, 'before-restore')
    assert.deepEqual((await get('/chat')).messages, priorChat)
    assert((await db.select().from(rawLogs)).some(row => row.id === 'fixture-old-interview-msg'))
    assert((await get('/history')).diaries.some(d => d.id === written.id))
    assert.equal((await get('/')).contexts.length, beforeCards + 4)
    assert.equal((await get('/settings')).model, 'test-choice', 'configuration survives restore')
  } finally {
    process.chdir(cwd)
    const rel = relative(tempRoot, temp)
    assert(isAbsolute(temp) && /^becoming-me-test-[a-z0-9]+$/i.test(rel))
    await rm(temp, { recursive: true, force: true })
  }
  console.log('Personal workspace: diary sources and focus, chat stream and correction, searchable long-chat quotes, event followup, book groups, topic filtering, explicit comparisons, hybrid recall, revision/restore, dream isolation, resumable diary reading, linked cards, model discovery and persistence, automatic evidence-based profile and in-chat revision, grounded hypothesis discussion, version-safe article revision and merge, safe purge/backup/restore and ZIP OK.')
} finally { await socket.stop(); await pg.close(); mock.close(); }
