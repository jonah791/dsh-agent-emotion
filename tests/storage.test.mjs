/**
 * dsh-agent-emotion — storage.ts 回归测试（IO 薄壳：路径解析 / 容错读 / 失败不抛写）
 * 运行：node --test tests/storage.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDataPath, loadState, saveState } from '../lib/storage.js'

const root = mkdtempSync(join(tmpdir(), 'emotion-storage-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

const sample = () => ({
  today: '2026-09-14',
  stats: { toolCalls: 9, toolSuccess: 8, toolErrors: 1, interactions: 3, outputs: 5, legacyWrites: 2, frontierTools: 6, reasoningChars: 120, reasoningEvents: 4 },
  toolNames: ['remember', 'write'],
  triggerCount: 7,
  weights: { cognition: 0.2, resilience: 0.1, existence: 0.2, relation: 0.1, frontier: 0.2, legacy: 0.2 },
  emotions: { cognition: 0.5 },
  history: [{ date: '2026-09-13', stats: {}, weights: {}, emotions: {} }],
})

// ---------- resolveDataPath ----------

test('resolveDataPath：DSH_HOME 环境变量优先（2026-08-30 迁移对齐）', () => {
  assert.equal(
    resolveDataPath({}, { DSH_HOME: 'E:\\alice\\.dsh' }, 'C:\\Users\\x'),
    join('E:\\alice\\.dsh', 'agent-emotion', 'emotion-state.json'),
  )
})

test('resolveDataPath：无 DSH_HOME → 回退 homedir/.dsh', () => {
  assert.equal(
    resolveDataPath({}, {}, '/home/x'),
    join('/home/x', '.dsh', 'agent-emotion', 'emotion-state.json'),
  )
})

test('resolveDataPath：config.dataDir 覆盖一切', () => {
  assert.equal(
    resolveDataPath({ dataDir: join(root, 'custom') }, { DSH_HOME: '/nope' }, '/home/x'),
    join(root, 'custom', 'emotion-state.json'),
  )
})

test('退化：resolveDataPath 空 config / 空 env → 不抛且给出确定路径', () => {
  assert.doesNotThrow(() => resolveDataPath({}, {}, '/tmp/h'))
  assert.ok(resolveDataPath({}, {}, '/tmp/h').endsWith('emotion-state.json'))
})

// ---------- loadState ----------

test('loadState：文件缺失 → 默认状态（不抛）', () => {
  const s = loadState(join(root, 'missing', 'emotion-state.json'))
  assert.equal(s.today, '')
  assert.equal(s.triggerCount, 0)
  assert.deepEqual(s.toolNames, [])
  assert.deepEqual(s.history, [])
  assert.equal(s.stats.toolCalls, 0)
  assert.equal(Object.keys(s.weights).length, 6)
})

test('loadState：完整文件 → 原样读回', () => {
  const p = join(root, 'full.json')
  writeFileSync(p, JSON.stringify(sample(), null, 2), 'utf-8')
  const s = loadState(p)
  assert.equal(s.today, '2026-09-14')
  assert.equal(s.stats.toolCalls, 9)
  assert.deepEqual(s.toolNames, ['remember', 'write'])
  assert.equal(s.triggerCount, 7)
  assert.equal(s.history.length, 1)
})

test('退化：损坏 JSON（torn tail）→ 重置为默认且不抛', () => {
  const p = join(root, 'corrupt.json')
  writeFileSync(p, '{"today":"2026-09-14","stats":{"toolCalls":', 'utf-8')
  let s
  assert.doesNotThrow(() => { s = loadState(p) })
  assert.equal(s.today, '')
  assert.equal(s.stats.toolCalls, 0)
})

test('退化：脏数据（null / 数组 / 字符串 / 缺字段）→ 不抛且结构被补齐', () => {
  const cases = [['null.json', 'null'], ['arr.json', '[1,2,3]'], ['str.json', '"hello"'], ['empty.json', '{}']]
  for (const [name, body] of cases) {
    const p = join(root, name)
    writeFileSync(p, body, 'utf-8')
    let s
    assert.doesNotThrow(() => { s = loadState(p) }, `${name} 不应抛`)
    assert.equal(Object.keys(s.weights).length, 6, `${name} 权重结构应补齐`)
    assert.equal(s.stats.toolCalls, 0, `${name} 统计应补齐`)
    assert.deepEqual(s.toolNames, [], `${name} 工具名应为空数组`)
    assert.deepEqual(s.history, [], `${name} 历史应为空数组`)
  }
})

test('退化：部分字段（stats 只有 toolCalls、weights 缺键）→ 缺省项补齐，已有项保留', () => {
  const p = join(root, 'partial.json')
  writeFileSync(p, JSON.stringify({ today: '2026-09-14', stats: { toolCalls: 5 }, weights: { cognition: 0.3 } }), 'utf-8')
  const s = loadState(p)
  assert.equal(s.stats.toolCalls, 5)
  assert.equal(s.stats.toolErrors, 0)
  assert.equal(s.weights.cognition, 0.3)
  assert.equal(Math.abs(s.weights.legacy - 1 / 6) < 1e-12, true)
})

// ---------- saveState ----------

test('saveState：写成功 → true，且能原样读回（往返一致）', () => {
  const p = join(root, 'roundtrip', 'emotion-state.json')
  const ok = saveState(p, sample())
  assert.equal(ok, true)
  assert.ok(existsSync(p))
  assert.deepEqual(loadState(p), sample())
})

test('写失败不抛：不可写路径（父路径是普通文件）→ 返回 false 且不抛', () => {
  const blocker = join(root, 'blocker.txt')
  writeFileSync(blocker, 'not a dir', 'utf-8')
  const p = join(blocker, 'sub', 'emotion-state.json')
  let ok
  assert.doesNotThrow(() => { ok = saveState(p, sample()) })
  assert.equal(ok, false)
})

test('写失败不抛：状态含循环引用（JSON.stringify 抛）→ 返回 false 且不抛', () => {
  const circular = sample()
  circular.self = circular
  let ok
  assert.doesNotThrow(() => { ok = saveState(join(root, 'circular', 'emotion-state.json'), circular) })
  assert.equal(ok, false)
})

test('退化：saveState 喂空对象/脏状态 → 不抛（写什么由调用方负责）', () => {
  const p = join(root, 'dirty', 'emotion-state.json')
  assert.doesNotThrow(() => saveState(p, {}))
  assert.ok(existsSync(p))
})

test('退化：目录已存在时重复写 → 幂等成功（mkdir recursive 不抛）', () => {
  const dir = join(root, 'again')
  mkdirSync(dir, { recursive: true })
  assert.equal(saveState(join(dir, 'emotion-state.json'), sample()), true)
  assert.equal(saveState(join(dir, 'emotion-state.json'), sample()), true)
})
