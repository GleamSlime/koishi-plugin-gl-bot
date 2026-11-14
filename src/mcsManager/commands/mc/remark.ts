import { Argv } from 'koishi';

import { BotCommandBase, BotCommandRole } from '../../../gl/commands/base';
import { GLCommandRegister } from '../../../gl/commands/register';
import { tokenizeArgs } from '../../../utils';
import { MCSManagerBot } from '../../bot';

// 注意：回复文本避免使用 <...> 占位符（部分平台会当作 CQ 码吞掉）
const HELP_TEXT = [
  '「服务器 备注」用法：',
  '  - 服务器 备注 增加 [备注键] [备注值]',
  '  - 服务器 备注 删除 [备注键]',
  '  - 服务器 备注 列表',
  '增加备注后，群内发送「备注键」时机器人会自动回复「备注值」',
].join('\n');

/**
 * 服务器备注指令
 *
 * @example 服务器 备注 增加 服务器ping "https://xxx.com/ping 访问可以看服务器的ping值哦"
 * @example 服务器 备注 删除 服务器ping
 * @example 服务器 备注 列表
 */
export class MCBotRemarkCommand extends BotCommandBase {
  command: string[] = [
    '服务器.备注.增加 <key> <value...>',
    'MC.备注.增加 <key> <value...>',
    '服务器.备注.删除 <key>',
    'MC.备注.删除 <key>',
    '服务器.备注.列表',
    'MC.备注.列表',
    '服务器.备注',
    'MC.备注',
  ];

  // 增删权限在 handle 中单独校验，列表对所有人开放
  roles = [];

  constructor(public readonly bot: MCSManagerBot) {
    super(bot);

    // 备注键精确匹配自动回复
    this.bot.ctx.on('message', async session => {
      const content = session.content?.trim();
      if (!content) return;

      // 排除指令消息（首词为主指令时交由指令系统处理）
      const mainCommand = content.split(/\s/g).at(0)?.toLocaleUpperCase();
      if (mainCommand && GLCommandRegister.mainCommands.has(mainCommand)) {
        return;
      }

      try {
        const remarks = await this.bot.ctx.database.get('mcRemark', {});
        const matched = remarks.find(item => item.key === content);
        if (matched) {
          await session.send(matched.value);
        }
      } catch (error) {
        console.debug('MCBotRemarkCommand auto reply failed:', error.message);
      }
    });
  }

  private hasAdminRole(cmd: Argv) {
    const userRole = cmd.session.event.member?.roles?.at(0);
    return [BotCommandRole.Admin, BotCommandRole.Owner].includes(
      userRole as unknown as BotCommandRole,
    );
  }

  private async listRemarks(): Promise<string> {
    const remarks = await this.bot.ctx.database.get('mcRemark', {});

    if (remarks.length === 0) {
      return '当前没有任何备注';
    }

    return `「服务器 备注」列表：\n${remarks
      .map(
        (item, index) =>
          `${index + 1}. ${item.key} -> ${MCBotRemarkCommand.limitPreview(
            item.value,
          )}`,
      )
      .join('\n')}`;
  }

  // 列表展示时截断过长的备注值
  static limitPreview(value: string, max = 32) {
    return value.length > max ? `${value.slice(0, max)}...` : value;
  }

  async handle(cmd: Argv, args: (string | string[])[]) {
    const content = cmd.session.content ?? '';
    const subMatch = content.match(/备注[.\s]*(增加|删除|列表)/);
    const sub = subMatch?.[1];

    // 优先从原始消息内容解析（command 模式下 args 可能为空），引号内的内容作为整体保留
    let tokens = subMatch
      ? tokenizeArgs(content.slice((subMatch.index ?? 0) + subMatch[0].length))
      : [];

    if (tokens.length === 0) {
      tokens = (args.flat(Infinity) as string[]).filter(Boolean);
    }

    if (sub === '列表') {
      return await this.listRemarks();
    }

    if (sub === '增加') {
      // if (!this.hasAdminRole(cmd)) {
      //   return '您没有权限使用此指令。';
      // }

      const key = tokens[0]?.trim();
      // 备注值可能包含空格（引号包裹时 tokenizeArgs 已合并为单个 token），整体作为值
      const value = tokens.slice(1).join(' ').trim();

      if (!key || !value) {
        return '用法：服务器 备注 增加 [备注键] [备注值]';
      }

      const exists = await this.bot.ctx.database.get('mcRemark', { key });
      if (exists.length > 0) {
        await this.bot.ctx.database.set('mcRemark', { key }, { value });
      } else {
        await this.bot.ctx.database.create('mcRemark', { key, value });
      }

      return `已${
        exists.length > 0 ? '更新' : '增加'
      }备注「${key}」，发送 "${key}" 时将自动回复`;
    }

    if (sub === '删除') {
      if (!this.hasAdminRole(cmd)) {
        return '您没有权限使用此指令。';
      }

      const key = tokens[0]?.trim();
      if (!key) {
        return '用法：服务器 备注 删除 [备注键]';
      }

      const exists = await this.bot.ctx.database.get('mcRemark', { key });
      if (exists.length === 0) {
        return `未找到备注「${key}」`;
      }

      await this.bot.ctx.database.remove('mcRemark', { key });
      return `已删除备注「${key}」`;
    }

    // 裸指令「服务器 备注」展示帮助 + 列表
    return `${HELP_TEXT}\n\n${await this.listRemarks()}`;
  }
}
