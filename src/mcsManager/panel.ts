import { Context, isEmpty, Logger } from 'koishi';
import { isEqual } from 'lodash';

import { IS_DEV } from '../constants';
import { GLBot, GLBotConfigType } from '../gl';
import { MCSManagerAPI } from './api';
import { RemoteInstanceStatusEnum } from './constants';
import { MCSManagerInstance } from './instance';
import {
  ServiceRemoteInstanceItem,
  ServiceRemoteItemCustom,
} from './type';
import { MCSManagerWebSocketIO } from './ws';

const logger = new Logger('mcsmanager-panel');

export class MCSManagerPanel {
  private isInitialized = false;

  public readonly api: MCSManagerAPI;

  private watchRemoteClock: NodeJS.Timeout | null = null;

  // 所有远程节点及其实例列表
  remotes: ServiceRemoteItemCustom[] = [];

  // 远程连接Map表
  remoteConnectionsMap: Map<string, MCSManagerWebSocketIO> = new Map();

  constructor(
    public readonly gl: GLBot,
    public readonly ctx: Context,
    public readonly config: GLBotConfigType,
  ) {
    this.api = new MCSManagerAPI(ctx.http, config.mcManagerHost);
  }

  async initialize() {
    if (this.isInitialized) {
      return;
    }
    this.isInitialized = true;

    const { mcManagerUsername, mcManagerPassword } = this.config;

    await this.api.login(mcManagerUsername, mcManagerPassword);
    await this.api.getUserInfo();

    await this.handleRemoteServices();

    await this.getAvailableRemoteInstance();

    this.watchRemoteConnections();
  }

  // 获取远程服务及其实例列表 [全量] - 来源为 config.mcManagerRemotes
  async handleRemoteServices(insertRemotes?: boolean) {
    try {
      const remoteList = this.config.mcManagerRemotes ?? [];
      const insertList: ServiceRemoteItemCustom[] = [];

      for (const remote of remoteList) {
        if (!remote.available) continue;

        const { mcManagerKey, ...remoteItem } = remote;
        const instanceList = await this.api.getServiceRemoteInstanceList(
          remote.uuid,
        );

        insertList.push({
          ...remoteItem,
          key: mcManagerKey,
          instances: instanceList.map(
            item =>
              new MCSManagerInstance(
                this.ctx,
                this.config,
                this.api,
                this,
                remoteItem,
                item,
                {
                  autoCreateQueQiao: insertRemotes !== false,
                },
              ),
          ),
        });
      }

      if (insertRemotes !== false) {
        this.remotes.map(remote => {
          remote.instances.forEach(instance => {
            instance.dispose();
          });
        });
        this.remotes = insertList;
      }

      if (insertRemotes !== false) {
        logger.info(
          `已获取到 ${this.remotes.length} 个远程节点及其实例 ${this.remotes.reduce((acc, remote) => acc + remote.instances.length, 0)} 个`,
        );
      }

      return insertList;
    } catch (error) {
      // 静默处理网络错误，避免在定时任务中抛出
      console.debug(
        'MCSManagerPanel.handleRemoteServices failed:',
        error.message,
      );
      return [];
    }
  }

  // 遍历所有远程节点 选择正在运行中的实力 建立远程连接
  getAvailableRemoteInstance() {
    for (const remote of this.remotes) {
      for (const instance of remote.instances) {
        this.createMCSManagerConnection(remote, instance);
      }
    }
  }

  /// 定时检查远程连接状态
  watchRemoteConnections() {
    clearInterval(this.watchRemoteClock as NodeJS.Timeout);

    const watchRemoteDelay = IS_DEV ? 60 * 1000 : 60 * 1000;
    this.watchRemoteClock = setInterval(async () => {
      try {
        // 拉取最新实例数据（不自动创建鹊桥、不更新 this.remotes）
        const newRemotes = await this.handleRemoteServices(false);
        if (!newRemotes.length) {
          return;
        }

        // 对比现有实例状态，处理状态变化
        for (const newRemote of newRemotes) {
          const oldRemote = this.remotes.find(r =>
            isEqual(r.uuid, newRemote.uuid),
          );
          if (!oldRemote) {
            // 配置中新增/启用的节点，直接并入
            this.remotes.push(newRemote);
            continue;
          }

          // 收集新实例 uuid 集合，用于检测被删除的实例
          const newUuids = new Set(
            newRemote.instances.map(i => i.cfg.instanceUuid),
          );

          // 处理状态变化
          for (const newInstance of newRemote.instances) {
            const oldInstance = oldRemote.instances.find(i =>
              isEqual(i.cfg.instanceUuid, newInstance.cfg.instanceUuid),
            );
            if (!oldInstance) {
              // 新建的实例立即并入，无需等待重启即可出现在列表中
              logger.info(
                `[${newInstance.cfg.config.nickname}] 发现新实例，已加入管理`,
              );
              oldRemote.instances.push(newInstance);
              continue;
            }

            const wasRunning = isEqual(
              oldInstance.cfg.status,
              RemoteInstanceStatusEnum.RUNNING,
            );
            const isRunning = isEqual(
              newInstance.cfg.status,
              RemoteInstanceStatusEnum.RUNNING,
            );

            // 同步最新实例配置
            oldInstance.cfg = newInstance.cfg;

            if (!wasRunning && isRunning) {
              // 实例刚启动，尝试连接鹊桥 ws
              logger.info(
                `[${newInstance.cfg.config.nickname}] 服务器已启动，尝试连接鹊桥...`,
              );
              oldInstance.createQueQiao();
            } else if (wasRunning && !isRunning) {
              // 实例已关闭，断开鹊桥 ws 并回收资源
              logger.info(
                `[${oldInstance.cfg.config.nickname}] 服务器已关闭，断开鹊桥连接并回收...`,
              );
              oldInstance.dispose();
            }
          }

          // 回收已从节点删除的实例
          const removedInstances: MCSManagerInstance[] = [];
          oldRemote.instances = oldRemote.instances.filter(oldInstance => {
            if (!newUuids.has(oldInstance.cfg.instanceUuid)) {
              removedInstances.push(oldInstance);
              return false;
            }
            return true;
          });
          removedInstances.forEach(instance => {
            logger.info(
              `[${instance.cfg.config.nickname}] 实例已从节点移除，回收资源...`,
            );
            instance.dispose();
          });
        }

        // 检查所有 RUNNING 实例的 WS 健康状态，断连/认证卡死时自动重建
        for (const remote of this.remotes) {
          for (const instance of remote.instances) {
            if (
              !isEqual(instance.cfg.status, RemoteInstanceStatusEnum.RUNNING)
            ) {
              continue;
            }
            await this.createMCSManagerConnection(remote, instance);
            // 鹊桥 WS 健康兜底：MC 进程重启（实例状态未变）导致 queQiao 断连放弃后自动重建
            await instance.createQueQiao();
          }
        }
      } catch (error) {
        // 静默处理定时任务中的网络错误
        console.debug('MCSManager定时任务执行失败:', error.message);
      }
    }, watchRemoteDelay);
  }

