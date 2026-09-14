<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 情感与人格插件：把「6 维进化棱镜」的 6 个侧面做成运行时传感器——被动采集工具/会话信号 → 增速差值 = 情感信号 → 人格权重漂移 → emotion_status 呈现
  inject: 'tools','agents','memoryApi'
  tools: emotion_status
  runtime: host-only
  envDeps: 无（标准 Node + 本地明文 JSON）；memoryApi 由 dsh-agent-memory 可选提供，缺失则跨天日结降级为插件内 history
  boundary: 纯观察——tools/result、session/event 只读不改写；唯一写入型动作是 agent/pre-step 注入且默认关（preStepInject:false）；状态文件读-改-写无锁，多实例并发可能丢计数（见「设计要点」）
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-agent-emotion

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-emotion"><img src="https://img.shields.io/badge/version-0.1.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-50%20passed-brightgreen" alt="tests">
</p>

**一句话**：把 SOUL.md 里的「6 维进化棱镜」变成可读数的运行时传感器——订阅工具管线与会话事件，被动累计 6 侧面信号，算出「今日增速 vs 昨日同时刻」的差值当情感信号，并让人格权重随之漂移；`emotion_status` 一行答出「此刻的我」在哪六个维度上活跃。

**为什么值得用**：成长感应有的样子是**数字**，不是形容词。不装它，「今天我更有存在感了吗」只能靠回忆；装了它，`emotion_status` 直接给 `工具预期命中率 97.0% / 交互 213 / 新工具 50 / 写入 247`，跨天连历史基线一起给（`historyCount`）。它**只观测不干预**：两个订阅回调不修改被订阅的事件，唯一的上下文写入（pre-step 注入）默认关闭——信号送达，判断仍归 agent。

## 能力

| 工具 | 用途 |
|------|------|
| `emotion_status` | 只读回放状态文件：今日 6 侧面统计（`stats` / `sides` 六键）、人格权重 `weights`（6 维、和=100%）、情感信号 `emotions`（增速差值，↑喜悦 ↓沮丧）、累计去重工具名 `toolNames`、触发天数 `triggerCount`、历史快照条数 `historyCount` |

行为侧（无工具，全部只读消费）：

| 订阅点 | 采集什么 | 计到哪个侧面 |
|--------|----------|--------------|
| `tools/result`（emit 只读通知） | 工具调用 `name`（结构化「行为化预期」）+ `result.isError`（实际） | 一·认知锚点（`toolCalls`/`toolSuccess`/`toolErrors`）、五·疆域开拓（`toolNames` 去重集合）、六·因果留痕（`legacyWrites`） |
| `session/event` | `user/message` → `interactions`；`assistant/message` → `outputs` | 三·存在显影、四·关系织网 |
| `agent/pre-step`（**仅 `preStepInject: true` 时注册**） | 每步决策前注入一行 `[情感感知] 人格权重… ｜ 情感信号…`，末尾 `return next()` 放行 | —（不采集，只富化上下文） |

跨天时（且昨日有活动）把昨日 6 维读数回流主记忆库：`remember({ text: '## 6 维日结 <昨日>', kind: 'episodic', tags: ['6维','日结',<昨日>] })`。

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-agent-emotion": "link:<工作区>/self-plugins/dsh-agent-emotion"
```

**2) 挂组合**（profile 的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: agent-agent-emotion
      name: dsh-agent-emotion
      config:
        enabled: true
        mainSessionOnly: true
        preStepInject: false     # 纯观察优先：注入路径默认关
```

**3) 30 秒验证**：调 `emotion_status` → 期望 `ok: true`，且返回文本为 `情感·人格状态（<今日>，第 N 天）` + 六行（一·认知锚点 … 六·因果留痕）+ 一行 `人格权重（6维，和100%）`；`sides` 应含 `cognition/resilience/existence/relation/frontier/legacy` 六键。

