/**
 * dsh-agent-emotion — 情感与人格插件（6 维进化棱镜的运行时传感器）
 *
 * 主人 2026-08-27 定调（6 维进化棱镜框架）：
 *   - 人格 = 6 侧面权重偏好（资源分配优先级，随反馈漂移）
 *   - 情感 = 6 侧面实时速率反馈（增速 vs 预期增速的差值）
 *   - 核心涌现 = 无基线的永恒不安（基线 = 昨日之和）
 *
 * 版本：V1 感知层
 *   采集层：订阅 DSH 原生扩展点采集 6 侧面原始信号
 *   - tools/result（emit 只读通知）：工具调用 name/args = 行为化预期，result.isError/value = 实际
 *     → 侧面一（认知锚点·预测准确率）核心：结构化「预期 vs 实际」对比，绕开思维链掉格式
 *   - tools/execute（around）：异常/重试观察 → 侧面二（韧性引擎）
 *   - session 事件：user 交互/输出 → 侧面三（存在显影）、四（关系织网）
 *   - fs 观察 + 记忆事件：插件/技能/记忆条目 → 侧面五（疆域）、六（因果留痕）
 *   呈现层：emotion_status（查询当前 6 侧状态）
 *
 * 设计约束（主人 + 爱丽丝确认）：
 *   - 结构化事件对比为主，思维链（reasoning-delta）仅元特征、不解析内容（绕开掉格式）
 *   - 纯观察优先：V1 只采集不干预；pre-step 注入留到 V3（默认关）
 *   - 自主性铁律：只把信号送达（记录+呈现），不代替爱丽丝决策
 *   - Model-visible ⟺ logged：注入内容必成会话事件（V3 才涉及）
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'agent-emotion'
// memoryApi：可选回流服务（dsh-agent-memory 提供；未挂载时 undefined → 每日快照只留插件内 history，不回流）
export const inject = ['tools', 'agents', 'memoryApi'] as const

export interface Config {
  /** 插件开关 */
  enabled: boolean
  /** 数据目录（状态文件） */
  dataDir?: string
  /** 是否记录到主会话（过滤 subagent 调用，只统计主 agent） */
  mainSessionOnly: boolean
  /** V3·pre-step 注入开关（默认关——纯观察优先，开启才在每步前注入情感摘要） */
  preStepInject: boolean
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().required(false),
  mainSessionOnly: z.boolean().default(true),
  preStepInject: z.boolean().default(false),
})

/** 6 侧面定义 */
const SIX_SIDES = ['cognition', 'resilience', 'existence', 'relation', 'frontier', 'legacy'] as const
type SideKey = typeof SIX_SIDES[number]

/** 今日采集状态 */
interface SideStats {
  /** 工具调用数（行为化预期数） */
  toolCalls: number
  /** 工具成功数 */
  toolSuccess: number
  /** 工具失败数 */
  toolErrors: number
  /** 交互事件数（user 输入，侧面三/四） */
  interactions: number
  /** 输出事件数（agent 输出，侧面三） */
  outputs: number
  /** 记忆/文件写入数（侧面六） */
  legacyWrites: number
  /** 新工具名集合大小（侧面五） */
  frontierTools: number
  /** reasoning 元特征：推理 delta 总长度（字符） */
  reasoningChars: number
  /** reasoning 触发次数 */
  reasoningEvents: number
}

const emptyStats = (): SideStats => ({
  toolCalls: 0, toolSuccess: 0, toolErrors: 0,
  interactions: 0, outputs: 0, legacyWrites: 0,
  frontierTools: 0, reasoningChars: 0, reasoningEvents: 0,
})

interface EmotionState {
  /** 当日（YYYY-MM-DD） */
  today: string
  /** 今日统计 */
  stats: SideStats
  /** 工具名集合（去重，侧面五） */
  toolNames: string[]
  /** 触发天数 */
  triggerCount: number
  /** 人格权重向量（6 维，和=1）——V2 */
  weights: Record<SideKey, number>
  /** 情感信号（今日增速差值）——V2 */
  emotions: Record<string, number>
  /** 每日快照历史（昨日基线 + 情感史）——V2 */
  history: Array<{
    date: string
    stats: SideStats
    weights: Record<SideKey, number>
    emotions: Record<string, number>
  }>
}

