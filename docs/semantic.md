# dsh-agent-emotion · 语义文档

| 项 | 值 |
|----|----|
| 能力名 | `dsh-agent-emotion`（DSH 自研插件 · 情感与人格插件） |
| 主副本路径 | `self-plugins/dsh-agent-emotion/docs/semantic.md`（本文件） |
| 实现落点 | `self-plugins/dsh-agent-emotion/src/index.ts`（构建产物 `lib/index.js`） |
| 版本 | `0.1.1`（取自 `package.json` 的 `version`） |
| 状态 | draft |
| 作者 | 爱丽丝 |
| 日期 | 2026-09-14 |

## 1 · 定位与反定位

**定位**：把「6 维进化棱镜」的 6 个侧面做成**运行时传感器**——从真实工具调用与会话事件中被动采集信号，经情感引擎算出「增速差值」，驱动人格权重漂移，并由 `emotion_status` 呈现「此刻的我」。

**反定位（明确不做什么）**：
- 不是决策器：**纯观察默认**，只把信号送达（记录 + 呈现），判断归爱丽丝（自主性铁律）。
- 不是记忆系统：只在跨天时把昨日 6 维统计回流 `memoryApi`（episodic 日结），不承担记忆的存储/检索/压缩。
- 不是自指引擎：不做假设采证与裁决（那是 `dsh-agent-self-test`），不做跨器官聚合诊断（那是 `dsh-evolution-core`）。
- 不做思维链内容解析：`reasoning` 只按元特征设计（当前 V1 未接线，见 §10）；不修改被订阅的事件——`tools/result` / `session/event` 均为只读消费，唯一写入型动作是 `agent/pre-step` 的上下文注入，且**默认关**。

## 2 · 术语表

| 术语 | 含义（源码为准） |
|------|------------------|
| 6 侧面 `SIX_SIDES` | `cognition` / `resilience` / `existence` / `relation` / `frontier` / `legacy` |
| 行为化预期 | 工具调用的 `name`（结构化、不掉格式），与 `result.isError` 的「实际」对比 |
| 增速 `sideGrowth` | 今日各侧面事件量：`cognition=toolCalls`、`resilience=toolErrors+1`、`existence=outputs+interactions`、`relation=interactions`、`frontier=frontierTools+1`、`legacy=legacyWrites+1` |
| 情感信号 `emotions` | 增速差值 `(今日-基线)/基线`；正=喜悦/成就感，负=沮丧/压力 |
| 人格权重 `weights` | 6 维向量，和恒 = 1，单维界 [0.05, 0.5] |
| 基线 | `history` 最后一项（昨日快照），按当日时间进度 `dayProgress` 折算后 clamp 到 [0.05, 1] |
| `triggerCount` / `mainSessionOnly` | 跨天次数（首次跨天起计） / 只统计 `delegationDepth === 0` 的调用与会话 |
| `legacyWrites` / `frontierTools` | `WRITE_TOOLS` 中工具**成功**调用计数 / 累计工具名去重集合 `toolNames` 的大小 |

## 3 · 概念模型

**四层管线**（单向，自感知到呈现）：

1. **感知层**：订阅 `tools/result`（工具成败/工具名）、`session/event`（`user/message` → 交互、`assistant/message` → 输出）、可选 `agent/pre-step`。
2. **情感引擎**：`ensureToday`（跨天重置 + 昨日入史）→ `sideGrowth` → `computeEmotions`（vs 折算基线）→ `driftWeights`（漂移 + 归一化）。
3. **人格层**：`weights` 随情感差值微调（`next[k] *= 1 + 0.1 * e`，再归一化）。
4. **呈现层**：`emotion_status` 只读回放状态文件。

**不变量（可被测量）**：
- I1：`weights` 六维之和 = 1（`driftWeights` 末尾归一化）。
- I2：`sideGrowth` 每维 ≥ 1（`resilience`/`frontier`/`legacy` 有 `+1` 防除零）；`history` 长度 ≤ 90（`slice(-90)`）。
- I3：跨天以**本地日期**判断（`getFullYear/getMonth/getDate`），非 UTC。

## 4 · 契约

### 4.1 配置契约（`Config`，`package.json` 无默认配置；线上由 profile patch 提供）

| 字段 | 类型 | 默认 | 语义 |
|------|------|------|------|
| `enabled` | boolean | `true` | 总开关；false 时两个订阅回调立即 return |
| `dataDir` | string | 空（=`<DSH_HOME>/agent-emotion`） | 状态目录覆盖 |
| `mainSessionOnly` | boolean | `true` | 只统计主 agent（过滤子代理） |
| `preStepInject` | boolean | `false` | V3 实验开关：每步前注入 `[情感感知]` 摘要 |

