import { Context } from 'koishi';
import { MCManager } from '.';
import { GLBotConfigType } from '../gl';
import { GLCommandRegister } from '../gl/commands/register';
import {
  ARKBotListCommand,
  ARKBotRestartCommand,
  ARKBotStartCommand,
  ARKBotStopCommand,
  MCBotBackupCommand,
  MCBotGameOnline,
  MCBotHealthCommand,
  MCBotListCommand,
  MCBotOnlineTimeCommand,
  MCBotRemarkCommand,
  MCBotRestartCommand,
  MCBotStartCommand,
  MCBotStopCommand,
} from './commands';
import { MCBotCreateCommand } from './commands/mc/create';
import { MCSManagerPanel } from './panel';

export class MCSManagerBot {
  constructor(
    public readonly manager: MCManager,
    public readonly ctx: Context,
    public readonly config: GLBotConfigType,
    public readonly panel: MCSManagerPanel,
  ) {
    this.initialize();
  }

  public commands() {
    return [
      MCBotRestartCommand,
      MCBotListCommand,
      MCBotStartCommand,
      MCBotStopCommand,
      MCBotCreateCommand,
      MCBotOnlineTimeCommand,
      MCBotGameOnline,
      MCBotHealthCommand,
      MCBotRemarkCommand,
      MCBotBackupCommand,

      ARKBotListCommand,
      ARKBotRestartCommand,
      ARKBotStartCommand,
      ARKBotStopCommand,
    ];
  }

  async initialize() {
    this.ctx.on('ready', async () => {
      this.registerCommands();
    });
  }

  private registerCommands() {
    const mode = this.config.cmdRegisterMode ? 'keyword' : 'command';

    for (const Command of this.commands()) {
      const cmd = new Command(this);

      for (const cmdStr of cmd.command) {
        if (mode === 'command') {
          this.ctx.command(cmdStr).action(async (argv, ...args) => {
            return await cmd.authenticate(argv, args);
          });
        }

        const formatCommand = cmdStr
          .replace(/(\S+)\.(\S+)/g, '$1 $2')
          .replace(/\<.*?\>/g, '')
          .toLocaleUpperCase()
          .trim();
        const mainCommand = formatCommand.split(/\s/g).at(0);

        if (mainCommand) {
          GLCommandRegister.commands[formatCommand] = cmd;
          GLCommandRegister.mainCommands.add(mainCommand);
          // mainCommand <arg0>  || mainCommand <args...>
          GLCommandRegister.commandRegExp[formatCommand] = new RegExp(
            `^${cmdStr
              .replace(/(\S+)\.(\S+)(?!=\>)/g, '$1 $2')
              // <args...> / <args... > 可变参数：匹配任意剩余内容（含空格）
              .replace(/ \<\S+\.\.\s?\>/g, '\\s.*')
              // 单参数：保持可选，避免裸指令（如「服务器 列表」）无法匹配
              .replace(/ \<\S+\>/g, '\(\\s\\S+\)?')}$`,
          );
        }
      }
    }

    if (mode === 'keyword') {
      this.ctx.on('message', async session => {
        const mainCommand = session.content
          .split(/\s/g)
          .at(0)
          ?.toLocaleUpperCase();

        if (mainCommand && GLCommandRegister.mainCommands.has(mainCommand)) {
          const formatCommand = session.content
            .replace(/(\S+)\.(\S+)/g, '$1 $2')
            .replace(/\<.*?\>/g, '')
            .toLocaleUpperCase()
            .trim();
          const findCmd = Object.entries(GLCommandRegister.commandRegExp).find(
            ([_, reg]) => reg.test(session.content),
          );

          if (!findCmd) {
            session.send(
              `指令：${mainCommand}\n可用的子指令有\n   - ${Object.keys(
                GLCommandRegister.commands,
              )
                .filter(item => item.startsWith(mainCommand!))
                .join('\n   - ')}`,
            );
            return;
          }

          const baseCommand = findCmd[0];
          const cmd = GLCommandRegister.commands[baseCommand];
          if (cmd) {
            // 从原始消息中截取参数，保留大小写（避免 URL 等参数被大写化）
            const normalized = session.content
              .replace(/(\S+)\.(\S+)/g, '$1 $2')
              .trim();
            const baseIndex = normalized
              .toLocaleUpperCase()
              .indexOf(baseCommand);
            const args =
              baseIndex >= 0
                ? normalized.slice(baseIndex + baseCommand.length).trim()
                : '';
            const response = await cmd.authenticate(
              session.argv,
              args.length ? args.split(/\s/g) : [],
            );
            if (response) {
              session.send(response);
            }
          }
        }
      });
    }
  }
}
