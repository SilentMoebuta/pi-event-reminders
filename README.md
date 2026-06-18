# pi-event-reminders

会话状态监控与智能提醒扩展。根据会话中的关键指标（测试频率、未提交文件数、Token 使用率、连续失败次数），在 agent 开始新轮次时自动注入提醒消息，帮助 agent 保持良好开发习惯。

**设计理念：** "被动监控，主动提醒。" 扩展不强制干预 agent 行为，而是在条件满足时注入提醒上下文，让 agent 自主决策。

## 安装

```bash
pi install git:github.com/SilentMoebuta/pi-event-reminders
```

> 旧的手动复制（`cp -r`）与 `pi -e` 加载方式已废弃，请使用上面的包安装。

配置文件需放在项目根目录的 `.pi/reminders.json` 中：

```bash
cp extensions/pi-event-reminders/reminders.example.json .pi/reminders.json
```

## 工作原理

```
Agent 开始新一轮
    ↓
before_agent_start 事件触发
    ↓
更新会话状态（轮次计数、未提交文件数、冷却减一）
    ↓
遍历所有提醒规则，检查条件是否满足
    ↓
    ├─ 不满足 → 无操作
    └─ 满足 → 通过 pi.sendMessage({ deliverAs: "steer" }) 注入合并消息（不累积进 session 历史）
              ↓
              设置冷却，避免频繁打扰
```

此外，扩展还监听以下事件来维护状态：

- **`tool_result`**：检测测试命令执行（重置 `turnsSinceLastTest`，**失败的测试也算"跑过测试"**——避免 agent 刚跑完失败测试仍被提醒"该跑测试了"）和工具失败（用 `event.isError` 计数 `consecutiveFailures`，任意工具失败均计数；成功即清零）
- **`session_start`**：加载配置文件，重置所有状态

Token 使用率从 `ctx.getContextUsage()` 读取（返回 `{tokens, contextWindow, percent}`），在 `before_agent_start` 时刷新。提醒消息通过 `pi.sendMessage(..., { deliverAs: "steer" })` 注入为当前轮次的 steering hint（不累积进 session 历史，避免污染上下文）。多条提醒合并为一条消息。

## 配置

配置文件为 `.pi/reminders.json`。顶层是一个 `reminders` 数组，每条规则包括以下字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `id` | `string` | ✓ | 规则唯一标识符，用于冷却追踪和消息标注 |
| `condition` | `object` | ✓ | 触发条件，含 `type` 和 `threshold` 两个子字段 |
| `condition.type` | `string` | ✓ | 条件类型，必须是以下四种之一 |
| `condition.threshold` | `number` | ✓ | 触发阈值，当前值 ≥ 阈值时触发 |
| `message` | `string` | ✓ | 提醒消息内容，会注入到 agent 上下文 |
| `cooldown` | `number` | ✓ | 冷却轮数，触发后在此轮数内不再重复提醒 |

### 条件类型详解

#### `turns_since_test`
自上次运行测试以来的轮次数。当 agent 连续多轮都在编辑文件却没有运行测试时触发。

- **阈值建议：** 15-25 轮（约等于一次中等规模修改的预期轮次）
- **重置时机：** 工具 `bash` 执行了匹配测试模式的命令（如 `npm test`、`npx jest`、`pytest` 等）且执行成功

```json
{
  "id": "no-test-check",
  "condition": { "type": "turns_since_test", "threshold": 20 },
  "message": "⚠️ 已经 20 轮没有运行测试了。请立即运行测试套件验证你的修改。",
  "cooldown": 5
}
```

#### `uncommitted_files`
当前未提交的修改文件数量。通过 `pi.exec` 异步执行 `git status --porcelain` 获取（不阻塞主线程）。

- **阈值建议：** 5-10 个文件
- **更新时机：** 每次 `before_agent_start` 事件自动刷新