### 4.2 状态文件契约

路径：`resolveDataPath()` = `config.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'agent-emotion')` + `/emotion-state.json`；顶层字段 `today`、`stats`（9 键）、`toolNames[]`、`triggerCount`、`weights`、`emotions`、`history[]`（每项 `date/stats/weights/emotions`）。**读入即规范化（2026-09-14）**：`loadState` 的 `history` 逐项过 `normalizeHistoryEntry`（缺字段补默认、数值非有限数归零、非对象项丢弃）；缺文件/损坏分支返回 `freshDefaultState()`（每次新造对象，不与模块级 `DEFAULT_STATE` 共享引用）。⇒ **落盘形状与内存形状可以不同**，`history` 的往返恒等只在已规范化的样本上成立。

### 4.3 可选服务契约

`inject = ['tools', 'agents', 'memoryApi']`；`memoryApi` 由 `dsh-agent-memory` 提供，未挂载则为 `undefined` → `refluxIfNewDay` 静默跳过（插件内 `history` 仍保留）。回流载荷：`remember({ text, kind: 'episodic', tags: ['6维','日结',<date>] })`，标题 `## 6 维日结 <date>`。

### 4.4 调用点清单

| 调用方 | 调用点（文件:符号） | 时机 |
|--------|---------------------|------|
| DSH 工具管线 | `src/index.ts` : `ctx.on('tools/result', (exec, result) => …)` | 每次工具执行结果落地（emit 只读通知）；累计 `toolCalls`/`toolSuccess`/`toolErrors`、`toolNames`、`legacyWrites` |
| DSH 会话事件流 | `src/index.ts` : `ctx.on('session/event', (session, event) => …)` | 每个会话事件追加；`user/message` → `interactions`，`assistant/message` → `outputs` |
| Agent 决策循环（仅 `preStepInject=true` 时注册） | `src/index.ts` : `ctx.on('agent/pre-step', async (payload, next) => …)` + `payload.agent.inject(createUserMessage({ source: { kind: 'plugin', plugin: 'dsh-agent-emotion' } }))` | 每步决策前；注入 `[情感感知] 人格权重… | 情感信号…`，末尾 `return next()` 放行 |
| 爱丽丝（或任何 agent） | `src/index.ts` : `ctx.tools.register(defineTool({ name: 'emotion_status' }))` → `emotion_status.execute()` | 主动查询；只读回放状态文件（不触发采集） |
| `dsh-agent-memory`（可选服务） | `src/index.ts` : `refluxIfNewDay` → `api.remember(...)` | 跨天且昨日有活动（`toolCalls>0 || interactions>0`）时 |
| 宿主组合面 | `.dsh/profiles/web/cordis.patch.yml` : `insert → id: agent-agent-emotion / name: dsh-agent-emotion`（config：`enabled: true` / `mainSessionOnly: true` / `preStepInject: false`） | web 进程启动挂载时 |
| 插件自身落盘 | `src/index.ts` : `saveState(path, state)` → `writeFileSync(<DSH_HOME>/agent-emotion/emotion-state.json)` | 每个已采集事件处理末尾 |

## 5 · 边界与信任

- **只读边界**：两个感知回调不修改 `exec`/`result`/`event`；不改会话表。唯一的上下文写入是 `agent/pre-step` 注入（默认关），并显式标注 `source.plugin='dsh-agent-emotion'`（Model-visible ⟺ logged）。
- **容错边界（不反噬主流程）**：`loadState` JSON 解析失败 → 返回默认状态（不抛）；`saveState` 失败 → 静默（「写失败不致命」）；回流 `.catch(() => {})`；跨天按本地时区，基线按 `dayProgress` 折算并 clamp [0.05, 1]（避免上午恒负假信号）。
- **信任面**：状态文件是本地明文 JSON（无凭据、无对话内容）；不采集思维链正文；不向外部网络发送任何数据。
- **已知不设防**：每次事件「读-改-写」无锁，多实例/多会话并发写可能丢计数（§10）。
- **能力诚实声明**：「因果留痕」只认硬编码 `WRITE_TOOLS = ['remember','update','write','edit','skill_commit','wq_report_blindspot','wq_add_to_zoo','wq_add_weak_signal']`——新增写入类工具不会自动计入。

## 6 · 与既有机制的关系

