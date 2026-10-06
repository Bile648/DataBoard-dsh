/**
 * 传输层：一次 POST 尝试 + 响应语义分类。
 *
 * 响应语义见 docs/progress-sync-design.md 4.3：
 *   2xx / 409            → 成功（409 为幂等重投，视同成功）
 *   400/401/403/413/422  → 永久失败，不重试
 *   408/425/429/5xx/网络 → 暂时失败，可重试
 */

import { signBody } from './signing.js'
import { endpointFor, PLUGIN_VERSION } from './config.js'

export const RESULT = {
  OK: 'ok',
  DUPLICATE: 'duplicate',
  PERMANENT: 'permanent',
  RETRYABLE: 'retryable',
}

const PERMANENT_STATUS = new Set([400, 401, 403, 404, 413, 415, 422])

/** 判断一次响应是否值得重试 */
export function classifyStatus(status) {
  if (status >= 200 && status < 300) return RESULT.OK
  if (status === 409) return RESULT.DUPLICATE
  if (PERMANENT_STATUS.has(status)) return RESULT.PERMANENT
  return RESULT.RETRYABLE
}

export function buildHeaders(envelope, { timestamp, token }) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-DSH-Schema': String(envelope.schemaVersion ?? 1),
    'X-DSH-Delivery': String(envelope.deliveryId ?? ''),
    'X-DSH-Timestamp': String(timestamp),
    'User-Agent': `dsh-progress/${PLUGIN_VERSION}`,
  }
  if (envelope.session?.id) headers['X-DSH-Session'] = String(envelope.session.id)
  // 摄入令牌是主要凭据；HMAC 签名为可选的第二层（兼容旧部署）
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

/**
 * 投递一条里程碑（单次尝试，不重试）。
 * @returns {Promise<{result: string, status?: number, reason?: string, body?: any}>}
 */
export async function postMilestone(envelope, options = {}) {
  const {
    endpoint,
    secret = '',
    token = '',
    timeoutMs = 8000,
    fetchImpl = globalThis.fetch,
    path = '/dsh/progress/v1/milestones',
  } = options

  const url = endpointFor({ endpoint }, path)
  const timestamp = Date.now()
  // 签名必须针对最终发送的字节，所以先在本地序列化一次并复用
  const rawBody = JSON.stringify(envelope)
  const headers = buildHeaders(envelope, { timestamp, token })
  if (secret) headers['X-DSH-Signature'] = `sha256=${signBody(secret, timestamp, rawBody)}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: rawBody,
      signal: controller.signal,
    })
    const result = classifyStatus(response.status)
    let body
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    return { result, status: response.status, body, url, retryAfter: response.headers?.get?.('retry-after') }
  } catch (error) {
    return {
      result: RESULT.RETRYABLE,
      reason: error?.name === 'AbortError' ? `请求超时(${timeoutMs}ms)` : String(error?.message || error),
      url,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 指数退避 + 抖动 */
export function computeBackoff(attempt, { baseMs = 1000, maxMs = 60000, jitter = 0.2 } = {}) {
  const raw = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs)
  const delta = raw * jitter
  return Math.round(raw - delta + Math.random() * delta * 2)
}

/** 健康检查（配置页「测试连接」用） */
export async function checkHealth(options = {}) {
  const { endpoint, timeoutMs = 5000, fetchImpl = globalThis.fetch } = options
  const url = endpointFor({ endpoint }, '/dsh/progress/v1/health')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { method: 'GET', signal: controller.signal })
    const body = await response.json().catch(() => undefined)
    return { ok: response.ok, status: response.status, body, url }
  } catch (error) {
    return { ok: false, status: 0, reason: String(error?.message || error), url }
  } finally {
    clearTimeout(timer)
  }
}
