/**
 * 极简 markdown 渲染器（无第三方依赖）。
 * 先整体转义 HTML，再按块级/行内规则转换，因此不存在 HTML 注入风险。
 * 支持：标题、代码块、表格、有序/无序/任务列表、引用、分隔线、粗体、行内代码、链接。
 */

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 行内规则（输入已转义） */
function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
}

export function renderMarkdown(source: string): string {
  const lines = escapeHtml(String(source ?? '')).split(/\r?\n/)
  const out: string[] = []
  let inCode = false
  let listType: 'ul' | 'ol' | null = null
  let inTable = false
  let paragraph: string[] = []

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`)
      listType = null
    }
  }
  const closeTable = () => {
    if (inTable) {
      out.push('</tbody></table>')
      inTable = false
    }
  }
  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`)
      paragraph = []
    }
  }
  const closeAll = () => {
    flushParagraph()
    closeList()
    closeTable()
  }

  const renderTableRow = (line: string) => {
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())
    return cells
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]

    if (/^\s*```/.test(line)) {
      if (inCode) {
        out.push('</code></pre>')
        inCode = false
      } else {
        closeAll()
        out.push('<pre class="md-code"><code>')
        inCode = true
      }
      continue
    }
    if (inCode) {
      out.push(line)
      continue
    }

    // 表格：连续的 | 行，第二行为分隔行
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const next = lines[index + 1] ?? ''
      if (!inTable && /^\s*\|[\s:|-]+\|\s*$/.test(next)) {
        closeAll()
        const headers = renderTableRow(line)
        out.push('<table class="md-table"><thead><tr>')
        for (const header of headers) out.push(`<th>${inline(header)}</th>`)
        out.push('</tr></thead><tbody>')
        inTable = true
        index += 1 // 跳过分隔行
        continue
      }
      if (inTable) {
        const cells = renderTableRow(line)
        out.push('<tr>')
        for (const cell of cells) out.push(`<td>${inline(cell)}</td>`)
        out.push('</tr>')
        continue
      }
    } else {
      closeTable()
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeAll()
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }

    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      closeAll()
      out.push('<hr />')
      continue
    }

    const task = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line)
    if (task) {
      flushParagraph()
      if (listType !== 'ul') {
        closeList()
        out.push('<ul class="md-tasks">')
        listType = 'ul'
      }
      const checked = task[1].toLowerCase() === 'x'
      out.push(
        `<li class="md-task${checked ? ' is-done' : ''}"><span class="md-check">${checked ? '✔' : '○'}</span>${inline(task[2])}</li>`,
      )
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph()
      if (listType !== 'ul') {
        closeList()
        out.push('<ul>')
        listType = 'ul'
      }
      out.push(`<li>${inline(bullet[1])}</li>`)
      continue
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      flushParagraph()
      if (listType !== 'ol') {
        closeList()
        out.push('<ol>')
        listType = 'ol'
      }
      out.push(`<li>${inline(ordered[1])}</li>`)
      continue
    }

    const quote = /^\s*&gt;\s?(.*)$/.exec(line)
    if (quote) {
      closeAll()
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`)
      continue
    }

    if (!line.trim()) {
      closeAll()
      continue
    }

    closeList()
    paragraph.push(line.trim())
  }

  if (inCode) out.push('</code></pre>')
  closeAll()
  return out.join('\n')
}
