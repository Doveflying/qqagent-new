# 快速开始（拿到压缩包的人看这里）

这是一个 QQ 机器人：**用你自己的 QQ 小号当机器人**，接你自己的大模型 API，带人格、记忆、语音、空间互动。

压缩包里是源码，**不含任何人的 API Key、QQ 号和个人数据**，全部要你自己填。

---

## 你需要准备

| 需要 | 说明 |
|---|---|
| Windows 10/11 电脑 | 别的系统也支持，但这套脚本是按 Windows 写的 |
| Node.js 22 或更高 | https://nodejs.org 下 LTS 装就行 |
| 一个 QQ 小号 | 就是机器人本体。别用主号，QQ 对异常登录有风控 |
| 一个大模型 API Key | DeepSeek / 智谱 / 硅基流动 / OpenAI 兼容的中转都行 |
| NapCat | OneBot 实现，负责让程序操作 QQ（Windows 版，双击即用） |

---

## 五步跑起来

### 1. 解压 + 装依赖

```powershell
cd 解压后的目录
npm ci
npm run build
```

> `npm ci` 报 EPERM 或卡住时：`npm ci --ignore-scripts`

### 2. 填你自己的 API Key

复制 `config/providers.yaml` 为 `config/providers.local.yaml`，把 key 填进去（这个文件不会被提交）：

```yaml
providers:
  deepseek:
    baseURL: https://api.deepseek.com/v1
    apiKey: "sk-你自己的"
```

### 3. 装 NapCat 并登录 QQ

把 NapCat 装到 `C:\napcat`，用它登录你的机器人 QQ 号（手机扫码）。
默认它监听 `ws://127.0.0.1:3001`，程序里已经配好这个地址。

### 4. 启动

双击 `start-all.cmd`（或 `app\QQAgent.exe` 里的「启动全部」）。

浏览器打开 **http://127.0.0.1:3081** 就是控制面板。

### 5. 设权限

面板「权限」里把自己的 QQ 号加成管理员，否则用不了 `/` 指令。

---

## 可选功能（不装也能用）

| 功能 | 需要什么 |
|---|---|
| 语音回复 | 一个 OpenAI 兼容的 TTS 服务（本地或云端），面板「语音」里配 |
| 唱歌（音色转换） | GPU（8 GB 显存+），`svc-setup.cmd` 一键装 |
| QQ 空间自动评论 | 机器人 QQ 能访问目标空间即可，配 `config/qzone-reply.json` |
| 主动私聊 / 自发说说 | 改 `config/proactive.json`、`config/self-post.json` 里的目标 QQ |

> 人格里写的 `voice:` 是**音色 id**，只在装了同一套 VoiceStudio 音色的机器上有效。换机器要么重建音色，要么把人格里的 `voice.voice` 清空，改用面板里配的全局默认音色。

---

## 放到云服务器（不用开电脑）

见 `deploy/README.md`：NapCat 跑在 Docker 里，Agent 用 systemd 常驻，手机能过 HTTPS 看面板。

注意一点：**云服务器 IP 是机房地址，QQ 可能拒绝扫码登录**（报 `ErrCode: 5`）。遇到这种情况，只能在和手机同一个网络的本机（家里的电脑/笔记本热点）上扫码，再把登录态搬过去，或者干脆跑在本机。

---

## 常见问题

- **面板打不开**：确认 `start-all.cmd` 窗口还开着，端口 3081 没被占（`netstat -ano | findstr 3081`）
- **提示已有实例在运行**：先双击 `stop-all.cmd`，再启动
- **机器人不回复**：面板「概览」看 `napcatConnected` 是否为 true；再看「日志」里有没有模型报错（多半是 key 没填或额度用完）
- **回复出现奇怪方块**：Windows 控制台编码问题，不影响功能，日志文件里是正常的

---

## 安全提醒

- `config/providers.local.yaml`、`config/*.local.json`、`config/roleplay.json`、`data/` 都是本地私有数据，**不要提交、不要发给别人**
- 机器人 QQ 的密码不要写进任何配置文件，登录靠 NapCat 扫码
- 面板默认只监听 `127.0.0.1`，要外网访问请加密码（见 `deploy/04-panel.sh` 的 nginx 方案）
