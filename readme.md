# koishi-plugin-gl-bot

[![npm](https://img.shields.io/npm/v/koishi-plugin-gl-bot?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-gl-bot)
[![license](https://img.shields.io/npm/l/koishi-plugin-gl-bot?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-gl-bot)

GleamSlime Koishi 兽耳咖啡厅插件。

以 [Koishi](https://koishi.chat) 插件形式运行，把 MCSManager 面板里的 Minecraft / 方舟实例管起来：群聊里查状态、开关服、看在线人数，游戏内聊天与 QQ 群互通，还带自动备份和域名动态解析。

## 功能

**服务器管理**
对接 MCSManager 面板及多个远程节点（daemon），支持按名称模糊搜索实例，查询列表、在线玩家、运行时长与健康指标，执行启动 / 关闭 / 重启 / 创建。MC 与 ARK 各有一套指令。

**鹊桥**
通过 RCON 与游戏服务端通信，经 WebSocket 把游戏内聊天转发到指定群，同时把群消息按清洗后的纯文本发回游戏，图片、视频、@ 等富文本会转成占位符。支持多服务器、断线重连与次数上限。

**自动备份**
把实例的指定目录压缩到其父级 `backup` 目录，按「定时值 + 最大保留数量」滚动清理。任务持久化在数据库，重启后按剩余时间继续计时。

**玩家统计**
记录玩家上下线时间，提供在线时长榜单。

**其他**
基于阿里云 DNS 定时把域名解析到本机公网 IP；NapCat HTTP API 对接；实例备注的增删查。

## 安装

```bash
npm install koishi-plugin-gl-bot
```

或在 Koishi 控制台的插件市场搜索 `gl-bot`。

需要 Koishi `^4.18.9`、`@koishijs/plugin-console` `^5.30.11`，并启用 `database` 服务。

## 配置

插件配置按模块分组，全部在控制台面板中填写。

| 分组            | 主要字段                                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GL 基础         | `cmdRegisterMode` — 指令模式 / 关键词模式                                                                                                                                                                 |
| GL 拓展         | `authID`、`authSecret`、`authKey`、`authDomain`、`authChildDomain` — 阿里云 AK/SK 与域名解析范围                                                                                                          |
| MCSMANAGER 基础 | `mcManagerHost` 面板地址、`mcManagerUsername` / `mcManagerPassword`、`mcManagerMaxConnectWs`，以及 `mcManagerRemotes` 远程节点列表（每项含 `uuid`、`ip`、`port`、`mcManagerKey`、`available`、`remarks`） |
| MCSMANAGER 鹊桥 | `queQiaoEnable`、`queQiaoSendToChannel` / `queQiaoWatchChannel`（格式 `{platform}:{groupId}`）、`maxReconnectCount`，以及 `queQiaoServers`（rcon 地址与密码、websocket 地址与 Token、`serverName`）       |
| NapCat          | `napCatBaseUrl`、`napCatToken`                                                                                                                                                                            |

远程节点的 `mcManagerKey` 是各 daemon 独立的 WS 认证 Key，不填或校验不过的节点会被跳过。

## 指令

同一功能都有 `服务器` 与 `MC` 两个前缀，下以 `服务器` 为例。`<...>` 为必填，`[...]` 为可选。

```
服务器 列表 [状态]
服务器 在线 [状态]
服务器 在线榜单 [状态]
服务器 健康 [状态]
服务器 启动 <名称>
服务器 关闭 <名称>
服务器 重启 <名称>
服务器 创建 <名称>
服务器 备注 增加 <key> <value>
服务器 备注 删除 <key>
服务器 备注 列表
```

方舟实例使用 `方舟` / `ARK` 前缀，提供 `列表`、`启动`、`关闭`、`重启`。

备份另有子指令：

```
服务器 备份 定时 [名称] [定时值] [最大数量] [目标相对路径]
服务器 备份 立刻 [名称] [定时值] [最大数量] [目标相对路径]
服务器 备份 关闭 [名称]
服务器 备份 删除 [名称]
服务器 备份 列表
```

定时值格式为数字加单位，`s` / `h` / `d`，例如 `1h`。名称含空格时可用双引号包裹。不带子指令时输出用法说明。

`cmdRegisterMode` 打开后走关键词匹配而非 Koishi 指令注册，适合会被平台预处理消息的适配器。

## 开发

```bash
pnpm install
pnpm build      # tsc 编译到 lib
pnpm build:console
pnpm fl         # prettier + eslint
```

## 发布

推送 `master` 触发 GitHub Actions：检测 `package.json` 中的版本号是否已存在于 npm，未发布则依次发布到 npmjs.com 与 GitHub Packages（后者包名为 `@gleamslime/koishi-plugin-gl-bot`）。发版只需改版本号并推送。

## License

MIT
