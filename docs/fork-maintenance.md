# Cyberboss Fork 基线与上游维护

## 文档目的

本文记录 Cyberboss 扩展型 fork 的 Git 基线、上游同步流程和冲突关注点。它回答“当前 fork 从哪里分叉、最近同步到哪里、Xiaoye 大规模扩展从哪里开始”，不代替当前架构文档、ADR 或跨仓库 Spec。

具体架构与所有权见：

- [`docs/architecture.md`](architecture.md)
- [`AGENTS.md`](../AGENTS.md)
- [`CONTEXT.md`](../CONTEXT.md)
- 共享仓库地图：本地 [`../murmurlane-stack/docs/repository-map.md`](../../murmurlane-stack/docs/repository-map.md)；GitHub：[main](https://github.com/Youxuuuuu/murmurlane-stack/blob/main/docs/repository-map.md)

## 仓库与维护分支

| 角色 | 当前记录 | 验证日期 | 验证方式 |
| --- | --- | --- | --- |
| 上游仓库 | `https://github.com/WenXiaoWendy/cyberboss.git`（remote：`upstream`） | 2026-08-03 | `git remote -v` |
| Fork 仓库 | `https://github.com/Youxuuuuu/ye-cyberboss.git`（remote：`origin`） | 2026-08-03 | `git remote -v` |
| Xiaoye 维护分支 | `dev/xiaoye`，跟踪 `origin/dev/xiaoye` | 2026-08-03 | `git branch -vv` |

本地 `upstream` 的 fetch URL 已配置；push URL 为 `DISABLED`。本文只记录当前 remote，不修改或自动添加 remote。

## 三种基线

三种基线用途不同。即使某次核对得到相同 SHA，也不得合并概念。

| 基线 | 定义 | 已验证 SHA | 提交信息 | 验证日期 |
| --- | --- | --- | --- | --- |
| Initial Upstream Base | `dev/xiaoye` 相对当前本地 `upstream/main` 的第一个独有提交之前、仍属于上游历史的父提交；表示这条维护分支最初开始加入本地提交时的上游基底。 | `373ab17d283f1e3b304a6a36e17e9e8d44f1acfc` | `Update timeline-for-agent dependency` | 2026-08-03 |
| Latest Upstream Sync Base | 当前 `dev/xiaoye` 与本地 `upstream/main` 的 merge-base；表示当前历史已经共同包含到的最新本地已知上游提交。 | `373ab17d283f1e3b304a6a36e17e9e8d44f1acfc` | `Update timeline-for-agent dependency` | 2026-08-03 |
| Xiaoye Expansion Baseline | Xiaoye 大规模 Conversation、WebChat、媒体和跨仓库扩展之前的本地功能基线；也是当前图中 `upstream/main..dev/xiaoye` 的第一个提交。 | `a1b2428631c453a4e153a79fd077d7612da523f1` | `正常启动` | 2026-08-03 |

### 验证证据

2026-08-03 的只读核对得到：

```text
git rev-list --reverse upstream/main..dev/xiaoye
→ 第一项 a1b2428631c453a4e153a79fd077d7612da523f1

git show -s --format=%P a1b2428631c453a4e153a79fd077d7612da523f1
→ 373ab17d283f1e3b304a6a36e17e9e8d44f1acfc

git merge-base dev/xiaoye upstream/main
→ 373ab17d283f1e3b304a6a36e17e9e8d44f1acfc
```

`upstream/main` 和 `a1b242…` 都是当前 `dev/xiaoye` 的祖先。

### 重要解释

`a1b242…` 虽然是 Xiaoye 大规模扩展前基线，但它已经包含本地运行、Windows 或 ClaudeCode 相关适配。不得把它描述为“完全未修改的纯上游本体”。

Initial Upstream Base 与 Latest Upstream Sync Base 当前同为 `373ab17…`，只说明当前本地 Git 图中，`dev/xiaoye` 已包含本地 `upstream/main` 的现有尖端，且没有证据表明之后又同步了一个更新的 `upstream/main` 提交；不表示两个概念永久相同。

以下信息当前无法从这次只读历史核对中确认：

- GitHub 服务器上的 `upstream/main` 是否存在尚未 fetch 到本地的更新：`Not yet verified`
- GitHub fork 创建事件的准确时间，以及服务器创建 fork 时指向的提交：`Not yet verified`
- 最近一次人工同步上游的执行者、冲突清单和验证报告：`Not yet verified`

## Cyberboss Core 修改门槛

涉及 MurmurLane、WebChat、Conversation 或页面功能时，默认不修改 `src/core/` 和上游既有主体文件。确认所有权后，依次优先考虑：

1. MurmurLane Workspace、Adapter 或 View。
2. `src/custom/xiaoye/murmurlane/`。
3. `src/custom/xiaoye/conversation/`。
4. 已存在的窄 Port 或扩展 seam。
5. Runtime 或 Channel 特有问题进入对应 Adapter。
6. 只有权威跨渠道或跨 Runtime 语义才考虑 Core。

修改 Core 或上游既有关键文件前，共享 Spec 必须记录 `Core change: none | required`、`Core decision: not-applicable | pending | approved | rejected`、`Approved by:`、`Decision date:` 与 `Core files:`，以及 Core 所有权依据、现有 Port/Xiaoye/Adapter 无法正确承载的原因、上游同步风险、兼容与回滚方案和验证边界。

`Core change: none` 时，`Core decision` 必须为 `not-applicable`。

`Core change: required` 时，智能体必须在 `Core decision: pending` 阶段先列出拟修改的 `Core files`、所有权依据、现有 seam 无法承载的原因、上游风险、兼容、回滚和验证方案。

`required + pending` 时不得修改任何 Core 文件。只有用户或维护者可以将 `Core decision` 改为 `approved`。批准仅覆盖当时已经列出的 `Core files`。

实施中如需增加或替换 Core 文件，必须把 `Core decision` 重新改为 `pending`，在 Comments 追加原因并重新获得批准。

`rejected` 时不得修改 Core，应采用替代方案或记录 `wontfix`。

必须修改 Core 时，优先新增职责单一的深模块，通过窄 interface 暴露；不得把领域算法直接堆入 `app.js`，也不得顺带重构无关上游代码。

## 上游同步流程

上游同步是独立维护任务，不与普通功能修改混在一起。

1. 明确同步范围，读取本文、`AGENTS.md`、`docs/architecture.md`、相关 ADR 和共享 Spec。
2. 确认 `dev/xiaoye` 工作树状态、当前提交、remote 和 tracking branch；存在无关改动时停止。
3. 在获得同步授权后执行 `git fetch upstream`，记录 fetch 前后的 `upstream/main`；不得静默修改 remote URL。
4. 重新计算 Initial Upstream Base、旧 Latest Upstream Sync Base 与 `git merge-base dev/xiaoye upstream/main`，不得沿用过期 SHA。
5. 从 `dev/xiaoye` 创建独立同步分支，例如 `sync/upstream-YYYYMMDD`；不要直接在维护分支试错。
6. 使用 `git log` 与 `git diff` 审阅旧同步基线到新 `upstream/main` 的上游变化，并先建立当前行为的 Characterization Test。
7. 根据已经发布的历史选择 merge、rebase 或分阶段迁移；不得重写已共享历史，选择和原因写入 Tracker。
8. 逐个解决冲突，保持当前模块所有权、Xiaoye Port、Runtime 身份和 Conversation/WebChat 契约，不把旧路径或已淘汰旁路重新带回。
9. 分别运行 Core、Runtime、Conversation、WebChat 和相关跨仓库验证，并从真实入口验收用户可见链路。
10. 记录新同步基线、冲突、测试、未验证项和回滚点；经审核后再合入 `dev/xiaoye`。不自动提交或 push。

## 冲突热点

以下是基于 2026-08-03 当前架构文档、fork delta 和提交触达次数得到的维护关注点；它们是预期检查点，不代表已经发生真实冲突。

| 范围 | 关注原因 |
| --- | --- |
| `src/core/app.js` | 当前 fork 历史中高频修改；承担启动与装配，容易与上游生命周期、Turn Gate 和事件接线变化相撞。 |
| `src/core/config.js`、`src/index.js`、`package.json`、`package-lock.json` | 启动参数、依赖与装配入口容易同时被上游和 fork 修改。 |
| `src/core/inbound-turn.js`、`stream-delivery.js`、`thread-state-store.js` | Inbound、Runtime Event、线程状态与渠道投递身份必须保持一致。 |
| `src/core/runtime-settings-service.js`、`thread-usage-ledger.js` | Fork 新增的模型、Effort 与 Usage 权威模块；同步时要确认 Core interface 和持久化边界。 |
| `src/adapters/runtime/codex/`、`claudecode/`、`shared/` | 上游 Runtime 能力与 fork 的模型目录、Usage、身份、媒体解析可能同时演进。 |
| `src/adapters/channel/router.js` | 必须保留显式 provider 路由，防止未知 provider 错误落到微信。 |
| `src/custom/xiaoye/index.js` | Core 与自定义模块的组合根和窄 Port；冲突解决不得恢复对 `CyberbossApp` 的宽依赖。 |
| `src/custom/xiaoye/conversation/` | Conversation Schema、身份、媒体、导入和 Writer 是 MurmurLane 的生产契约来源。 |
| `src/custom/xiaoye/murmurlane/` | WebChat HTTP/SSE、Request Ledger 和 Chat Service 是跨仓库契约热点。 |
| 对应 `test/` 契约与 fixture | 冲突解决必须保留失败语义，不得只让实现代码编译通过。 |

历史中曾存在 `src/core/conversation/`、`src/adapters/channel/webchat/` 等旧物理路径。同步和冲突解决必须以当前架构所有权为准，不得仅因上游文件名相似就复活已迁移的旧结构。

## 最近一次上游同步记录模板

复制以下模板追加记录；无法确认的字段使用 `Not yet verified`，不得猜测 SHA。

```md
### YYYY-MM-DD 上游同步

- 执行者：Not yet verified
- 目标分支：dev/xiaoye
- 集成分支：Not yet verified
- 同步前 dev/xiaoye：Not yet verified
- 同步前 upstream/main：Not yet verified
- 旧 Latest Upstream Sync Base：Not yet verified
- 同步后 upstream/main：Not yet verified
- 新 Latest Upstream Sync Base：Not yet verified
- 上游提交范围：Not yet verified
- 集成方式：merge | rebase | 分阶段迁移 | Not yet verified
- Core change：none | required | Not yet verified
- Core decision：not-applicable | pending | approved | rejected | Not yet verified
- 批准人：Not yet verified
- 决策日期：Not yet verified
- Core files：Not yet verified
- 相关 Spec：Not yet verified
- 冲突文件：Not yet verified
- 冲突决策：Not yet verified
- Cyberboss 定向验证：Not yet verified
- Cyberboss 完整验证：Not yet verified
- MurmurLane 契约验证：Not yet verified
- 用户可见链路验收：Not yet verified
- 回滚点：Not yet verified
- 最终提交：Not yet verified
- 未完成事项：Not yet verified
```
