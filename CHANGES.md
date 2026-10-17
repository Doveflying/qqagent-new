# 本仓库相对上游的改动

本仓库是 [shuang-ying/QQagent](https://github.com/shuang-ying/QQagent) v2.2.0 的二次开发副本。
上游未附 LICENSE，因此本仓库仅作个人使用与学习记录，不构成对上游代码的再授权。

## 一、源码修复

### `src/config/writer.ts` — YAML 标量写入的类型歧义

`formatValue()` 会把形如 `[A-Za-z0-9_./@+-]+` 的值裸写进 YAML，只排除了
`true/false/null/yes/no/on/off/~`，**没有排除数字形态**。于是这类字符串写入后再读回
会被 YAML 解析成数字：

| 写入的值 | 读回结果 |
|---|---|
| `398e3278` | `3.98e3278` → `Infinity` |
| `123` / `1e5` / `.5` / `+7` | 数字 |

后果：`speech.tts.voice` 这类字符串字段收到数字后会触发 zod 校验失败，
表现为 `POST /api/settings` 返回 400 `expected string, received Infinity`。

修复：数字形态与保留字一律加引号。

### 单实例保护

两个 Agent 同时运行会争抢同一条 OneBot 连接并写同一个 `brain.db`，表现为
"日志正常、没有报错、进程静默消失"。启动器层的端口检查挡不住 5 秒内连续两次
双击（第一次还没绑定端口），因此在两个层面各加一道：

1. `start-all.cmd` / `start-silent.cmd`：`runtime/agent.lock` 目录锁，
   `mkdir` 原子性保证只有一个赢家；存活 2 分钟内的锁视为有效，更早的视为崩溃残留
2. `src/index.ts`：启动时写 `runtime/agent.pid`，发现同名 PID 仍存活就打印提示并
   以退出码 1 终止，覆盖任务计划、手动 `npm start` 等其它入口

## 二、新增指令

### `/voice`（别名 `/音色`）— 切换语音音色

列出本地语音服务的可用音色并标记当前值；支持按名字或序号切换，写入
`speech.tts.voice` 后热生效。

### `/lang`（别名 `/语言`）— 切换朗读语言

写入 `config/voice-proxy.json` 的 `translate` 段，代理每 5 秒轮询该文件，
改完自动热加载。支持 `ja / zh / en / ko / fr / de / es / ru / pt / it`，
`zh` 或 `off` 表示关闭转换（用中文朗读）。

两条指令都接入原有指令权限体系，默认继承管理员。

## 三、新增脚本

| 文件 | 作用 |
|---|---|
| `scripts/voice-boost.mjs` | 语音代理（127.0.0.1:3910）：目标语言翻译 → 本地合成 / 云端回落 → 前瞻限幅拉响度 |
| `scripts/speech-backend.ps1` | 探测本地语音服务，运行时切换 TTS 角色与音色 |
| `scripts/model-schedule.ps1` | 按时间表切换模型（支持只切主对话） |
| `scripts/model-schedule-loop.cmd` | 每 10 分钟执行上面两个检测 |
| `scripts/run-model-schedule.cmd` | 手动跑一次模型切换 |
| `start-all.cmd` | 一键启动：语音代理 + 调度循环 + Agent，带单实例端口守卫 |

## 四、新增配置

| 文件 | 作用 |
|---|---|
| `config/voice-proxy.json` | 翻译开关与目标语言、本地/云端语音上游 |
| `config/speech-backend.json` | 本地优先、云端回落的音色与供应商 |
| `config/model-schedule.json` | 分时段模型时间表 |
| `config/personas/shiori.yaml` | 人格「宫城志绪理」示例 |

## 五、需要自行配置的部分

以下文件含个人数据，**未包含在本仓库中**：

- `config/app.yaml`：管理员 QQ、群白名单、默认模型等运行时设置
- `config/providers.local.yaml`：供应商 API Key
- `config/model-schedule.state.json`：调度器运行时状态

克隆后请按 `README.md` 的「快速开始」自行完成模型与权限配置。
