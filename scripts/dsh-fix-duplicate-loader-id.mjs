#!/usr/bin/env node
/**
 * dsh-fix-duplicate-loader-id — 检测并修复 dsh profile 启动崩溃：
 * `duplicate loader entry id: <id>` / `plugin tree failed to load`。
 *
 * 原理（对应 vendor/include 的 applyEntryPatches 语义）：
 *   - `- insert:`（无 id 的顶层简写）或 `- id: <group>` + `insert:` 键：
 *     向 entry 列表 push 新 row（创建）。同一 id 被 push 两次 → loader 的
 *     EntryGroup.update 抛 `duplicate loader entry id`，中止整个启动。
 *   - 顶层 `- id: <id>`（无 insert）= id-targeted patch：按 id 修改已存在
 *     row；目标缺失只 warn（`patch: entry %C not found`）跳过，不报错。
 *
 * 因此修复路线：把「后出现」的重复 insert 子项转换为顶层 id-targeted
 * patch（去掉 name 行——id patch 带 name 且与目标不符会 warn 跳过；
 * 保留 config/disabled 与注释）。
 *
 * 用法：
 *   node dsh-fix-duplicate-loader-id.mjs [--profile <dir>] [--fix] [--dry-run] [--json]
 *
 * 默认扫描 ~/.dsh/profiles/*（每个含 dsh.profile.bundles 的 profile）。
 * 纯 Node，零第三方依赖；只读检测时绝不写盘。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { homedir } from 'node:os'

const HELP = `用法:
  node dsh-fix-duplicate-loader-id.mjs [options]

选项:
  --profile <dir>   只检查指定 profile 目录（默认扫描 ~/.dsh/profiles/*）
  --fix             自动修复：重复 insert 子项 → id-targeted patch（先备份 .dsh-fix.bak）
  --dry-run         与 --fix 同逻辑但只打印将执行的修改，不写盘
  --json            输出 JSON 报告
  -h, --help        显示帮助

退出码: 0 = 无冲突; 1 = 存在冲突（未修复时）; 2 = 用法/IO 错误
`

// ── 参数解析 ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const opts = { profile: null, fix: false, dryRun: false, json: false }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--profile') opts.profile = args[++i]
  else if (a === '--fix') opts.fix = true
  else if (a === '--dry-run') opts.dryRun = true
  else if (a === '--json') opts.json = true
  else if (a === '-h' || a === '--help') { process.stdout.write(HELP); process.exit(0) }
  else { process.stderr.write(`未知参数: ${a}\n\n${HELP}`); process.exit(2) }
}

// ── 行级 YAML 扫描解析（只识别 patch 需要的结构，不引入 yaml 依赖）──────────
/**
 * 解析一个 patch 文件的顶层 entries。
 * 返回 [{ type:'patch'|'insert'|'other', id?, line, endLine, insertRows?, hasInsertKey }]
 *   - type 'insert'：顶层简写 `- insert:`，insertRows 为其子项（可能为空）
 *   - type 'patch'：`- id: xxx` 顶层 entry；若带 `insert:` 键，insertRows 为子项
 *   - type 'other'：其他顶层 entry（忽略）
 * 子项: { id, line, endLine, commentStart, insertRows?, hasInsertKey }
 */
