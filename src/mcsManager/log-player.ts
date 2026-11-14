import { Logger } from 'koishi';

const logger = new Logger('mcsmanager-panel');

// ANSI 转义序列（CSI 带参数/两字符、OSC、单字符转义）
const ANSI_REG =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

// Minecraft 原版 §颜色代码
const MC_COLOR_REG = /§[0-9a-fk-or§]/gi;

export type ParsedPlayerEvent =
  | { type: 'join'; nickname: string }
  | { type: 'quit'; nickname: string }
  | { type: 'chat'; nickname: string; message: string };

const JOIN_REG = /^(.*?)\b(\S+) joined the game\b/i;
const JOIN_CN_REG = /(?:\[Server\])?\s*(\S+) 加入了(?:游戏|服务器)/;
const QUIT_REG = /^(.*?)\b(\S+) left the game\b/i;
const QUIT_CN_REG = /(?:\[Server\])?\s*(\S+) (?:离开了|退出了)(?:游戏|服务器)/;
// 异常掉线不一定输出 "left the game"，这些变体同样代表玩家下线
const QUIT_LOST_REG =
  /^(.*?)\b([A-Za-z0-9_]{1,16})(?:\s*\/[^\s\]]+|\s*\[[^\]]*\])*\s+lost connection\b/i;
const QUIT_DISCONNECTING_REG =
  /^disconnecting\s+([A-Za-z0-9_]{1,16})(?:\/[^\s:]+(?::\d+)?)?\b/i;
// 方舟输出：`[2026.11.14-06.27.54:383][540]2026.11.14_06.27.54: 玩家名 [UniqueNetId:xxx Platform:None] joined this ARK!`
const ARK_JOIN_REG =
  /^(?:\[[^\]]*\]\[[^\]]*\][^:]*:\s*)?(.+?)\s*\[UniqueNetId:[^\]]*\]\s*joined this ARK/i;
const ARK_QUIT_REG =
  /^(?:\[[^\]]*\]\[[^\]]*\][^:]*:\s*)?(.+?)\s*\[UniqueNetId:[^\]]*\]\s*left this ARK/i;
const CHAT_ANGLE_REG = /^<([A-Za-z0-9_]{1,16})>\s+(.+)$/;
const CHAT_COLON_REG = /^([A-Za-z0-9_]{1,16})[：:]\s+(.+)$/;

/**
 * 清洗 daemon 控制台输出：去 ANSI/§颜色码、去掉 `[HH:mm:ss INFO]: ` 日志前缀
 */
export function cleanConsoleLine(text: string): string {
  let line = text.replace(ANSI_REG, '').replace(MC_COLOR_REG, '');

  const prefixMatch = line.match(/^\[[0-9: ]{5,16}[^\]]*\]:\s?/);
  if (prefixMatch) {
    line = line.slice(prefixMatch[0].length);
  }

  return line.trim();
}

/**
 * 从 MCS 终端日志行识别玩家加入/离开/聊天（无鹊桥配置时的兜底数据源）
 */
export function parsePlayerEvent(line: string): ParsedPlayerEvent | null {
  const arkJoinMatch = line.match(ARK_JOIN_REG);
  if (arkJoinMatch) {
    return { type: 'join', nickname: arkJoinMatch[1].trim() };
  }

  const arkQuitMatch = line.match(ARK_QUIT_REG);
  if (arkQuitMatch) {
    return { type: 'quit', nickname: arkQuitMatch[1].trim() };
  }

  const joinMatch = line.match(JOIN_REG) ?? line.match(JOIN_CN_REG);
  if (joinMatch) {
    // 进服统计行（如 "There are 3 of a max of 20 players online"）不是玩家
    if (/\bthere are\b/i.test(joinMatch[1] ?? '')) {
      return null;
    }
    return { type: 'join', nickname: joinMatch[2] ?? joinMatch[1] };
  }

  const quitMatch =
    line.match(QUIT_REG) ??
    line.match(QUIT_CN_REG) ??
    line.match(QUIT_LOST_REG) ??
    line.match(QUIT_DISCONNECTING_REG);
  if (quitMatch) {
    const nickname = quitMatch[2] ?? quitMatch[1];
    if (/\bthere are\b/i.test(quitMatch[1] ?? '')) {
      return null;
    }
    return { type: 'quit', nickname };
  }

  const chatMatch =
    line.match(CHAT_ANGLE_REG) ??
    (line.includes(':') || line.includes('：')
      ? line.match(CHAT_COLON_REG)
      : null);
  if (chatMatch) {
    const nickname = chatMatch[1];
    // 排除控制台/系统输出伪装成聊天的行
    if (/^(?:Server|INFO|WARN|ERROR|Debug|Trace)$/i.test(nickname)) {
      return null;
    }
    return { type: 'chat', nickname, message: chatMatch[2].trim() };
  }

  return null;
}

