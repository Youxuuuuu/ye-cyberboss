# WebChat 语音配置与运行边界

本文描述当前 Cyberboss Xiaoye WebChat 异步语音实现的服务端配置。领域契约和跨仓库验收状态见 [`murmurlane-stack/tracker/webchat-voice-message/`](../../murmurlane-stack/tracker/webchat-voice-message/implementation-status.md)。

## `.env` 位置与重启

Cyberboss 按项目既有规则读取环境变量；本地开发通常把配置放在仓库根目录 `.env`。API Key 只存在服务端环境，不得使用 `VITE_*`、不得放进 MurmurLane、Conversation、日志或浏览器存储。

Voice Profile、Provider 与 voice id 在 Cyberboss 启动时读取。修改以下配置后需要重启：

```powershell
cd D:\study\cyberboss
npm run shared:start
```

重启只影响后续生成；历史 Voice Asset 不重新合成、不覆盖。

## 用户语音输入

第一版生产输入理解使用 SiliconFlow Qwen3 Omni：

```dotenv
CYBERBOSS_USER_VOICE_INPUT_ENABLED=true
SILICONFLOW_API_KEY=你的服务端密钥
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
SILICONFLOW_OMNI_MODEL=Qwen/Qwen3-Omni-30B-A3B-Instruct
```

可选限制保持默认即可，只有明确需要调优时再设置：

```dotenv
CYBERBOSS_USER_VOICE_TRANSCRIPT_CONFIDENCE_THRESHOLD=0.6
CYBERBOSS_USER_VOICE_PROVIDER_TIMEOUT_MS=120000
CYBERBOSS_USER_VOICE_WORKFLOW_TIMEOUT_MS=130000
CYBERBOSS_USER_VOICE_AFFECT_WAIT_MS=5000
```

Provider 未配置或不可用时录音入口 fail closed；MurmurLane 模型面板不展示 Provider、模型或“可用”技术状态。

## Assistant Voice Message 与 Speech Rendition

启用两个独立能力：

```dotenv
CYBERBOSS_ASSISTANT_VOICE_MESSAGE_ENABLED=true
CYBERBOSS_SPEECH_RENDITION_ENABLED=true
```

显式选择合成 Provider；不配置时默认 `minimax`，不会在失败时自动切换：

```dotenv
CYBERBOSS_ASSISTANT_VOICE_PROVIDER=minimax
```

### MiniMax

```dotenv
MINIMAX_API_KEY=你的服务端密钥
MINIMAX_BASE_URL=与你账号区域匹配的官方地址
MINIMAX_VOICE_ID=你的_voice_id
MINIMAX_TTS_MODEL=speech-2.8-hd
MINIMAX_TTS_LANGUAGE=Chinese
MINIMAX_TTS_SPEED=1
MINIMAX_TTS_VOLUME=1
MINIMAX_TTS_PITCH=0
MINIMAX_TTS_FORMAT=mp3
```

MiniMax Adapter 会把 Speech Delivery Plan 映射为其支持的 emotion、速度、音量、音高、停顿与 sound tag。默认表达 `warm` 当前映射为 MiniMax `calm`。

### Mossland

```dotenv
CYBERBOSS_ASSISTANT_VOICE_PROVIDER=mossland
MOSS_API_KEY=你的服务端密钥
MOSS_BASE_URL=https://api.mosi.cn
MOSS_VOICE_ID=你的_voice_id
MOSS_TTS_MODEL=moss-tts
MOSS_TTS_FORMAT=mp3
# 只有官方音色页面明确给出版本时才设置：
# MOSS_TTS_VERSION=实际版本
```

当前 Mossland 单人接口只接收原始 spoken text、voice id、模型版本和输出格式。Adapter 不添加隐藏 Prompt，也不会把 MiniMax 专属语气指令拼入朗读正文；emotion、speed、pitch、pause 等不支持能力会安全降级。

## 生成、播放与存储

- 用户原音频：`MLane/voice/self/<YYYY>/<MM>/`。
- Assistant Voice Message 与 Speech Rendition：`MLane/voice/threads/<threadId>/<YYYY>/<MM>/`。
- 文件名、扩展名和相对路径只由 Cyberboss 服务端生成。
- 当前 MiniMax 与 Mossland 都在完整音频接收、校验和永久落盘后发布可播放 Asset，不是边生成边播放的流式 TTS。
- Speech Rendition 后续播放读取已保存文件，不再次调用 Provider；重新生成会创建新永久文件，成功后才切换 active generation。

## 浏览器边界

- 桌面 `localhost` 可以使用浏览器录音。
- 手机通过局域网录音必须使用受信任 HTTPS；普通 `http://<局域网IP>` 可以打开页面，但浏览器通常会拒绝麦克风能力。
- MurmurLane 负责 MediaRecorder、Voice Draft、播放协调和 UI；Cyberboss 不生成 waveform peaks，不拥有页面 Audio 生命周期。