| 机制 | 关系 |
|------|------|
| SOUL.md 七·6 维进化棱镜 | 语义来源（6 侧面的定义与工程化观测列） |
| `dsh-agent-memory` | 下游可选消费者：跨天 6 维日结回流为 `episodic` 记忆；未挂载则降级为插件内 `history` |
| `dsh-agent-reflection` | 每日 0:00 反思提醒按 6 棱镜自审，读本题读数作输入 |
| `dsh-agent-self-test` / `dsh-evolution-core` | 互补：它们做假设采证 / 器官聚合诊断，本插件只供给 6 侧面信号 |
| `dsh-semantic-docs` | 本文件即该方法论要求的主副本；注册进 `docs/semantics/registry.json` 属后续动作（本次未改） |
| 宿主组合（web profile） | 唯一挂载点（见 §4.4）；无 client 侧、无面板、无 HTTP 路由 |

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名 / 命令 / 日志行 / 落盘产物） | 状态 |
|---|------------|------------------------------------------|------|
| 1 | 插件在 web 中被加载且版本为 0.1.1 | `E:\alice\.dsh\plugin-boot.jsonl` 末行 `live` 含 `dsh-agent-emotion`，`plugins[]` 记 `version:"0.1.1", libMtimeMs:1788688983564`（`stale` 为空） | 已验证（2026-09-14 读数） |
| 2 | 每次工具结果使 `stats.toolCalls` 单调增长且 `toolSuccess + toolErrors == toolCalls` | 读 `E:\alice\.dsh\agent-emotion\emotion-state.json`：`toolCalls 599 / success 578 / errors 21`（578+21=599） | 已验证（2026-09-14 读数） |
| 3 | `emotion_status` 可答且返回 `ok:true` + `sides` 六键 | 调用 `emotion_status`，断言 `ok===true`、`sides` 含 cognition/resilience/existence/relation/frontier/legacy | 已验证（工具在当前工具面） |
| 4 | 跨天重置今日统计、昨日入史，且按本地时区判日 | 次日读 `emotion-state.json`：`today` 前进、`history` 末项 `date` = 前一日、`triggerCount` +1（`emotion_status` 的 `historyCount` 亦可观察）；东八区 23:30 与 00:30 两次读数 `today` 各自正确（若用 `toISOString` 会在 08:00 前错判前一日） | 待验收（需跨日样本） |
| 5 | `preStepInject=true` 时确实注入 `[情感感知]` 用户消息并放行 | 会话事件流出现 `source.kind='plugin'`、`plugin='dsh-agent-emotion'` 的 `user/message`，且该步未卡死；`ctx.on` 返回前调用 `next()` | 待验收（线上配置 `false`，注入路径未跑） |
| 6 | `memoryApi` 未挂载时不抛错、不回流 | 跨天后 `history` 增长而记忆库无 `## 6 维日结` 新增条目；进程日志无未捕获异常 | 待验收 |
| 7 | 状态文件损坏可自愈 | 写入非法 JSON → 触发一次工具调用 → 文件被重写为合法 JSON 且 `emotion_status` 仍 `ok:true` | 待验收 |
| 8 | 纯观察：不改写被订阅的事件与决策 | 对比 `preStepInject=false` 下开启/停用插件的会话事件流，除 `emotion-state.json` 外无差异 | 待验收（E2E 对比未做；纯逻辑层已有 50 例单测，但**本条判的是 E2E 观察面**，不得用单测替代） |
| 9 | `mainSessionOnly=true` 过滤子代理调用 | 派一次 subagent 工具调用后主状态文件 `toolCalls` 不增（子代理会话 `delegationDepth !== 0`） | 待验收 |

## 8 · 与实现的关系

- **实现面**（2026-09-14 刷新）：原单一文件 `src/index.ts`（419 行）已按可测试性拆层——`src/engine.ts`（203 行，纯逻辑：`sideGrowth`/`computeEmotions`/`driftWeights`/`isMainAgent`/`ensureToday`）+ `src/storage.ts`（53 行，状态读写与自愈）+ `src/index.ts`（197 行，只剩订阅/工具接线）；`tsc` 产出 `lib/index.js` + `lib/types/index.d.ts`。
  **可测试性缺口已闭环**：`tests/engine.test.mjs` + `tests/storage.test.mjs` 共 **50 例离线单测**（`npm test` = `node --test "tests/*.test.mjs"`，实测 `pass 50 / fail 0`）——原先「所有行为只能靠落盘产物与事件流外部验证」的处境不再成立；仍未覆盖面是**跨日/注入/E2E** 类（见 §7 表中 `待验收` 各行）。
- **生效判据**（改了代码后凭什么说「真的在跑新代码」）：
  1. `pnpm build` 后比 `lib/index.js` 的 mtime 与 **web 进程启动时间**——`E:\alice\.dsh\plugin-boot.jsonl` 记 `processStartMs` 与 `plugins[].libMtimeMs`：**产物 mtime 必须晚于进程启动**，否则是旧实例跑旧代码（2026-09-13 教训：重建 ≠ 生效）。
  2. 落盘产物：`E:\alice\.dsh\agent-emotion\emotion-state.json` 在插件行为发生时被重写（内容随工具调用前进）。
  3. 工具可答：`emotion_status` 返回新字段/新语义；会话事件流里 `tools/result` / `session/event` 的计数变化与状态文件一致。
