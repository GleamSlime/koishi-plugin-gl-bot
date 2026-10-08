import { readFileSync } from 'fs';
import { HTTP } from 'koishi';
import {
  CreateInstanceConfig,
  CreateInstanceData,
  MCManagerPanelResponse,
  ServiceInstanceConnectAuth,
  ServiceRemoteInstanceItem,
  ServiceRemoteItem,
  UserInfo,
} from './type';

import { IS_DEV } from '../constants';
const createInstanceUpload = require('./json/createInstanceUpload.json');

export class MCSManagerAPI {
  userInfo: UserInfo;

  get requestHeaders() {
    return {
      cookie: this.authCookie,
      'x-requested-with': 'XMLHttpRequest',
    };
  }

  constructor(
    private http: HTTP,
    private baseUrl: string,
    private authCookie?: string,
  ) {}

  public send<T>(url: string | URL, config?: HTTP.RequestConfig) {
    return this.http<T>(url, config);
  }

  async login(username: string, password: string) {
    const result = await this.send(`${this.baseUrl}/auth/login`, {
      method: 'POST',
      data: {
        username,
        password,
      },
    });

    if (result.status === 200 && result.headers.get('set-cookie')) {
      const cookieString = result.headers.get('set-cookie');
      this.authCookie = extractCookiesWithRegex(cookieString);
      return true;
    }
    return false;
  }

  async getUserInfo() {
    const result = await this.send<MCManagerPanelResponse<UserInfo>>(
      `${this.baseUrl}/auth`,
      {
        headers: this.requestHeaders,
      },
    );

    if (result.status === 200) {
      this.userInfo = result.data.data;
      return this.userInfo;
    }

    return null;
  }

  async getServiceRemoteList() {
    try {
      return (
        (
          await this.send<MCManagerPanelResponse<ServiceRemoteItem[]>>(
            `${this.baseUrl}/service/remote_services_list`,
            {
              headers: this.requestHeaders,
              params: {
                token: this.userInfo.token,
              },
            },
          )
        ).data.data ?? []
      );
    } catch (error) {
      // 静默处理网络错误，避免在定时任务中抛出
      console.debug(
        'MCSManagerAPI.getServiceRemoteList failed:',
        error.message,
      );
      return [];
    }
  }

  async getServiceRemoteInstanceList(
    daemonId: string,
    options?: {
      status?: string;
      tag: string[];
      instance_name?: string;
      page?: number;
      page_size?: number;
    },
  ) {
    console.log({
      daemonId,
      options,
    });

    return (
      (
        await this.send<
          MCManagerPanelResponse<{
            data: ServiceRemoteInstanceItem[];
          }>
        >(`${this.baseUrl}/service/remote_service_instances`, {
          headers: this.requestHeaders,
          params: {
            daemonId,
            page: options?.page || 1,
            page_size: options?.page_size || 999,
            status: options?.status || '',
            instance_name: options?.instance_name || '',
            tag: JSON.stringify(options?.tag || []),
            token: this.userInfo.token,
          },
        })
      ).data?.data?.data ?? []
    );
  }

  async getServiceInstanceConnectAuth(
    remoteUUID: string,
    instanceId: string,
  ): Promise<ServiceInstanceConnectAuth | null> {
    return (
      (
        await this.send<MCManagerPanelResponse<ServiceInstanceConnectAuth>>(
          `${this.baseUrl}/protected_instance/stream_channel`,
          {
            method: 'POST',
            headers: this.requestHeaders,
            params: {
              remote_uuid: remoteUUID,
              uuid: instanceId,
              token: this.userInfo.token,
            },
          },
        )
      ).data.data ?? null
    );
  }

  async restartRemoteInstance(
    daemonId: string,
    instanceId: string,
  ): Promise<boolean> {
    return (
      (
        await this.send<
          MCManagerPanelResponse<{
            instanceUuid: string;
          }>
        >(`${this.baseUrl}/protected_instance/restart`, {
          headers: this.requestHeaders,
          params: {
            daemonId,
            uuid: instanceId,
            token: this.userInfo.token,
          },
        })
      ).data.data?.instanceUuid === instanceId
    );
  }

