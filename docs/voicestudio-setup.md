# 接入 VoiceStudio 本地语音

用本机的 [VoiceStudio](https://github.com/debpalash/VoiceStudio) 做语音合成，零成本、离线、
可以使用自己克隆的音色。VoiceStudio 不与腾讯/QQ 有关系，仅作本地语音引擎使用。

## 链路

```text
QQ Agent ──中文回复文本──▶ 3910 语音代理 ──▶ 3900 VoiceStudio（本地，优先）
                                        └──▶ 硅基流动 CosyVoice（可选，回落）
```

代理负责三件事：把中文翻成目标语言、对合成音频做响度归一、本地不可用时回落到云端。
它不修改 QQ Agent 源码，只作为 OpenAI 兼容的语音端点被调用。

## 前置检查

1. 安装并启动 VoiceStudio，确认本地 API 已监听：

   ```powershell
   curl.exe -s http://127.0.0.1:3900/v1/audio/voices
   ```

   返回 JSON（含 `voices` 数组）即正常。**这一条不通，后面全部白搭。**

2. Node.js 22.16+ 已安装。

## 配置步骤

### 1. 启动语音代理

```powershell
node scripts/voice-boost.mjs
```

默认监听 `127.0.0.1:3910`。用 `start-all.cmd` 启动时会自动带起它，不需要单独开窗口。

自检：

```powershell
curl.exe -s http://127.0.0.1:3910/health
```

`ok:true` 且 `local:true` 表示本地链路通。

### 2. 在面板里添加供应商

打开 `http://127.0.0.1:3081` →「模型接入」→ 添加供应商：

| 字段 | 值 |
| --- | --- |
| 标识 key | `voicestudio` |
| 显示名 | VoiceStudio 本地 |
| Base URL | `http://127.0.0.1:3910/v1` |
| 协议 | `openai` |
| API Key | 随便填，本地接口不校验 |

注意 Base URL 是 **3910（代理）**，不是 3900。直接指向 3900 会绕开翻译和响度处理。

### 3. 设置模型用途

「模型用途」→ **语音合成（TTS）**：

- 供应商：`voicestudio`
- 模型：`omnivoice`（手填，模型列表里可能没有）

语音识别（ASR）**不要**选这个供应商：本地转写实测冷启动 72 秒、热态约 19 秒，
远超聊天一轮的预算，建议继续用云端（如硅基流动的 SenseVoice）。

### 4. 检查语音开关

「概览 → 语音」：

- 启用人格语音回复：**开**
- 语音回复场景：`always`（每条回复都发语音）或 `on-audio`（只有收到录音才回语音）
- 合成音频格式：`wav`（代理需要 PCM 才能改音量，**不要设成 mp3**）
- 最大朗读字数：建议 800

### 5. 换成本机音色

仓库里的 `config/speech-backend.json` 写的是原作者机器上的克隆音色 ID，
**在你的机器上不存在，合成会报错**，必须换成自己的。

在 QQ 里发 `/voice` 查看本机可用音色，然后：

```text
/voice 3          按序号切换
/voice 曼波        按名字切换
```

也可以直接改面板的「默认音色」字段，或编辑 `config/speech-backend.json` 的 `local.voice`。

## 可选功能

### 日语（或其他语言）朗读

聊天文字保持中文，只有语音用目标语言。改 `config/voice-proxy.json`：

```json
"translate": { "enabled": true, "target": "ja" }
```

或在 QQ 里发 `/lang ja` / `/lang zh`。代理每 5 秒轮询该文件，改完自动生效，无需重启。

翻译走 `translator.providerKey` 指定的供应商（默认 `deepseek`），需要你自己在面板里
配置对应供应商和 Key，否则翻译会被跳过、直接朗读原文。

### 云端回落

本地 VoiceStudio 没开时，代理可以改用云端合成。在 `config/voice-proxy.json` 的
`cloud` 段填供应商与模型，并确该供应商在面板里存在且配好 Key。

`cloud.enabled: false` 可关闭回落，此时本地不可用就直接失败。

### 响度

QQ 端播放经常显得偏轻，代理默认把音频压到 `-9 dBFS` 左右。环境变量可调：

```powershell
$env:VS_TARGET_RMS_DB = "-12"   # 更保守
$env:VS_TARGET_RMS_DB = "-6"    # 更响，但可能开始失真
node scripts/voice-boost.mjs
```

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| `/health` 连接被拒 | 代理没启动：`node scripts/voice-boost.mjs` |
| `/health` 返回 503 | VoiceStudio 没在跑，或本地 API 未监听 3900 |
| 回复只有文字、日志报 `voice-reply` 失败 | 检查「模型用途 TTS」是否选了 `voicestudio/omnivoice`，以及 `speech.tts.enabled` |
| 合成 502 / 报音色不存在 | 音色 ID 是别人的，用 `/voice` 换成本机音色 |
| 有声音但很小 | 确认格式是 `wav`（mp3 无法处理），或调高 `VS_TARGET_RMS_DB` |
| 语音发出去但 QQ 里播不出 | NapCat 侧转 SILK 失败，检查 NapCat 所在环境是否有 ffmpeg |
| 改了 `voice-proxy.json` 没反应 | 等待 5 秒（文件轮询），或确认代理仍在运行 |
