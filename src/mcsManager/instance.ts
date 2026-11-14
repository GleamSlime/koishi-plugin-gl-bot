import { Context, Logger } from 'koishi';
import { isEqual } from 'lodash';
import YAML from 'yaml';

import { GLBotConfigType } from '../gl';
import MinecraftQueQiao from '../queQiao';
import { MCSManagerAPI } from './api';
import { MCBotGameOnline } from './commands';
import { RemoteInstanceStatusEnum } from './constants';
import { McLogPlayerParser, ParsedPlayerEvent } from './log-player';
import { MCSManagerPanel } from './panel';
import {
  MCSManagerQueQiaoYMLConfig,
  ServiceInstanceConnectAuth,
  ServiceRemoteInstanceItem,
  ServiceRemoteItem,
} from './type';

const logger = new Logger('mcsmanager-panel');

export class MCSManagerInstance {
  public isAuthenticated = false;

  // 该实例的 stream 连接认证信息（与实例绑定，缓存避免重复申请）
  public auth?: ServiceInstanceConnectAuth;

  public queQiao: MinecraftQueQiao | null = null;

  // 鹊桥实例是否由本对象创建（复用 adapter 已有实例时为 false，销毁时不连带回收）
  private queQiaoOwned = false;

  constructor(
    private readonly ctx: Context,
    private readonly config: GLBotConfigType,
    private readonly api: MCSManagerAPI,
    private readonly panel: MCSManagerPanel,
    public remote: ServiceRemoteItem,
    public cfg: ServiceRemoteInstanceItem,
    options?: {
      autoCreateQueQiao: boolean;
    },
  ) {
    if (
      options?.autoCreateQueQiao &&
      this.cfg.status === RemoteInstanceStatusEnum.RUNNING
    ) {
      this.createQueQiao();
    }
  }

  public async restartInstance() {
    return await this.api.restartRemoteInstance(
      this.remote.uuid,
      this.cfg.instanceUuid,
    );
  }

  public async stopInstance() {
    return await this.api.stopRemoteInstance(
      this.remote.uuid,
      this.cfg.instanceUuid,
    );
  }

  public async startInstance() {
    return await this.api.startRemoteInstance(
      this.remote.uuid,
      this.cfg.instanceUuid,
    );
  }

  // 回收鹊桥连接：从 adapter 摘除并销毁。
  // 不健康重建时必须连带销毁 adapter 借来的连接（owned=false），
  // 否则「复用 adapter 已有连接」分支会再次拿到同一个死连接，导致永远无法自愈
  private recycleConnection(qq: MinecraftQueQiao) {
    const adapter = this.panel.gl.queQiaoAdapter;
    const name = qq.config.serverName;
    if (name && adapter.servers[name] === qq) {
      delete adapter.servers[name];
    }
    if (!qq.isDisposing) {
      qq.dispose().catch(() => undefined);
    }
  }

  // 鹊桥创建进行中：并发调用复用同一 Promise，避免重复读 yml 产生双份实例
  private queQiaoCreating: Promise<MinecraftQueQiao | null> | null = null;

  public createQueQiao(): Promise<MinecraftQueQiao | null> {
    if (this.queQiaoCreating) {
      return this.queQiaoCreating;
    }

    const task = this.createQueQiaoOnce().finally(() => {
      if (this.queQiaoCreating === task) {
        this.queQiaoCreating = null;
      }
    });
    this.queQiaoCreating = task;
    return task;
  }

