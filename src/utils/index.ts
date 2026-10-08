export * from './game.mc';

/**
 * 引号感知的分词：按空白拆分，但引号（半角/全角）内的内容作为整体保留并去掉引号。
 * 用于支持包含空格的参数，如 "服务器名称 带空格"
 */
export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  const reg = /"([^"]*)"|“([^”]*)”|'([^']*)'|(\S+)/g;
  let matched: RegExpExecArray | null;

  while ((matched = reg.exec(input))) {
    const token = matched[1] ?? matched[2] ?? matched[3] ?? matched[4];
    if (token !== undefined && token.length > 0) {
      tokens.push(token);
    }
  }

  return tokens;
}

/**
 * 格式化时间差为易读格式
 * @param milliseconds 时间差（毫秒）
 * @returns 格式化后的时间字符串
 */
export function formatDuration(milliseconds: number): string {
  if (milliseconds <= 0) {
    return '0分';
  }

  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (years > 0) {
    const remainingMonths = Math.floor((days % 365) / 30);
    return remainingMonths > 0
      ? `${years}年${remainingMonths}月`
      : `${years}年`;
  }

  if (months > 0) {
    const remainingDays = days % 30;
    return remainingDays > 0 ? `${months}月${remainingDays}天` : `${months}月`;
  }

  if (days > 0) {
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}天${remainingHours}时` : `${days}天`;
  }

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0
      ? `${hours}时${remainingMinutes}分`
      : `${hours}时`;
  }

  if (minutes > 0) {
    return `${minutes}分`;
  }

  return `${seconds}秒`;
}

export function formatOnlineTime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${hours}小时${minutes}分钟${remainingSeconds}秒`;
  } else if (minutes > 0) {
    return `${minutes}分钟${remainingSeconds}秒`;
  } else {
    return `${remainingSeconds}秒`;
  }
}