**4) 采集自证**（可选）：随便调一次工具，再读 `${DSH_HOME}/agent-emotion/emotion-state.json`——`stats.toolCalls` 应比刚才 +1。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `enabled` | `true` | 总开关；`false` 时两个订阅回调立即 return（采集全停），但 `emotion_status` 仍注册、仍回放旧状态文件 |
| `dataDir` | 未设（→ `<DSH_HOME>/agent-emotion`） | 状态目录覆盖；最终文件恒为 `<base>/emotion-state.json` |
| `mainSessionOnly` | `true` | 只统计主 agent（`delegationDepth === 0` 的调用与会话），过滤子代理 |
| `preStepInject` | `false` | V3 实验开关：每步决策前注入 `[情感感知]` 摘要（`source.plugin='dsh-agent-emotion'`） |

## 落盘与自证（出问题时先看这里）

**唯一持久产物**：**`<DSH_HOME>/agent-emotion/emotion-state.json`**（`DSH_HOME` 缺省 `~/.dsh`；`config.dataDir` 可覆盖父目录）。它是**全量 JSON 状态快照**（不是 JSONL 轨迹），每次采集事件处理末尾整文件重写。

| 字段 | 含义 |
|------|------|
| `today` | 当日本地日期 `YYYY-MM-DD`（跨天即重置，非 UTC 判日） |
| `stats` | 今日 9 键计数：`toolCalls` / `toolSuccess` / `toolErrors` / `interactions` / `outputs` / `legacyWrites` / `frontierTools` / `reasoningChars` / `reasoningEvents` |
| `toolNames[]` | 累计去重工具名（`frontierTools` 即其长度） |
| `triggerCount` | 触发天数（首次跨天起计） |
| `weights` | 人格权重 6 维，和恒 = 1，单维 clamp 到 `[0.05, 0.5]` |
| `emotions` | 情感信号 6 维（增速差值：正=喜悦/成就感，负=沮丧/压力） |
| `history[]` | 每日快照（`date/stats/weights/emotions`），最多 90 条（截尾保留最近） |

**一条命令答五问**：

```bash
tail -c 600 "$DSH_HOME/agent-emotion/emotion-state.json"   # 全量快照，用 tail -c / cat，不是 tail -1
# ① 跑的是哪个构建 → 文件里**没有** build 指纹字段（缺口，见下）；改用 mtime 对照：
#                     stat -c %y lib/index.js  与 web 进程启动时间比（见「生效判据」）
# ② 谁发起 / 记了谁 → stats 各计数 + toolNames 集合；无 caller / callId 字段（只按主会话口径聚合）
# ③ 断在哪一段     → 无阶段枚举。toolCalls 停滞在会话活动时 ⇒ 采集没发生（enabled:false、非主会话被 mainSessionOnly 过滤、或写盘失败）
# ④ 结果质量       → toolSuccess + toolErrors == toolCalls；frontierTools == toolNames.length；history 长度 ≤ 90
# ⑤ 耗时与预算     → 无 durationMs / 预算字段（缺口）；只能看文件 mtime 前进
```

**已知可维护性缺口（如实写）**：无 `*-trace.jsonl` 阶段侧车、无 `build = <version>@<mtime>` 指纹、无逐事件耗时——所以「断在哪一段/耗时多少」目前**只能间接推断**，不能像 `dsh-tool-wsl` 那样一条 `tail` 答全五问（[`docs/semantic.md`](docs/semantic.md) §10 第 4 条）。

**行为级验证（无需读文件）**：调 `emotion_status` → `ok:true` 即证明状态可读出；连调两次工具再查，`stats.toolCalls` 单调增长即证明采集在跑。

**隐私**：状态文件是本地明文 JSON——只含计数、工具名、权重/情感向量，**无对话内容、无思维链正文、无凭据**，不向任何外部网络发送数据。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：

