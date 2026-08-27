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
        this.createMCSManagerConnection(remote, instance.cfg);
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
      } catch (error) {
        // 静默处理定时任务中的网络错误
        console.debug('MCSManager定时任务执行失败:', error.message);
      }
    }, watchRemoteDelay);
  }

  // 创建远程连接
  async createMCSManagerConnection(
    remote: ServiceRemoteItemCustom,
    instance: ServiceRemoteInstanceItem,
  ) {
    if (isEqual(instance.status, RemoteInstanceStatusEnum.RUNNING)) {
      const uuid = instance.instanceUuid;

      // 已存在的实例且连接中 直接返回
      if (
        this.remoteConnectionsMap.has(uuid) &&
        this.remoteConnectionsMap.get(uuid).connect.connected
      ) {
        return this.remoteConnectionsMap.get(uuid);
      }

      // 上限检测
      if (
        this.remoteConnectionsMap.size >=
        this.config.mcManagerMaxConnectWs
      ) {
        return;
      }

      // 试图自动获取认证信息
      if (isEmpty(remote.auth)) {
        const instanceConnectAuth =
          await this.api.getServiceInstanceConnectAuth(
            remote.uuid,
            instance.instanceUuid,
          );
        remote.auth = instanceConnectAuth;
      }

      if (remote.auth) {
        const ws = new MCSManagerWebSocketIO(
          this.ctx,
          this.api,
          remote,
          instance,
          remote.auth,
        );
        this.remoteConnectionsMap.set(uuid, ws);
        return ws;
      }

      logger.error(
        `远程实例 ${instance.config.nickname} 缺少连接认证信息，无法建立连接`,
      );
    }
  }

  // 模糊搜索实例 通过 实例名称
  async searchInstanceByName(instanceName: string) {
    const instanceMap = new Map<
      string,
      {
        remote: ServiceRemoteItemCustom;
        instance: MCSManagerInstance;
        sort: number;
      }
    >();

    const keywords = instanceName.length < 10 ? instanceName.split('') : [];

    for (const remote of this.remotes) {
      for (const instance of remote.instances) {
        // 连词搜索
        if (instance.cfg.config.nickname.includes(instanceName)) {
          instanceMap.set(instance.cfg.instanceUuid, {
            remote,
            instance,
            sort: 1,
          });
        }

        // 分词搜索
        if (keywords.length) {
          // 索引词权重
          keywords.forEach(keyword => {
            if (instance.cfg.config.nickname.includes(keyword)) {
              if (!instanceMap.has(instance.cfg.instanceUuid)) {
                instanceMap.set(instance.cfg.instanceUuid, {
                  remote,
                  instance,
                  sort: 1,
                });
              } else {
                // 已存在则增加权重
                const record = instanceMap.get(instance.cfg.instanceUuid);
                record.sort += 1;
                instanceMap.set(instance.cfg.instanceUuid, record);
              }
            }
          });
        }
      }
    }

    return Array.from(instanceMap.values()).sort((a, b) => b.sort - a.sort);
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
