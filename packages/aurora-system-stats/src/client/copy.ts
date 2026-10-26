/**
 * Panel copy, in the two locales the web GUI ships.
 *
 * The orb carries its own dictionary rather than registering a locale
 * namespace: it is a single small surface, and reading the active language
 * from the document keeps the component free of client-only services.
 * @module aurora-system-stats/client/copy
 */

export interface Copy {
  readonly title: string
  readonly cpu: string
  readonly memory: string
  readonly load: string
  readonly load1: string
  readonly load5: string
  readonly load15: string
  readonly disk: string
  readonly cores: string
  readonly swap: string
  readonly uptime: string
  readonly offline: string
  readonly waiting: string
  readonly expand: string
  readonly collapse: string
  readonly reset: string
  readonly busy: string
  readonly usedOf: (used: string, total: string) => string
}

const zh: Copy = {
  title: '系统资源',
  cpu: 'CPU',
  memory: '内存',
  load: '负载',
  load1: '1 分钟',
  load5: '5 分钟',
  load15: '15 分钟',
  disk: '磁盘',
  cores: '核心',
  swap: '交换',
  uptime: '运行',
  offline: '连接中断，显示最后一次数据',
  waiting: '正在读取系统指标…',
  expand: '悬停查看系统资源面板',
  collapse: '收起系统资源面板',
  reset: '回到默认位置',
  busy: '负载高于核心数',
  usedOf: (used, total) => `${used} / ${total}`,
}

const en: Copy = {
  title: 'System resources',
  cpu: 'CPU',
  memory: 'Memory',
  load: 'Load',
  load1: '1 min',
  load5: '5 min',
  load15: '15 min',
  disk: 'Disk',
  cores: 'cores',
  swap: 'Swap',
  uptime: 'Uptime',
  offline: 'Disconnected — showing the last sample',
  waiting: 'Reading system metrics…',
  expand: 'Hover to open the system resources panel',
  collapse: 'Close the system resources panel',
  reset: 'Reset position',
  busy: 'Load above core count',
  usedOf: (used, total) => `${used} / ${total}`,
}

/** The copy for the document's active language. */
export function copyFor(language: string | undefined): Copy {
  return (language ?? '').toLowerCase().startsWith('zh') ? zh : en
}

/** Read the GUI's active language without depending on the locale service. */
export function activeLanguage(): string {
  if (typeof document === 'undefined') return 'en'
  return document.documentElement.lang || navigator.language || 'en'
}
