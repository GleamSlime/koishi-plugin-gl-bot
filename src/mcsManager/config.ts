import { Schema } from 'koishi';

export class MCManagerConfig {
  static Base = Schema.object({
    mcManagerUsername: Schema.string().default('admin').description('用户名'),
    mcManagerPassword: Schema.string()
      .role('secret')
      .default('admin')
      .description('密码'),
    mcManagerHost: Schema.string()
      .default('http://localhost:23333/api')
      .description('面板地址'),
    mcManagerMaxConnectWs: Schema.number()
      .default(20)
      .description('最大连接实例数'),
    mcManagerRemotes: Schema.array(
      Schema.object({
        uuid: Schema.string().description('远程节点UUID'),
        ip: Schema.string()
          .description('节点地址(含协议，如 wss://panel.gleamslime.com)'),
        port: Schema.union([Schema.number(), Schema.string()]).description(
          '节点端口',
        ),
        prefix: Schema.string().default('').description('前缀'),
        available: Schema.boolean().default(false).description('是否启用'),
        remarks: Schema.string().description('备注'),
        mcManagerKey: Schema.string()
          .role('secret')
          .description('该节点 WS 认证 Key（每个 daemon 独立）'),
      }),
    )
      .default([])
      .description('MCSManager 远程节点(daemon)列表，Key 不通过则跳过该节点'),
  }).description('MCSMANAGER 基础配置');

  static QueQiao = Schema.object({
    queQiaoEnable: Schema.boolean().default(false).description('是否启用鹊桥'),
    maxReconnectCount: Schema.number()
      .default(5)
      .description('最大重连次数，防止死循环重连'),
    queQiaoSendToChannel: Schema.array(String).description(
      '消息发送到目标群组格式{platform}:{groupId}',
    ),
    queQiaoWatchChannel: Schema.array(String).description(
      '消息观察频道目标群组格式{platform}:{groupId}',
    ),
    queQiaoServers: Schema.array(
      Schema.object({
        enable: Schema.boolean().default(false).description('-- 是否启用'),
        rconServerHost: Schema.string()
          .default('127.0.0.1:25575')
          .description('-- rcon地址'),
        rconPassword: Schema.string()
          .role('secret')
          .description('-- rcon服务器的密码(推荐设置)'),
        wsHost: Schema.string()
          .default('127.0.0.1:8080')
          .description('-- websocket服务器的地址(服务器监听地址)'),
        Token: Schema.string().description('-- websocket服务器的验证Token'),
        serverName: Schema.string().description(
          '-- 鹊桥配置文件中对应的server_name',
        ),
      }),
    )
      .default([])
      .description('启用鹊桥的服务器列表，留空表示全部启用'),
  }).description('MCSMANAGER 鹊桥配置');
}
