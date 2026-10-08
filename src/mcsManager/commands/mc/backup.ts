import { Argv } from 'koishi';

import { BotCommandBase } from '../../../gl/commands/base';
import { tokenizeArgs } from '../../../utils';
import { MCBackupService } from '../../backup';
import { MCSManagerBot } from '../../bot';
import { McBackup } from '../../schedules/mc.schedule';

// 注意：回复文本避免使用 <...> 占位符（部分平台会当作 CQ 码吞掉）
const HELP_TEXT = [
  '「服务器 备份」用法：',
  '  - 服务器 备份 定时 [服务器名称] [定时值] [备份最大数量] [备份目标相对路径]',
  '  - 服务器 备份 立刻 [服务器名称] [定时值 备份最大数量 备份目标相对路径]',
  '  - 服务器 备份 关闭 [服务器名称]',
  '  - 服务器 备份 删除 [服务器名称]',
  '  - 服务器 备份 列表',
  '服务器名称含空格时可用引号包裹，如 "2026-落幕曲"',
  '定时值格式：数字 + s(秒)/h(小时)/d(天)，如 1h',
  '示例：服务器 备份 定时 锻造之旅1.4 1h 3 ./world',
].join('\n');

// 解析定时值，如 1h -> 3600 秒
function parseInterval(token: string): number | null {
  const match = token.match(/^(\d+)([shd])$/i);
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const unitSeconds = { s: 1, h: 3600, d: 86400 } as const;
  return value * unitSeconds[unit as 's' | 'h' | 'd'];
}

/**
 * 服务器备份指令
 *
 * @example 服务器 备份 定时 锻造之旅1.4 1h 3 ./world
 * @example 服务器 备份 立刻 锻造之旅1.4 1h 3 ./world
 * @example 服务器 备份 关闭 锻造之旅1.4
 * @example 服务器 备份 删除 锻造之旅1.4
 * @example 服务器 备份 列表
 */
export class MCBotBackupCommand extends BotCommandBase {
  command: string[] = [
    '服务器.备份.定时 <args...>',
    'MC.备份.定时 <args...>',
    '服务器.备份.立刻 <args...>',
    'MC.备份.立刻 <args...>',
    '服务器.备份.关闭 <args...>',
    'MC.备份.关闭 <args...>',
    '服务器.备份.删除 <args...>',
    'MC.备份.删除 <args...>',
    '服务器.备份.列表',
    'MC.备份.列表',
    '服务器.备份',
    'MC.备份',
  ];

  // roles 为空数组表示对所有人开放（[BotCommandRole.All] 会拦截所有人）
  roles = [];

  constructor(public readonly bot: MCSManagerBot) {
    super(bot);
  }

  private get service(): MCBackupService {
    return this.bot.manager.backup;
  }

  /**
   * 参数从尾部解析：最后 = 目标路径、倒数第二 = 最大数量、倒数第三 = 间隔，其余为服务器名称。
   * 参数不足 4 个时整体作为服务器名称（供「立刻/关闭/删除」仅传名称的场景）
   */
  private parseArgs(tokens: string[]) {
    if (tokens.length >= 4) {
      const targetPath = tokens.at(-1)!;
      const maxCount = Number(tokens.at(-2));
      const interval = parseInterval(tokens.at(-3)!);
      const serverName = tokens.slice(0, -3).join(' ');
      return { serverName, interval, maxCount, targetPath };
    }

    return {
      serverName: tokens.join(' '),
      interval: null as number | null,
      maxCount: NaN,
      targetPath: '',
    };
  }

  private async findRecord(serverName: string): Promise<McBackup | null> {
    const records = await this.bot.ctx.database.get('mcBackup', {});
    return records.find(item => item.serverName === serverName) ?? null;
  }

  // 按名称解析实例，获取 uuid 与规范昵称
  private async resolveInstance(serverName: string) {
    const nameInstances = await this.bot.panel.searchInstanceByName(serverName);
    if (nameInstances.length === 0) {
      return null;
    }

    return (
      nameInstances.find(
        item => item.instance.cfg.config.nickname === serverName,
      ) ?? nameInstances[0]
    );
  }

  private async upsertRecord(options: {
    serverName: string;
    intervalSec: number;
    maxCount: number;
    targetPath: string;
    enabled?: boolean;
  }): Promise<McBackup | null> {
    const record = await this.findRecord(options.serverName);

    if (record) {
      const updates: Partial<McBackup> = {
        intervalSec: options.intervalSec,
        maxCount: options.maxCount,
        targetPath: options.targetPath,
      };
      if (options.enabled !== undefined) {
        updates.enabled = options.enabled;
      }

      await this.bot.ctx.database.set('mcBackup', { id: record.id }, updates);
      return { ...record, ...updates };
    }

    // 新任务需解析实例以冗余存储 uuid
    const found = await this.resolveInstance(options.serverName);
    if (!found) {
      return null;
    }

    const serverName = found.instance.cfg.config.nickname;
    const created = await this.bot.ctx.database.create('mcBackup', {
      serverName,
      instanceUuid: found.instance.cfg.instanceUuid,
      intervalSec: options.intervalSec,
      maxCount: options.maxCount,
      targetPath: options.targetPath,
      enabled: options.enabled ?? true,
      lastBackupTime: new Date(),
    });

    return created as McBackup;
  }

