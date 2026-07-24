# 任务状态

| 标准角色 | 任务状态 | 含义 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 等待维护者判断和分类 |
| `needs-info` | `needs-info` | 等待补充信息 |
| `ready-for-agent` | `ready-for-agent` | 信息完整，可由智能体执行 |
| `ready-for-human` | `ready-for-human` | 需要人工处理 |
| `wontfix` | `wontfix` | 决定不处理 |

任务文件通过 `Status:` 字段记录当前状态。
