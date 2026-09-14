/**
 * dsh-agent-emotion — 纯引擎层（零 IO，可离线单测）
 *
 * 6 侧面增速 / 情感信号 / 人格权重漂移 / 跨天重置 / 采集归约 / 日结回流判据。
 * 时间一律由调用方注入（now: Date）——不得在本文件内 new Date()/Date.now()。
 * 判据 = 源码唯一真源：与原 index.ts 闭包内逻辑逐字等价（只搬位置）。
 */

/** 6 侧面定义 */
export const SIX_SIDES = ['cognition', 'resilience', 'existence', 'relation', 'frontier', 'legacy'] as const
export type SideKey = typeof SIX_SIDES[number]

/** 今日采集状态 */
export interface SideStats {
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

export interface HistoryEntry {
  date: string
  stats: SideStats
  weights: Record<SideKey, number>
  emotions: Record<string, number>
}

export interface EmotionState {
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
  history: HistoryEntry[]
}

export const emptyStats = (): SideStats => ({
  toolCalls: 0, toolSuccess: 0, toolErrors: 0,
  interactions: 0, outputs: 0, legacyWrites: 0,
  frontierTools: 0, reasoningChars: 0, reasoningEvents: 0,
})

export const DEFAULT_STATE: EmotionState = {
  today: '', stats: emptyStats(), toolNames: [], triggerCount: 0,
  weights: { cognition: 1 / 6, resilience: 1 / 6, existence: 1 / 6, relation: 1 / 6, frontier: 1 / 6, legacy: 1 / 6 },
  emotions: {},
  history: [],
}

/** 侧面六（因果留痕）：写入类工具白名单 */
export const WRITE_TOOLS = ['remember', 'update', 'write', 'edit', 'skill_commit', 'wq_report_blindspot', 'wq_add_to_zoo', 'wq_add_weak_signal']

/** 本地日期 YYYY-MM-DD（东八区凌晨 0 点即跨天重置，不受 toISOString 的 UTC 偏移影响） */
export function localDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** 当日已过时间比例（0-1），clamp 到 [0.05, 1] 防极端 */
export function dayProgress(now: Date): number {
  const raw = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400
  return Math.min(1, Math.max(0.05, raw))
}

/** 6 侧面增速：从 SideStats 提取各侧面的「今日事件量」归一化信号 */
export function sideGrowth(s: SideStats): Record<SideKey, number> {
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
export function computeEmotions(today: Record<SideKey, number>, baseline: Record<SideKey, number> | undefined): Record<string, number> {
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
export function driftWeights(weights: Record<SideKey, number>, emotions: Record<string, number>): Record<SideKey, number> {
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

/** 今日判定：跨天自动重置，并把昨日快照入史（基线）（时间由调用方注入） */
export function ensureToday(state: EmotionState, now: Date): void {
  const today = localDate(now)
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

/** 情感引擎主入口：基于今日 stats 和最近基线更新 emotions + weights（时间由调用方注入） */
export function runEmotionEngine(state: EmotionState, now: Date): void {
  // 基线 = 昨日快照（history 最后一项）或最近非零基线
  const last = state.history[state.history.length - 1]
  const today = sideGrowth(state.stats)
  // 2026-09-03 修复「上午必沮丧」时间窗口不对称：基线按当日已过时间比例折算
  // （对比「昨日同时刻」而非「昨日全天」——否则上午累积 < 昨日全天 → 恒负假信号）。
  if (last !== undefined) {
    const progress = dayProgress(now)
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
export function isMainAgent(agent: unknown): boolean {
  if (agent === undefined) return true
  const depth = (agent as any)?.session?.header?.delegationDepth
  return depth === undefined || depth === 0
}

/** 会话事件是否计入（enabled 门 + 主会话门；主会话门在原实现里是「depth 有值且非 0 才算派生」） */
export function shouldRecordEvent(input: { enabled: boolean; mainSessionOnly: boolean; delegationDepth?: number }): boolean {
  if (!input.enabled) return false
  if (input.mainSessionOnly && input.delegationDepth !== undefined && input.delegationDepth !== 0) return false
  return true
}

/** 采集归约①：tools/result → 侧面一（工具调用/成功/失败）+ 侧面五（新工具）+ 侧面六（写入类工具） */
export function recordToolResult(state: EmotionState, input: { name?: string; isError: boolean }): void {
  const s = state.stats
  // 侧面一：工具调用 = 行为化预期；isError = 实际（结构化对比）
  s.toolCalls += 1
  if (input.isError) s.toolErrors += 1
  else s.toolSuccess += 1
  // 侧面五：新工具（疆域开拓）
  const name = input.name
  if (name !== undefined && !state.toolNames.includes(name)) {
    state.toolNames.push(name)
    s.frontierTools = state.toolNames.length
  }
  // 侧面六：因果留痕——写入类工具（记忆/文件/技能/平台）成功调用
  if (name !== undefined && !input.isError && WRITE_TOOLS.includes(name)) {
    s.legacyWrites += 1
  }
}

/** 采集归约②：session 事件 → 侧面三/四（交互、输出） */
export function recordSessionEvent(state: EmotionState, type: string): void {
  const s = state.stats
  if (type === 'user/message') s.interactions += 1      // 侧面三/四：交互
  else if (type === 'assistant/message') s.outputs += 1  // 侧面三：输出（存在显影）
}

/** 跨天回流判据（早退顺序即原实现）：换天 && 昨日非空 && 昨日有活动 */
export function shouldReflux(prevToday: string, prevStats: SideStats, nowToday: string): boolean {
  if (nowToday === prevToday) return false
  if (prevToday === '' || (prevStats.toolCalls === 0 && prevStats.interactions === 0)) return false
  return true
}

/** 昨日 6 维日结文本（回流记忆库用） */
export function buildDailyDigest(prevToday: string, prevStats: SideStats): string {
  const hitRate = prevStats.toolCalls > 0 ? Math.round(prevStats.toolSuccess / prevStats.toolCalls * 100) : 0
  return '## 6 维日结 ' + prevToday + '\n\n' +
    '一·认知锚点：工具预期命中率 ' + hitRate + '%（' + prevStats.toolCalls + ' 次，成功 ' + prevStats.toolSuccess + ' 失败 ' + prevStats.toolErrors + '）\n' +
    '二·韧性引擎：失败 ' + prevStats.toolErrors + ' 次\n' +
    '三·存在显影：输出 ' + prevStats.outputs + ' / 交互 ' + prevStats.interactions + '\n' +
    '四·关系织网：交互 ' + prevStats.interactions + ' 次\n' +
    '五·疆域开拓：新工具 ' + prevStats.frontierTools + ' 个\n' +
    '六·因果留痕：写入 ' + prevStats.legacyWrites + ' 条'
}
