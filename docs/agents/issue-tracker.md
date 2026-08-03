# 共享 Tracker 入口

权威工作流：本地 [`../murmurlane-stack/docs/workflow/issue-tracker.md`](../../../murmurlane-stack/docs/workflow/issue-tracker.md)；GitHub：[main](https://github.com/Youxuuuuu/murmurlane-stack/blob/main/docs/workflow/issue-tracker.md)。

唯一 Tracker：本地 [`../murmurlane-stack/tracker`](../../../murmurlane-stack/tracker)；GitHub：[main](https://github.com/Youxuuuuu/murmurlane-stack/tree/main/tracker)。

- 每个任务必须有 `Repo`、`Status`、`Contract change`、`Core change` 与 `Core decision`。
- 只有生产契约与消费者都需修改、跨边界身份/媒体变化、两侧独立缺陷或无法独立兼容发布时使用 `Repo: both`。
- 未确定归属时使用 `Status: needs-triage`；状态包含 `completed`。
- 完整规则以 `murmurlane-stack` 为准。
