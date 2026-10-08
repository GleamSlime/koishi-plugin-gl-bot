import { isEmpty } from 'lodash';
import { BotCommandBase } from '../../../gl/commands/base';
import MinecraftQueQiao from '../../../queQiao';
import { formatOnlineTime } from '../../../utils';
import { MCSManagerBot } from '../../bot';
import { McUser } from '../../type';

export class MCBotGameOnline extends BotCommandBase {
  static list: Record<
    string,
    {
      config: Schemastery.TypeS<typeof MinecraftQueQiao.Config>;
      list: Record<string, McUser>;
    }
  > = {};

  command: string[] = ['服务器.在线 <status>', 'MC.在线 <status>'];

  roles = [];

  constructor(public readonly bot: MCSManagerBot) {
    super(bot);
  }

  /**
   * 通过 rcon 发送 list 指令，截取响应中的玩家名列表
   * rcon 不可用或无响应时返回 null（调用方可降级使用内存数据）
   */
  static async getOnlinePlayers(
    connect: MinecraftQueQiao,
  ): Promise<string[] | null> {
    let response: string;
    try {
      response = await connect.sendRconCommand('list');
    } catch (err) {
      console.error(`[${connect.serverName}] 获取在线玩家失败:`, err);
      return null;
    }

    // rcon 未连接/未启用时无响应
    if (!response) {
      return null;
    }

    // There are 2 of a max of 2026 players online: xxx, xxxx
    // 中文服务端响应同样以冒号分隔，取冒号后的玩家名部分
    const playersStr = response.split(/[:：]/).pop()?.trim() ?? '';

    return playersStr.length > 0
      ? playersStr
          .split(',')
          .map(name => name.trim())
          .filter(name => name.length > 0)
      : [];
  }

  /**
   * 以 rcon list 结果为准同步在线玩家列表，
   * 同时清理内存中残留的已下线玩家（退出事件丢失时会产生），
   * 并把被清理玩家的本次在线时长结算入库。
   * rcon 不可用时降级使用内存数据。
   */
  static async syncOnlineList(bot: MCSManagerBot) {
    const result: typeof MCBotGameOnline.list = {};

    for (const server of Object.values(
      bot.manager.gl.queQiaoAdapter.servers,
    )) {
      const serverName = server.config.serverName || '';
      const cached = MCBotGameOnline.list[serverName] ?? {
        config: server.config,
        list: {},
      };

      const online = await MCBotGameOnline.getOnlinePlayers(server);

      if (online) {
        // 内存中存在但 rcon 未返回的玩家视为已下线，移除并结算时长
        const stalePlayers = Object.values(cached.list).filter(
          player => !online.includes(player.nickname),
        );

        for (const player of stalePlayers) {
          delete cached.list[player.nickname];
        }

        if (stalePlayers.length > 0) {
          await MCBotGameOnline.settleOnlineTime(bot, serverName, stalePlayers);
        }

        for (const nickname of online) {
          cached.list[nickname] ??= { nickname, uuid: '' } as McUser;
        }
      }

      cached.config = server.config;
      MCBotGameOnline.list[serverName] = cached;
      result[serverName] = cached;
    }

    return result;
  }

  /**
   * 结算残留玩家的本次在线时长（加入时 lastTime 已记录，退出事件丢失导致未结算）
   */
  private static async settleOnlineTime(
    bot: MCSManagerBot,
    serverName: string,
    players: McUser[],
  ) {
    for (const player of players) {
      try {
        if (isEmpty(player.uuid)) {
          continue;
        }

        const user = await bot.ctx.database.get('mcUser', {
          uuid: player.uuid,
        });

        if (user.length === 0 || !user[0].lastTime) {
          continue;
        }

        const onlineDuration = Math.floor(
          (Date.now() - new Date(user[0].lastTime).getTime()) / 1000,
        );

        if (onlineDuration <= 0) {
          continue;
        }

        const playerId = player.uuid + '|' + serverName;

        let onlineTimeJSON: { mc?: Record<string, number> } = {};
        try {
          onlineTimeJSON = JSON.parse(user[0].onlineTimeJSON);
        } catch (err) {
          onlineTimeJSON = {};
        }

        if (!onlineTimeJSON.mc) {
          onlineTimeJSON.mc = {};
        }
        if (!onlineTimeJSON.mc[playerId]) {
          onlineTimeJSON.mc[playerId] = 0;
        }
        onlineTimeJSON.mc[playerId] += onlineDuration;

        await bot.ctx.database.set(
          'mcUser',
          { uuid: player.uuid },
          {
            // lastTime 置空表示已结算下线，避免在线/榜单命令误把下线后的时间累加
            lastTime: null,
            onlineTimeJSON: JSON.stringify(onlineTimeJSON),
          },
        );
      } catch (err) {
        console.error(`结算玩家 ${player.nickname} 在线时长失败:`, err);
      }
    }
  }