  private async createQueQiaoOnce() {
    // 旧鹊桥不健康（WS 已断/已停止重连/正在销毁）则先回收，避免复用死连接导致 MC 重启后无法恢复
    if (this.queQiao) {
      const qq = this.queQiao;
      if (!qq.isDisposing && qq.isConnected) {
        return this.queQiao;
      }
      logger.info(
        `[${qq.config.serverName || '未知'}] 鹊桥连接不健康，重建中...`,
      );
      this.recycleConnection(qq);
      this.queQiao = null;
      this.queQiaoOwned = false;
    }

    // 实例未运行则不创建鹊桥
    if (!isEqual(this.cfg.status, RemoteInstanceStatusEnum.RUNNING)) {
      return null;
    }

    let yml: MCSManagerQueQiaoYMLConfig | null = null;
    try {
      const ymlString = await this.api.readFileSafe(
        this.remote.uuid,
        this.cfg.instanceUuid,
        '/config/QueQiao/config.yml',
      );
      yml = ymlString ? YAML.parse(ymlString) ?? null : null;
    } catch (err) {
      yml = null;
    }

    // 未安装鹊桥插件/读取失败：无鹊桥可用，交由终端日志兜底
    if (!yml?.server_name) {
      this.queQiaoConfigured = false;
      logger.debug(
        `[${this.logLabel}] 未读取到鹊桥插件配置，玩家事件改由终端日志兜底`,
      );
      return null;
    }

    // 从 queQiaoServers 配置匹配当前实例（通过 server_name）
    const queQiaoServers = this.config.queQiaoServers ?? [];
    const serverConfig = queQiaoServers.find(
      s => isEqual(s.serverName, yml.server_name) && s.enable,
    );

    if (!serverConfig) {
      this.queQiaoConfigured = false;
      logger.debug(`[${yml.server_name}] 未找到启用的鹊桥配置，跳过创建`);
      return null;
    }
    this.queQiaoConfigured = true;

    // adapter 已按配置创建过同名鹊桥时直接复用，避免双份消息处理器。
    // 仅当连接可用/连接中/正在重连才复用；已放弃重连的死连接回收后走下方新建逻辑
    const adapter = this.panel.gl.queQiaoAdapter;
    const existing = adapter.servers[yml.server_name];
    if (existing && !existing.isDisposing) {
      if (existing.isConnected || existing.ws || existing.reconnectIntervalId) {
        this.queQiao = existing;
        this.queQiaoOwned = false;
        return this.queQiao;
      }
      logger.info(
        `[${yml.server_name}] adapter 中的鹊桥连接已失效，回收重建...`,
      );
      this.recycleConnection(existing);
    }

    // 拆分配置项的 host:port
    const [rconHost, rconPortStr] =
      serverConfig.rconServerHost?.split(':') ?? [];
    const [wsHost, wsPortStr] = serverConfig.wsHost?.split(':') ?? [];

    this.queQiao = new MinecraftQueQiao(
      this.ctx,
      this.panel.gl.queQiaoAdapter,
      {
        rconEnable: yml.rcon.enable,
        rconServerHost: rconHost,
        rconServerPort: rconPortStr ? Number(rconPortStr) : yml.rcon.port,
        rconPassword: serverConfig.rconPassword || yml.rcon.password,

        wsServer: '客户端',
        wsHost: wsHost,
        wsPort: wsPortStr ? Number(wsPortStr) : yml.websocket_server.port,
        Token: serverConfig.Token || yml.access_token,
        serverName: yml.server_name,

        sendToChannel: this.config.queQiaoSendToChannel,
        watchChannel: this.config.queQiaoWatchChannel,
      },
    );

    // 注册进 adapter，供其他实例复用与健康指令查询
    adapter.servers[yml.server_name] = this.queQiao;
    this.queQiaoOwned = true;

    return this.queQiao;
  }

  // 实例销毁逻辑
  public dispose() {
    // 实例停止后无人在线，清空内存在线列表，避免重启后残留导致重连玩家被判为重复加入
    const serverName = this.serverName;
    if (MCBotGameOnline.list[serverName]) {
      delete MCBotGameOnline.list[serverName];
    }

    this.logParser?.dispose();
    this.logParser = null;

    if (this.queQiao) {
      logger.info(`[${this.queQiao?.config.serverName || '未知'}] 实例已销毁`);

      if (this.queQiaoOwned) {
        const adapter = this.panel.gl.queQiaoAdapter;
        const name = this.queQiao.config.serverName;
        if (name && adapter.servers[name] === this.queQiao) {
          delete adapter.servers[name];
        }
        this.queQiao.dispose();
      }

      this.queQiao = null;
      this.queQiaoOwned = false;
    }
  }

