import { Context, Schema } from 'koishi';
import { GLBot, GLBotConfigType } from '../gl';
import { MCBackupService } from './backup';
import { MCSManagerBot } from './bot';
import { MCBotGameOnline } from './commands';
import { MCManagerConfig } from './config';
import { MCSManagerPanel } from './panel';
import { registerMcSchedule } from './schedules';

export class MCManager {
  static Config = Schema.intersect([
    MCManagerConfig.Base,
    MCManagerConfig.QueQiao,
  ]);

  public panel: MCSManagerPanel;

  public bot: MCSManagerBot;

  public backup: MCBackupService;

  constructor(
    public readonly gl: GLBot,
    public readonly ctx: Context,
    public readonly config: GLBotConfigType,
  ) {
    registerMcSchedule(ctx);

    this.panel = new MCSManagerPanel(gl, ctx, config);
    this.bot = new MCSManagerBot(this, ctx, config, this.panel);
    this.backup = new MCBackupService(ctx, this.panel);
    ctx.on('ready', this.initialize.bind(this));
  }

  async initialize() {
    await this.panel.initialize();

    // 面板就绪后启动通用自动备份定时器（读取持久化任务继续计时）
    this.backup.start();
  }

  public dispose() {
    this.backup.dispose();
    this.panel.dispose();
    MCBotGameOnline.list = {};
  }
}

export type MCManagerConfigType = typeof MCManager.Config;
