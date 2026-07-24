# 任务跟踪：共享本地 Markdown

Cyberboss 和 MurmurLane 共用同一个本地 Markdown 任务目录：

`D:\study\.cyberboss\engineering-tracker`

## 文件约定

- 每个功能使用一个目录：`<tracker>\<feature-slug>\`
- 需求说明位于：`<tracker>\<feature-slug>\spec.md`
- 实施任务位于：`<tracker>\<feature-slug>\issues\<NN>-<slug>.md`
- 每张任务必须包含 `Repo:` 字段，可选值为：
  - `cyberboss`
  - `murmurlane`
  - `both`
- 每张任务必须包含 `Status:` 字段，状态值见 `triage-labels.md`
- 讨论和进度记录追加在 `## Comments` 标题下

## 发布任务

当 skill 要求“发布到任务跟踪器”时，在共享目录中创建对应文件。不要在仓库内另外创建 `.scratch` 任务目录。

## 读取任务

根据用户提供的功能目录、任务编号或文件名，从共享目录读取任务。

## 项目范围

- `Repo: cyberboss`：后端、运行时、消息渠道、服务或智能体桥接相关工作
- `Repo: murmurlane`：前端展示和 MurmurLane 独有工作
- `Repo: both`：需要两个仓库协同完成的工作
