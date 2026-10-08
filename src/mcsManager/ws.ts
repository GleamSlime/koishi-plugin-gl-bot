import * as io from 'socket.io-client';

import { Context, Logger } from 'koishi';
import { isEqual } from 'lodash';
import { MCSManagerAPI } from './api';
import {
  ServiceInstanceConnectAuth,
  ServiceRemoteInstanceItem,
  ServiceRemoteItemCustom,
} from './type';

const logger = new Logger('mcsmanager-ws');

export class MCSManagerWebSocketIO {
  public connect: io.Socket;

  // 是否已认证通过
  public isAuthenticated = false;

  // 是否已记录过首条控制台输出（用于确认日志通道打通，只提示一次）
  private receivedFirstStdout = false;

  constructor(
    private readonly ctx: Context,
    private readonly api: MCSManagerAPI,
    private remote: ServiceRemoteItemCustom,
    private instance: ServiceRemoteInstanceItem,
    private auth: ServiceInstanceConnectAuth,
    // daemon 转发的实例控制台输出（text 可能包含多行）
    private onConsoleText?: (text: string) => void,
    // 实例流认证通过（用于标记重连回放日志的起点）
    private onStreamAuthenticated?: () => void,
  ) {
    this.initialize();
  }

  // 拼接该节点自身的 WS 地址 remote.ip(含协议) : remote.port
  private buildWsUrl() {
    const { ip, port } = this.remote;
    if (!ip) return '';
    // ip 形如 wss://panel.gleamslime.com，port 形如 23444 / 443
    return port ? `${ip}:${port}` : `${ip}`;
  }

  initialize() {
    if (this.connect) {
      this.connect.close();
    }

    const wsUrl = this.buildWsUrl();
    if (!wsUrl) {
      logger.error(
        `[${this.remote.remarks}] 节点缺少 ip/port，跳过该 daemon 连接`,
      );
      return;
    }

    this.connect = io.connect(wsUrl, {
      multiplex: false,
      reconnectionDelayMax: 1000 * 3,
      timeout: 1000 * 3,
      reconnection: true,
      reconnectionAttempts: 2000,
    });

    this.bindEvents();

    logger.debug(
      `正在连接到 MCSManager 实例服务器 [${this.remote.remarks}] - ${this.instance.config.nickname} ...`,
    );
  }

  // 发送MC指令到远程实例
  public sendCommand(command: string) {
    this.connect.emit('stream/input', {
      data: { command },
    });

    logger.warn(
      `已向远程实例 ${this.instance.config.nickname} 发送指令：${command}`,
    );
  }

  private bindEvents() {
    this.connect.on('connect', this.onConnect.bind(this));
    this.connect.on('disconnect', this.onDisconnect.bind(this));
    this.connect.on('reconnect', this.onReconnect.bind(this));
    this.connect.on('connect_error', this.onConnectError.bind(this));
    // 认证事件用 on 注册（非 once），避免重连后事件在监听器注册前到达导致认证卡死、需重启
    this.connect.on('auth', this.onAuth.bind(this));
    this.connect.on('stream/auth', this.onStreamAuth.bind(this));
    // 实例流认证通过后，daemon 通过该事件持续推送实例控制台输出
    this.connect.on('instance/stdout', this.onInstanceStdout.bind(this));
  }

  private onConnect() {
    // 重连后必须重置认证状态，否则断连期间 isAuthenticated 仍为 true
    this.isAuthenticated = false;
    logger.info(
      `已连接到 MCSManager 实例服务器 [${this.remote.remarks}] - ${this.instance.config.nickname}，开始认证...`,
    );
    // 发起节点 Key 认证，auth/stream/auth 监听已在 initialize 注册
    this.connect.emit('auth', { data: this.remote.key });
  }

  private onDisconnect(reason: string) {
    this.isAuthenticated = false;
    logger.warn(`与 MCSManager 实例服务器的连接已断开，原因：${reason}`);
  }

  private onReconnect(attemptNumber: number) {
    this.isAuthenticated = false;
    logger.info(
      `正在重新连接到 MCSManager 实例服务器，尝试次数：${attemptNumber}`,
    );
  }

  private onConnectError(error: Error) {
    logger.error(`连接 MCSManager 实例服务器时出错：${error.message}`);
  }

  // daemon 推送的实例控制台输出，packet 形如 { status, event, data: { instanceUuid, text } }
  private onInstanceStdout(pack: any) {
    const text = pack?.data?.text;
    if (typeof text !== 'string' || text.length === 0) {
      return;
    }

    // 首次输出打一条日志，确认该实例的控制台日志通道已打通（便于定位兜底不生效）
    if (!this.receivedFirstStdout) {
      this.receivedFirstStdout = true;
      logger.info(
        `[${this.remote.remarks}] - ${this.instance.config.nickname} 已收到实例控制台输出`,
      );
    }

    logger.debug(
      `[${this.instance.config.nickname}] instance/stdout: ${text.slice(0, 200)}`,
    );

    this.onConsoleText?.(text);
  }

  // 节点 Key 认证回调
  private onAuth({ event, status }: { event: string; status: number }) {
    // 节点 Key 认证不通过属于永久性失败，停止重连
    if (!isEqual(event, 'auth') || !isEqual(status, 200)) {
      logger.error(
        `[${this.remote.remarks}] 节点 Key 认证失败，跳过该 daemon 连接`,
      );
      this.isAuthenticated = false;
      // disconnect() 会停止自动重连
      this.connect.disconnect();
      return;
    }

    // 节点认证通过，继续实例认证
    this.connect.emit('stream/auth', {
      data: { password: this.auth.password },
    });
  }

  // 实例认证回调
  private onStreamAuth(pack: { status: number; data: unknown }) {
    if (isEqual(pack.status, 200) && isEqual(pack.data, true)) {
      logger.info(
        `已成功连接到 MCSManager 实例服务器 [${this.remote.remarks}] - ${this.instance.config.nickname} `,
      );
      this.isAuthenticated = true;
      this.onStreamAuthenticated?.();
      return;
    }

    logger.error(
      `远程实例 ${this.instance.config.nickname} 认证失败，无法建立连接`,
    );
    this.isAuthenticated = false;
    this.connect.disconnect();
  }
}