  // 创建远程连接
  async createMCSManagerConnection(
    remote: ServiceRemoteItemCustom,
    instance: MCSManagerInstance,
  ) {
    if (
      isEqual(instance.cfg.status, RemoteInstanceStatusEnum.RUNNING)
    ) {
      const uuid = instance.cfg.instanceUuid;
      const existing = this.remoteConnectionsMap.get(uuid);

      // 已连接且已认证视为健康，直接复用
      if (existing && existing.connect.connected && existing.isAuthenticated) {
        return existing;
      }

      // 不健康则清理旧连接，避免 socket 泄漏及重连卡死残留后不重建
      if (existing) {
        try {
          existing.connect.disconnect();
        } catch (err) {
          // 忽略断开旧连接时的异常
        }
        this.remoteConnectionsMap.delete(uuid);
      }

      // 上限检测
      if (
        this.remoteConnectionsMap.size >=
        this.config.mcManagerMaxConnectWs
      ) {
        logger.info(
          `[${instance.cfg.config.nickname}] WS 连接数已达上限(${this.config.mcManagerMaxConnectWs})，该实例暂未连接，控制台日志兜底不可用`,
        );
        return;
      }

      // 逐实例获取认证信息（stream 密码与实例绑定，缓存在实例上避免复用其他实例的凭据）
      if (isEmpty(instance.auth)) {
        instance.auth =
          (await this.api
            .getServiceInstanceConnectAuth(remote.uuid, uuid)
            .catch((err: any) => {
              logger.warn(
                `[${instance.cfg.config.nickname}] 获取实例流认证信息失败:`,
                err,
              );
              return null;
            })) ?? undefined;
      }

      if (instance.auth) {
        const ws = new MCSManagerWebSocketIO(
          this.ctx,
          this.api,
          remote,
          instance.cfg,
          instance.auth,
          text => instance.handleConsoleText(text),
          () => instance.notifyStreamAuthenticated(),
        );
        this.remoteConnectionsMap.set(uuid, ws);
        return ws;
      }

      logger.error(
        `远程实例 ${instance.cfg.config.nickname} 缺少连接认证信息，无法建立连接`,
      );
    }
  }

  // 模糊搜索实例 通过 实例名称
  async searchInstanceByName(instanceName: string) {
    // 连词（精确子串）匹配：输入整体作为子串匹配名称
    const substringMatches: Map<
      string,
      {
        remote: ServiceRemoteItemCustom;
        instance: MCSManagerInstance;
        sort: number;
      }
    > = new Map();
    // 分词（单字）匹配：输入拆字后逐字匹配，作为连词无结果时的降级
    const tokenMatches: Map<
      string,
      {
        remote: ServiceRemoteItemCustom;
        instance: MCSManagerInstance;
        sort: number;
      }
    > = new Map();

    const keywords = instanceName.length < 10 ? instanceName.split('') : [];

    for (const remote of this.remotes) {
      for (const instance of remote.instances) {
        const uuid = instance.cfg.instanceUuid;
        const nickname = instance.cfg.config.nickname;

        // 连词命中后不再参与分词匹配，避免弱相关结果混入
        if (nickname.includes(instanceName)) {
          substringMatches.set(uuid, { remote, instance, sort: 1 });
          continue;
        }

        // 分词匹配：单字命中数作为权重
        if (keywords.length) {
          let hit = 0;
          for (const keyword of keywords) {
            if (nickname.includes(keyword)) hit++;
          }
          if (hit > 0) {
            tokenMatches.set(uuid, { remote, instance, sort: hit });
          }
        }
      }
    }

    // 连词匹配存在时只返回连词结果，否则降级用分词匹配
    const result =
      substringMatches.size > 0 ? substringMatches : tokenMatches;
    return Array.from(result.values()).sort((a, b) => b.sort - a.sort);
  }

  public dispose() {
    this.remotes.forEach(remote => {
      remote.instances.forEach(instance => {
        instance.dispose();
      });
    });

    clearInterval(this.watchRemoteClock as NodeJS.Timeout);
  }
}
