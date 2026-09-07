# dsh-agent-emotion


<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-emotion"><img src="https://img.shields.io/badge/version-0.1.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
</p>
> 情感与人格插件：6 维进化棱镜的运行时传感器。
> DeepSeek Harness 自研插件 · v0.1.1

## 定位

把「进化棱镜」的 6 个侧面（认知锚点 / 韧性引擎 / 存在显影 / 关系织网 / 疆域开拓 / 因果留痕）做成**运行时传感器**——从真实工具调用中被动采集 6 侧面信号，计算情感信号，驱动人格权重漂移，让智能体的成长可观测。

## 功能特性

- **感知层**：订阅 DSH 工具管线 / 思考流事件，采集 6 侧面信号（认知锚点=工具预期命中率、韧性=错误数、存在=输出交互、关系=交互数、疆域=新工具数、因果=写入数）
- **情感引擎**：增速差值 = 情感信号（正增速 = 积极，负增速 = 压力）
- **人格层**：权重漂移（信号累积 → 人格权重微调）
- **呈现层**：`emotion_status` 查看「此刻的我」在 6 个维度上的实时信号
- **设计原则**：结构化事件为主，思维链仅元特征，**纯观察默认**（不干预决策）

## 安装

```bash
git clone https://github.com/jonah791/dsh-agent-emotion.git self-plugins/dsh-agent-emotion
cd self-plugins/dsh-agent-emotion && pnpm install && pnpm build
```

挂载到 web profile。

## 使用（工具面）

| 工具 | 用途 |
|------|------|
| `emotion_status` | 查看今日 6 侧面采集统计 + 触发天数（情感/人格实时状态） |

## 配置

无（纯观察，被动采集）。

## 技术要点

- **纯观察**：订阅事件流只读取不修改，不参与决策——信号送达，判断归智能体
- **6 侧面工程化观测**：每个侧面有可度量信号（见 SOUL.md 六维进化棱镜）
- 与 dsh-evolution-core（聚合诊断）、dsh-agent-self-test（假设采证）互补

## License

MIT