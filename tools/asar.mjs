#!/usr/bin/env node
/**
 * asar 按需读取工具（DSH 源码在 app.asar 内，普通文件工具读不了）。
 *
 * 用法：
 *   node asar.mjs list <子串> [数量]      # 列出路径包含子串的文件
 *   node asar.mjs cat <内部路径>          # 打印单个文件
 *   node asar.mjs extract <前缀> <输出目录>  # 按前缀批量提取
 *   node asar.mjs grep <子串> <关键词> [上限] # 在匹配文件中搜索关键词
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const ASAR = process.env.ASAR_PATH ?? 'D:\\dsh\\resources\\app.asar'

/** asar 布局：u32 pickle大小@0 | u32 头pickle大小@4 | u32 对齐长度@8 | u32 JSON长度@12 | JSON@16 | 数据区 */
function loadArchive() {
  const buffer = readFileSync(ASAR)
  const headerStringSize = buffer.readUInt32LE(12)
  const header = JSON.parse(buffer.toString('utf8', 16, 16 + headerStringSize))
  if (!header?.files) throw new Error('asar 头解析异常：缺少 files 字段')
  const dataOffset = 16 + headerStringSize
  return { buffer, header, dataOffset }
}

/** 深度遍历，产出 [内部路径, 条目] */
function* walk(node, prefix = '') {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name
    if (entry.files) {
      yield* walk(entry, path)
    } else {
      yield [path, entry]
    }
  }
}

const { buffer, header, dataOffset } = loadArchive()
const all = [...walk(header)]
const readEntry = (entry) => buffer.subarray(dataOffset + Number(entry.offset), dataOffset + Number(entry.offset) + entry.size)

const [command, ...rest] = process.argv.slice(2)

if (command === 'list') {
  const [needle, limit = '60'] = rest
  const hits = all.filter(([path]) => path.includes(needle))
  console.log(`匹配 ${hits.length} 个文件（显示前 ${limit}）`)
  for (const [path, entry] of hits.slice(0, Number(limit))) {
    console.log(`${String(entry.size).padStart(9)}  ${path}`)
  }
} else if (command === 'cat') {
  const [target] = rest
  const found = all.find(([path]) => path === target) ?? all.find(([path]) => path.endsWith(target))
  if (!found) {
    console.error(`未找到: ${target}`)
    process.exit(1)
  }
  process.stdout.write(readEntry(found[1]).toString('utf8'))
} else if (command === 'extract') {
  const [prefix, outDir] = rest
  const hits = all.filter(([path]) => path.startsWith(prefix))
  for (const [path, entry] of hits) {
    const destination = join(outDir, relative(prefix, path))
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, readEntry(entry))
  }
  console.log(`提取 ${hits.length} 个文件 → ${outDir}`)
} else if (command === 'grep') {
  const [pathNeedle, keyword, limit = '40'] = rest
  const hits = all.filter(([path]) => path.includes(pathNeedle))
  let shown = 0
  for (const [path, entry] of hits) {
    if (entry.size > 3_000_000) continue
    const text = readEntry(entry).toString('utf8')
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      if (shown < Number(limit) && line.includes(keyword)) {
        console.log(`${path}:${index + 1}: ${line.trim().slice(0, 220)}`)
        shown += 1
      }
    })
  }
  console.log(`--- 共 ${shown} 处匹配 ---`)
} else {
  console.error('用法：list|cat|extract|grep')
  process.exit(1)
}
