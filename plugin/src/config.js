/**
 * 插件配置：默认值 + 深度合并。
 *
 * 对应 docs/progress-sync-design.md 第 7 节。
 * 生产环境应通过 DSH 的 settings / credentials 服务注入，这里保留同名结构以便直接对接。
 */

export const PLUGIN_NAME = 'dsh-progress-sync'
export const PLUGIN_VERSION = '0.1.0'

export const DEFAULTS = {
  enabled: true,

  /** 外部配套服务基地址；插件会拼接 /dsh/progress/v1/milestones */
  endpoint: 'http://127.0.0.1:8787',

  /** 密钥：生产走 credentials 服务（secretRef），联调可直接给 secret */
  secretRef: 'progress-webhook',
  secret: '',

  /** 各里程碑开关（只报大节点，turn/session 默认关） */
  milestones: {
    goal: true,
    deliverable: true,
    plan: true,
    blocked: true,
    phase: true,
    report: true,
    turn: false,
    session: false,
  },

  report: {
    inline: true,
    maxBytes: 262144,
    sources: ['present', 'assistant-message', 'synthesized'],
    includeCwd: false,
  },

  /** 合并窗口：普通节点在此窗口内聚合成一条 */
  coalesceWindowMs: 3000,
  /** 同 (sessionId, sequenceKey) 相同状态的去重窗口 */
  dedupeWindowMs: 30000,

  timeoutMs: 8000,

  retry: {
    attempts: 5,
    baseMs: 1000,
    maxMs: 60000,
    jitter: 0.2,
  },

  outbox: {
    maxEntries: 500,
    maxBytes: 4194304,
    /** 非空则落盘（对应设计的 outbox 持久化；DSH 内可换成 storageDomain） */
    persistPath: '',
  },

  /** 生成回跳链接用；DSH Web GUI 默认地址 */
  previewUrl: 'http://127.0.0.1:19387',
}

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 深度合并（数组整体替换，便于用配置覆盖 sources 列表） */
export function mergeConfig(base, patch) {
  if (!isPlainObject(patch)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeConfig(base[key], value) : value
  }
  return out
}

export function resolveConfig(input = {}) {
  const merged = mergeConfig(DEFAULTS, input)
  // 环境变量兜底，方便在没有 DSH 的情况下联调
  if (!input.endpoint && process.env.DSH_PROGRESS_ENDPOINT) {
    merged.endpoint = process.env.DSH_PROGRESS_ENDPOINT
  }
  if (!input.secret && process.env.DSH_PROGRESS_SECRET) {
    merged.secret = process.env.DSH_PROGRESS_SECRET
  }
  return merged
}

/** 拼接端点路径，容忍基地址末尾的斜杠与子路径前缀 */
export function endpointFor(config, path = '/dsh/progress/v1/milestones') {
  const base = String(config.endpoint || '').replace(/\/+$/, '')
  return `${base}${path}`
}