```json
{
  "id": "uncommitted-check",
  "condition": { "type": "uncommitted_files", "threshold": 5 },
  "message": "⚠️ 已有 5 个文件被修改但未提交。建议现在 git commit 保存进度。",
  "cooldown": 10
}
```

#### `token_usage_pct`
当前上下文窗口的 Token 使用率（百分比）。从 `before_provider_request` 事件中获取。

- **阈值建议：** 70-85%（超过 90% 可能导致上下文截断）
- **注意：** 此条件是否触发取决于你使用的 provider 是否在 `before_provider_request` 事件中提供 `contextTokens` 和 `contextWindow` 字段

```json
{
  "id": "token-budget-check",
  "condition": { "type": "token_usage_pct", "threshold": 80 },
  "message": "⚠️ 上下文窗口已使用 80%。请总结关键进展，准备压缩。",
  "cooldown": 3
}
```

#### `consecutive_failures`
连续工具执行失败的次数。当 agent 的工具调用反复出错（bash 非零退出码、工具返回 error）时计数。

- **阈值建议：** 3-5 次
- **重置时机：** 任何工具执行成功后清零

```json
{
  "id": "consecutive-failure-check",
  "condition": { "type": "consecutive_failures", "threshold": 3 },
  "message": "⚠️ 连续 3 个工具执行失败。请停下来重新评估你的方案。",
  "cooldown": 10
}
```

## 冷却机制

每条提醒规则在触发后进入冷却期，在 `cooldown` 指定轮数内不会再次触发。冷却值在每次 `before_agent_start` 时减一。

**为什么需要冷却：**

- **防止刷屏：** 如果 agent 连续 30 轮不跑测试，不加冷却会每轮都注入同一条提醒，污染上下文
- **给 agent 反应时间：** 提醒被注入后，agent 需要几轮时间来处理——比如决定"我先完成这个修改提交，然后马上跑测试"
- **冷却值参考：**
  - `turns_since_test`：5-10 轮（足够让 agent 跑一轮测试后再被检查）
  - `uncommitted_files`：10-15 轮（提交本身需要 1-2 轮，剩下的留给用户决策）
  - `token_usage_pct`：3-5 轮（Token 使用率变化快，频繁检查有意义）
  - `consecutive_failures`：10-15 轮（agent 重新思考需要更多轮次）

冷却在 `session_start` 时全部清空，所有规则回到可触发状态。

## 消息格式

提醒消息被注入时采用统一格式：

```
[Reminder: <id>] <message>
```

例如：

```
[Reminder: no-test-check] ⚠️ 已经 20 轮没有运行测试了。请立即运行测试套件验证你的修改。
```

消息通过 `before_agent_start` 的 `return { message }` 注入，因此与 pi 的 steering 机制和 superpowers 技能完全兼容。

## 与 Superpowers 技能的集成

### verification-before-completion（完成前验证）
`turns_since_test` 和 `consecutive_failures` 提醒与验证技能互补。当 agent 即将声称"任务完成"时：
- 如果测试很久没跑，agent 会被提醒先验证
- 如果有连续失败，agent 会被提醒问题尚未解决

### test-driven-development（测试驱动开发）
`turns_since_test` 提醒确保 agent 在 TDD 流程中不会偏离"红-绿-重构"循环：
- agent 写了几轮实现后，提醒确保它回到测试环节
- 与 TDD 技能的"先写测试再写实现"约束形成双重保障

### commit（提交变更）
`uncommitted_files` 提醒与 `/commit` 命令配合：
- 当修改积累到一定数量时，提醒 agent 考虑提交
- 防止长时间不提交导致工作丢失或难以回滚

## 安全

- 配置文件使用 `loadRemindersConfig` 加载，带有类型校验（`isValidReminder`），无效条目被静默过滤
- `git status --porcelain` 通过 `pi.exec` 异步调用（不阻塞主线程），有 5 秒超时，失败时返回 0
- 正则匹配（`isTestCommand`）仅用于分类，不涉及用户输入注入

## 许可证

MIT
