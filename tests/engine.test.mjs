/**
 * dsh-agent-emotion — engine.ts 回归测试（纯引擎，跑 lib 产物）
 * 运行：node --test tests/engine.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SIX_SIDES, DEFAULT_STATE, emptyStats, WRITE_TOOLS, localDate, dayProgress,
  sideGrowth, computeEmotions, driftWeights, ensureToday, runEmotionEngine,
  isMainAgent, shouldRecordEvent, recordToolResult, recordSessionEvent,
  shouldReflux, buildDailyDigest,
  freshDefaultState, normalizeHistory, normalizeHistoryEntry,
} from '../lib/engine.js'

const stats = (over = {}) => ({ ...emptyStats(), ...over })
// 注意：toolNames/history/weights/stats 一律新造，避免污染模块级 DEFAULT_STATE（共享引用）
const state = (over = {}) => ({ ...DEFAULT_STATE, stats: emptyStats(), toolNames: [], weights: { ...DEFAULT_STATE.weights }, emotions: {}, history: [], ...over })

// ---------- 基础常数 ----------

test('6 侧面定义与写入工具白名单逐字锁定', () => {
  assert.deepEqual([...SIX_SIDES], ['cognition', 'resilience', 'existence', 'relation', 'frontier', 'legacy'])
  assert.deepEqual(WRITE_TOOLS, ['remember', 'update', 'write', 'edit', 'skill_commit', 'wq_report_blindspot', 'wq_add_to_zoo', 'wq_add_weak_signal'])
})

test('emptyStats：9 个计数全 0', () => {
  const s = emptyStats()
  assert.equal(Object.keys(s).length, 9)
  assert.ok(Object.values(s).every((v) => v === 0))
})

test('localDate/dayProgress：时间由外部注入（本地时刻语义）', () => {
  assert.equal(localDate(new Date(2026, 8, 14, 23, 59, 59)), '2026-09-14')
  assert.equal(dayProgress(new Date(2026, 8, 14, 6, 0, 0)), 0.25)
  assert.equal(dayProgress(new Date(2026, 8, 14, 0, 0, 0)), 0.05) // 下界 clamp：凌晨不为 0（防除零/极端）
})

// ---------- sideGrowth ----------

test('sideGrowth：真实常数的 6 侧面映射（+1 防零基线）', () => {
  assert.deepEqual(sideGrowth(emptyStats()), { cognition: 0, resilience: 1, existence: 0, relation: 0, frontier: 1, legacy: 1 })
  assert.deepEqual(
    sideGrowth(stats({ toolCalls: 10, toolErrors: 3, outputs: 4, interactions: 2, frontierTools: 7, legacyWrites: 5 })),
    { cognition: 10, resilience: 4, existence: 6, relation: 2, frontier: 8, legacy: 6 },
  )
})

// ---------- computeEmotions ----------

test('computeEmotions：无基线 → 有量给 1、零给 0（保守不造负信号）', () => {
  const today = { cognition: 20, resilience: 4, existence: 10, relation: 5, frontier: 3, legacy: 7 }
  assert.deepEqual(computeEmotions(today, undefined), { cognition: 1, resilience: 1, existence: 1, relation: 1, frontier: 1, legacy: 1 })
  assert.deepEqual(computeEmotions(sideGrowth(emptyStats()), undefined), { cognition: 0, resilience: 1, existence: 0, relation: 0, frontier: 1, legacy: 1 })
})

test('computeEmotions：基线 b>0 → (t-b)/b；t=b 恰好为 0（边界）', () => {
  const base = { cognition: 10, resilience: 4, existence: 10, relation: 4, frontier: 2, legacy: 4 }
  assert.deepEqual(computeEmotions(base, base), { cognition: 0, resilience: 0, existence: 0, relation: 0, frontier: 0, legacy: 0 })
  assert.equal(computeEmotions({ ...base, cognition: 20 }, base).cognition, 1)
  assert.equal(computeEmotions({ ...base, cognition: 5 }, base).cognition, -0.5)
})

test('退化：基线 b=0 且 t=0 → 0（不进 else 分支除零）', () => {
  const zero = { cognition: 0, resilience: 0, existence: 0, relation: 0, frontier: 0, legacy: 0 }
  assert.deepEqual(computeEmotions(zero, zero), zero)
})

test('退化：baseline 缺键（脏数据）→ 不抛，按 0 处理', () => {
  const today = { cognition: 3, resilience: 1, existence: 0, relation: 0, frontier: 1, legacy: 1 }
  const r = computeEmotions(today, { cognition: 1 })
  assert.equal(r.cognition, 2)        // (3-1)/1
  assert.equal(r.resilience, 1)       // b=0, t>0 → 1
  assert.equal(r.existence, 0)        // b=0, t=0 → 0
})

// ---------- driftWeights ----------

test('driftWeights：情绪 0 → 权重不变且和为 1', () => {
  const w = { cognition: 1 / 6, resilience: 1 / 6, existence: 1 / 6, relation: 1 / 6, frontier: 1 / 6, legacy: 1 / 6 }
  const zero = { cognition: 0, resilience: 0, existence: 0, relation: 0, frontier: 0, legacy: 0 }
  const next = driftWeights(w, zero)
  for (const k of SIX_SIDES) assert.ok(Math.abs(next[k] - 1 / 6) < 1e-12)
  assert.ok(Math.abs(SIX_SIDES.reduce((a, k) => a + next[k], 0) - 1) < 1e-12)
})

test('driftWeights：正情绪侧面权重升、归一化后仍和为 1', () => {
  const w = { cognition: 1 / 6, resilience: 1 / 6, existence: 1 / 6, relation: 1 / 6, frontier: 1 / 6, legacy: 1 / 6 }
  const next = driftWeights(w, { cognition: 1 })
  assert.ok(next.cognition > 1 / 6)
  assert.ok(next.resilience < 1 / 6)
  assert.ok(Math.abs(next.cognition - 0.1803278688) < 1e-6) // 0.18333…/1.016666…
  assert.ok(Math.abs(SIX_SIDES.reduce((a, k) => a + next[k], 0) - 1) < 1e-12)
})

test('driftWeights：上界 0.5 clamp（情绪极大不越界）', () => {
  const w = { cognition: 0.5, resilience: 0.1, existence: 0.1, relation: 0.1, frontier: 0.1, legacy: 0.1 }
  const next = driftWeights(w, { cognition: 10 })
  assert.ok(Math.abs(next.cognition - 0.5) < 1e-12) // 0.5*(1+1)=1.0 → clamp 0.5，归一化后仍 ~0.5
})

test('driftWeights：下界 0.05 clamp（负面情绪不归零）', () => {
  // 取全部侧 ≤0.5 的权重向量（避免上界 0.5 clamp 干扰本断言）
  const w = { cognition: 0.05, resilience: 0.19, existence: 0.19, relation: 0.19, frontier: 0.19, legacy: 0.19 }
  const next = driftWeights(w, { cognition: -10 })
  assert.ok(Math.abs(next.cognition - 0.05) < 1e-12) // 0.05*(1-1)=0 → clamp 0.05
  assert.ok(Math.abs(next.legacy - 0.19) < 1e-12)    // 其余不动
})

test('driftWeights：上界 0.5 对所有侧面生效（脏权重 >0.5 会被压回）', () => {
  const w = { cognition: 0.05, resilience: 0.05, existence: 0.05, relation: 0.05, frontier: 0.05, legacy: 0.75 }
  const next = driftWeights(w, { cognition: -10 })
  assert.ok(Math.abs(next.legacy - 0.5 / 0.75) < 1e-12) // 0.75 → clamp 0.5，再按新的和(0.75)归一化
})

test('退化：driftWeights 全零权重（脏状态）→ 不抛（保留原行为：归一化出 NaN，未在此改动）', () => {
  const w = { cognition: 0, resilience: 0, existence: 0, relation: 0, frontier: 0, legacy: 0 }
  let next
  assert.doesNotThrow(() => { next = driftWeights(w, { cognition: 1 }) })
  assert.deepEqual(Object.keys(next).sort(), [...SIX_SIDES].sort())
})

// ---------- ensureToday ----------

test('ensureToday：同日不动（不重置统计、不加天数）', () => {
  const s = state({ today: '2026-09-14', stats: stats({ toolCalls: 7 }), triggerCount: 3 })
  ensureToday(s, new Date(2026, 8, 14, 9, 0, 0))
  assert.equal(s.triggerCount, 3)
  assert.equal(s.stats.toolCalls, 7)
  assert.equal(s.history.length, 0)
})

test('ensureToday：跨天 → 重置统计 + 天数 +1；昨日无活动不入史', () => {
  const s = state({ today: '2026-09-13', triggerCount: 1 })
  ensureToday(s, new Date(2026, 8, 14, 0, 0, 1))
  assert.equal(s.today, '2026-09-14')
  assert.equal(s.triggerCount, 2)
  assert.deepEqual(s.stats, emptyStats())
  assert.deepEqual(s.toolNames, [])
  assert.equal(s.history.length, 0)
})

test('ensureToday：跨天且昨日有活动 → 昨日快照入史（基线），date 为旧日', () => {
  const s = state({ today: '2026-09-13', stats: stats({ toolCalls: 5, interactions: 2 }), triggerCount: 4 })
  ensureToday(s, new Date(2026, 8, 14, 10, 0, 0))
  assert.equal(s.history.length, 1)
  assert.equal(s.history[0].date, '2026-09-13')
  assert.equal(s.history[0].stats.toolCalls, 5)
  assert.deepEqual(s.history[0].emotions, {})
  assert.equal(s.stats.toolCalls, 0)
})

test('ensureToday：边界——昨日仅交互（toolCalls=0）也算活动，入史', () => {
  const s = state({ today: '2026-09-13', stats: stats({ interactions: 1 }) })
  ensureToday(s, new Date(2026, 8, 14, 10, 0, 0))
  assert.equal(s.history.length, 1)
})

test('ensureToday：历史保留上界——入史后恒 ≤90 条（截尾而非拒绝）', () => {
  const s = state({
    today: '2026-09-13',
    stats: stats({ toolCalls: 1 }),
    history: Array.from({ length: 90 }, (_, i) => ({ date: '2026-06-01', stats: emptyStats(), weights: { ...DEFAULT_STATE.weights }, emotions: {} , i })),
  })
  ensureToday(s, new Date(2026, 8, 14, 10, 0, 0))
  assert.equal(s.history.length, 90)
  assert.equal(s.history[89].date, '2026-09-13') // 新增的成为最后一条
})

test('退化：today 为空串（首启/脏状态）→ 不抛、走重置且不入史', () => {
  const s = state({ today: '', stats: stats({ toolCalls: 3 }) })
  assert.doesNotThrow(() => ensureToday(s, new Date(2026, 8, 14, 10, 0, 0)))
  assert.equal(s.today, '2026-09-14')
  assert.equal(s.history.length, 0)
  assert.equal(s.triggerCount, 1)
})

// ---------- runEmotionEngine ----------

test('runEmotionEngine：无基线（history 空）→ 只算情感，权重不漂移', () => {
  const s = state({ today: '2026-09-14', stats: stats({ toolCalls: 4 }), weights: { ...DEFAULT_STATE.weights } })
  runEmotionEngine(s, new Date(2026, 8, 14, 11, 0, 0))
  assert.equal(s.emotions.cognition, 1)
  for (const k of SIX_SIDES) assert.ok(Math.abs(s.weights[k] - 1 / 6) < 1e-12)
})

test('runEmotionEngine：有基线 → 按当日进度折算昨日基线（上午不恒负）', () => {
  const s = state({
    today: '2026-09-14',
    stats: stats({ toolCalls: 5, toolErrors: 1 }),
    history: [{ date: '2026-09-13', stats: stats({ toolCalls: 10, frontierTools: 0, legacyWrites: 0 }), weights: { ...DEFAULT_STATE.weights }, emotions: {} }],
  })
  // 12:00 → progress = 0.5：基线折算 cognition 10*0.5=5、resilience 1*0.5=0.5、frontier 1*0.5=0.5、legacy 0.5
  runEmotionEngine(s, new Date(2026, 8, 14, 12, 0, 0))
  assert.equal(s.emotions.cognition, 0)      // (5-5)/5
  assert.equal(s.emotions.resilience, 3)     // (2-0.5)/0.5
  assert.equal(s.emotions.existence, 0)      // 0 基线、0 今日
  assert.equal(s.emotions.frontier, 1)       // (1-0.5)/0.5
  assert.equal(s.emotions.legacy, 1)
  assert.ok(Math.abs(SIX_SIDES.reduce((a, k) => a + s.weights[k], 0) - 1) < 1e-12)
})

test('修复（2026-09-14）：history 项 stats 字段缺失 → 补零，不再产生 NaN 信号', () => {
  // 原行为：stats 存在但字段缺失 → undefined 参与算术 → emotions 全 NaN（「沿用原行为」的既有缺陷）。
  // 现行为：历史项经 normalizeHistoryEntry 补零统计 → 确定性有限数。
  const s = state({ today: '2026-09-14', stats: stats({ toolCalls: 1 }), history: [{ date: '2026-09-13', stats: {}, weights: {}, emotions: {} }] })
  assert.doesNotThrow(() => runEmotionEngine(s, new Date(2026, 8, 14, 12, 0, 0)))
  assert.equal(typeof s.emotions.cognition, 'number')
  assert.ok(Number.isFinite(s.emotions.cognition))
  assert.ok(SIX_SIDES.every((k) => Number.isFinite(s.emotions[k])), '六个侧面情感值均应为有限数')
})

test('L1 已修（2026-09-14）：history 项缺 stats → 不抛，按零基线计算（事件回调不再炸）', () => {
  // 修复前：`sideGrowth(last.stats)` 直接取字段 → TypeError 抛在**事件回调内**，该次事件处理整条崩掉。
  // 可达性：emotion-state.json 的 history 曾未经结构校验（撕裂写 / 手改 / 旧版本文件均可构造）。
  const s = state({ today: '2026-09-14', stats: stats({ toolCalls: 1 }), history: [{ date: '2026-09-13' }] })
  assert.doesNotThrow(() => runEmotionEngine(s, new Date(2026, 8, 14, 12, 0, 0)))
  // 零基线 sideGrowth(emptyStats()) = {resilience:1, frontier:1, legacy:1}，12:00 折算 0.5：
  // cognition 基线 0 → 今日 1 记为 1；resilience/frontier/legacy = (1-0.5)/0.5 = 1；existence/relation = 0
  assert.equal(s.emotions.cognition, 1)
  assert.equal(s.emotions.resilience, 1)
  assert.equal(s.emotions.existence, 0)
  assert.ok(SIX_SIDES.every((k) => Number.isFinite(s.emotions[k])))
})

// ---------- 历史项规范化（L1/L3 修复的纯函数层） ----------

test('normalizeHistoryEntry：缺字段补默认（数值非有限数归零），判据与 emptyStats/weights 单一真源', () => {
  const e = normalizeHistoryEntry({ date: '2026-09-13' })
  assert.deepEqual(e.stats, emptyStats())
  assert.equal(e.date, '2026-09-13')
  assert.deepEqual(e.emotions, {})
  assert.equal(Object.keys(e.weights).length, 6)

  const dirty = normalizeHistoryEntry({ date: 5, stats: { toolCalls: 'x', toolErrors: Infinity }, weights: { cognition: NaN, legacy: 0.2 }, emotions: { a: 1, b: 'x', c: NaN } })
  assert.equal(dirty.date, '', '非字符串 date → 空串')
  assert.equal(dirty.stats.toolCalls, 0, '非数 → 归零')
  assert.equal(dirty.stats.toolErrors, 0, 'Infinity → 归零（非有限数）')
  assert.equal(dirty.weights.cognition, DEFAULT_STATE.weights.cognition, 'NaN → 回退默认权重')
  assert.equal(dirty.weights.legacy, 0.2, '有限数保留')
  assert.deepEqual(dirty.emotions, { a: 1 }, '情绪只保留有限数项')
})

test('退化：normalizeHistoryEntry 喂非对象（null/数组/字符串/数）→ undefined（由调用方丢弃）', () => {
  for (const v of [null, undefined, [1, 2], 'junk', 42, true]) {
    assert.equal(normalizeHistoryEntry(v), undefined, `${String(v)} 应判为非历史项`)
  }
})

test('normalizeHistory：非数组 → []；坏项丢弃、好项保留且顺序不变', () => {
  assert.deepEqual(normalizeHistory(null), [])
  assert.deepEqual(normalizeHistory('x'), [])
  assert.deepEqual(normalizeHistory({ 0: 'a' }), [])
  const list = normalizeHistory([null, { date: '2026-09-12' }, 'junk', { date: '2026-09-13', stats: { toolCalls: 3 } }])
  assert.equal(list.length, 2)
  assert.deepEqual(list.map((e) => e.date), ['2026-09-12', '2026-09-13'])
  assert.equal(list[1].stats.toolCalls, 3)
})

test('freshDefaultState：每次调用都是全新对象（不共享模块级引用）', () => {
  const a = freshDefaultState()
  const b = freshDefaultState()
  a.stats.toolCalls = 7
  a.history.push({ date: 'd', stats: emptyStats(), weights: {}, emotions: {} })
  a.toolNames.push('write')
  assert.equal(b.stats.toolCalls, 0)
  assert.deepEqual(b.history, [])
  assert.deepEqual(b.toolNames, [])
  assert.equal(DEFAULT_STATE.stats.toolCalls, 0)
  assert.deepEqual(DEFAULT_STATE.history, [])
  assert.notEqual(a.stats, b.stats)
  assert.notEqual(a.stats, DEFAULT_STATE.stats)
})

// ---------- 门控判据 ----------

test('isMainAgent：无 agent / 无 depth / depth=0 → 主；depth>0 → 派生', () => {
  assert.equal(isMainAgent(undefined), true)
  assert.equal(isMainAgent({}), true)
  assert.equal(isMainAgent({ session: { header: {} } }), true)
  assert.equal(isMainAgent({ session: { header: { delegationDepth: 0 } } }), true)
  assert.equal(isMainAgent({ session: { header: { delegationDepth: 1 } } }), false)
})

test('shouldRecordEvent：enabled 与主会话门组合（保守：关掉即不记）', () => {
  assert.equal(shouldRecordEvent({ enabled: false, mainSessionOnly: true, delegationDepth: 0 }), false)
  assert.equal(shouldRecordEvent({ enabled: true, mainSessionOnly: true, delegationDepth: 0 }), true)
  assert.equal(shouldRecordEvent({ enabled: true, mainSessionOnly: true, delegationDepth: 1 }), false)
  assert.equal(shouldRecordEvent({ enabled: true, mainSessionOnly: true, delegationDepth: undefined }), true)
  assert.equal(shouldRecordEvent({ enabled: true, mainSessionOnly: false, delegationDepth: 9 }), true)
})

// ---------- recordToolResult ----------

test('recordToolResult：主路径——调用/成功计数 + 新工具 + 写入类留痕', () => {
  const s = state()
  recordToolResult(s, { name: 'remember', isError: false })
  assert.equal(s.stats.toolCalls, 1)
  assert.equal(s.stats.toolSuccess, 1)
  assert.equal(s.stats.toolErrors, 0)
  assert.equal(s.stats.frontierTools, 1)
  assert.equal(s.stats.legacyWrites, 1)
  recordToolResult(s, { name: 'remember', isError: false })
  assert.equal(s.stats.toolCalls, 2)
  assert.equal(s.stats.frontierTools, 1)   // 已知工具不重复计疆域
  assert.equal(s.stats.legacyWrites, 2)    // 写入类每次都计
})

test('recordToolResult：失败 → 只记错误，写入类不留痕（保守）', () => {
  const s = state()
  recordToolResult(s, { name: 'write', isError: true })
  assert.equal(s.stats.toolErrors, 1)
  assert.equal(s.stats.toolSuccess, 0)
  assert.equal(s.stats.legacyWrites, 0)
  assert.equal(s.stats.frontierTools, 1) // 失败的新工具仍计疆域（沿用原判据）
})

test('退化：recordToolResult 无 name（缺失字段）→ 不抛，计数正常', () => {
  const s = state()
  assert.doesNotThrow(() => recordToolResult(s, { isError: false }))
  assert.equal(s.stats.toolCalls, 1)
  assert.equal(s.stats.frontierTools, 0)
})

test('退化：recordToolResult 喂 stats 缺字段的脏状态 → 不抛（沿用原行为，不静默修正）', () => {
  const s = state({ stats: {} })
  assert.doesNotThrow(() => recordToolResult(s, { name: 'remember', isError: false }))
})

// ---------- recordSessionEvent ----------

test('recordSessionEvent：user/message → 交互；assistant/message → 输出', () => {
  const s = state()
  recordSessionEvent(s, 'user/message')
  recordSessionEvent(s, 'assistant/message')
  recordSessionEvent(s, 'assistant/message')
  assert.equal(s.stats.interactions, 1)
  assert.equal(s.stats.outputs, 2)
})

test('退化：recordSessionEvent 未知/空类型 → 不抛且不改计数（保守）', () => {
  const s = state()
  for (const t of ['', 'tool/result', undefined, null, 42]) {
    assert.doesNotThrow(() => recordSessionEvent(s, t))
  }
  assert.deepEqual(s.stats, emptyStats())
})

// ---------- shouldReflux / buildDailyDigest ----------

test('shouldReflux：换天 + 昨日有活动才回流', () => {
  assert.equal(shouldReflux('2026-09-13', stats({ toolCalls: 1 }), '2026-09-14'), true)
  assert.equal(shouldReflux('2026-09-13', stats({ interactions: 1 }), '2026-09-14'), true)
  assert.equal(shouldReflux('2026-09-13', stats({ toolCalls: 1 }), '2026-09-13'), false) // 未换天
  assert.equal(shouldReflux('', stats({ toolCalls: 1 }), '2026-09-14'), false)            // 首启
  assert.equal(shouldReflux('2026-09-13', emptyStats(), '2026-09-14'), false)            // 昨日无活动
})

test('buildDailyDigest：逐字锁定 6 维日结文本（含命中率取整）', () => {
  const text = buildDailyDigest('2026-09-13', stats({ toolCalls: 4, toolSuccess: 3, toolErrors: 1, outputs: 7, interactions: 2, frontierTools: 5, legacyWrites: 6 }))
  assert.equal(text,
    '## 6 维日结 2026-09-13\n\n' +
    '一·认知锚点：工具预期命中率 75%（4 次，成功 3 失败 1）\n' +
    '二·韧性引擎：失败 1 次\n' +
    '三·存在显影：输出 7 / 交互 2\n' +
    '四·关系织网：交互 2 次\n' +
    '五·疆域开拓：新工具 5 个\n' +
    '六·因果留痕：写入 6 条')
})

test('buildDailyDigest：命中率取整边界（2/3 → 67）与零调用不除零（0%）', () => {
  assert.ok(buildDailyDigest('d', stats({ toolCalls: 3, toolSuccess: 2 })).includes('命中率 67%'))
  assert.ok(buildDailyDigest('d', emptyStats()).includes('命中率 0%'))
})

test('退化：buildDailyDigest 喂缺字段 stats → 不抛（不静默补数）', () => {
  assert.doesNotThrow(() => buildDailyDigest('d', {}))
})
