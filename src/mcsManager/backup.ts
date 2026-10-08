import { Context, Logger } from 'koishi';
import { posix } from 'path';

import { MCSManagerAPI } from './api';
import { RemoteInstanceStatusEnum, RemoteInstanceStatusName } from './constants';
import { McBackup } from './schedules/mc.schedule';
import { MCSManagerInstance } from './instance';
import { MCSManagerPanel } from './panel';
import { ServiceRemoteItemCustom } from './type';

const logger = new Logger('mcsmanager-backup');

export type MCBackupRunResult = {
  ok: boolean;
  message: string;
};

/**
 * 通用自动备份服务
 *
 * 仅创建一个 1s 定时器，每次触发时检测持久化的备份任务列表（mcBackup 表），
 * 当「上次备份时间 + 间隔」到达当前时间时执行备份。
 * 备份通过 MCSManager 文件管理 API 将「备份目标相对路径」压缩到
 * 其父目录下的 backup 目录中，并清理超出最大数量的最旧备份。
 */
export class MCBackupService {
  private clock: NodeJS.Timeout | null = null;

  // 正在执行备份的任务，避免重入
  private running = new Set<number>();

  constructor(
    private readonly ctx: Context,
    private readonly panel: MCSManagerPanel,
  ) {}

  public start() {
    if (this.clock) return;

    this.clock = setInterval(() => {
      this.tick().catch(error => {
        console.debug('MCBackupService.tick failed:', error.message);
      });
    }, 1000);
  }

  public dispose() {
    clearInterval(this.clock as NodeJS.Timeout);
    this.clock = null;
  }

  private async tick() {
    const tasks = await this.ctx.database.get('mcBackup', {});
    const now = Date.now();

    for (const task of tasks) {
      if (!task.enabled || this.running.has(task.id)) continue;

      const lastBackupTime = task.lastBackupTime
        ? new Date(task.lastBackupTime).getTime()
        : 0;

      // 上次备份距今达到设定间隔时触发（程序重启后依据 lastBackupTime 继续计时）
      if (now - lastBackupTime >= task.intervalSec * 1000) {
        this.running.add(task.id);
        this.runBackup(task)
          .then(result => {
            if (result.ok) {
              logger.info(`[${task.serverName}] ${result.message}`);
            } else {
              logger.warn(`[${task.serverName}] 自动备份跳过：${result.message}`);
            }
          })
          .catch(error => {
            logger.warn(`[${task.serverName}] 自动备份失败：${error.message}`);
          })
          .finally(() => {
            this.running.delete(task.id);
          });
      }
    }
  }

  /**
   * 解析备份任务对应的实例：优先按 instanceUuid 精确匹配，
   * 实例被重建/重命名时回退到名称精确匹配
   */
  public resolveInstance(task: McBackup): {
    remote: ServiceRemoteItemCustom;
    instance: MCSManagerInstance;
  } | null {
    for (const remote of this.panel.remotes) {
      for (const instance of remote.instances) {
        if (
          task.instanceUuid &&
          instance.cfg.instanceUuid === task.instanceUuid
        ) {
          return { remote, instance };
        }
      }
    }

    for (const remote of this.panel.remotes) {
      for (const instance of remote.instances) {
        if (instance.cfg.config.nickname === task.serverName) {
          return { remote, instance };
        }
      }
    }

    return null;
  }