  // 无鹊桥（未配置或连接不可用）时，从 MCS 终端日志识别玩家加入/离开/聊天
  public logParser: McLogPlayerParser | null = null;

  // 该实例是否在配置中启用了鹊桥（决定日志兜底是否参与，避免与鹊桥重复）
  public queQiaoConfigured = false;

  // 由 ws 的 instance/stdout 回调进入
  public handleConsoleText(text: string) {
    // 配置了鹊桥的服务器以鹊桥事件为准，避免同一玩家因命名不一致产生两份在线记录
    if (this.queQiaoConfigured) {
      if (!this.logFallbackSkipLogged) {
        this.logFallbackSkipLogged = true;
        logger.info(
          `[${this.logLabel}] 已启用鹊桥，终端日志玩家事件兜底不生效`,
        );
      }
      return;
    }

    this.getLogParser().handleText(text);
  }

  private logFallbackSkipLogged = false;

  // 非 Minecraft 实例跳过日志连接的提示只打一次
  public streamSkipLogged = false;

  // 日志前缀固定用实例昵称，避免鹊桥在线/离线时同一条日志出现两种标识
  private get logLabel() {
    return this.cfg.config.nickname || '未知服务器';
  }

  // 只有 Minecraft 服务端才有「玩家加入/离开/聊天」语义，
  // 方舟之类的实例终端日志格式完全不同，解析只会产生假事件并白占 WS 连接额度
  public get isMinecraft() {
    if (this.cfg.config.enableRcon) {
      return true;
    }

    const type = this.cfg.config.type ?? '';

    return /minecraft|bukkit|forge|fabric|paper|bedrock/i.test(type);
  }

  // 方舟实例靠 tag 标记，终端只识别进服行
  public get isArk() {
    const tags = this.cfg.config.tag as unknown;
    const list = Array.isArray(tags) ? tags : [];

    return list.some(tag => String(tag).includes('方舟'));
  }

  // 是否值得占用一条控制台日志流
  public get shouldStreamConsole() {
    return this.isMinecraft || this.isArk;
  }

  // 流认证完成的时刻，用于丢弃重连时 daemon 回放的旧日志
  public notifyStreamAuthenticated() {
    logger.info(
      `[${this.logLabel}] 实例控制台日志流已连通，玩家事件兜底开始监听`,
    );
    this.getLogParser().notifyAuthenticated();
  }

  private getLogParser() {
    if (!this.logParser) {
      this.logParser = new McLogPlayerParser(this.logLabel, event =>
        this.handlePlayerEvent(event),
      );
    }
    return this.logParser;
  }

  private async handlePlayerEvent(event: ParsedPlayerEvent) {
    const serverName = this.serverName;
    const { nickname } = event;

    // 方舟只做进服播报，不参与 MC 在线列表与玩家库
    if (this.isArk) {
      if (event.type === 'join') {
        this.broadcastLogMessage(`${nickname} 进入 ${serverName}`);
      }
      return;
    }

    if (!MCBotGameOnline.list[serverName]) {
      MCBotGameOnline.list[serverName] = {
        config: { serverName } as any,
        list: {},
      };
    }
    const onlineList = MCBotGameOnline.list[serverName].list;

    if (event.type === 'join') {
      // 控制台同一行会被 daemon 重复推送（重连回放/多 chunk），已在线的玩家再次 join 视为重复，避免重复广播与计时重置
      if (onlineList[nickname]) {
        return;
      }

      onlineList[nickname] = {
        nickname,
        uuid: '',
        address: '',
        health: 0,
        max_health: 0,
        experience_level: 0,
        experience_progress: 0,
        total_experience: 0,
        is_op: false,
        walk_speed: 0,
        x: 0,
        y: 0,
        z: 0,
      };
      this.broadcastLogMessage(`[${serverName}] ${nickname} 加入了服务器！`);
      await this.touchUserOnJoin(nickname);
      return;
    }

    if (event.type === 'quit') {
      // 玩家不在在线列表即视为重复的离开日志，避免重复结算
      if (!onlineList[nickname]) {
        return;
      }

      delete onlineList[nickname];
      this.broadcastLogMessage(`[${serverName}] ${nickname} 离开了服务器！`);
      await this.settleUserOnQuit(nickname);
      return;
    }

    this.broadcastLogMessage(`[${serverName}] ${nickname}: ${event.message}`);
  }