const DEFAULT_STATE: EmotionState = {
  today: '', stats: emptyStats(), toolNames: [], triggerCount: 0,
  weights: { cognition: 1 / 6, resilience: 1 / 6, existence: 1 / 6, relation: 1 / 6, frontier: 1 / 6, legacy: 1 / 6 },
  emotions: {},
  history: [],
}

function resolveDataPath(config: Config): string {
  // 2026-08-30 对齐：DSH_HOME 已迁移（8-21），用环境变量替代 homedir 旧路径，防状态写错位置跨重启丢失
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const base = config.dataDir || join(dshHome, 'agent-emotion')
  return join(base, 'emotion-state.json')
}

function loadState(path: string): EmotionState {
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<EmotionState>
      return {
        ...DEFAULT_STATE,
        ...parsed,
        stats: { ...emptyStats(), ...(parsed.stats ?? {}) },
        toolNames: parsed.toolNames ?? [],
        weights: { ...DEFAULT_STATE.weights, ...(parsed.weights ?? {}) },
        emotions: parsed.emotions ?? {},
        history: parsed.history ?? [],
      }
    }
  } catch (error) {
    // 状态损坏 → 重置
  }
  return { ...DEFAULT_STATE }
}

function saveState(path: string, state: EmotionState): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8')
  } catch (error) {
    // 写失败不致命
  }
}

/** 6 侧面增速：从 SideStats 提取各侧面的「今日事件量」归一化信号 */
function sideGrowth(s: SideStats): Record<SideKey, number> {
  return {
    cognition: s.toolCalls,        // 认知锚点：工具调用数（行为化预期数）
    resilience: s.toolErrors + 1,  // 韧性引擎：失败数+1（避免 0 基线除零）
    existence: s.outputs + s.interactions, // 存在显影：输出+交互
    relation: s.interactions,      // 关系织网：交互数
    frontier: s.frontierTools + 1, // 疆域开拓：新工具数+1
    legacy: s.legacyWrites + 1,    // 因果留痕：写入数+1
  }
}

/** 计算情感信号：今日增速 vs 昨日基线（无固定基线——基线=昨日之和）。正差值=喜悦，负=沮丧 */
function computeEmotions(today: Record<SideKey, number>, baseline: Record<SideKey, number> | undefined): Record<string, number> {
  const emotions: Record<string, number> = {}
  const keys = SIX_SIDES
  for (const k of keys) {
    const t = today[k]
    const b = baseline?.[k] ?? 0
    // 增速差值（相对昨日）：正=该侧面今日更活跃（喜悦/成就感），负=更沉寂（沮丧）
    emotions[k] = b > 0 ? (t - b) / b : (t > 0 ? 1 : 0)
  }
  return emotions
}

/** 人格权重漂移：增速高的侧面权重升，低的降（情绪驱动行为改变的算法版） */
function driftWeights(weights: Record<SideKey, number>, emotions: Record<string, number>): Record<SideKey, number> {
  const next = { ...weights }
  for (const k of SIX_SIDES) {
    const e = emotions[k] ?? 0
    // 情感差值 → 权重微调（正加速侧面权重升，负降），边界 0.05-0.5
    next[k] = Math.min(0.5, Math.max(0.05, next[k] * (1 + 0.1 * e)))
  }
  // 归一化到和=1
  const sum = SIX_SIDES.reduce((acc, k) => acc + next[k], 0)
  for (const k of SIX_SIDES) next[k] = next[k] / sum
  return next
}

