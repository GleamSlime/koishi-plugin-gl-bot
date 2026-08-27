import { Context, Logger } from 'koishi';
import { isEqual } from 'lodash';
import YAML from 'yaml';

import { GLBotConfigType } from '../gl';
import MinecraftQueQiao from '../queQiao';
import { MCSManagerAPI } from './api';
import { RemoteInstanceStatusEnum } from './constants';
import { MCSManagerPanel } from './panel';
import {
  MCSManagerQueQiaoYMLConfig,
  ServiceRemoteInstanceItem,
  ServiceRemoteItem,
} from './type';

const logger = new Logger('mcsmanager-panel');

export class MCSManagerInstance {
  public isAuthenticated = false;

  public queQiao: MinecraftQueQiao | null = null;

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

  public async createQueQiao() {
    if (this.queQiao) {
      return this.queQiao;
    }

    // 实例未运行则不创建鹊桥
    if (!isEqual(this.cfg.status, RemoteInstanceStatusEnum.RUNNING)) {
      return null;
    }

    const ymlResult = await this.api.readFile(
      this.remote.uuid,
      this.cfg.instanceUuid,
      '/config/QueQiao/config.yml',
    );
    const ymlJsonStr =
      ymlResult.length && isEqual(ymlResult[0], '{')
        ? JSON.parse(ymlResult)
        : null;
    const ymlString: string = ymlJsonStr?.data ?? '';
    const yml: MCSManagerQueQiaoYMLConfig = YAML.parse(ymlString);

    // 从 queQiaoServers 配置匹配当前实例（通过 server_name）
    const queQiaoServers = this.config.queQiaoServers ?? [];
    const serverConfig = queQiaoServers.find(
      s => isEqual(s.serverName, yml.server_name) && s.enable,
    );

    if (!serverConfig) {
      logger.info(
        `[${yml.server_name}] 未找到启用的鹊桥配置，跳过创建`,
      );
      return null;
    }

    // 拆分配置项的 host:port
    const [rconHost, rconPortStr] = serverConfig.rconServerHost.split(':');
    const [wsHost, wsPortStr] = serverConfig.wsHost.split(':');

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

    return this.queQiao;
  }

  // 实例销毁逻辑
  public dispose() {
    if (this.queQiao) {
      logger.info(`[${this.queQiao?.config.serverName || '未知'}] 实例已销毁`);
      this.queQiao?.dispose();
      this.queQiao = null;
    }
  }
}
