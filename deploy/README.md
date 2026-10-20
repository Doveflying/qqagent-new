# 部署到云服务器（Rocky Linux，北京）

目标：服务器上跑 QQ(NapCat) + Agent，电脑关机也能回消息。

## 会变的东西（先看这段）

| 能力 | 云端 | 原因 |
|---|---|---|
| 文字聊天、记忆、人格、主动私聊、QQ 空间 | ✅ 照旧 | 纯 Node + 数据库 |
| 语音回复 | ⚠️ 改用云端 TTS | VoiceStudio 是 Windows 本机的 Electron 应用，云上没有；`config/speech-backend.json` 里的 siliconflow 云端回落会接管 |
| 唱歌（Seed-VC） | ❌ 留在本机 | 需要 8 GB+ 显存的 GPU 和 909 MB 模型，云服务器是 CPU |
| Obsidian 同步 | ❌ 默认不跑 | `config/obsidian.json` 里是 Windows 路径；要用就把 vault 和 obsidian-bridge 一起拷过去再改路径 |

## 三步

在本机（Windows）：

```powershell
cd C:\桌面图标\qwe\QQagent
powershell -File deploy\pack.ps1
scp qqagent-deploy.tar.gz root@SERVER_IP:/root/
```

服务器上：

```bash
sudo bash 01-napcat.sh    # 装 docker + 起 NapCat
# 浏览器开 http://公网IP:6099/webui 扫码登录机器人 QQ，登录完关掉 6099 的端口
sudo PROACTIVE_UID=你的QQ号 bash 02-agent.sh /root/qqagent-deploy.tar.gz
```

`PROACTIVE_UID` 决定「自发说说」和「主动私聊」发给谁。不给也能跑，但这两项会因为没有目标而跳过。

`02-agent.sh` 会装两个 systemd 单元：

- `qqagent.service`：Agent 本体，挂了自动重启
- `qqagent-cron.timer`：每 10 分钟跑 `deploy/cron.sh`（自发说说 + 主动私聊），对应 Windows 上的 `model-schedule-loop.cmd`

时区会被设成 `Asia/Shanghai`，因为主动私聊按 10:30–23:00 选时间，服务器在 UTC 会变成半夜发。

看面板（不要给公网开 3081）：

```powershell
ssh -L 3081:127.0.0.1:3081 root@SERVER_IP
# 保持这个窗口，然后本机浏览器打开 http://127.0.0.1:3081
```

## 云厂商安全组

- **6099**：只在扫码时临时放行，登录完关掉
- **3001**：不要放行，NapCat 只绑 127.0.0.1，Agent 在本机连
- **3081**：不要放行，走 SSH 隧道

## 切换顺序（重要）

同一个机器人 QQ 号**不能同时在两处登录**：本机的 NapCat 还连着的时候，云端扫码会把本机顶掉，两边都不稳。

正确顺序：

1. 本机跑 `stop-all.cmd`，再退出本机 NapCat（或直接关掉 `QQAgent` 窗口）
2. 服务器上 `docker start napcat`，扫码登录
3. `systemctl start qqagent`
4. 确认云端能正常收发后，本机不再开 QQ Agent

想保留本机做备用，就换一个机器人 QQ 号，别用同一个。

## 迁移过来的数据
包里已经带了：

- `config/personas/shiori.yaml`（人格，含 Obsidian 同步生成的结构化字段）
- `config/app.yaml`（管理员、模型、语音等设置）
- `data/brain.db`（聊天记录、长期记忆、摘要、粘性表情）

`config/roleplay.json`、`config/*.local.json` 不进包（都是本机私有状态），到服务器上重新配置。

## 上线后要检查的

```bash
systemctl status qqagent
journalctl -u qqagent -n 50            # 有没有「机器人已上线」
ss -lntp | grep 3001                   # OneBot 端口在不在
curl -s 127.0.0.1:3081/api/health | head -c 200
```

面板「概览」里 `napcatConnected` 应为 true。

## 常见问题

**扫码后立刻掉线**：NapCat 容器里的 QQ 版本和手机端不匹配，`docker logs napcat` 里会写；更新镜像 `docker pull mlikiowa/napcat-docker:latest && docker restart napcat`。

**`npm ci` 报错**：Node 版本低于 22；`node -v` 确认，`engines` 要求 >= 22.16。

**语音不发**：服务器上没有本地 TTS，`config/speech-backend.json` 的云端回落要指向可用的语音服务；先用 `/voice` 指令看当前音色状态。

**数据库锁住**：`data/brain.db-wal` 被一起打包会让副本不一致——`pack.ps1` 已经排掉了；如果拿到旧包，删掉 `data/brain.db-wal`、`data/brain.db-shm`。

**面板打不开**：确认隧道窗口还开着，且 `firewall-cmd --list-ports` 里没有对公网放行 3081。