  async handle(cmd: Argv, args: (string | string[])[]) {
    const content = cmd.session.content ?? '';
    const subMatch = content.match(/备份[.\s]*(定时|立刻|关闭|删除|列表)/);
    const sub = subMatch?.[1];

    // 优先从原始消息内容解析（command 模式下 args 可能为空），引号内的名称作为整体保留
    let tokens = subMatch
      ? tokenizeArgs(content.slice((subMatch.index ?? 0) + subMatch[0].length))
      : [];

    if (tokens.length === 0) {
      tokens = (args.flat(Infinity) as string[]).filter(Boolean);
    }

    if (sub === '列表') {
      const records = await this.bot.ctx.database.get('mcBackup', {});
      if (records.length === 0) {
        return '当前没有任何备份任务';
      }

      const now = Date.now();
      return `「服务器 备份」任务列表：\n${records
        .map((item, index) => {
          const lastBackupTime = item.lastBackupTime
            ? new Date(item.lastBackupTime).getTime()
            : 0;
          const nextIn = Math.max(
            0,
            Math.ceil((lastBackupTime + item.intervalSec * 1000 - now) / 1000),
          );
          return [
            `${index + 1}. ${item.serverName}`,
            `   状态：${
              item.enabled
                ? `✅ 已启用（${MCBackupService.formatInterval(
                    nextIn,
                  )}后下次备份）`
                : '❌ 已关闭'
            }`,
            `   间隔：${MCBackupService.formatInterval(
              item.intervalSec,
            )} / 保留 ${item.maxCount} 份 / 目标：${item.targetPath}`,
          ].join('\n');
        })
        .join('\n')}`;
    }

    const { serverName, interval, maxCount, targetPath } =
      this.parseArgs(tokens);

    if (!serverName) {
      return HELP_TEXT;
    }

    if (sub === '定时') {
      if (interval === null || isNaN(maxCount) || !targetPath) {
        return '用法：服务器 备份 定时 [服务器名称] [定时值] [备份最大数量] [备份目标相对路径]';
      }

      const record = await this.upsertRecord({
        serverName,
        intervalSec: interval,
        maxCount,
        targetPath,
        enabled: true,
      });

      if (!record) {
        return `未找到名称为 "${serverName}" 的服务器`;
      }

      // 计时从当前开始，首次备份等待一个完整周期
      await this.bot.ctx.database.set(
        'mcBackup',
        { id: record.id },
        { lastBackupTime: new Date() },
      );

      return `已为 "${
        record.serverName
      }" 设置定时备份：每 ${MCBackupService.formatInterval(
        interval,
      )} 备份 ${targetPath}，最多保留 ${maxCount} 份`;
    }

    if (sub === '立刻') {
      let record = await this.findRecord(serverName);

      // 无记录且携带完整参数时按参数创建（不启用定时）
      if (!record && tokens.length >= 4) {
        if (interval === null || isNaN(maxCount) || !targetPath) {
          return '用法：服务器 备份 立刻 [服务器名称] [定时值] [备份最大数量] [备份目标相对路径]';
        }

        record = await this.upsertRecord({
          serverName,
          intervalSec: interval,
          maxCount,
          targetPath,
          enabled: false,
        });
      }

      if (!record) {
        return `未找到 "${serverName}" 的备份任务，请先使用「服务器 备份 定时 ...」创建`;
      }

      // 大存档压缩耗时较久，先回执处理中提示，避免群内以为没有响应；
      // 提示发送失败不阻断备份流程
      await cmd.session
        .send(`「${record.serverName}」备份任务处理中，请稍候...`)
        .catch(() => undefined);

      try {
        const result = await this.service.runBackup(record);
        return `「${record.serverName}」立刻备份：${result.message}`;
      } catch (error) {
        return `「${record.serverName}」立刻备份失败：${error.message}`;
      }
    }

    if (sub === '关闭') {
      const record = await this.findRecord(serverName);
      if (!record) {
        return `未找到 "${serverName}" 的备份任务`;
      }

      await this.bot.ctx.database.set(
        'mcBackup',
        { id: record.id },
        { enabled: false },
      );
      return `已关闭 "${record.serverName}" 的定时备份（任务已保留，可用「服务器 备份 定时」重新启用）`;
    }

    if (sub === '删除') {
      const record = await this.findRecord(serverName);
      if (!record) {
        return `未找到 "${serverName}" 的备份任务`;
      }

      await this.bot.ctx.database.remove('mcBackup', { id: record.id });
      return `已删除 "${record.serverName}" 的备份任务`;
    }

    return HELP_TEXT;
  }
}