  async stopRemoteInstance(
    daemonId: string,
    instanceId: string,
  ): Promise<boolean> {
    return (
      (
        await this.send<
          MCManagerPanelResponse<{
            instanceUuid: string;
          }>
        >(`${this.baseUrl}/protected_instance/stop`, {
          headers: this.requestHeaders,
          params: {
            daemonId,
            uuid: instanceId,
            token: this.userInfo.token,
          },
        })
      ).data.data?.instanceUuid === instanceId
    );
  }

  async startRemoteInstance(
    daemonId: string,
    instanceId: string,
  ): Promise<boolean> {
    return (
      (
        await this.send<
          MCManagerPanelResponse<{
            instanceUuid: string;
          }>
        >(`${this.baseUrl}/protected_instance/open`, {
          headers: this.requestHeaders,
          params: {
            daemonId,
            uuid: instanceId,
            token: this.userInfo.token,
          },
        })
      ).data.data?.instanceUuid === instanceId
    );
  }

  // 创建实例
  async createInstance(daemonId: string, data: CreateInstanceData) {
    const mergeConfig = Object.assign({}, data, {
      nickname: '',
      startCommand: '',
      stopCommand: 'stop',
      cwd: '.',
      ie: 'utf-8',
      oe: 'utf-8',
      processType: 'general',
      lastDatetime: '',
      type: 'minecraft/java',
      tag: [],
      maxSpace: null,
      endTime: '',
      docker: {
        containerName: '',
        image: '',
        ports: [],
        extraVolumes: [],
        networkMode: 'bridge',
        networkAliases: [],
        cpusetCpus: '',
        workingDir: '/data',
        changeWorkdir: false,
        env: [],
      },
    });

    const result = await this.send<
      MCManagerPanelResponse<ServiceRemoteInstanceItem>
    >(`${this.baseUrl}/instance`, {
      method: 'POST',
      headers: this.requestHeaders,
      params: {
        daemonId,
        token: this.userInfo.token,
      },
      data: mergeConfig,
    });

    if (result.status === 200) {
      return true;
    }

    return;
  }

  async instanceUploadByZip(
    daemonId: string,
    wsUrl: string,
    config: Partial<CreateInstanceConfig>,
    file: {
      filename: string;
      size: number;
      path: string;
    },
    onProcessHandle?: (value: string) => void,
  ) {
    const mergeConfig = Object.assign({}, createInstanceUpload, config);
    const uploadDir = '.';

    const { status, data } = await this.send<
      MCManagerPanelResponse<{
        addr: string;
        instanceUuid: string;
        password: string;
        remoteMappings: string[];
      }>
    >(`${this.baseUrl}/instance/upload`, {
      method: 'POST',
      headers: this.requestHeaders,
      params: {
        upload_dir: uploadDir,
        daemonId,
        token: this.userInfo.token,
      },
      data: mergeConfig,
    });

    if (status !== 200 && !data.data.instanceUuid) {
      throw new Error('创建实例上传任务失败');
    }

    const newFile = await this.send<MCManagerPanelResponse<{ id: string }>>(
      `${wsUrl}/upload-new/${data.data.password}`,
      {
        headers: this.requestHeaders,
        method: 'POST',
        params: {
          filename: file.filename,
          size: file.size,
          sum: '',
          overwrite: false,
          unzip: true,
          code: 'gbk',
          token: this.userInfo.token,
        },
      },
    );

    if (newFile.status !== 200 || !newFile.data.data.id) {
      throw new Error('上传文件失败');
    }

    // 分片上传文件
    const fileBuffer = readFileSync(file.path);
    const chunkSize = 2 * 1024 * 1024; // 2MB 每个分片
    const totalSize = fileBuffer.length;
    let offset = 0;

    onProcessHandle?.(`正在解压文件...`);
    while (offset < totalSize) {
      const end = Math.min(offset + chunkSize, totalSize);
      const chunk = fileBuffer.slice(offset, end);
      const chunkBlob = new Blob([chunk], {
        type: 'application/octet-stream',
      });

      const formData = new FormData();
      formData.append('file', chunkBlob, file.filename);

      if (IS_DEV) {
        console.log(
          `上传分片: offset=${offset}, size=${chunk.length}, progress=${((end / totalSize) * 100).toFixed(1)}%`,
        );
      }
      const response = await this.send(
        `${wsUrl}/upload-piece/${newFile.data.data.id}`,
        {
          method: 'POST',
          params: {
            offset,
            token: this.userInfo.token,
          },
          data: formData,
        },
      );

      if (response.status !== 200) {
        throw new Error(`分片上传失败，offset: ${offset}`);
      }

      offset = end;
    }

    return data.data;
  }

