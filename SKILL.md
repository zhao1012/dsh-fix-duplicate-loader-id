---
name: dsh-fix-duplicate-loader-id
description: Use when `dsh web` / `dsh tui` / any profile boot crashes with "duplicate loader entry id", "plugin tree failed to load", "failed to apply loader entry include", or after pnpm install/update/dsh plugin overwrites a previously patched cordis.patch.yml in node_modules — detect duplicate loader entry ids across profile bundles and convert the later duplicate `- insert:` rows into id-targeted patches so the profile boots reliably.
---

# dsh 启动崩溃修复：重复 loader entry id

当 `dsh web`（或任意 profile 启动）报以下错误之一时使用本 skill：

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): duplicate loader entry id: <id>
TypeError: duplicate loader entry id: storage
```

## 根因（一句话）

profile 的多个 bundle 层都会以 `- insert:` 向 loader entry 列表 push row；同一 id 被 push 两次时，loader 的 `EntryGroup.update` 抛 `duplicate loader entry id`，中止整个启动。典型：dsh-web-app bundle 层先 insert 了 `storage`/`storage-json`/`storage-domain`/`workspace`/`cordis-host-runner`/`agent-presets` 等 row，@deepseek-harness-tui/dsh-tui 插件层又 insert 了同 id 的 row。

补丁语义（vendor/include 的 `applyEntryPatches`，也是修复的依据）：

- `- insert:` 子项（或 `- id: <group>` + `insert:` 键）= **创建** row；同 id 创建两次 → 崩溃。
- 顶层 `- id: <id>`（无 insert）= **按 id 修改已存在 row**；目标缺失只打 `patch: entry %C not found` 警告并跳过，**不终止启动**。
- ⚠️ id-targeted patch 不能带 `name:` 行：`name` 与目标不符会 warn 跳过、补丁不生效。

因此修复路线 = 把「后插入的」重复 `- insert:` 子项转成顶层 id-targeted patch（保留 config、删掉 name 行）。

## 1. 自动检测（只读，先跑这个）

脚本随 skill 提供，纯 Node、零依赖：

```sh
node <skill 目录>/scripts/dsh-fix-duplicate-loader-id.mjs
# 默认扫描 ~/.dsh/profiles/* 下所有含 dsh.profile.bundles 的 profile
node <skill 目录>/scripts/dsh-fix-duplicate-loader-id.mjs --profile ~/.dsh/profiles/web
node <skill 目录>/scripts/dsh-fix-duplicate-loader-id.mjs --json   # 机器可读
```

输出每个 bundle patch 文件的 insert/id-patch 统计，并把冲突逐条列出（id、首次插入位置、重复插入位置）。退出码：0 = 无冲突；1 = 有冲突。

## 2. 自动修复

```sh
node <skill 目录>/scripts/dsh-fix-duplicate-loader-id.mjs --profile <dir> --dry-run   # 先预览
node <skill 目录>/scripts/dsh-fix-duplicate-loader-id.mjs --profile <dir> --fix       # 执行
```

`--fix` 对每个冲突文件：

1. 先备份 `<cordis.patch.yml>.dsh-fix.bak`；
2. 把重复的 insert 子项（连同其上方注释）从 insert 块中移除；
3. 在文件末尾追加同 id 的顶层 id-targeted patch（`- id: <id>` + 原 config，name 行已剔除，带 `[dsh-fix]` 说明注释）；
4. 若 insert 块因此变空，移除 `- insert:` 头行；
5. 自动复检并报告剩余冲突（应为 0）。

修改落在 pnpm 的 `.pnpm` 缓存副本里（node_modules 符号链接指向处）。改动前先确认用户同意修改该文件；`--dry-run` 输出完全可读，便于用户核对。

## 3. 验证

1. 重跑检测：`node <skill 目录>/scripts/dsh-fix-duplicate-loader-id.mjs --profile <dir>` → `✓ 无重复 insert id`、退出码 0。
2. 实跑启动（后台起、确认监听后停掉；超时兜底）：

```sh
cd <profile 目录>  # 或项目根
pnpm dsh web
# 预期：越过 plugin-tree 加载，出现监听日志（如 Listening on http://127.0.0.1:3080）
```

若用户只给了错误信息而没有可复现环境，至少完成检测 + 修复 + 复检，并说明实跑验证由用户在本地执行。

## 4. 复发与根治

- `pnpm install` / `pnpm update` / `dsh plugin` 重装升级插件后，`.pnpm` 缓存副本被覆盖，**本修复会丢失、问题复现**。复发时重跑本 skill 即可（检测脚本对已修复文件幂等：0 冲突直接退出，不写盘）。
- 从源头根治：推动上游插件（如 @deepseek-harness-tui/dsh-tui）把与 web-app 重叠的 insert 改为 id-targeted 写法（即本 skill 的做法），或在该插件的 `dsh.profile.bundles` 挂载顺序上避免两个 bundle 声明同一 row。
- 也可用 `pnpm patch <pkg>` 把修复固化为本地补丁，重装后自动重放（视用户环境可选）。

## 边界与注意

- 检测只把「`- insert:` 子项 id 重复」判为冲突——与 loader 崩溃语义严格一致。顶层 id-targeted patch 不算插入、不判冲突（它就是修复目标形态）。
- group insert（`- id: <group>` + `insert:`，目标需显式 `group: true` 才是真 group）极罕见，loader 对非 group 目标只 warn 跳过、不崩；如遇显式 `group: true` 场景的重复，按同一思路手工转换。
- 修复时若同一文件里多个 insert 块插同一 id，按 bundle 顺序保留最早一次插入，其余全部转换。
- 手工修复替代路线（脚本不可用时）：打开重复插入方的 cordis.patch.yml，把冲突子项从 `- insert:` 块里整段挪出（保留注释），顶格写成 `- id: <id>` + 原 config 行（去掉 4 空格缩进、删掉 name 行），然后执行上面的验证。
