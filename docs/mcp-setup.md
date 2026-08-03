# 外部 MCP / Skill 本地接入说明

本文只说明当前仓库的本地接入方式，不迁移外部 MCP / Skill 源码进当前仓库。

## 固定路径

- 当前仓库：本文所在仓库根目录
- 状态目录：由本地真实配置指定的 Cyberboss State Directory
- 外部 MCP / Skill 根目录：`D:\mcp`

## 配置分工

- Codex 端读取本地 `.codex/config.toml`
- ClaudeCode 端读取工作区根目录 `.mcp.json`
- `.codex/config.toml` 和 `.mcp.json` 都是本地真实配置，不提交到仓库
- 可提交示例统一放在 `examples/mcp/`

## 已确认可接入的外部 MCP

### 音乐播放 MCP

- 目录：`D:\mcp\cloud-music-mcp`
- server 名：`cloud_music`
- 已确认可用启动方式：
  - `command = "D:/mcp/cloud-music-mcp/.venv/Scripts/python.exe"`
  - `args = ["-m", "cloud_music_mcp"]`
  - `cwd = "D:/mcp/cloud-music-mcp"`
  - `PYTHONPATH = "D:/mcp/cloud-music-mcp/src"`

说明：
- 这是外部 MCP，不要把源码迁回当前仓库
- `CLOUD_MUSIC_ADB_SERIAL` 这类本地设备信息只能放真实本地配置，示例文件必须留空

### 阅读 MCP

- 目录：`D:\mcp\co-reading-kit`
- server 名：`co-reading-kit`
- 已确认入口：`D:/mcp/co-reading-kit/src/mcp-server.js`
- 需要显式传入：`READING_STATE_DIR=<Cyberboss State Directory>`
- 建议同时设置：`cwd = "D:/mcp/co-reading-kit"`

说明：
- 这是外部 MCP，不要把源码迁回当前仓库
- 阅读状态目录固定复用已配置的 Cyberboss State Directory

## MCP 最小验证结果

### `cloud_music`

- 已验证进程能启动
- 已验证可响应 `initialize`
- 已验证可响应 `tools/list`
- 已验证关键工具可见：
  - `cloud_music_search`
  - `cloud_music_play`
  - `cloud_music_android_play`
  - `cloud_music_android_control`
- 已做只读最小调用：`cloud_music_search`
- 本轮未执行：
  - 自动播放
  - 安卓控制

### `co-reading-kit`

- 已验证进程能启动
- 已验证可响应 `initialize`
- 已验证可响应 `tools/list`
- 已验证关键工具可见：
  - `reading_search`
  - `reading_search_exact`
  - `reading_get_chunk`
  - `reading_get_progress`
  - `reading_update_progress`
  - `reading_update_note`
- 已做只读最小调用：
  - `reading_get_progress`
  - `reading_search`
- 本轮未执行：
  - 写入笔记
  - 修改进度

## Skill 安装与识别

### ClaudeCode

- 项目本地 Skill 目录：`.claude/skills`
- 已复制：
  - `weread-skills`
  - `dianping-queue-skill`
- 当前本机 Claude Code 明确支持项目级 `.claude/skills`
- 本地 `.mcp.json` server approval 由 `.claude/settings.local.json` 维护

### Codex

- 项目本地镜像目录：`.codex/skills`
- 全局有效 Skill 目录：`C:\Users\25049\.codex\skills`
- 已复制：
  - `weread-skills`
  - `dianping-queue-skill`
- 当前这台机器上，Codex 的已知有效 Skill 发现路径是全局 `C:\Users\25049\.codex\skills`
- 项目内 `.codex/skills` 已保留镜像，便于同仓库整理，但不把它表述成唯一有效加载路径

## 已确认的 Skill

### 微信读书 Skill

- 目录：`D:/mcp/weread-skills`
- 真正 Skill 根目录：`D:/mcp/weread-skills`
- 类型：Skill，不是 MCP server

说明：
- 只读能力主要来自 `SKILL.md` 中声明的搜索、书架、阅读统计、笔记划线、点评与推荐
- 如果要做真实接口调用，仍然需要可用的 `WEREAD_API_KEY`

### 大众点评取号 Skill

- 目录：`D:/mcp/dianping-queue-skill`
- 真正 Skill 根目录：`D:/mcp/dianping-queue-skill`
- 类型：Skill，不是 MCP server

说明：
- 只读层面可先根据 `SKILL.md` 列出能力边界
- 公开仓库说明中，核心浏览器自动化逻辑依赖闭源 helper 下载
- 安装入口是 `python3 scripts/setup_runtime.py`
- 当前 Windows PowerShell 原生环境不作为它的主要运行目标
- 本轮只验证 Skill 识别与说明层触发，不做 helper 运行验证
- 若要真实执行取号、短信验证、浏览器验证等流程，仍然依赖账号、验证码、页面状态，以及更合适的运行环境（如 macOS、Linux、WSL2 Ubuntu）

## 本地配置更新原则

1. 保留已有配置，再合并新增外部 server
2. 不写真实 token、cookie、账号、设备序列号到可提交文件
3. `cloud-music-mcp` 和 `co-reading-kit` 必须使用当前机器上已验证可启动的命令
4. `weread-skills` 和 `dianping-queue-skill` 是 Skill，不是 MCP server
5. Skill 的真实账号、cookie、token 不放进仓库

## 示例文件

- Codex 示例：`examples/mcp/codex-config.example.toml`
- ClaudeCode 示例：`examples/mcp/mcp.example.json`

使用时请把示例内容合并到本地真实配置，不要直接提交真实配置文件。