  public get serverName() {
    return (
      this.queQiao?.config.serverName ||
      this.cfg.config.nickname ||
      '未知服务器'
    );
  }

  // 日志来源没有 uuid：仅按昵称匹配，多行时取最近进入的一行
  private async findUserByNickname(nickname: string) {
    const users = await this.ctx.database
      .get('mcUser', { nickname })
      .catch((err: any) => {
        logger.error(`[${this.logLabel}] 查询 mcUser(${nickname}) 失败:`, err);
        return [] as any[];
      });

    return users.find(u => u.lastTime) ?? users[0] ?? null;
  }

  private async touchUserOnJoin(nickname: string) {
    const user = await this.findUserByNickname(nickname);

    if (!user) {
      await this.ctx.database.create('mcUser', {
        nickname,
        uuid: '',
        lastTime: new Date(),
        level: 0,
        onlineTimeJSON: '{}',
      });
      logger.info(
        `[${this.logLabel}] 已为「${nickname}」新建 mcUser 记录并开始计时`,
      );
      return;
    }

    await this.ctx.database.set(
      'mcUser',
      { id: user.id },
      { nickname, lastTime: new Date() },
    );
  }

  private async settleUserOnQuit(nickname: string) {
    const user = await this.findUserByNickname(nickname);
    if (!user) {
      logger.info(
        `[${this.logLabel}] 结算时长失败：mcUser 中无「${nickname}」记录`,
      );
      return;
    }
    if (!user.lastTime) {
      logger.info(
        `[${this.logLabel}] 「${nickname}」无进行中的在线记录，跳过时长结算`,
      );
      return;
    }

    const onlineDuration = Math.max(
      0,
      Math.floor((Date.now() - new Date(user.lastTime).getTime()) / 1000),
    );

    let onlineTimeJSON: { mc?: Record<string, number> } = {};
    try {
      onlineTimeJSON = JSON.parse(user.onlineTimeJSON);
    } catch (err) {
      onlineTimeJSON = {};
    }

    if (!onlineTimeJSON.mc) {
      onlineTimeJSON.mc = {};
    }
    const playerId = `${user.uuid || nickname}|${this.serverName}`;
    onlineTimeJSON.mc[playerId] =
      (onlineTimeJSON.mc[playerId] ?? 0) + onlineDuration;

    logger.info(
      `[${this.logLabel}] 「${nickname}」本次在线 ${onlineDuration}s，累计写入 ${playerId}`,
    );

    await this.ctx.database.set(
      'mcUser',
      { id: user.id },
      { lastTime: null, onlineTimeJSON: JSON.stringify(onlineTimeJSON) },
    );
  }

  private broadcastLogMessage(message: string) {
    const channels = this.config.queQiaoSendToChannel ?? [];

    if (!channels.length) {
      logger.info(`[${this.logLabel}] ${message}（未配置广播频道，仅写日志）`);
      return;
    }

    let matched = 0;

    this.ctx.bots.forEach((bot: any) => {
      const botChannels = channels
        .filter(str => str.includes(`${bot.platform}`))
        .map(str => str.replace(`${bot.platform}:`, ''));

      if (!botChannels.length) return;
      matched += botChannels.length;

      bot
        .broadcast(botChannels, message, 0)
        .catch((err: any) =>
          logger.error(`[${this.logLabel}] 广播到 ${bot.platform} 失败:`, err),
        );
    });

    if (!matched) {
      logger.info(
        `[${this.logLabel}] 无匹配的平台机器人，消息未广播：${channels.join(
          ',',
        )}｜${message}`,
      );
    }
  }
}