  /**
   * 执行一次备份
   * @param manual 手动「立刻」备份时为 true，失败信息用于回复用户
   */
  public async runBackup(task: McBackup): Promise<MCBackupRunResult> {
    const found = this.resolveInstance(task);
    if (!found) {
      return { ok: false, message: `未找到服务器「${task.serverName}」` };
    }

    const { remote, instance } = found;

    // 仅能备份正在运行的服务器
    if (instance.cfg.status !== RemoteInstanceStatusEnum.RUNNING) {
      return {
        ok: false,
        message: `服务器「${task.serverName}」当前状态为 ${
          RemoteInstanceStatusName[instance.cfg.status] ?? instance.cfg.status
        }，仅能备份运行中的服务器`,
      };
    }

    const api = this.panel.api;
    const daemonId = remote.uuid;
    const instanceId = instance.cfg.instanceUuid;
    const targetPath = task.targetPath;
    const baseName = posix.basename(targetPath.replace(/\/+$/, '')) || 'world';
    // MCSManager 的 files/list 对无前导斜杠的相对路径解析不一致（moveFiles 能工作但 listFiles 返回空），
    // 统一使用 / 前缀，守护进程将其视为相对实例 cwd 的绝对路径
    const backupDir = posix.join('/', posix.dirname(targetPath), 'backup');

    // 检查 backup 目录是否存在，不存在则创建；创建失败但目录已存在时继续备份
    let files: Awaited<ReturnType<typeof api.listFiles>> = [];
    try {
      files = await api.listFiles(daemonId, instanceId, backupDir);
    } catch (error) {
      files = [];
    }

    try {
      const mkdirResult = await api.mkdirFile(daemonId, instanceId, backupDir);
      // 部分面板版本对已存在的目录返回 EEXIST 错误，此时目录可用，视为创建成功；
      // 其余失败仅在目录不存在（无法列出文件）时阻断备份
      const alreadyExists =
        !!mkdirResult.error && /EEXIST|already exists/i.test(mkdirResult.error);

      if (!mkdirResult.ok && !alreadyExists && files.length === 0) {
        return {
          ok: false,
          message: `创建备份目录 ${backupDir} 失败：${mkdirResult.error ?? '未知错误'}`,
        };
      }
    } catch (error) {
      if (files.length === 0) {
        return {
          ok: false,
          message: `创建备份目录 ${backupDir} 失败：${error.message}`,
        };
      }
    }

    // 守护进程压缩时以「输出 zip 所在目录」为工作目录、文件列表仅取文件名，
    // 因此必须先在源目录生成 zip，再移动到 backup 目录（直接输出到 backup 会报压缩程序异常）
    const zipName = `${baseName}_${MCBackupService.formatTimestamp(new Date())}.zip`;
    const zipPath = posix.join(backupDir, zipName);
    const sourceDir = posix.dirname(targetPath.replace(/\/+$/, '')) || '.';
    const tempZipPath = posix.join(sourceDir, zipName);

    try {
      const compressResult = await api.compressFile(
        daemonId,
        instanceId,
        tempZipPath,
        [targetPath],
      );
      if (!compressResult.ok) {
        return {
          ok: false,
          message: `压缩失败：${compressResult.error ?? '未知错误'}`,
        };
      }
    } catch (error) {
      // HTTP 超时等异常时面板可能仍在压缩，轮询等待 zip 生成完成（最多 10 分钟）
      const ready = await MCBackupService.waitForFile(
        api,
        daemonId,
        instanceId,
        sourceDir,
        zipName,
        600,
      );
      if (!ready) {
        return { ok: false, message: `压缩失败：${error.message}` };
      }
    }

    // 将 zip 从源目录移动到 backup 目录；失败时清理临时压缩包避免残留占磁盘
    try {
      const moveResult = await api.moveFiles(daemonId, instanceId, [
        [tempZipPath, zipPath],
      ]);

      if (!moveResult.ok) {
        await api
          .deleteFiles(daemonId, instanceId, [tempZipPath])
          .catch(() => undefined);
        return {
          ok: false,
          message: `备份文件移动到 ${backupDir} 失败：${moveResult.error ?? '未知错误'}`,
        };
      }
    } catch (error) {
      await api
        .deleteFiles(daemonId, instanceId, [tempZipPath])
        .catch(() => undefined);
      return {
        ok: false,
        message: `备份文件移动到 ${backupDir} 失败：${error.message}`,
      };
    }

    // 获取备份文件大小用于回复展示（获取失败不影响备份结果）
    let zipSizeText = '';
    let backupFiles: Awaited<ReturnType<typeof api.listFiles>> = [];
    try {
      backupFiles = await api.listFiles(daemonId, instanceId, backupDir);
      const zipFile = backupFiles.find(item => item.name === zipName);
      if (zipFile) {
        zipSizeText = `（${MCBackupService.formatFileSize(Number(zipFile.size))}）`;
      }
    } catch (error) {
      // 大小获取失败不阻断，仅不展示大小
    }

    // 新备份入库后按最新目录列表清理超出最大数量的最旧备份（清理失败不影响本次备份结果）
    let cleanupNote = '';
    try {
      // 尝试获取最新文件列表，失败时依次回退到移动后列表、初始列表
      let cleanupFiles = backupFiles;
      try {
        const latestFiles = await api.listFiles(
          daemonId,
          instanceId,
          backupDir,
        );
        if (latestFiles.length > 0) {
          cleanupFiles = latestFiles;
        }
      } catch (error) {
        logger.debug(
          `[${task.serverName}] 清理前重新获取列表失败，使用回退列表：${error.message}`,
        );
      }

      // 移动后列表也为空时，回退到初始列表（mkdir 前的目录快照）+ 新备份
      if (cleanupFiles.length === 0 && files.length > 0) {
        cleanupFiles = files;
      }

      const backups = cleanupFiles
        .filter(item => item.name.endsWith('.zip'))
        .sort(
          (a, b) =>
            MCBackupService.backupSortKey(a) -
            MCBackupService.backupSortKey(b) ||
            a.name.localeCompare(b.name),
        );

      // listFiles 可能因文件系统同步延迟遗漏刚移动的新备份，手动补入确保计入清理计数
      if (zipName && !backups.some(item => item.name === zipName)) {
        backups.push({
          name: zipName,
          type: 1,
          size: 0,
          time: Date.now(),
        });
        backups.sort(
          (a, b) =>
            MCBackupService.backupSortKey(a) -
            MCBackupService.backupSortKey(b) ||
            a.name.localeCompare(b.name),
        );
      }

      logger.info(
        `[${task.serverName}] 备份目录 ${backupDir}：共 ${backups.length} 个 zip，最大保留 ${task.maxCount} 份`,
      );

      let failed = 0;
      while (backups.length > task.maxCount) {
        const oldest = backups.shift()!;
        try {
          const deleteResult = await api.deleteFiles(daemonId, instanceId, [
            // basename 防止 listFiles 返回的 name 含目录前缀时路径拼接错误
            posix.join(backupDir, posix.basename(oldest.name)),
          ]);
          if (!deleteResult.ok) {
            failed++;
            logger.warn(
              `[${task.serverName}] 清理旧备份 ${oldest.name} 失败：${deleteResult.error ?? '未知错误'}`,
            );
            // 路径/权限问题，继续删下一个也会失败，退出避免空转
            break;
          }
        } catch (error) {
          failed++;
          logger.warn(
            `[${task.serverName}] 清理旧备份 ${oldest.name} 失败：${error.message}`,
          );
          break;
        }
      }

      if (failed > 0) {
        cleanupNote = `（${failed} 个旧备份清理失败，请检查 ${backupDir}）`;
      }
    } catch (error) {
      logger.warn(`[${task.serverName}] 清理旧备份失败：${error.message}`);
    }

    await this.ctx.database.set(
      'mcBackup',
      { id: task.id },
      { lastBackupTime: new Date() },
    );

    return {
      ok: true,
      message: `备份完成 -> ${zipPath}${zipSizeText}${cleanupNote}`,
    };
  }