  // 上传文件至实例
  async uploadFileToRemoteInstance(
    daemonId: string,
    filePath: string,
  ): Promise<boolean> {
    const fileBuffer = readFileSync(filePath);
    const fileBlob = new Blob([fileBuffer], {
      type: 'application/octet-stream',
    });
    const formData = new FormData();
    formData.append('file', fileBlob);

    const result = await this.send<MCManagerPanelResponse<null>>(
      `${this.baseUrl}/protected_instance/upload_file`,
      {
        method: 'POST',
        headers: {
          ...this.requestHeaders,
        },
        params: {
          daemonId,
          token: this.userInfo.token,
        },
        data: formData,
      },
    );

    return result.status === 200;
  }

  async readServerProperties(
    daemonId: string,
    instanceId: string,
  ): Promise<Record<string, never>> {
    return (
      await this.send<MCManagerPanelResponse<Record<string, never>>>(
        `${this.baseUrl}/protected_instance/process_config/file`,
        {
          headers: this.requestHeaders,
          params: {
            daemonId,
            uuid: instanceId,
            fileName: 'server.properties',
            type: 'properties',
            token: this.userInfo.token,
          },
        },
      )
    ).data.data;
  }

  async readFile(daemonId: string, instanceId: string, target: string) {
    return (
      await this.send<string>(`${this.baseUrl}/files`, {
        method: 'PUT',
        headers: this.requestHeaders,
        params: {
          daemonId,
          uuid: instanceId,
          token: this.userInfo.token,
        },
        data: {
          target,
        },
      })
    ).data;
  }

  /**
   * 安全读取实例内文件，文件不存在/读取失败时返回 null。
   * 面板响应为 JSON 字符串 {data: 文件内容}，其余情况原样返回。
   */
  async readFileSafe(
    daemonId: string,
    instanceId: string,
    target: string,
  ): Promise<string | null> {
    try {
      const raw = await this.readFile(daemonId, instanceId, target);

      if (typeof raw !== 'string' || raw.length === 0) {
        return null;
      }

      if (raw.startsWith('{')) {
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed?.data === 'string') {
            return parsed.data;
          }
        } catch (err) {
          // 非 JSON 时原样返回
        }
      }

