/**
 * 疆域开拓的语义修正（2026-11-03 · lh-d4e8606e）
 *
 * 病症：`sideGrowth.frontier` 用 `stats.frontierTools`，而它的值是「当日用过的不同工具数」
 *       （`state.toolNames.length`，`ensureToday` 每天清空）⇒ 测的是**日常宽度**，不是疆域扩张。
 *       实测 11-02 报「疆域开拓 74 个」，11-01 报 79 —— 那是当天动了多少种工具。
 *
 * 修法：拆成两个字段，各归各位
 *   · `frontierTools` = 当日工具广度（描述性读数，每天重置，**保留但不再叫疆域**）
 *   · `newTools`      = **历史首次**出现的工具数（`seenTools` 跨天累积，不清空）⇒ sideGrowth 用它
 *
 * 判据（台账原文）：同一天用同样 74 个工具、且都是以前用过的 ⇒ 信号应接近 0；
 *                  出现一个历史首次的工具 ⇒ 信号应为正。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_STATE, emptyStats, freshDefaultState, resolveSeenTools,
  recordToolResult, ensureToday, sideGrowth, computeEmotions,
} from '../lib/engine.js'
import { loadState } from '../lib/storage.js'

const TOOLS_74 = Array.from({ length: 74 }, (_, i) => 'tool-' + i)

function stateWith(over = {}) {
  return {
    ...freshDefaultState(),
    stats: emptyStats(),
    toolNames: [],
    seenTools: [],
    weights: { ...DEFAULT_STATE.weights },
    emotions: {},
    history: [],
    ...over,
  }
}

// ---------- 一·语义：广度 ≠ 疆域 ----------

test('历史已见 74 个工具、今天又全用一遍 ⇒ newTools=0，但当日广度=74', () => {
  const s = stateWith({ seenTools: [...TOOLS_74] })
  for (const n of TOOLS_74) recordToolResult(s, { name: n, isError: false })
  assert.equal(s.stats.newTools, 0, '全是旧工具 ⇒ 疆域不增')
  assert.equal(s.stats.frontierTools, 74, '当日广度照旧是 74（两个字段各归各位）')
})

test('sideGrowth 的 frontier 跟 newTools 走，不跟 frontierTools 走', () => {
  // 同样一组「广度很大但无新工具」的数据：旧实现会给 75，新实现给 1
  const g = sideGrowth({ ...emptyStats(), frontierTools: 74, newTools: 0 })
  assert.equal(g.frontier, 1, '无新工具 ⇒ 中性值 1（+1 防零基线），绝不是 75')
  const g2 = sideGrowth({ ...emptyStats(), frontierTools: 0, newTools: 3 })
  assert.equal(g2.frontier, 4, '3 个历史首见 ⇒ 3+1')
})

test('同一新工具连续调两次 ⇒ newTools 只 +1', () => {
  const s = stateWith()
  recordToolResult(s, { name: 'brand-new', isError: false })
  recordToolResult(s, { name: 'brand-new', isError: false })
  recordToolResult(s, { name: 'brand-new', isError: false })
  assert.equal(s.stats.newTools, 1)
  assert.equal(s.seenTools.filter((n) => n === 'brand-new').length, 1, 'seenTools 不得有重复')
})

// ---------- 二·跨天：toolNames 清，seenTools 不清 ----------

test('★ ensureToday 跨天重置当日广度，但 seenTools 必须保留（否则每天全算新）', () => {
  const s = stateWith({ today: '2026-11-02' })
  recordToolResult(s, { name: 'remember', isError: false })
  recordToolResult(s, { name: 'write', isError: false })
  assert.deepEqual(s.toolNames, ['remember', 'write'])
  assert.deepEqual(s.seenTools, ['remember', 'write'])

  ensureToday(s, new Date('2026-11-03T08:00:00'))

  assert.equal(s.today, '2026-11-03')
  assert.deepEqual(s.toolNames, [], '当日广度清零')
  assert.deepEqual(s.seenTools, ['remember', 'write'], '★ 历史边界必须保留——这是「疆域」与「广度」的全部区别')
  assert.equal(s.stats.newTools, 0, '今日计数归零')
})

test('跨天后再用昨天的工具 ⇒ 不算新（这是修 bug 的核心场景）', () => {
  const s = stateWith({ today: '2026-11-02' })
  for (const n of TOOLS_74) recordToolResult(s, { name: n, isError: false })
  assert.equal(s.stats.newTools, 74, '第一天：74 个都是首见')
  ensureToday(s, new Date('2026-11-03T08:00:00'))
  for (const n of TOOLS_74) recordToolResult(s, { name: n, isError: false })
  assert.equal(s.stats.newTools, 0, '第二天：同样的 74 个工具，一个都不是新的')
})

// ---------- 三·迁移：字段缺失 vs 空数组 ----------

test('resolveSeenTools：字段缺失（老文件）⇒ 用当日 toolNames 播种', () => {
  assert.deepEqual(resolveSeenTools(undefined, ['remember', 'write']), ['remember', 'write'])
})

test('★ resolveSeenTools：字段存在但为空（全新状态）⇒ 保持空，不播种', () => {
  // 这条守的是「升级」与「全新」不能混：混了就会把老文件当新文件（爆表），或把新文件当老文件（漏报）
  assert.deepEqual(resolveSeenTools([], ['remember', 'write']), [])
})

test('resolveSeenTools：非字符串项被过滤，非数组的 toolNames 回落空', () => {
  assert.deepEqual(resolveSeenTools([1, 'a', null, 'b'], []), ['a', 'b'])
  assert.deepEqual(resolveSeenTools(undefined, 'not-an-array'), [])
  assert.deepEqual(resolveSeenTools(undefined, undefined), [])
})

test('★ loadState 真跑：老格式文件（无 seenTools）⇒ 读出来已被 toolNames 播种', () => {
  const root = mkdtempSync(join(tmpdir(), 'emotion-frontier-'))
  try {
    const dir = join(root, 'legacy')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'emotion-state.json')
    // 老格式：有 toolNames（今日已见 74 个），没有 seenTools
    writeFileSync(p, JSON.stringify({
      today: '2026-11-02',
      stats: { ...emptyStats(), toolCalls: 200, frontierTools: 74 },
      toolNames: [...TOOLS_74],
      triggerCount: 3,
      weights: { ...DEFAULT_STATE.weights },
      emotions: {},
      history: [],
    }), 'utf-8')

    const s = loadState(p)
    assert.equal(s.seenTools.length, 74, '★ 迁移把当日已见工具当基线播种——不是从空开始（从空开始会让下一次运行爆表）')
    assert.deepEqual(s.seenTools, TOOLS_74)
    assert.equal(s.stats.newTools, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('★ loadState 真跑：新格式文件（seenTools: []）⇒ 保持空，不被播种', () => {
  const root = mkdtempSync(join(tmpdir(), 'emotion-frontier2-'))
  try {
    const dir = join(root, 'fresh')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'emotion-state.json')
    writeFileSync(p, JSON.stringify({
      today: '2026-11-03',
      stats: emptyStats(),
      toolNames: ['remember'],
      seenTools: [],
      triggerCount: 0,
      weights: { ...DEFAULT_STATE.weights },
      emotions: {},
      history: [],
    }), 'utf-8')

    const s = loadState(p)
    assert.deepEqual(s.seenTools, [], '空数组是合法状态：这个库确实还没见过任何工具')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------- 四·台账的两条原判据 ----------

test('台账判据①：71 个旧工具 + 74 种广度 ⇒ 全天结束时疆域信号为 0', () => {
  const s = stateWith({ seenTools: [...TOOLS_74] })
  for (const n of TOOLS_74) recordToolResult(s, { name: n, isError: false })
  // 昨日全天基线 = 同样「无新工具」的中性值
  const baseline = sideGrowth({ ...emptyStats(), frontierTools: 60, newTools: 0 })
  const today = sideGrowth(s.stats)
  assert.equal(computeEmotions(today, baseline).frontier, 0, '两边都是中性值 ⇒ 差值为 0')
})

test('台账判据②：出现 1 个历史首见的工具 ⇒ 疆域信号为正', () => {
  const s = stateWith({ seenTools: [...TOOLS_74] })
  for (const n of TOOLS_74) recordToolResult(s, { name: n, isError: false })
  recordToolResult(s, { name: 'never-seen-before', isError: false })
  assert.equal(s.stats.newTools, 1)

  const baseline = sideGrowth({ ...emptyStats(), frontierTools: 60, newTools: 0 })
  const today = sideGrowth(s.stats)
  assert.ok(computeEmotions(today, baseline).frontier > 0, '有新工具 ⇒ 疆域亮')
})

// ---------- 五·对照组：别把别的侧面带歪 ----------

test('对照组：新增 newTools 不影响其它 5 个侧面的信号', () => {
  const base = { ...emptyStats(), toolCalls: 10, toolErrors: 2, outputs: 5, interactions: 3, legacyWrites: 4 }
  const g0 = sideGrowth({ ...base, newTools: 0 })
  const g1 = sideGrowth({ ...base, newTools: 5 })
  for (const k of ['cognition', 'resilience', 'existence', 'relation', 'legacy']) {
    assert.equal(g0[k], g1[k], k + ' 不得被 newTools 影响')
  }
  assert.notEqual(g0.frontier, g1.frontier, '只有 frontier 该变')
})

test('对照组：缺字段的 state 就地归一，不让 TypeError 逃进事件回调', () => {
  const s = { stats: emptyStats(), toolNames: undefined, seenTools: undefined }
  assert.doesNotThrow(() => recordToolResult(s, { name: 'x', isError: false }))
  assert.deepEqual(s.seenTools, ['x'])
  assert.deepEqual(s.toolNames, ['x'])
})