function parsePatch(text) {
  const lines = text.split('\n')
  const entries = []
  let i = 0

  const isComment = (l) => /^\s*#/.test(l)
  const isEmpty = (l) => l.trim() === ''
  const entryStart = (l, indent) => new RegExp(`^ {${indent}}-\\s`).test(l)
  const keyOf = (l) => {
    const m = l.match(/^(\s*)-?\s*([A-Za-z][\w-]*):/)
    return m ? m[2] : null
  }

  /** 从 line 开始解析一个 entry（列表项 `- key:`），返回 {endLine, insertRows} */
  function parseEntry(line, indent) {
    const key = keyOf(lines[line])
    const insertRows = []
    let j = line + 1
    let insertIndent = null // insert 键行的缩进
    let lastContent = -1 // 最后一个实质内容行（注释/空行不计入 endLine）
    while (j < lines.length) {
      const l = lines[j]
      if (isEmpty(l) || isComment(l)) { j++; continue }
      const m = l.match(/^(\s*)(\S)/)
      const ind = m ? m[1].length : 0
      if (ind <= indent) break // 回到上层（含下一个同级子项），不计入本 entry
      lastContent = j
      const k = keyOf(l)
      if (k === 'insert' && /:\s*$/.test(l.trim())) {
        insertIndent = ind
        // 子列表项：缩进 > insertIndent 的 `- ` 行
        let s = j + 1
        let childIndent = null
        while (s < lines.length) {
          const cl = lines[s]
          if (isEmpty(cl) || isComment(cl)) { s++; continue }
          const cm = cl.match(/^(\s*)(\S)/)
          const cind = cm ? cm[1].length : 0
          if (cind <= indent) break
          if (/^ {2,}-\s/.test(cl) && (childIndent === null ? cind > insertIndent : cind === childIndent)) {
            if (childIndent === null) childIndent = cind
            const child = parseEntry(s, childIndent)
            const idm = lines[s].match(/^ {2,}-\s+id:\s*(\S+)/)
            child.id = idm ? idm[1] : null
            child.commentStart = commentStart(s)
            child.line = s
            insertRows.push(child)
            s = child.endLine + 1
          } else {
            s++
          }
        }
        j = s
        break
      }
      j++
    }
    return { endLine: lastContent >= 0 ? lastContent : j - 1, insertRows, hasInsertKey: insertIndent !== null }
  }

  /** entry 上方紧邻的连续注释行起始（不含空行分隔） */
  function commentStart(line) {
    let s = line - 1
    while (s >= 0 && isComment(lines[s])) s--
    return s + 1
  }

  while (i < lines.length) {
    const l = lines[i]
    if (isEmpty(l) || isComment(l)) { i++; continue }
    if (entryStart(l, 0)) {
      const key = keyOf(l)
      if (key === 'insert') {
        // 顶层简写 `- insert:`：解析子列表（与 group insert 相同规则）
        const parsed = { type: 'insert', line: i, id: null }
        let j = i + 1
        let childIndent = null
        const insertRows = []
        while (j < lines.length) {
          const cl = lines[j]
          if (isEmpty(cl) || isComment(cl)) { j++; continue }
          const cm = cl.match(/^(\s*)(\S)/)
          const cind = cm ? cm[1].length : 0
          if (cind === 0) break
          if (/^ {2,}-\s/.test(cl) && (childIndent === null ? cind > 0 : cind === childIndent)) {
            if (childIndent === null) childIndent = cind
            const child = parseEntry(j, childIndent)
            const idm = cl.match(/^ {2,}-\s+id:\s*(\S+)/)
            child.id = idm ? idm[1] : null
            child.commentStart = commentStart(j)
            child.line = j
            insertRows.push(child)
            j = child.endLine + 1
          } else {
            j++
          }
        }
        parsed.insertRows = insertRows
        parsed.endLine = j - 1
        entries.push(parsed)
        i = j
      } else if (key === 'id') {
        const idm = l.match(/^-\s+id:\s*(\S+)/)
        const parsed = parseEntry(i, 0)
        parsed.type = 'patch'
        parsed.id = idm ? idm[1] : null
        parsed.line = i
        entries.push(parsed)
        i = parsed.endLine + 1
      } else {
        const parsed = parseEntry(i, 0)
        parsed.type = 'other'
        parsed.line = i
        entries.push(parsed)
        i = parsed.endLine + 1
      }
    } else {
      i++
    }
  }
  return entries
}

/** 深度收集 insert 子项（含嵌套 group 的 insert） */
function collectInsertRows(entries) {
  const rows = []
  const walk = (list) => {
    for (const e of list) {
      if (e.insertRows?.length) {
        for (const r of e.insertRows) {
          rows.push(r)
          if (r.insertRows?.length) walk(r.insertRows)
        }
      }
    }
  }
  walk(entries)
  return rows
}

/** 深度收集顶层 id patch（含嵌套 group 内子项） */
function collectTopIds(entries) {
  const ids = []
  const walk = (list) => {
    for (const e of list) {
      if (e.type === 'patch' && e.id) ids.push(e.id)
      if (e.insertRows?.length) walk(e.insertRows)
    }
  }
  walk(entries)
  return ids
}

// ── profile 扫描 ────────────────────────────────────────────────────────────
/** 返回 [{name, dir, bundles, patchFiles: [{label, path, text}]}] */
function scanProfiles() {
  const roots = opts.profile ? [resolve(opts.profile)] : defaultProfileRoots()
  const profiles = []
  for (const dir of roots) {
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) continue
    let pkg = null
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch { /* 忽略坏 package.json */ }
    if (!pkg?.dsh?.profile?.bundles) continue
    const bundles = pkg.dsh.profile.bundles
    const patchFiles = []
    for (const b of bundles) {
      const p = join(dir, 'node_modules', b, 'cordis.patch.yml')
      if (existsSync(p)) patchFiles.push({ label: `${b} (cordis.patch.yml)`, path: p })
    }
    const user = join(dir, 'cordis.patch.yml')
    if (existsSync(user)) patchFiles.push({ label: `${basename(dir)}/cordis.patch.yml (用户层)`, path: user })
    profiles.push({ name: basename(dir), dir, bundles, patchFiles })
  }
  return profiles
}