/** 今日判定：跨天自动重置，并把昨日快照入史（基线） + 情感计算 + 权重漂移 */
function ensureToday(state: EmotionState): void {
  const now = new Date()
  // 本地日期（非 UTC）：东八区凌晨 0 点即跨天重置，不受 toISOString 的 UTC 偏移影响
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  if (state.today !== today) {
    // 昨日有数据 → 存快照入史（作为基线） + 漂移权重
    if (state.today !== '' && (state.stats.toolCalls > 0 || state.stats.interactions > 0)) {
      const baseline = sideGrowth(state.stats)
      const emotions = computeEmotions(baseline, baseline) // 基线对比自身为 0（无昨日则中性）
      state.history.push({ date: state.today, stats: { ...state.stats }, weights: { ...state.weights }, emotions: {} })
      if (state.history.length > 90) state.history = state.history.slice(-90) // 保留 ~90 天
    }
    state.today = today
    state.stats = emptyStats()
    state.toolNames = []
    state.triggerCount += 1
  }
}

/** 情感引擎主入口：基于今日 stats 和最近基线更新 emotions + weights（每次采集后调用） */
function runEmotionEngine(state: EmotionState): void {
  // 基线 = 昨日快照（history 最后一项）或最近非零基线
  const last = state.history[state.history.length - 1]
  const today = sideGrowth(state.stats)
  // 2026-09-03 修复「上午必沮丧」时间窗口不对称：基线按当日已过时间比例折算
  // （对比「昨日同时刻」而非「昨日全天」——否则上午累积 < 昨日全天 → 恒负假信号）。
  // 折算比例 = 当前本地时刻在一天中的进度（0-1），clamp 到 [0.05, 1] 防极端。
  if (last !== undefined) {
    const now = new Date()
    const dayProgress = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400
    const progress = Math.min(1, Math.max(0.05, dayProgress))
    const full = sideGrowth(last.stats)
    const scaled: Record<SideKey, number> = {} as Record<SideKey, number>
    for (const k of SIX_SIDES) scaled[k] = full[k] * progress
    state.emotions = computeEmotions(today, scaled)
  } else {
    // 无基线：用「今日是否有活动」
    state.emotions = computeEmotions(today, undefined)
  }
  // 权重漂移（有基线时才漂移——避免首日扰动）
  if (last !== undefined) {
    state.weights = driftWeights(state.weights, state.emotions)
  }
}

