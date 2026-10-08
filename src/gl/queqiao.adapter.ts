import { Context } from 'koishi';
import { GLBot, GLBotConfigType } from '.';
import MinecraftQueQiao from '../queQiao';

export class GLQueQiaoAdapter {
  servers: Record<string, MinecraftQueQiao> = {};

  constructor(
    public readonly gl: GLBot,
    public readonly ctx: Context,
    private readonly config: GLBotConfigType,
  ) {
    if (this.config.queQiaoEnable) {
      this.initialize();
    }
  }

  private initialize() {
    this.config.queQiaoServers?.forEach(serverConfig => {
      if (!serverConfig.enable || !serverConfig.serverName) {
        return;
      }

      // wsHost 与 rconServerHost 均支持 `host:port` 格式，拆分出主机与端口
      const [wsHost, wsPort] = serverConfig.wsHost?.split(':') ?? [];
      const [rconHost, rconPort] =
        serverConfig.rconServerHost?.split(':') ?? [];

      this.servers[serverConfig.serverName] = new MinecraftQueQiao(
        this.ctx,
        this,
        {
          // Websocket 配置
          wsServer: '客户端',
          wsHost: wsHost || '127.0.0.1',
          wsPort: Number(wsPort) || 8080,
          Token: serverConfig.Token,
          serverName: serverConfig.serverName,
          joinMsg: '[客户端] 连接成功！',
          // 订阅全部事件（聊天/命令/死亡/加入/退出）
          event: 0b11111,
          maxReconnectCount: this.config.maxReconnectCount || 5,
          maxReconnectInterval: 1000 * 10,
          // RCON 配置
          rconEnable: !!serverConfig.rconServerHost,
          rconServerHost: rconHost || '127.0.0.1',
          rconServerPort: Number(rconPort) || 25575,
          rconPassword: serverConfig.rconPassword,
          alluser: false,
          superuser: [],
          commonCmd: ['list', 'spigot:tps'],
          cannotCmd: ['restart', 'stop'],
          // 基础配置
          sendToChannel: this.config.queQiaoSendToChannel ?? [],
          watchChannel: this.config.queQiaoWatchChannel ?? [],
          sendprefix: '.#',
          cmdprefix: './',
          hideConnect: true,
          locale: 'zh-CN',
        },
      );
    });
  }
}