function defaultProfileRoots() {
  const root = join(homedir(), '.dsh', 'profiles')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .map((d) => join(root, d))
    .filter((p) => { try { return statSync(p).isDirectory() } catch { return false } })
}

// ── 检测 ─────────────────────────────────────────────────────────────
function detect(profiles) {
  const report = { profiles: [] }
  for (const prof of profiles) {
    const seen = new Map() // insert id → {file, line}
    const conflicts = []
    const fileInfos = []
    for (const pf of prof.patchFiles) {
      let text
      try { text = readFileSync(pf.path, 'utf8') } catch (e) {
        fileInfos.push({ label: pf.label, error: String(e) })
        continue
      }
      const entries = parsePatch(text)
      const inserted = collectInsertRows(entries)
      for (const row of inserted) {
        if (!row.id) continue
        if (seen.has(row.id)) {
          const first = seen.get(row.id)
          conflicts.push({
            id: row.id,
            file: pf.path,
            label: pf.label,
            line: row.line + 1,
            firstFile: first.file,
            firstLabel: first.label,
            firstLine: first.line,
            row,
          })
        } else {
          seen.set(row.id, { file: pf.path, label: pf.label, line: row.line + 1 })
        }
      }
      fileInfos.push({
        label: pf.label,
        path: pf.path,
        inserts: inserted.length,
        topIds: collectTopIds(entries).length,
      })
    }
    report.profiles.push({ name: prof.name, dir: prof.dir, bundles: prof.bundles.length, fileInfos, conflicts })
  }
  return report
}

// ── 修复 ───────────────────────────────────────────────────────────────
const FIX_HEADER = (id) => [
  `# [dsh-fix] ${id} 已由更早的 bundle 层插入；此处由 insert 转为 id-targeted patch：`,
  `# row 已存在（组合启动）→ 幂等 no-op；row 不存在（裸启动）→ 仅无害警告。`,
  `# 注意：重装/升级该插件（pnpm install/update、dsh plugin）会覆盖此文件，请保留本修改或推动上游。`,
]