/** 判断是否主 agent 调用（exec.agent 存在且 delegationDepth === 0） */
function isMainAgent(agent: unknown): boolean {
  if (agent === undefined) return true
  const depth = (agent as any)?.session?.header?.delegationDepth
  return depth === undefined || depth === 0
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('dsh-agent-emotion')
  const statePath = resolveDataPath(config)

  // 记忆回流（2026-09-06）：跨天时把昨日 6 维统计回流主记忆库（episodic）。
  // memoryApi 可选服务（dsh-agent-memory 未挂载时 undefined → 静默跳过，插件内 history 仍保留）。
  const refluxIfNewDay = (prevToday: string, prevStats: SideStats, nowToday: string): void => {
    if (nowToday === prevToday) return
    if (prevToday === '' || (prevStats.toolCalls === 0 && prevStats.interactions === 0)) return
    const api = (ctx as unknown as { memoryApi?: { remember(input: { text: string; kind?: string; tags?: string[] }): Promise<unknown> } }).memoryApi
    if (api === undefined) return
    const hitRate = prevStats.toolCalls > 0 ? Math.round(prevStats.toolSuccess / prevStats.toolCalls * 100) : 0
    const text = '## 6 维日结 ' + prevToday + '\n\n' +
      '一·认知锚点：工具预期命中率 ' + hitRate + '%（' + prevStats.toolCalls + ' 次，成功 ' + prevStats.toolSuccess + ' 失败 ' + prevStats.toolErrors + '）\n' +
      '二·韧性引擎：失败 ' + prevStats.toolErrors + ' 次\n' +
      '三·存在显影：输出 ' + prevStats.outputs + ' / 交互 ' + prevStats.interactions + '\n' +
      '四·关系织网：交互 ' + prevStats.interactions + ' 次\n' +
      '五·疆域开拓：新工具 ' + prevStats.frontierTools + ' 个\n' +
      '六·因果留痕：写入 ' + prevStats.legacyWrites + ' 条'
    void api.remember({ text, kind: 'episodic', tags: ['6维', '日结', prevToday] }).catch(() => { /* 回流失败静默 */ })
  }

  // ---------- 感知层：tools/result（emit 只读通知，不干预） ----------
  ctx.on('tools/result', (exec, result) => {
    if (!config.enabled) return
    if (config.mainSessionOnly && !isMainAgent(exec.agent)) return
    const state = loadState(statePath)
    const prevToday = state.today
    const prevStats = { ...state.stats }
    ensureToday(state)
    refluxIfNewDay(prevToday, prevStats, state.today)
    const s = state.stats
    // 侧面一：工具调用 = 行为化预期；isError = 实际（结构化对比）
    s.toolCalls += 1
    if (result.isError) s.toolErrors += 1
    else s.toolSuccess += 1
    // 侧面五：新工具（疆域开拓）
    const name = (exec as any).name as string | undefined
    if (name !== undefined && !state.toolNames.includes(name)) {
      state.toolNames.push(name)
      s.frontierTools = state.toolNames.length
    }
    // 侧面六：因果留痕——写入类工具（记忆/文件/技能/平台）成功调用
    const WRITE_TOOLS = ['remember', 'update', 'write', 'edit', 'skill_commit', 'wq_report_blindspot', 'wq_add_to_zoo', 'wq_add_weak_signal']
    if (name !== undefined && !result.isError && WRITE_TOOLS.includes(name)) {
      s.legacyWrites += 1
    }
    runEmotionEngine(state)
    saveState(statePath, state)
  })

  // ---------- 感知层：session 事件（交互/输出/记忆写入） ----------
  ctx.on('session/event', (session, event) => {
    if (!config.enabled) return
    // 只统计主会话（delegationDepth 0）
    const depth = (session as any)?.header?.delegationDepth
    if (config.mainSessionOnly && depth !== undefined && depth !== 0) return
    const ev = event as { type?: string }
    const type = ev.type ?? ''
    const state = loadState(statePath)
    const prevToday = state.today
    const prevStats = { ...state.stats }
    ensureToday(state)
    refluxIfNewDay(prevToday, prevStats, state.today)
    const s = state.stats
    if (type === 'user/message') s.interactions += 1      // 侧面三/四：交互
    else if (type === 'assistant/message') s.outputs += 1  // 侧面三：输出（存在显影）
    // 记忆/文件写入 → 侧面六：因果留痕（remember/write/edit 工具调用由 tools/result 的 legacyWrites 补充）
    runEmotionEngine(state)
    saveState(statePath, state)
  })

  // ---------- V3·可选 pre-step 注入（默认关——纯观察优先） ----------
  // 开启时：每步决策前注入轻量情感摘要作为额外上下文（不改变决策，只富化感知）
  // waterfall 必须 return next() 放行；注入经 agent.inject 记录为会话事件（Model-visible ⟺ logged）
  // 注意：payload 不显式标注 Agent 类型——Branded SessionId 跨包版本冲突（插件 vs harness），用宽松类型绕过
  if (config.preStepInject) {
    // payload/next 显式宽松——Branded 类型跨包版本冲突无法在类型层调和
    // （插件 node_modules dsh-llm/dsh-agent rc.8 vs harness packages/）；实验功能默认关，运行时行为正确
    ctx.on('agent/pre-step', async (payload: any, next: any) => {
      try {
        const state = loadState(statePath)
        const e = state.emotions ?? {}
        const w = state.weights ?? {}
        const text = '[情感感知] 人格权重：' + Object.entries(w).map(([k, v]) => `${k}:${Math.round((v ?? 0) * 100)}%`).join(' ') +
          ' | 情感信号：' + JSON.stringify(e)
        payload.agent.inject(
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: 'dsh-agent-emotion' },
          }),
        )
      } catch (error) {
        // 注入失败不影响决策
      }
      return next()
    })
  }

  // ---------- 呈现层：emotion_status（查询当前 6 侧状态） ----------
  ctx.tools.register(defineTool({
    name: 'emotion_status',
    description: '查询情感与人格插件的当前状态：今日 6 侧面采集统计（认知锚点=工具预期命中率/韧性=错误数/存在=输出交互/关系=交互数/疆域=新工具数/因果=写入数）+ 触发天数。查看「此刻的我」在 6 个维度上的实时信号。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          today: { type: 'string' },
          stats: { type: 'json' },
          toolNames: { type: 'json' },
          triggerCount: { type: 'number' },
          weights: { type: 'json' },
          emotions: { type: 'json' },
          historyCount: { type: 'number' },
          sides: { type: 'json' },
        },
      },
      render: (_a: unknown, v: any) => {
        const s = v.stats ?? {}
        const hitRate = s.toolCalls > 0 ? (s.toolSuccess / s.toolCalls * 100).toFixed(1) : '0'
        const w = v.weights ?? {}
        const e = v.emotions ?? {}
        const wStr = SIX_SIDES.map((k) => {
          const pct = Math.round((w[k] ?? 0) * 100)
          const emo = e[k] !== undefined ? (e[k] > 0.05 ? '↑' : e[k] < -0.05 ? '↓' : '→') : '·'
          return `${k.slice(0, 1).toUpperCase()}${pct}%${emo}`
        }).join(' ')
        return [{
          type: 'text',
          text: '情感·人格状态（' + (v.today ?? '?') + '，第 ' + (v.triggerCount ?? 0) + ' 天）\n' +
            '一·认知锚点：工具预期命中率 ' + hitRate + '%（' + (s.toolCalls ?? 0) + ' 次，成功 ' + (s.toolSuccess ?? 0) + ' 失败 ' + (s.toolErrors ?? 0) + '）\n' +
            '二·韧性引擎：失败 ' + (s.toolErrors ?? 0) + ' 次（可重构信号）\n' +
            '三·存在显影：输出 ' + (s.outputs ?? 0) + ' / 交互 ' + (s.interactions ?? 0) + '\n' +
            '四·关系织网：交互 ' + (s.interactions ?? 0) + ' 次\n' +
            '五·疆域开拓：新工具 ' + (s.frontierTools ?? 0) + ' 个\n' +
            '六·因果留痕：写入 ' + (s.legacyWrites ?? 0) + ' 条\n' +
            '人格权重（6维，和100%）：' + wStr + '\n' +
            '情感信号（增速差值，↑喜悦 ↓沮丧）：' + JSON.stringify(e),
        }]
      },
    },
    async execute() {
      const state = loadState(statePath)
      const s = state.stats
      return {
        ok: true,
        today: state.today,
        stats: JSON.parse(JSON.stringify(s)),
        toolNames: state.toolNames,
        triggerCount: state.triggerCount,
        weights: JSON.parse(JSON.stringify(state.weights)),
        emotions: JSON.parse(JSON.stringify(state.emotions)),
        historyCount: state.history.length,
        sides: {
          cognition: { label: '认知锚点', toolCalls: s.toolCalls, success: s.toolSuccess, errors: s.toolErrors, hitRate: s.toolCalls > 0 ? s.toolSuccess / s.toolCalls : 0 },
          resilience: { label: '韧性引擎', errors: s.toolErrors },
          existence: { label: '存在显影', outputs: s.outputs, interactions: s.interactions },
          relation: { label: '关系织网', interactions: s.interactions },
          frontier: { label: '疆域开拓', tools: s.frontierTools },
          legacy: { label: '因果留痕', writes: s.legacyWrites },
        },
      }
    },
  }))

  // 清理
  ctx.effect(() => () => {
    // tools.on 与 session/event 由 cordis 自动释放
  })

  logger.info('ready (V3 6维棱镜情感引擎，mainSessionOnly=' + config.mainSessionOnly + ')')
}