      return raw;
    } catch (err) {
      return null;
    }
  }

  // 列出实例内指定目录的文件。
  // 注意：守护进程分页从 0 开始（sliceStart = page * pageSize），
  // 且面板会将非数字的 page 转为 0，因此首页必须传 page=0
  async listFiles(
    daemonId: string,
    instanceId: string,
    target: string,
    page = 0,
    pageSize = 100,
  ): Promise<{
    name: string;
    type: number;
    size: number;
    time: number | string;
  }[]> {
    const result = await this.send<
      MCManagerPanelResponse<{
        page: number;
        pageSize: number;
        total: number;
        items: {
          name: string;
          type: number;
          size: number;
          time: number | string;
        }[];
      }> | {
        page: number;
        pageSize: number;
        total: number;
        items: {
          name: string;
          type: number;
          size: number;
          time: number | string;
        }[];
      }
    >(`${this.baseUrl}/files/list`, {
      method: 'GET',
      headers: this.requestHeaders,
      validateStatus: () => true,
      params: {
        daemonId,
        uuid: instanceId,
        target,
        page,
        page_size: pageSize,
        token: this.userInfo.token,
      },
    });

    if (result.status !== 200) {
      return [];
    }

    const data = result.data as any;

    return data?.items ?? data?.data?.items ?? [];
  }

  // 在实例内创建目录：不抛 HTTP 异常，返回面板真实状态与错误信息（目录已存在时视为成功）
  async mkdirFile(
    daemonId: string,
    instanceId: string,
    target: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const result = await this.send<MCManagerPanelResponse<unknown>>(
      `${this.baseUrl}/files/mkdir`,
      {
        method: 'POST',
        headers: this.requestHeaders,
        validateStatus: () => true,
        params: {
          daemonId,
          uuid: instanceId,
          token: this.userInfo.token,
        },
        data: {
          target,
        },
      },
    );

    if (result.status === 200) {
      return { ok: true };
    }

    return {
      ok: false,
      error: MCSManagerAPI.extractError(result) ?? `HTTP ${result.status}`,
    };
  }

  // 从面板响应中提取错误信息（异常时响应体结构不固定，逐个兼容）
  private static extractError(result: { data: unknown }): string | undefined {
    const data = result.data as unknown;

    if (typeof data === 'string' && data.length > 0 && data.length <= 500) {
      return data;
    }

    const body = data as {
      data?: unknown;
      message?: string;
      time?: string;
    };

    if (body && typeof body === 'object') {
      if (typeof body.data === 'string') return body.data;
      if (typeof body.message === 'string') return body.message;
      if (typeof body.time === 'string') return body.time;
    }

    return undefined;
  }

  /**
   * 压缩实例内文件（守护进程压缩完成后才返回，大存档可能耗时较久）
   * @param source 输出的压缩包路径，注意守护进程仅支持压缩包与源文件同目录
   * @param targets 需要压缩的文件/目录列表，如 ['./world']
   */
  async compressFile(
    daemonId: string,
    instanceId: string,
    source: string,
    targets: string[],
  ): Promise<{ ok: boolean; error?: string }> {
    const result = await this.send<MCManagerPanelResponse<unknown>>(
      `${this.baseUrl}/files/compress`,
      {
        method: 'POST',
        headers: this.requestHeaders,
        validateStatus: () => true,
        timeout: 10 * 60 * 1000,
        params: {
          daemonId,
          uuid: instanceId,
          token: this.userInfo.token,
        },
        data: {
          source,
          targets,
          type: 1,
          code: 'utf-8',
        },
      },
    );

    if (result.status === 200) {
      return { ok: true };
    }

    return {
      ok: false,
      error: MCSManagerAPI.extractError(result) ?? `HTTP ${result.status}`,
    };
  }

  // 删除实例内文件：不抛 HTTP 异常，返回面板真实状态与错误信息
  async deleteFiles(
    daemonId: string,
    instanceId: string,
    targets: string[],
  ): Promise<{ ok: boolean; error?: string }> {
    const result = await this.send<MCManagerPanelResponse<unknown>>(
      `${this.baseUrl}/files`,
      {
        method: 'DELETE',
        headers: this.requestHeaders,
        validateStatus: () => true,
        params: {
          daemonId,
          uuid: instanceId,
          token: this.userInfo.token,
        },
        data: {
          targets,
        },
      },
    );

    if (result.status === 200) {
      return { ok: true };
    }

    return {
      ok: false,
      error: MCSManagerAPI.extractError(result) ?? `HTTP ${result.status}`,
    };
  }

  // 移动/重命名实例内文件：不抛 HTTP 异常，返回面板真实状态与错误信息。
  // 面板接口格式：targets 为 [源路径, 目标路径] 元组数组，如 [['./a.zip', './backup/a.zip']]
  async moveFiles(
    daemonId: string,
    instanceId: string,
    moves: [string, string][],
  ): Promise<{ ok: boolean; error?: string }> {
    const result = await this.send<MCManagerPanelResponse<unknown>>(
      `${this.baseUrl}/files/move`,
      {
        method: 'PUT',
        headers: this.requestHeaders,
        validateStatus: () => true,
        params: {
          daemonId,
          uuid: instanceId,
          token: this.userInfo.token,
        },
        data: {
          targets: moves,
        },
      },
    );

    if (result.status === 200) {
      return { ok: true };
    }

    return {
      ok: false,
      error: MCSManagerAPI.extractError(result) ?? `HTTP ${result.status}`,
    };
  }
}

function extractCookiesWithRegex(cookieStr) {
  return cookieStr
    .match(/(\S+=\S+;)/g)
    .filter(v => v !== 'path=/;')
    .join(' ');
}