/** 把 insert 子项文本转换为顶层 id-targeted patch 文本（去缩进、删 name 行）。 */
function toPatchText(row, lines) {
  const out = []
  for (let i = row.commentStart; i <= row.endLine; i++) {
    const l = lines[i]
    if (l.trim() === '') { out.push(''); continue }
    if (/^\s*#/.test(l)) { out.push(l.trimStart()); continue }
    // 删掉 name 行（id patch 带 name 且与目标不符会 warn 跳过）
    if (/^\s{4,}name:/.test(l)) continue
    // 去掉子项基准缩进（= 该 entry 行的缩进）
    const m = l.match(/^(\s*)(\S)/)
    const ind = m ? m[1].length : 0
    out.push(' '.repeat(Math.max(0, ind - row.indent)) + l.trimStart())
  }
  return out
}

function entryIndent(lines, line) {
  const m = lines[line].match(/^(\s*)/)
  return m ? m[1].length : 0
}

function applyFix(report, write) {
  const plan = [] // {file, label, id, line, patchText, removeInsertHead}
  for (const prof of report.profiles) {
    // 按文件分组
    const byFile = new Map()
    for (const c of prof.conflicts) {
      if (!byFile.has(c.file)) byFile.set(c.file, [])
      byFile.get(c.file).push(c)
    }
    for (const [file, conflicts] of byFile) {
      const text = readFileSync(file, 'utf8')
      const lines = text.split('\n')
      const entries = parsePatch(text)
      const topIds = new Set(collectTopIds(entries))
      // 行号从 1-based 转 0-based
      const cs = conflicts.map((c) => ({ ...c, line0: c.line - 1 }))
      // 自下而上处理（行号映射以原行号为基准，最后统一过滤）
      const remove = new Set() // 需要删除的原行号
      const appends = [] // 追加到文件尾的 patch 文本（含所属 id）
      for (const c of cs) {
        const row = c.row
        row.indent = entryIndent(lines, row.line) // row.line 为 0-based
        const block = toPatchText(row, lines)
        if (!topIds.has(c.id)) {
          appends.push({ id: c.id, lines: [...FIX_HEADER(c.id), ...block] })
        }
        for (let i = row.commentStart; i <= row.endLine; i++) remove.add(i)
      }
      // 移除「子项已被删空」的 insert 键行（- insert: / `  insert:`）
      const dropHead = new Set()
      for (const e of entries) {
        // 找键行：简写 insert 的 `- insert:` 行，或 patch entry 内容中的 `  insert:` 行
        let keyIdx = -1
        if (e.type === 'insert') keyIdx = e.line
        else if (e.type === 'patch' && e.hasInsertKey) {
          for (let k = e.line + 1; k <= e.endLine; k++) {
            if (/^ {2}insert:\s*$/.test(lines[k])) { keyIdx = k; break }
          }
        }
        if (keyIdx < 0 || remove.has(keyIdx)) continue
        // 键行之后到下一个同级 entry 前是否还有残留子项
        const keyInd = entryIndent(lines, keyIdx)
        let hasChild = false
        for (let k = keyIdx + 1; k < lines.length; k++) {
          const l = lines[k]
          if (l.trim() === '' || /^\s*#/.test(l)) continue
          const m = l.match(/^(\s*)(\S)/)
          const ind = m ? m[1].length : 0
          if (ind <= keyInd) break
          if (remove.has(k)) continue
          hasChild = true
          break
        }
        if (!hasChild) dropHead.add(keyIdx)
      }
      // 按原行号统一过滤（removedSet ∪ dropHead）
      const finalLines = []
      for (let idx = 0; idx < lines.length; idx++) {
        if (remove.has(idx) || dropHead.has(idx)) continue
        finalLines.push(lines[idx])
      }
      let result = finalLines.join('\n')
      for (const app of appends) {
        result = result.replace(/\s*$/, '\n') + '\n' + app.lines.join('\n') + '\n'
      }
      plan.push({ file, label: conflicts[0].label, ids: appends.map((a) => a.id), line: conflicts[0].line, patch: appends.map((a) => a.lines), changed: remove.size + dropHead.size > 0 })
      if (write) {
        const bak = file + '.dsh-fix.bak'
        if (!existsSync(bak)) copyFileSync(file, bak)
        writeFileSync(file, result)
      }
    }
  }
  return plan
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
function main() {
  const profiles = scanProfiles()
  if (!profiles.length) {
    process.stderr.write(`未找到任何含 dsh.profile.bundles 的 profile（默认扫 ~/.dsh/profiles/*）。\n可用 --profile <dir> 指定。\n`)
    process.exit(2)
  }
  const report = detect(profiles)
  const total = report.profiles.reduce((n, p) => n + p.conflicts.length, 0)

  if (opts.json) {
    const out = { profiles: report.profiles.map((p) => ({ name: p.name, dir: p.dir, conflicts: p.conflicts.map((c) => ({ id: c.id, file: c.file, line: c.line, firstFile: c.firstFile, firstLine: c.firstLine })) })), total }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  } else {
    for (const p of report.profiles) {
      process.stdout.write(`[${p.name}] ${p.dir}\n`)
      for (const f of p.fileInfos) {
        process.stdout.write(`  ${f.label}（insert ×${f.inserts}，id patch ×${f.topIds}${f.error ? `，读取失败: ${f.error}` : ''}）\n`)
      }
      if (!p.conflicts.length) {
        process.stdout.write(`  ✓ 无重复 insert id\n`)
      } else {
        process.stdout.write(`  ✗ ${p.conflicts.length} 处重复 insert id：\n`)
        for (const c of p.conflicts) {
          process.stdout.write(`    - ${c.id}：首次插入 ${c.firstLabel}:${c.firstLine} ← 重复插入 ${c.label}:${c.line}\n`)
        }
      }
    }
    process.stdout.write(total ? `\n共 ${total} 处冲突。\n` : `\n全部 profile 无冲突。\n`)
  }

  if (total === 0) process.exit(0)

  if (!opts.fix && !opts.dryRun) {
    process.stdout.write(`\n修复建议：node dsh-fix-duplicate-loader-id.mjs --profile <dir> --fix\n（--dry-run 可先预览修改）\n`)
    process.exit(1)
  }

  if (opts.fix || opts.dryRun) {
    const plan = applyFix(report, opts.fix)
    if (opts.json) {
      process.stdout.write(JSON.stringify({ fixed: plan.map((p) => ({ file: p.file, ids: p.ids, line: p.line })) }, null, 2) + '\n')
    } else {
      for (const p of plan) {
        process.stdout.write(`\n${opts.fix ? '已修复' : '[dry-run] 将修复'} ${p.label}\n`)
        for (const [i, app] of p.patch.entries()) {
          process.stdout.write(`  → id ${p.ids[i] ?? '?'}：转 id-targeted patch，追加到文件末尾：\n`)
          for (const l of app) process.stdout.write(`    ${l}\n`)
        }
      }
      if (opts.fix) {
        process.stdout.write(`\n已备份：<文件>.dsh-fix.bak。重新检测：\n`)
        const again = detect(scanProfiles())
        const left = again.profiles.reduce((n, p) => n + p.conflicts.length, 0)
        process.stdout.write(left ? `⚠ 仍有 ${left} 处冲突，请检查以上输出。\n` : `✓ 复检通过：0 冲突。\n`)
      }
    }
  }
}

// 仅作为 CLI 入口运行时执行 main（被 import 时不触发副作用）
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main()
