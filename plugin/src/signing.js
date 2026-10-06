/**
 * 请求签名：HMAC-SHA256。
 *
 * 签名串为 ``<timestamp>.<rawBody>`` 的**字节**拼接 —— 与后端
 * server/app.py 的 _verify_signature 保持完全一致，避免编码歧义。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export function signBody(secret, timestamp, rawBody) {
  return createHmac('sha256', Buffer.from(String(secret), 'utf8'))
    .update(Buffer.from(String(timestamp), 'utf8'))
    .update(Buffer.from('.', 'utf8'))
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8'))
    .digest('hex')
}

/** 服务端校验用的等价实现，供本地自测复用 */
export function verifyBody(secret, timestamp, rawBody, signature) {
  const expected = signBody(secret, timestamp, rawBody)
  const provided = String(signature || '').replace(/^sha256=/, '')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}
