/**
 * dsh-agent-emotion — IO 薄壳（状态文件读写）
 *
 * 只有路径解析 + 读/写状态文件三件事；任何失败一律吞错（C4：观测/状态 IO 绝不反噬主流程）。
 * 判据与默认值来自 engine.ts（单一真源）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DEFAULT_STATE, emptyStats } from './engine.ts'
import type { EmotionState } from './engine.ts'

/** 状态文件路径（2026-08-30 对齐：DSH_HOME 用环境变量，替代 homedir 旧路径） */
export function resolveDataPath(
  config: { dataDir?: string },
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const dshHome = env.DSH_HOME || join(home, '.dsh')
  const base = config.dataDir || join(dshHome, 'agent-emotion')
  return join(base, 'emotion-state.json')
}

/** 读状态：文件缺失/损坏/字段缺失一律回退默认值并补齐结构（不抛） */
export function loadState(path: string): EmotionState {
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

/** 写状态：失败吞错并返回 false（调用方忽略返回值，失败不阻塞采集） */
export function saveState(path: string, state: EmotionState): boolean {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8')
    return true
  } catch (error) {
    // 写失败不致命
    return false
  }
}
