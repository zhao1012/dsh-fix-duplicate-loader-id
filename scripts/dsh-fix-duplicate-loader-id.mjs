#!/usr/bin/env node
/**
 * dsh-fix-duplicate-loader-id â æ£æµå¹¶ä¿®å¤ dsh profile å¯å¨å´©æºï¼
 * `duplicate loader entry id: <id>` / `plugin tree failed to load`ã
 *
 * åçï¼å¯¹åº vendor/include ç applyEntryPatches è¯­ä¹ï¼ï¼
 *   - `- insert:`ï¼æ  id çé¡¶å±ç®åï¼æ `- id: <group>` + `insert:` é®ï¼
 *     å entry åè¡¨ push æ° rowï¼åå»ºï¼ãåä¸ id è¢« push ä¸¤æ¬¡ â loader ç
 *     EntryGroup.update æ `duplicate loader entry id`ï¼ä¸­æ­¢æ´ä¸ªå¯å¨ã
 *   - é¡¶å± `- id: <id>`ï¼æ  insertï¼= id-targeted patchï¼æ id ä¿®æ¹å·²å­å¨
 *     rowï¼ç®æ ç¼ºå¤±åª warnï¼`patch: entry %C not found`ï¼è·³è¿ï¼ä¸æ¥éã
 *
 * å æ­¤ä¿®å¤è·¯çº¿ï¼æãååºç°ãçéå¤ insert å­é¡¹è½¬æ¢ä¸ºé¡¶å± id-targeted
 * patchï¼å»æ name è¡ââid patch å¸¦ name ä¸ä¸ç®æ ä¸ç¬¦ä¼ warn è·³è¿ï¼
 * ä¿ç config/disabled ä¸æ³¨éï¼ã
 *
 * ç¨æ³ï¼
 *   node dsh-fix-duplicate-loader-id.mjs [--profile <dir>] [--fix] [--dry-run] [--json]
 *
 * é»è®¤æ«æ ~/.dsh/profiles/*ï¼æ¯ä¸ªå« dsh.profile.bundles ç profileï¼ã
 * çº¯ Nodeï¼é¶ç¬¬ä¸æ¹ä¾èµï¼åªè¯»æ£æµæ¶ç»ä¸åçã
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { homedir } from 'node:os'

const HELP = `ç¨æ³:
  node dsh-fix-duplicate-loader-id.mjs [options]

éé¡¹:
  --profile <dir>   åªæ£æ¥æå® profile ç®å½ï¼é»è®¤æ«æ ~/.dsh/profiles/*ï¼
  --fix             èªå¨ä¿®å¤ï¼éå¤ insert å­é¡¹ â id-targeted patchï¼åå¤ä»½ .dsh-fix.bakï¼
  --dry-run         ä¸ --fix åé»è¾ä½åªæå°å°æ§è¡çä¿®æ¹ï¼ä¸åç
  --json            è¾åº JSON æ¥å
  -h, --help        æ¾ç¤ºå¸®å©

éåºç : 0 = æ å²çª; 1 = å­å¨å²çªï¼æªä¿®å¤æ¶ï¼; 2 = ç¨æ³/IO éè¯¯
`

// ââ åæ°è§£æ âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const args = process.argv.slice(2)
const opts = { profile: null, fix: false, dryRun: false, json: false }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--profile') opts.profile = args[++i]
  else if (a === '--fix') opts.fix = true
  else if (a === '--dry-run') opts.dryRun = true
  else if (a === '--json') opts.json = true
  else if (a === '-h' || a === '--help') { process.stdout.write(HELP); process.exit(0) }
  else { process.stderr.write(`æªç¥åæ°: ${a}\n\n${HELP}`); process.exit(2) }
}

// ââ è¡çº§ YAML æ«æè§£æï¼åªè¯å« patch éè¦çç»æï¼ä¸å¼å¥ yaml ä¾èµï¼ââââââââââ
/**
 * è§£æä¸ä¸ª patch æä»¶çé¡¶å± entriesã
 * è¿å [{ type:'patch'|'insert'|'other', id?, line, endLine, insertRows?, hasInsertKey }]
 *   - type 'insert'ï¼é¡¶å±ç®å `- insert:`ï¼insertRows ä¸ºå¶å­é¡¹ï¼å¯è½ä¸ºç©ºï¼
 *   - type 'patch'ï¼`- id: xxx` é¡¶å± entryï¼è¥å¸¦ `insert:` é®ï¼insertRows ä¸ºå­é¡¹
 *   - type 'other'ï¼å¶ä»é¡¶å± entryï¼å¿½ç¥ï¼
 * å­é¡¹: { id, line, endLine, commentStart, insertRows?, hasInsertKey }
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

  /** ä» line å¼å§è§£æä¸ä¸ª entryï¼åè¡¨é¡¹ `- key:`ï¼ï¼è¿å {endLine, insertRows} */
  function parseEntry(line, indent) {
    const key = keyOf(lines[line])
    const insertRows = []
    let j = line + 1
    let insertIndent = null // insert é®è¡çç¼©è¿
    let lastContent = -1 // æåä¸ä¸ªå®è´¨åå®¹è¡ï¼æ³¨é/ç©ºè¡ä¸è®¡å¥ endLineï¼
    while (j < lines.length) {
      const l = lines[j]
      if (isEmpty(l) || isComment(l)) { j++; continue }
      const m = l.match(/^(\s*)(\S)/)
      const ind = m ? m[1].length : 0
      if (ind <= indent) break // åå°ä¸å±ï¼å«ä¸ä¸ä¸ªåçº§å­é¡¹ï¼ï¼ä¸è®¡å¥æ¬ entry
      lastContent = j
      const k = keyOf(l)
      if (k === 'insert' && /:\s*$/.test(l.trim())) {
        insertIndent = ind
        // å­åè¡¨é¡¹ï¼ç¼©è¿ > insertIndent ç `- ` è¡
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

  /** entry ä¸æ¹ç´§é»çè¿ç»­æ³¨éè¡èµ·å§ï¼ä¸å«ç©ºè¡åéï¼ */
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
        // é¡¶å±ç®å `- insert:`ï¼è§£æå­åè¡¨ï¼ä¸ group insert ç¸åè§åï¼
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

/** æ·±åº¦æ¶é insert å­é¡¹ï¼å«åµå¥ group ç insertï¼ */
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

/** æ·±åº¦æ¶éé¡¶å± id patchï¼å«åµå¥ group åå­é¡¹ï¼ */
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

// ââ profile æ«æ ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
/** è¿å [{name, dir, bundles, patchFiles: [{label, path, text}]}] */
function scanProfiles() {
  const roots = opts.profile ? [resolve(opts.profile)] : defaultProfileRoots()
  const profiles = []
  for (const dir of roots) {
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) continue
    let pkg = null
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch { /* å¿½ç¥å package.json */ }
    if (!pkg?.dsh?.profile?.bundles) continue
    const bundles = pkg.dsh.profile.bundles
    const patchFiles = []
    for (const b of bundles) {
      const p = join(dir, 'node_modules', b, 'cordis.patch.yml')
      if (existsSync(p)) patchFiles.push({ label: `${b} (cordis.patch.yml)`, path: p })
    }
    const user = join(dir, 'cordis.patch.yml')
    if (existsSync(user)) patchFiles.push({ label: `${basename(dir)}/cordis.patch.yml (ç¨æ·å±)`, path: user })
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

// ââ æ£æµ âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function detect(profiles) {
  const report = { profiles: [] }
  for (const prof of profiles) {
    const seen = new Map() // insert id â {file, line}
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

// ââ ä¿®å¤ âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const FIX_HEADER = (id) => [
  `# [dsh-fix] ${id} å·²ç±æ´æ©ç bundle å±æå¥ï¼æ­¤å¤ç± insert è½¬ä¸º id-targeted patchï¼`,
  `# row å·²å­å¨ï¼ç»åå¯å¨ï¼â å¹ç­ no-opï¼row ä¸å­å¨ï¼è£¸å¯å¨ï¼â ä»æ å®³è­¦åã`,
  `# æ³¨æï¼éè£/åçº§è¯¥æä»¶ï¼pnpm install/updateãdsh pluginï¼ä¼è¦çæ­¤æä»¶ï¼è¯·ä¿çæ¬ä¿®æ¹ææ¨å¨ä¸æ¸¸ã`,
]

/** æ insert å­é¡¹ææ¬è½¬æ¢ä¸ºé¡¶å± id-targeted patch ææ¬ï¼å»ç¼©è¿ãå  name è¡ï¼ã */
function toPatchText(row, lines) {
  const out = []
  for (let i = row.commentStart; i <= row.endLine; i++) {
    const l = lines[i]
    if (l.trim() === '') { out.push(''); continue }
    if (/^\s*#/.test(l)) { out.push(l.trimStart()); continue }
    // å æ name è¡ï¼id patch å¸¦ name ä¸ä¸ç®æ ä¸ç¬¦ä¼ warn è·³è¿ï¼
    if (/^\s{4,}name:/.test(l)) continue
    // å»æå­é¡¹åºåç¼©è¿ï¼= è¯¥ entry è¡çç¼©è¿ï¼
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
    // ææä»¶åç»
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
      // è¡å·ä» 1-based è½¬ 0-based
      const cs = conflicts.map((c) => ({ ...c, line0: c.line - 1 }))
      // èªä¸èä¸å¤çï¼è¡å·æ å°ä»¥åè¡å·ä¸ºåºåï¼æåç»ä¸è¿æ»¤ï¼
      const remove = new Set() // éè¦å é¤çåè¡å·
      const appends = [] // è¿½å å°æä»¶å°¾ç patch ææ¬ï¼å«æå± idï¼
      for (const c of cs) {
        const row = c.row
        row.indent = entryIndent(lines, row.line) // row.line ä¸º 0-based
        const block = toPatchText(row, lines)
        if (!topIds.has(c.id)) {
          appends.push({ id: c.id, lines: [...FIX_HEADER(c.id), ...block] })
        }
        for (let i = row.commentStart; i <= row.endLine; i++) remove.add(i)
      }
      // ç§»é¤ãå­é¡¹å·²è¢«å ç©ºãç insert é®è¡ï¼- insert: / `  insert:`ï¼
      const dropHead = new Set()
      for (const e of entries) {
        // æ¾é®è¡ï¼ç®å insert ç `- insert:` è¡ï¼æ patch entry åå®¹ä¸­ç `  insert:` è¡
        let keyIdx = -1
        if (e.type === 'insert') keyIdx = e.line
        else if (e.type === 'patch' && e.hasInsertKey) {
          for (let k = e.line + 1; k <= e.endLine; k++) {
            if (/^ {2}insert:\s*$/.test(lines[k])) { keyIdx = k; break }
          }
        }
        if (keyIdx < 0 || remove.has(keyIdx)) continue
        // é®è¡ä¹åå°ä¸ä¸ä¸ªåçº§ entry åæ¯å¦è¿ææ®çå­é¡¹
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
      // æåè¡å·ç»ä¸è¿æ»¤ï¼removedSet âª dropHeadï¼
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

// ââ ä¸»æµç¨ âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function main() {
  const profiles = scanProfiles()
  if (!profiles.length) {
    process.stderr.write(`æªæ¾å°ä»»ä½å« dsh.profile.bundles ç profileï¼é»è®¤æ« ~/.dsh/profiles/*ï¼ã\nå¯ç¨ --profile <dir> æå®ã\n`)
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
        process.stdout.write(`  ${f.label}ï¼insert Ã${f.inserts}ï¼id patch Ã${f.topIds}${f.error ? `ï¼è¯»åå¤±è´¥: ${f.error}` : ''}ï¼\n`)
      }
      if (!p.conflicts.length) {
        process.stdout.write(`  â æ éå¤ insert id\n`)
      } else {
        process.stdout.write(`  â ${p.conflicts.length} å¤éå¤ insert idï¼\n`)
        for (const c of p.conflicts) {
          process.stdout.write(`    - ${c.id}ï¼é¦æ¬¡æå¥ ${c.firstLabel}:${c.firstLine} â éå¤æå¥ ${c.label}:${c.line}\n`)
        }
      }
    }
    process.stdout.write(total ? `\nå± ${total} å¤å²çªã\n` : `\nå¨é¨ profile æ å²çªã\n`)
  }

  if (total === 0) process.exit(0)

  if (!opts.fix && !opts.dryRun) {
    process.stdout.write(`\nä¿®å¤å»ºè®®ï¼node dsh-fix-duplicate-loader-id.mjs --profile <dir> --fix\nï¼--dry-run å¯åé¢è§ä¿®æ¹ï¼\n`)
    process.exit(1)
  }

  if (opts.fix || opts.dryRun) {
    const plan = applyFix(report, opts.fix)
    if (opts.json) {
      process.stdout.write(JSON.stringify({ fixed: plan.map((p) => ({ file: p.file, ids: p.ids, line: p.line })) }, null, 2) + '\n')
    } else {
      for (const p of plan) {
        process.stdout.write(`\n${opts.fix ? 'å·²ä¿®å¤' : '[dry-run] å°ä¿®å¤'} ${p.label}\n`)
        for (const [i, app] of p.patch.entries()) {
          process.stdout.write(`  â id ${p.ids[i] ?? '?'}ï¼è½¬ id-targeted patchï¼è¿½å å°æä»¶æ«å°¾ï¼\n`)
          for (const l of app) process.stdout.write(`    ${l}\n`)
        }
      }
      if (opts.fix) {
        process.stdout.write(`\nå·²å¤ä»½ï¼<æä»¶>.dsh-fix.bakãéæ°æ£æµï¼\n`)
        const again = detect(scanProfiles())
        const left = again.profiles.reduce((n, p) => n + p.conflicts.length, 0)
        process.stdout.write(left ? `â  ä»æ ${left} å¤å²çªï¼è¯·æ£æ¥ä»¥ä¸è¾åºã\n` : `â å¤æ£éè¿ï¼0 å²çªã\n`)
      }
    }
  }
}

// ä»ä½ä¸º CLI å¥å£è¿è¡æ¶æ§è¡ mainï¼è¢« import æ¶ä¸è§¦åå¯ä½ç¨ï¼
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main()
