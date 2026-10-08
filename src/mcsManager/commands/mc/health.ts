import { isNumber } from 'lodash';
import { BotCommandBase } from '../../../gl/commands/base';
import MinecraftQueQiao from '../../../queQiao';
import { MCSManagerBot } from '../../bot';

/**
 * 服务器 健康 指令
 *
 * @example 服务器 健康
 */
export class MCBotHealthCommand extends BotCommandBase {
  command: string[] = ['服务器.健康 <status>', 'MC.健康 <status>'];

  roles = [];

  constructor(public readonly bot: MCSManagerBot) {
    super(bot);
  }

  async getHealthStatus(connect: MinecraftQueQiao) {
    const healths = [];

    // 未连接时尝试（重）连接，未启用/连接失败则跳过指标采集
    if (!(await connect.ensureRconConnected())) {
      return healths;
    }

    try {
      // FIXME: 此处需适配，`forge tps` 仅 forge 端支持，其他服务端无有效响应
      const result = await connect.sendRconCommand('forge tps');
      // Overall: Mean tick time: 3.314 ms. Mean TPS: 20.000
      const [, tickTimeMatch, tpsMatch] =
        result.match(/Mean tick time: ([\d.]+) ms\. Mean TPS: ([\d.]+)/) ||
        [];

      if (tickTimeMatch && isNumber(Number(tickTimeMatch))) {
        healths.push(
          `Tick：${Number(tickTimeMatch).toFixed(2)} ms [${Number(tickTimeMatch) <= 50 ? '优秀' : '过高'}]`,
        );
      }

      if (tpsMatch && isNumber(Number(tpsMatch))) {
        healths.push(
          `TPS：${Number(tpsMatch).toFixed(2)} [${Number(tpsMatch) >= 15 ? '优秀' : '过低'}]`,
        );
      }
    } catch (err) {
      console.error(`[${connect.serverName}] 获取健康指标失败:`, err);
    }

    return healths;
  }

  async handle(_, status?: string[]): Promise<string> {
    const result = ['服务器 健康 状态：'];

    for (const [name, server] of Object.entries(
      this.bot.manager.gl.queQiaoAdapter.servers,
    )) {
      const headers = await this.getHealthStatus(server);
      const queQIaoConnected = server.ws?.readyState === 1;
      const rconConnected = server.rcon?.authenticated === true;

      result.push(
        `- [${name}] 互通：${queQIaoConnected ? 'OK' : 'NO'} | 后端：${rconConnected ? 'OK' : 'NO'}${headers.length > 0 ? ` | ${headers.join(' | ')}` : ''}`,
      );
    }

    if (result.length === 1) {
      result.push('- 未配置任何启用鹊桥的服务器');
    }

    return result.join('\n');
  }
}