/**
 * 订阅 daemon 的 instance/stdout 控制台输出，解析玩家事件
 *
 * 重连时守护进程会把认证前缓冲的旧日志一次性发来，认证后的宽限期内全部丢弃，
 * 避免把历史事件当成实时事件重复结算/广播。
 */
export class McLogPlayerParser {
  private readonly authGraceMs = 5000;

  // 面板控制台会把同一条输出拆成多个 chunk 重复推送，短时间内同一事件只认一次
  private readonly repeatWindowMs = 800;

  private authCompletedAt = 0;

  private lastEventKey = '';

  private lastEventAt = 0;

  // 事件串行处理，保持加入/聊天/离开的先后顺序
  private chain: Promise<void> = Promise.resolve();

  // daemon 可能把一行日志拆进两个 chunk，未闭合的行先缓存
  private pendingLine = '';

  private pendingFlushTimer: NodeJS.Timeout | null = null;

  // 无换行结尾时判定为整行的等待时间
  private readonly lineFlushMs = 800;

  private lastRawLine = '';

  // 已丢弃的回放日志条数（仅用于提示一次）
  private graceWarned = false;

  constructor(
    private readonly label: string,
    private readonly onEvent: (
      event: ParsedPlayerEvent,
    ) => void | Promise<void>,
  ) {}

  public notifyAuthenticated() {
    this.authCompletedAt = Date.now();
    this.graceWarned = false;
    logger.debug(
      `[${this.label}] 终端日志解析已就绪（${this.authGraceMs}ms 内到达的输出按重连回放丢弃）`,
    );
  }

  // 认证后宽限期内为 true（此时到达的输出视为重连回放的历史日志）
  public get inAuthGrace() {
    return (
      !this.authCompletedAt ||
      Date.now() - this.authCompletedAt < this.authGraceMs
    );
  }

  public handleText(text: string) {
    if (this.inAuthGrace) {
      // 重连时 daemon 会先把缓冲的旧日志发来，提示一次便于排查「事件没上报」
      if (!this.graceWarned) {
        this.graceWarned = true;
        logger.info(
          `[${this.label}] 终端日志解析宽限期内，丢弃 ${
            text.split(/\r?\n/).filter(l => l.trim()).length
          } 行（疑似重连回放的旧日志）`,
        );
      }
      return;
    }

    this.dispatch(text);
  }

  private dispatch(raw: string) {
    // 上一段未闭合的内容拼在本次输入前，整行了才解析
    const segments = (this.pendingLine + raw).split(/\r?\n/);

    this.clearPendingFlush();
    this.pendingLine = segments.pop() ?? '';

    if (this.pendingLine) {
      // 尾部没有换行，可能是一行没发完，也可能本来就没有行尾
      this.pendingFlushTimer = setTimeout(
        () => this.flushPendingLine(),
        this.lineFlushMs,
      );
      this.pendingFlushTimer.unref?.();
    }

    for (const part of segments) {
      this.processLine(part);
    }
  }

  private flushPendingLine() {
    this.clearPendingFlush();

    const line = this.pendingLine;
    this.pendingLine = '';

    if (line) {
      this.processLine(line);
    }
  }

  private clearPendingFlush() {
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }
  }

  public dispose() {
    this.clearPendingFlush();
    this.pendingLine = '';
  }

  private processLine(part: string) {
    const line = cleanConsoleLine(part);
    if (!line || line === this.lastRawLine) {
      return;
    }
    this.lastRawLine = line;

    const event = parsePlayerEvent(line);
    if (!event) return;

    const now = Date.now();
    const key = `${event.type}|${event.nickname}|${
      'message' in event ? event.message : ''
    }`;
    if (
      key === this.lastEventKey &&
      now - this.lastEventAt < this.repeatWindowMs
    ) {
      logger.debug(`[${this.label}] 重复事件已忽略：${key}`);
      return;
    }
    this.lastEventKey = key;
    this.lastEventAt = now;

    logger.info(`[${this.label}] 终端日志识别玩家事件：${key.slice(0, 120)}`);

    this.chain = this.chain
      .then(() => this.onEvent(event))
      .catch(err => {
        logger.error(`[${this.label}] 处理终端日志玩家事件失败:`, err);
      }) as Promise<void>;
  }
}