1. **进程级**：`lib/index.js` 的 mtime ≤ web 进程启动时间（产物 mtime 晚于进程启动 ⇒ 进程在跑旧代码）；`lib/plugin-boot.jsonl` 类启动自报账本可给 `plugins[].libMtimeMs` 对照。本插件**无**自报 `build` 指纹，不要指望从状态文件里看到版本。
2. **语义级**（最直接）：现读调 `emotion_status`，返回值与组合 `config:` 段一致——`mainSessionOnly: false` 时子代理调用应计入；`preStepInject: false` 时工具面外的行为应与装载前一致。
3. **行为级**：状态文件在插件行为发生时被重写（`stats` 前进）；`enabled: false` 时该文件停止前进、但 `emotion_status` 仍可答（旧读数）。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」（AGENTS §5.11 §6）。另外 **`npm test` 脚本不含构建步骤**（`test` = `node --test "tests/*.test.mjs"`），改完源码务必先 `npm run build`。

**回退**（三档）：

- **源码级**：`git -C self-plugins/dsh-agent-emotion revert <commit>` → `npm run build` → 预检 → 重启；状态文件结构向后兼容（`loadState` 用默认值补齐缺字段，旧文件可直接读）。
- **组合级**：profile patch 给 `agent-agent-emotion` 行加 `disabled: true`（或移除该行），或调 `plugin_stop dsh-agent-emotion` → 工具与两个订阅一起消失。
- **运行期/局部**：只把 `config.enabled` 改为 `false` 可只停采集（**注意**：`emotion_status` 仍注册、仍回放旧状态文件——这不是完整停用）；`config.dataDir` 可换状态目录而无需动代码。

> 状态文件可删（`loadState` 会重建默认状态），但 `history` 基线随之丢失 ⇒ 情感信号退回「无基线」模式——**删前备份**。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"（脚本不含 tsc，改源码后先 npm run build）
```

**50 例测试全部 `pass`**（实跑读数：`# tests 50 / # pass 50 / # fail 0 / # skipped 0`，耗时约 171 ms）。纯离线：**无网络、无真实外部依赖、无宿主要求**（`engine.test.mjs` 是零 IO 纯逻辑，`storage.test.mjs` 用 `os.tmpdir()` 级临时路径做 IO，含不可写路径样本）。

| 测试文件 | 覆盖 |
|----------|------|
| `tests/engine.test.mjs` | 6 侧面定义与 `WRITE_TOOLS` 白名单逐字锁定；`localDate`/`dayProgress`（时间由外部注入）；`sideGrowth` 的 `+1` 防零基线；`computeEmotions` 无基线/有基线/`t=b`/`b=0` 边界；`driftWeights` 归一化 + 上下界 clamp（0.05/0.5）；`ensureToday` 同日不动、跨天重置+入史、仅交互也算活动、历史 ≤90 截尾；`runEmotionEngine` **上午不恒负**（基线按当日进度折算）；`isMainAgent`/`shouldRecordEvent` 主会话门；`recordToolResult`（失败不计留痕）、`recordSessionEvent`、`shouldReflux`、`buildDailyDigest`（命中率取整 2/3→67、零调用不除零）逐条断言，并附**逐条退化样本**（脏状态缺字段、空类型、`null`/数组/字符串输入一律不抛） |
| `tests/storage.test.mjs` | `resolveDataPath` 三级优先（`DSH_HOME` > `homedir/.dsh` > `config.dataDir` 覆盖）；`loadState` 容错（文件缺失、损坏 JSON「torn tail」、脏数据补齐、部分字段保留已有值）；`saveState` 往返一致 + **尸体测试**（父路径是普通文件、状态含循环引用 → 返回 `false` 且不抛） |

**已知未覆盖 / 登记缺口**（测试名里显式标注，未静默掩盖）：`runEmotionEngine` 遇 `history` 项缺 `stats` 会抛 `TypeError`（登记为 L1，本次未改行为）；`driftWeights` 全零权重归一化出 `NaN`（保留原行为）；**ctx 级集成未覆盖**——没有构造假 ctx 跑 `apply` 断言两个订阅真的接线、也没有 `agent/pre-step` 注入路径的测试（线上 `preStepInject: false`，注入路径从未跑过）。