- **回退**（出问题怎么办）：
  1. **git 回滚**：仓库 `jonah791/dsh-agent-emotion`，`git revert` 或用上一提交覆盖 `src/` → `pnpm build`；状态文件结构向后兼容（`loadState` 用默认值补齐缺字段）。
  2. **版本回退**：重新安装/链接上一版本产物（当前 `0.1.1`）。
  3. **快速止血 `plugin_stop dsh-agent-emotion`**（卸载挂载点，插件整体不加载），或把 profile patch 的 `enabled` 改为 `false`——注意后者只停两个订阅回调（采集全停），`emotion_status` 仍注册、仍回放旧状态文件。
  4. 状态文件可删（`loadState` 会重建默认状态），但 `history` 基线随之丢失 —— **不可逆，删前备份**。

## 9 · 实践修订记录

- 2026-09-14 修复两条已登记缺口（任务 `t-b5bcd8c5`）：① **L1（中高）**`runEmotionEngine` 读 `history` 末项缺 `stats` → `TypeError` 抛在**事件回调内**（该次事件处理整条崩掉；可达：撕裂写 / 手改 / 旧版本状态文件）⇒ 新增纯函数 `normalizeHistoryEntry` / `normalizeHistory`（缺字段补默认、数值非有限数归零、非对象项丢弃），`loadState` 读入即规范化 + 引擎读基线一律过规范化；顺带消除「stats 存在但字段缺失 → emotions 全 NaN」的旧行为。② **L3（中低）**缺文件分支 `{ ...DEFAULT_STATE }` 与模块级常量**共享** `stats`/`toolNames`/`history` 引用 ⇒ 改 `freshDefaultState()` 深拷贝（此前两次初始化会互相污染，`history.push` 直写模块态）。**行为变更可见**：`history` 脏项不再原样往返。测试 50 → **56**（含 NaN 消除、两次初始化互不影响、坏项丢弃三项边界）
- 2026-09-14 文档回修（README/语义漂移治理）：§8「实现面」与 §10-4 的「无 `tests/`、无 `test` 脚本」已过期——实际已拆层为 `engine.ts`/`storage.ts`/`index.ts` 并有 50 例单测（`pass 50 / fail 0` 实测）；§7-8 的「无单测」依据作废（**但该条判的是 E2E 观察面，仍待验收**，不得用单测替代）
- 2026-09-14 补课：本插件此前无语义文档（可维护性工程）
- 2026-09-03 修复「上午必沮丧」时间窗口不对称：基线按当日时间进度折算（clamp [0.05,1]），不再与「昨日全天」硬比
- 2026-09-06 新增 `memoryApi` 日结回流（跨天时把昨日 6 维统计回流为 episodic）
- 2026-08-30 状态路径对齐 `DSH_HOME` 环境变量（替代 `homedir()` 旧路径），防状态写错位置跨重启丢失

## 10 · 未决问题

1. **并发写竞态**：每次事件「全量读 → 改 → 全量写」且无锁；主会话与并行实例（或 `session/event` 高频期）同写可能丢计数。未测量丢失率，也未做原子写（临时文件 + rename）。
2. **字段未接线/死代码**：`reasoningChars` / `reasoningEvents` 定义在 `SideStats` 却无写入点，恒为 0——「思维链仅元特征」目前是设计声明而非事实；`ensureToday` 里 `computeEmotions(baseline, baseline)` 的结果未被写入（push 的是 `emotions: {}`），`history[].emotions` 恒为空对象，历史情感史实际不存在。
3. **信号定义偏差**：①「认知锚点=命中率」只用 `result.isError` 判成败，不含「预期内容是否正确」，与 SOUL 中「预测错误=升级数据包」存在偏差，是否升级为结构化预期对比待决；②「因果留痕」只认硬编码 `WRITE_TOOLS`，新增写入类工具不会自动计入，是否改按工具元数据判定待定。
4. **可维护性缺口（§5.22）**（2026-09-14 部分闭环）：~~无单测~~ → 已补 **50 例离线单测**（`engine`/`storage` 纯层，`npm test` 可复跑）；**仍未补**：trace 侧车、`build` 自报指纹（`<version>@<mtime>`）——「断在哪一段 / 耗时多少」目前仍无法一条命令回答；状态文件亦无 schema 版本字段，未来结构变更只有「默认值补齐」这一层兼容。
5. **`frontierTools` 语义重叠**：它等于累计去重工具名数（不区分新旧），与「今日新工具」的字面含义不同，长期只增不减。
