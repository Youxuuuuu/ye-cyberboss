# Cyberboss 运行与对话上下文

Cyberboss 连接人类消息渠道与 AI Runtime，并把运行过程投影为可消费的 Conversation Record。这里定义跨渠道、Runtime 和归档协作时使用的统一词汇。

## Language

**Cyberboss**:
承接渠道消息、驱动 Runtime、维护线程状态，并通过 `src/custom/xiaoye/conversation/` 生成派生 Conversation Record 的主体系统。
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
由 `src/custom/xiaoye/conversation/` 从渠道输入或 Raw Session Record 派生出的标准展示与检索记录。
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
当前 Thread 最近一次模型 API 调用的活动上下文用量事实；它来自 Runtime Adapter 的真实 Usage，而不是 Thread 生命周期累计。ClaudeCode 优先采用最后一条非零 assistant Usage，仅在 assistant Usage 全为 0 且最终 `num_turns = 1` 时使用 Result Usage 回退；Codex 采用 `last_token_usage` / `lastTokenUsage`。
_Persistence_: 当前只保存在 Cyberboss 进程内；重启后在下一笔真实 Runtime Usage 到来前可以为空或为 0。
_Avoid_: Thread 累计 Usage、整次多调用 Agent Loop 的累计 Result、Conversation Record 计数、根据消息文本估算

**Runtime Context Window**:
当前 Runtime 实际用于管理 Context 和压缩边界的窗口容量。Codex 使用 Runtime 报告的 `model_context_window` / `modelContextWindow`；ClaudeCode 普通模型标识按 200k，显式 `[1m]` 模型按 1M，且该值不等同于第三方 Provider 宣称的原生模型上限。
_Avoid_: 全局人工近似值、把 Provider 营销上限当作当前 Runtime 已启用窗口

**Thread Usage Totals**:
Cyberboss 根据 Runtime 权威 Usage Observation 为单个 Thread 幂等累计并持久化的真实用量。
_Avoid_: Runtime Context Snapshot、页面会话计数、根据文本估算的 Token

**Voice Message**:
通过录制或语音合成产生、以异步媒体消息进入 WebChat 与 Conversation 契约的音频内容。
_Avoid_: 实时语音通话、WebRTC 会话

**Speech Rendition**:
从一条既有 Assistant 文字消息派生并持久保存的合成音频表达；它依附于原消息，不形成新的 Voice Message。
_Avoid_: Assistant Voice Message、每次播放重新合成、覆盖旧音频文件

**Speech Provider**:
由 Cyberboss 选择和调用、负责语音合成或转写的可替换外部能力；它返回音频或转写事实，但不拥有 Voice Message 与 Conversation 语义。
_Avoid_: Runtime、Channel、Conversation Store

**Synthesis Provider**:
根据文本、Assistant Voice Profile 与合成设置生成音频的可替换外部能力；当前提供 MiniMax 与 Mossland Adapter，由显式配置选择且不自动 fallback。MiniMax 映射结构化 Speech Delivery Plan；Mossland `moss-tts` 单人语音接口只消费其官方支持的文本、音色和输出格式，其余表演指令安全降级。
_Avoid_: Transcription Provider、Voice Reply Policy、Voice Message 持久化

**Transcription Provider**:
把用户音频转换为 transcript 与转写元数据的可替换外部能力。第一版输入链路由 SiliconFlow Qwen3 Omni 的 combined-audio-understanding Adapter 同一次调用提供 transcript 与候选 affect；ElevenLabs Scribe v2 仅保留为未来可选纯转写 Adapter。
_Avoid_: Synthesis Provider、MiniMax TTS、Conversation Record

**Voice Affect Observation**:
从用户原始语音的音量、音高、节奏和停顿等信号推导出的、带置信度的非字面上下文。
_Avoid_: 用户真实情绪、Transcript、确定性人格判断

**Voice Affect Analyzer**:
位于 Xiaoye 扩展中的输入理解编排能力；第一版校验 Qwen combined-audio-understanding 返回的候选 affect，并把它规范化为 Voice Affect Observation。它参考 `hervoice` 的三层观察方法与坑点，但不部署 `hervoice`、不运行 `librosa` 旁路；affect 失败不阻塞有效 transcript。
_Avoid_: MiniMax TTS、Conversation Runtime、用户真实情绪检测器

**Affect Inference Provider**:
未来可拆分的情绪推断能力，接收 transcript 与声学观察并返回结构化 emotion、confidence 与描述。第一版不单独调用该 Provider，而由 SiliconFlow Qwen3 Omni combined Adapter 在同一音频理解响应中提供候选 affect；它不跟随 Thread Runtime model 或 Effort。
_Avoid_: 当前第一版 Qwen combined Adapter、Voice Affect Analyzer、聊天 Runtime

**Voice Reply Policy**:
约束 Assistant 在一个 WebChat Thread 中优先使用文字、按语境自适应或优先使用 Voice Message 的用户偏好。
_Avoid_: TTS Provider 设置、Runtime Effort、每条回复强制转音频

**Assistant Voice Profile**:
所有 WebChat Thread 共用的小机稳定声音身份；保存语言、语速、音高、音量、表达设置以及各 Speech Provider 的声音标识绑定，并同时用于 Assistant Voice Message 与 Speech Rendition。
_Avoid_: Voice Reply Policy、按 Thread 音色、历史音频重生成

**Speech Delivery Plan**:
单次 Assistant 语音合成的结构化表演指令，描述 emotion、相对语速或音高、停顿与 sound tags；由 Synthesis Adapter 按模型能力映射，不改变 Assistant Voice Profile 的基础声音身份。
_Avoid_: 自由 TTS Prompt、待朗读正文、全局 Voice Profile

**Voice Storage Root**:
Cyberboss 为 WebChat Voice Asset 提供的专属持久化根目录；其下以 `self/<年>/<月>/` 保存用户原始语音，以 `threads/<threadId>/<年>/<月>/` 保存 Assistant Voice Message 与 Speech Rendition。
_Avoid_: 通用 inbox、MurmurLane public 目录、绝对路径 Conversation 字段、随 Conversation 删除音频

**Voice Processing State**:
用户 Voice Message 从原始音频上传、转写、情绪分析到 transcript 提交 Runtime 的可恢复状态；STT 失败必须可重试，affect 失败可以降级。
_Avoid_: Assistant 回复状态、音频播放状态、纯视觉动画状态

**Normalized Voice Transcript**:
提交给 Runtime 的用户语音文字内容；通常来自高置信度 STT，低置信度时必须经过用户确认或修正。机器原始 transcript 与用户修正版均保留，不得事后静默改写已提交内容。
_Avoid_: 原始 STT 输出、Voice Affect Observation、音频文件
