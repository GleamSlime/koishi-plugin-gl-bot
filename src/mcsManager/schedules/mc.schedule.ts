import { Context } from 'koishi';

export interface McUser {
  id: number;
  nickname: string;
  uuid: string;
  lastTime: Date;
  level: number;
  /// json
  onlineTimeJSON: string;
}

export interface McRemark {
  id: number;
  key: string;
  value: string;
}

export interface McBackup {
  id: number;
  // 服务器名称（实例昵称）
  serverName: string;
  // 实例 UUID（冗余存储，实例被重命名时可通过名称重新解析）
  instanceUuid: string;
  // 备份间隔（秒）
  intervalSec: number;
  // 备份最大保留数量
  maxCount: number;
  // 备份目标相对路径，如 ./world
  targetPath: string;
  // 是否启用定时备份（「关闭」仅停用不删除）
  enabled: boolean;
  // 上次备份时间，程序重启后依据此值继续计时
  lastBackupTime: Date;
}

export default (ctx: Context) => {
  ctx.model.extend(
    'mcUser',
    {
      id: { type: 'unsigned', length: 8 },
      nickname: 'string',
      uuid: 'string',
      lastTime: 'timestamp',
      level: 'integer',
      onlineTimeJSON: 'text',
    },
    {
      primary: 'id',
      autoInc: true,
    },
  );

  ctx.model.extend(
    'mcRemark',
    {
      id: { type: 'unsigned', length: 8 },
      key: { type: 'string', length: 128 },
      value: 'text',
    },
    {
      primary: 'id',
      autoInc: true,
    },
  );

  ctx.model.extend(
    'mcBackup',
    {
      id: { type: 'unsigned', length: 8 },
      serverName: 'string',
      instanceUuid: 'string',
      intervalSec: 'integer',
      maxCount: 'integer',
      targetPath: 'string',
      enabled: 'boolean',
      lastBackupTime: 'timestamp',
    },
    {
      primary: 'id',
      autoInc: true,
    },
  );
};