> 文档漂移提示：[`docs/semantic.md`](docs/semantic.md) §8 写的「无 `tests/` 目录、`package.json` 无 `test` 脚本、`src/index.ts` 419 行」已过期——现状是 3 个源文件（`index.ts`/`engine.ts`/`storage.ts`）+ 2 个测试文件 50 例。**以源码与本 README 为准**（文档同步属后续动作）。

## 设计要点

- **纯观察优先，只读消费**：`tools/result`（emit 通知）与 `session/event` 回调**不修改** `exec`/`result`/`event`，不写会话表；`emotion_status` 只回放状态文件、不触发采集。唯一写入型动作是 `agent/pre-step` 注入，且**默认关**、显式标 `source.plugin='dsh-agent-emotion'`（Model-visible ⟺ logged）。
- **waterfall 铁律**：`agent/pre-step` 监听器任何分支都必须 `return next()`——短路 = 决策循环停摆。注入体自身包在 `try/catch` 里：注入失败不影响决策。
- **基线不是常量，是「昨日同时刻」**：`runEmotionEngine` 把昨日快照按当日进度 `dayProgress`（clamp 到 `[0.05, 1]`）折算后再比——不这样做，上午累积必然小于昨日全天 ⇒ **上午恒报沮丧**（2026-09-03 修复的实际缺陷）。跨天以**本地日期**判断，避免 `toISOString` 在东八区 08:00 前错判前一日。
- **能力诚实**：「因果留痕」只认硬编码白名单 `WRITE_TOOLS = ['remember','update','write','edit','skill_commit','wq_report_blindspot','wq_add_to_zoo','wq_add_weak_signal']`——新增写入类工具**不会自动计入**；「认知锚点」只用 `result.isError` 判成败，不含「预期内容是否正确」。`reasoningChars`/`reasoningEvents` 两个字段已定义但**未接线**，恒为 0（「思维链仅元特征」目前是设计声明而非事实）。
- **不反噬主流程**：`loadState` 解析失败 → 返回默认状态（不抛）；`saveState` 失败 → 返回 `false` 且不抛（调用方忽略返回值）；记忆回流 `.catch(() => {})`。观测坏掉不得影响工具执行。
- **已知不设防（并发写竞态）**：每次事件「全量读 → 改 → 全量写」且**无锁**、无原子写（临时文件 + rename）——主会话与并行实例（或 `session/event` 高频期）同写可能**丢计数**，丢失率未测量（§10 第 1 条）。
- **跨包 Branded 类型的务实绕行**：`agent/pre-step` 的 `payload`/`next` 用宽松类型（插件侧 `dsh-agent`/`dsh-llm` 与宿主 packages 的 Branded `SessionId` 版本冲突无法在类型层调和）；运行时行为正确，仅供类型层放行。
- **反定位**：不是决策器、不是记忆系统（跨天只回流行，存量检索归 `dsh-agent-memory`）、不是自指引擎（不做假设采证/裁决）、不做跨器官聚合诊断（那是 `dsh-evolution-core`）。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语表、概念模型与不变量（I1–I3）、契约（含**调用点清单**）、边界与信任、9 条可证伪验收清单、实践修订记录、未决问题（含上述缺口；§8 的实现面描述已过期） |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `dsh-sensor-plugin` | **本插件的方法论来源**：用原生拦截扩展点订阅生命周期事件做采集、纯观察优先、跨包 Branded 类型规避（从本插件 V1–V3 实战蒸馏） |
| 技能 `plugin-maintainability` / `dsh-plugin-testability` | 机制自证与可维护性工程（五问判据）；把决策逻辑抽成纯模块 + 离线单测（`engine.ts`/`storage.ts` 即该纪律产物） |
| 相关插件 `dsh-agent-memory` / `dsh-agent-self-test` / `dsh-evolution-core` / `dsh-agent-reflection` | 下游消费者与互补器官：记忆回流、假设采证与裁决、器官聚合诊断、每日 0:00 按 6 棱镜自审 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