  // 备份文件排序键：优先用文件名内的时间戳（world_2026-08-27_12-30-05.zip 字典序即时间序），
  // 其次用面板返回的 time 字段，保证时间最旧的排在最前
  private static backupSortKey(item: { name: string; time: number | string }) {
    const nameMatch = item.name.match(
      /(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/,
    );
    if (nameMatch) {
      // 2026-08-27_12-30-05 -> 2026-08-27T12:30:05
      const [datePart, timePart] = nameMatch[1].split('_');
      const parsed = Date.parse(`${datePart}T${timePart.replace(/-/g, ':')}`);
      if (!isNaN(parsed)) {
        return parsed;
      }
    }

    const time = Number(item.time);
    if (Number.isFinite(time) && time > 0) {
      return time;
    }

    return Number.MAX_SAFE_INTEGER;
  }

  // 轮询等待目录内指定文件出现且连续两次大小一致（视为生成完成）
  private static async waitForFile(
    api: MCSManagerAPI,
    daemonId: string,
    instanceId: string,
    dir: string,
    fileName: string,
    timeoutSec: number,
  ): Promise<boolean> {
    let lastSize = -1;

    for (let i = 0; i < timeoutSec; i++) {
      try {
        const current = await api.listFiles(daemonId, instanceId, dir);
        const found = current.find(item => item.name === fileName);
        const size = found ? Number(found.size) : -1;

        if (size > 0 && size === lastSize) {
          return true;
        }

        lastSize = size;
      } catch (error) {
        // 列表查询失败不阻断，继续等待下一轮
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return false;
  }

  // 字节数转为可读大小，如 1536 -> 1.5KB
  static formatFileSize(size: number) {
    if (!Number.isFinite(size) || size < 0) return '未知大小';
    if (size < 1024) return `${size}B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
    if (size < 1024 * 1024 * 1024) {
      return `${(size / 1024 / 1024).toFixed(1)}MB`;
    }
    return `${(size / 1024 / 1024 / 1024).toFixed(2)}GB`;
  }

  static formatTimestamp(date: Date) {
    const pad = (value: number) => String(value).padStart(2, '0');
    return [
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`,
    ].join('_');
  }

  // 秒数转为可读间隔，如 3600 -> 1小时
  static formatInterval(intervalSec: number) {
    if (intervalSec % 86400 === 0) return `${intervalSec / 86400}天`;
    if (intervalSec % 3600 === 0) return `${intervalSec / 3600}小时`;
    if (intervalSec % 60 === 0) return `${intervalSec / 60}分钟`;
    return `${intervalSec}秒`;
  }
}
