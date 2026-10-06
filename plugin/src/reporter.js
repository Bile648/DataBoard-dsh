/**
 * 报告装配：为里程碑附上一份供开发者阅读的 markdown。
 *
 * 三级来源（设计 5.3，按优先级）：
 *   1. present 交付物的正文（从磁盘读）
 *   2. 助手收尾消息
 *   3. 插件自组装摘要（兜底，保证任何情况下都有可读正文）
 *
 * 大小控制：超 maxBytes 按 UTF-8 边界安全截断并置 truncated=true。
 */

import { createHash } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'

export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/** 路径相对化，避免泄漏用户名与目录结构 */
export function relativize(path, cwd) {
  const value = String(path ?? '')
  if (!value || !cwd) return value
  try {
    if (isAbsolute(value)) {
      const rel = relative(cwd, value)
      return rel && !rel.startsWith('..') ? rel.replace(/\\/g, '/') : value
    }
            return value.replace(/\\/g, '/')
  } catch {
    return value
  }
}

/** 按 UTF-8 边界安全截断 */
export function truncateUtf8(text, maxBytes) {
  const value = String(text ?? '')
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.length <= maxBytes) return { body: value, truncated: false, bytes: buffer.length }
  let end = maxBytes
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
  return {
    body: `${buffer.subarray(0, end).toString('utf8')}\n\n> ⚠️ 报告已截断（原始 ${buffer.length} 字节，上限 ${maxBytes} 字节）`,
    truncated: true,
    bytes: buffer.length,
  }
}

/** 兜底报告：由任务状态与变更概览拼装 */
export function synthesizeReport({ milestone, goal, todos, counts, changes } = {}) {
  const lines = [`# ${milestone?.title ?? '进度更新'}`, '']
  lines.push(`- 里程碑：\`${milestone?.kind ?? '-'}\` / \`${milestone?.status ?? '-'}\``)
  if (goal?.objective) lines.push(`- 目标：${goal.objective}`)
  if (goal?.phase) lines.push(`- 目标阶段：\`${goal.phase}\``)
  if (goal?.blockedReason?.message) lines.push(`- 阻塞原因：${goal.blockedReason.message}`)
  if (counts?.total) lines.push(`- 待办：${counts.completed}/${counts.total} 完成`)
  if (changes) {
    lines.push(`- 变更：${changes.files ?? 0} 个文件，+${changes.added ?? 0} / -${changes.deleted ?? 0}`)
  }

  if (Array.isArray(todos) && todos.length) {
    lines.push('', '## 待办明细', '')
    for (const todo of todos) {
      const box = todo.status === 'completed' ? 'x' : ' '
      lines.push(`- [${box}] ${todo.content}${todo.status === 'in_progress' ? ' _(进行中)_' : ''}`)
    }
  }

  if (Array.isArray(changes?.sample) && changes.sample.length) {
    lines.push('', '## 涉及文件', '')
    for (const file of changes.sample) lines.push(`- \`${file}\``)
  }

  return `${lines.join('\n')}\n`
}

/**
 * 装配报告。
 * @param {object} options
 * @param {string[]} options.sources           来源优先级
 * @param {Array} options.artifacts            交付物清单
 * @param {(path: string) => Promise<string>} [options.readFile]  读文件实现（由宿主注入）
 * @param {string|null} [options.assistantText] 助手收尾消息
 * @param {object} options.context             { milestone, goal, todos, counts, changes }
 * @param {number} options.maxBytes
 * @returns {Promise<object|null>} 报告对象，或 null（全部来源都不可用）
 */
export async function buildReport({
  sources = ['present', 'assistant-message', 'synthesized'],
  artifacts = [],
  readFile,
  assistantText = null,
  context = {},
  maxBytes = 262144,
} = {}) {
  for (const source of sources) {
    if (source === 'present') {
      const artifact = artifacts.find((a) => a.kind === 'markdown' || /\.md$/i.test(a.path ?? ''))
      if (artifact && typeof readFile === 'function') {
        try {
          const content = await readFile(artifact.path)
          if (content && String(content).trim()) {
            return finalize({ body: String(content), source: 'present', title: artifact.description ?? artifact.path }, maxBytes)
          }
        } catch {
          // 读不到就降级到下一来源
        }
      }
      continue
    }

    if (source === 'assistant-message') {
      if (assistantText && assistantText.trim()) {
        return finalize({ body: assistantText, source: 'assistant-message', title: context.milestone?.title }, maxBytes)
      }
      continue
    }

    if (source === 'synthesized') {
      return finalize(
        { body: synthesizeReport(context), source: 'synthesized', title: context.milestone?.title },
        maxBytes,
      )
    }
  }
  return null
}

function finalize({ body, source, title }, maxBytes) {
  const { body: finalBody, truncated, bytes } = truncateUtf8(body, maxBytes)
  return {
    format: 'markdown',
    title: title ?? null,
    body: finalBody,
    bytes,
    truncated,
    source,
    sha256: sha256Hex(finalBody),
  }
}
