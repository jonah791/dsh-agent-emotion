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
import {
  SIX_SIDES, ensureToday, runEmotionEngine, isMainAgent, recordToolResult, recordSessionEvent,
  shouldReflux, buildDailyDigest,
} from './engine.ts'
import type { SideStats } from './engine.ts'
import { resolveDataPath, loadState, saveState } from './storage.ts'

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

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('dsh-agent-emotion')
  const statePath = resolveDataPath(config)

  // 记忆回流（2026-09-06）：跨天时把昨日 6 维统计回流主记忆库（episodic）。
  // memoryApi 可选服务（dsh-agent-memory 未挂载时 undefined → 静默跳过，插件内 history 仍保留）。
  const refluxIfNewDay = (prevToday: string, prevStats: SideStats, nowToday: string): void => {
    if (!shouldReflux(prevToday, prevStats, nowToday)) return
    const api = (ctx as unknown as { memoryApi?: { remember(input: { text: string; kind?: string; tags?: string[] }): Promise<unknown> } }).memoryApi
    if (api === undefined) return
    const text = buildDailyDigest(prevToday, prevStats)
    void api.remember({ text, kind: 'episodic', tags: ['6维', '日结', prevToday] }).catch(() => { /* 回流失败静默 */ })
  }

  // ---------- 感知层：tools/result（emit 只读通知，不干预） ----------
  ctx.on('tools/result', (exec, result) => {
    if (!config.enabled) return
    if (config.mainSessionOnly && !isMainAgent(exec.agent)) return
    const state = loadState(statePath)
    const prevToday = state.today
    const prevStats = { ...state.stats }
    ensureToday(state, new Date())
    refluxIfNewDay(prevToday, prevStats, state.today)
    // 侧面一（预期 vs 实际）+ 侧面五（新工具）+ 侧面六（写入类工具）
    recordToolResult(state, { name: (exec as any).name as string | undefined, isError: Boolean(result.isError) })
    runEmotionEngine(state, new Date())
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
    ensureToday(state, new Date())
    refluxIfNewDay(prevToday, prevStats, state.today)
    // 侧面三/四：交互（user/message）与输出（assistant/message）
    recordSessionEvent(state, type)
    runEmotionEngine(state, new Date())
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
