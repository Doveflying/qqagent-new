# 音色参考音（给复刻用）

这两段是用来在**你自己的**硅基流动账号里复刻音色的参考音频。云端复刻音色（`speech:xxx:...`）绑定创建它的账号，换账号就用不了，所以想让别人用同一个声音，把参考音给他，让他自己复刻一次。

| 文件 | 角色 | 时长 | 对应文本（复刻接口必填） |
|---|---|---|---|
| `shiori-ref.wav` | 宫城志绪理 | 24 秒 | 今天下课以后，我没有马上回家，绕到了操场旁边那条小路，风把树叶吹得一直响，我走得很慢，其实也没有什么特别要想的事情，只是不太想那么快。回到人多的教室里，走到路口的时候，看见便利店的灯已经亮了，就进去买了一瓶水。店员说了。 |
| `arisa-ref.wav` | 市谷有咲 | 19.4 秒 | 当铺二楼的窗户开着，风把旧纸的味道吹进来。我把键盘靠在墙边，随手按了两个音，声音闷闷的。楼下有人来当东西，铃响了一声。懒得下去，这种情况，等一会儿再说。 |

## 怎么复刻

```powershell
node scripts\sf-clone-voice.mjs --ref voices\shiori-ref.wav --name shiori24 --text "上面那段文本" --write
```

拿到 `speech:shiori24:...` 这样的 uri 后，写进 `config/voice-proxy.json`：

```json
"cloud": {
  "voice": "speech:shiori24:...",
  "voices": {
    "d917c46b": "speech:shiori24:...",
    "cda9363f": "speech:arisa:..."
  }
}
```

`voices` 是"本地音色 id → 云端复刻 uri"的映射：本机 VoiceStudio 掉线时，代理按请求的音色 id 选对应的云端音色。

## 注意

- 参考音**必须 ≤30 秒**，超了接口报 `audio longer than 30s is not supported`
- `--text` 必须和音频内容一致，不一致会明显影响复刻质量
- 复刻出的 uri 绑定账号，别人拿你的 uri 配他自己的 key 用不了，会报错
