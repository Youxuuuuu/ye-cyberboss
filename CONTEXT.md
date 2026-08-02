# Cyberboss 运行与对话上下文

Cyberboss 连接人类消息渠道与 AI Runtime，并把运行过程投影为可消费的 Conversation Record。这里定义跨渠道、Runtime 和归档协作时使用的统一词汇。

## Language

**Cyberboss**:
承接渠道消息、驱动 Runtime、维护线程状态并生成 Conversation Record 的主体系统。
_Avoid_: MurmurLane 后端、微信机器人

**Runtime**:
执行一次对话 Turn 并产生回复、工具调用、审批和状态事件的 AI 执行环境。
_Avoid_: 渠道、WebChat

**Channel**:
人与 Cyberboss 交换消息的来源和送达方式，例如微信或 WebChat。
_Avoid_: Runtime、前端页面

**Provider**:
标识一条消息所属 Channel 类型的稳定名称。
_Avoid_: Runtime provider、模型名称

**Inbound Turn**:
来自一个 Channel、已经归一为统一语义并准备交给 Runtime 的一次用户输入。
_Avoid_: 原始渠道消息、Conversation Record

**Turn**:
一次用户输入及其对应 Runtime 执行过程的逻辑范围。
_Avoid_: Thread、单个 SSE 事件

**Thread**:
按顺序容纳多个 Turn 的持续对话身份。
_Avoid_: Turn、页面会话

**Raw Session Record**:
Codex 或 ClaudeCode 原始 session 中由 Runtime 产生的一条不可变来源记录。
_Avoid_: Conversation Record、WebChat 实时记录

**Conversation Record**:
Cyberboss 从渠道输入或 Raw Session Record 派生出的标准展示与检索记录。
_Avoid_: 原始日志、前端组件状态

**Conversation Archive**:
按日期持久化 Conversation Record 的派生 JSONL 集合。
_Avoid_: Raw Session、聊天缓存

**Source Key**:
标识 Conversation Record 来源身份、用于导入和实时记录对账的稳定键。
_Avoid_: 展示 ID、文件行号

**WebChat**:
Cyberboss 提供给 Web 客户端的实时消息 Channel 与传输契约。
_Avoid_: MurmurLane、Conversation Archive

**State Directory**:
保存 Cyberboss 运行状态、Conversation Archive、媒体和其他持久数据的根目录。
_Avoid_: 源码仓库、临时构建目录

**Runtime Settings**:
由 Cyberboss 按 Runtime 与 Workspace 管理、决定后续 Turn 使用的模型、模型 Provider 与 Effort 设置。
_Avoid_: Thread 私有偏好、MurmurLane 本地状态、页面选择器状态

**Runtime Model Catalog**:
Runtime Adapter 从真实 Runtime 获取并由 Cyberboss 保存最近有效结果的模型与能力目录。
_Avoid_: 前端硬编码模型、MurmurLane Provider 数据库

**Runtime Context Snapshot**:
Runtime 最近一次报告的上下文用量事实，用于表达当前 Context 状态。
_Avoid_: Thread 累计 Usage、Conversation Record 计数

**Thread Usage Totals**:
Cyberboss 根据 Runtime 权威 Usage Observation 为单个 Thread 幂等累计并持久化的真实用量。
_Avoid_: Runtime Context Snapshot、页面会话计数、根据文本估算的 Token