  async handle(): Promise<string> {
    try {
      // 以 rcon list 指令结果为准获取在线玩家，并清理内存中残留的已下线玩家
      const onlineServers = await MCBotGameOnline.syncOnlineList(this.bot);
      const users = await this.bot.ctx.database.get('mcUser', {});

      const allOnlineUsers: McUser[] = Object.values(onlineServers).flatMap(
        server => {
          return Object.values(server.list).map(user => {
            user.server = server.config;

            return user;
          });
        },
      );

      const userRankings = allOnlineUsers
        .map(user => {
          const dbUser = users.find(
            u =>
              (!isEmpty(user.uuid) && u.uuid === user.uuid) ||
              u.nickname === user.nickname,
          );

          // 本次在线时长（加入游戏时会更新 lastTime）
          const lastTime = dbUser?.lastTime
            ? new Date(dbUser.lastTime).getTime()
            : 0;
          const totalOnlineTime =
            lastTime > 0 ? Math.floor((Date.now() - lastTime) / 1000) : -1;

          return {
            ...user,
            totalOnlineTime,
          } as McUser & { totalOnlineTime: number };
        })
        .sort((a, b) => b.totalOnlineTime - a.totalOnlineTime)
        .slice(0, 10);

      if (userRankings.length === 0) {
        return '当前没有在线玩家';
      }

      let result = `==== 在线 玩家 ====\n`;

      userRankings.forEach((user, index) => {
        const rank = index + 1;
        const onlineTimeStr =
          user.totalOnlineTime === -1
            ? ''
            : `「${formatOnlineTime(user.totalOnlineTime)}」`;

        result += `[${user.server?.serverName ?? '-'}] ${rank}. ${user.nickname} ${onlineTimeStr}\n`;
      });

      result += '=================';

      return result;
    } catch (error) {
      console.error('查询在线玩家失败:', error);
      return '查询在线玩家时发生错误，请稍后重试';
    }
  }
}

/**
 * 服务器在线榜单指令
 * 查询服务器在线时长排行
 *
 * @example 服务器 在线榜单
 */
export class MCBotOnlineTimeCommand extends BotCommandBase {
  command: string[] = ['服务器.在线榜单 <status>', 'MC.在线榜单 <status>'];

  roles = [];

  constructor(public readonly bot: MCSManagerBot) {
    super(bot);
  }

  async handle(): Promise<string> {
    try {
      // 先以 rcon list 结果为准同步在线列表，用于判断玩家当前是否在线
      await MCBotGameOnline.syncOnlineList(this.bot);

      const users = await this.bot.ctx.database.get('mcUser', {});

      if (users.length === 0) {
        return '暂无玩家在线时长数据';
      }

      const userRankings = users
        .map(user => {
          let totalOnlineTime = 0;

          try {
            const onlineTimeData = JSON.parse(user.onlineTimeJSON || '{}');
            // onlineTimeJSON.mc 的 key 为 `uuid|服务器名`，兼容旧版纯 uuid 的 key
            if (onlineTimeData?.mc) {
              for (const [key, seconds] of Object.entries(
                onlineTimeData.mc,
              )) {
                if (key === user.uuid || key.startsWith(`${user.uuid}|`)) {
                  totalOnlineTime += Number(seconds) || 0;
                }
              }
            }
          } catch (err) {
            // onlineTimeJSON 解析失败时按 0 处理
          }

          // 当前在线的玩家累加本次在线时长
          const isOnline = Object.values(MCBotGameOnline.list).some(server => {
            const player = server.list[user.nickname];

            return (
              !!player &&
              (isEmpty(player.uuid) ||
                isEmpty(user.uuid) ||
                player.uuid === user.uuid)
            );
          });

          if (isOnline && user.lastTime) {
            totalOnlineTime += Math.floor(
              (Date.now() - new Date(user.lastTime).getTime()) / 1000,
            );
          }

          return {
            nickname: user.nickname,
            uuid: user.uuid,
            level: user.level,
            totalOnlineTime,
            lastTime: user.lastTime,
          };
        })
        .sort((a, b) => b.totalOnlineTime - a.totalOnlineTime)
        .slice(0, 10);

      let result = '==== 服务器在线时长排行榜 ====\n';

      const tag = [, '🥇', '🥈', '🥉'];
      userRankings.forEach((user, index) => {
        const rank = index + 1;
        const medal = tag[rank] || `${rank}.`;
        const onlineTimeStr = formatOnlineTime(user.totalOnlineTime);

        result += `${medal} ${user.nickname} 「${onlineTimeStr}」\n`;
        if (index < userRankings.length - 1) {
          result += '\n';
        }
      });

      result += '========================';

      return result;
    } catch (error) {
      console.error('查询在线时长排行榜失败:', error);
      return '查询在线时长排行榜时发生错误，请稍后重试';
    }
  }
}
