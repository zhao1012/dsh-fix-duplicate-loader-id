# dsh-fix-duplicate-loader-id

DSH (DeepSeek Harness) skill：**自动检测并修复 `duplicate loader entry id` 启动崩溃**。

当 `dsh web` / `dsh tui`（或任意 profile 启动）因多个 bundle 层对同一 loader entry id 重复 `- insert:` 而崩溃时，本 skill 指导并执行完整的诊断 → 修复 → 验证流程，把重复插入行转换为 **id-targeted patch**，保证 dsh 启动稳定不报错。

## 问题背景

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): duplicate loader entry id: storage
TypeError: duplicate loader entry id: storage
```

**根因**：profile 的多个 bundle 层都会以 `- insert:` 向 loader entry 列表 push row；同一 id 被 push 两次时，loader 的 `EntryGroup.update` 抛 `duplicate loader entry id`，中止整个启动。典型案例：`@deepseek-ai/dsh-web-app` bundle 层先插入了 `storage` / `storage-json` / `storage-domain` / `workspace` / `cordis-host-runner` / `agent-presets` 等 row，`@deepseek-harness-tui/dsh-tui` 插件层又插入了同 id 的 row。

**补丁语义**（`applyEntryPatches`）：

| 写法 | 语义 | 冲突行为 |
|---|---|---|
| `- insert:` 子项 | **创建** row | 同 id 创建两次 → 崩溃 |
| 顶层 `- id:`（无 insert） | **按 id 修改已存在 row** | 目标缺失只 warn，不终止启动 |

因此修复路线 = 把「后插入的」重复 `- insert:` 子项转成顶层 id-targeted patch（保留 config、**删掉 name 行**——id patch 带 name 且与目标不符会 warn 跳过、补丁不生效）。

## 安装

把本仓库克隆或复制到 DSH 用户级 skill 根目录：

```sh
git clone https://github.com/zhao1012/dsh-fix-duplicate-loader-id.git ~/.agents/skills/dsh-fix-duplicate-loader-id
# 或只复制核心文件：
#   SKILL.md                      → ~/.agents/skills/dsh-fix-duplicate-loader-id/
#   scripts/dsh-fix-duplicate-loader-id.mjs → ~/.agents/skills/dsh-fix-duplicate-loader-id/scripts/
```

DSH 的 skill 加载器会自动发现（`$DSH_AGENTS_HOME` 缺省 `~/.agents`）。之后只要对 agent 说「dsh 启动报 duplicate loader entry id」或触发对应错误特征，agent 就会按 SKILL.md 执行本 skill。

## 检测

脚本纯 Node、零依赖、只读检测绝不写盘：

```sh
node ~/.agents/skills/dsh-fix-duplicate-loader-id/scripts/dsh-fix-duplicate-loader-id.mjs
# 默认扫描 ~/.dsh/profiles/* 下所有含 dsh.profile.bundles 的 profile
node ~/.agents/skills/dsh-fix-duplicate-loader-id/scripts/dsh-fix-duplicate-loader-id.mjs --profile ~/.dsh/profiles/web
node ~/.agents/skills/dsh-fix-duplicate-loader-id/scripts/dsh-fix-duplicate-loader-id.mjs --json   # 机器可读
```

输出每个 bundle patch 文件的 insert/id-patch 统计，逐条列出冲突（id、首次插入位置、重复插入位置）。退出码：`0` = 无冲突；`1` = 有冲突。

## 修复

```sh
node ~/.agents/skills/dsh-fix-duplicate-loader-id/scripts/dsh-fix-duplicate-loader-id.mjs --profile <dir> --dry-run   # 先预览
node ~/.agents/skills/dsh-fix-duplicate-loader-id/scripts/dsh-fix-duplicate-loader-id.mjs --profile <dir> --fix       # 执行
```

`--fix` 对每个冲突文件：

1. 先备份 `<cordis.patch.yml>.dsh-fix.bak`；
2. 把重复的 insert 子项（连同其上方注释）从 insert 块中移除；
3. 在文件末尾追加同 id 的顶层 id-targeted patch（`- id: <id>` + 原 config，name 行已剔除）；
4. 若 insert 块因此变空，移除 `- insert:` 头行；
5. 自动复检并报告剩余冲突（应为 0）。

幂等：已修复的文件重跑 = 0 冲突直接退出，不写盘。

## 验证

```sh
node ~/.agents/skills/dsh-fix-duplicate-loader-id/scripts/dsh-fix-duplicate-loader-id.mjs --profile <dir>   # → ✓ 无重复 insert id
pnpm dsh web    # 越过 plugin-tree 加载，出现监听日志
```

## 复发与根治

- `pnpm install` / `pnpm update` / `dsh plugin` 重装升级插件后，`.pnpm` 缓存副本被覆盖，修复可能丢失、问题复现——**复发时重跑本 skill 即可**（检测对已修复文件幂等）。
- 更稳的本地固化：用 `pnpm patch <pkg>` + `pnpm patch-commit` 把修复固化为 `pnpm.patchedDependencies`，重装自动重放。
- 根治：推动上游插件把与 web-app 重叠的 insert 改为 id-targeted 写法（例如 [dsh-TUI 上游修复分支](https://github.com/ccch1mneyyy/dsh-TUI)）。

## 边界

- 检测只把「`- insert:` 子项 id 重复」判为冲突——与 loader 崩溃语义严格一致；顶层 id-targeted patch 不算插入、不判冲突。
- group insert（`- id: <group>` + `insert:`）需目标显式 `group: true` 才生效，极罕见；loader 对非 group 目标只 warn 跳过、不崩。

## License

MIT © zhao1012

## 赞助（Sponsor）

如果这个 skill 帮你省下了排查 `duplicate loader entry id` 的时间、解决了实际问题，欢迎请我喝杯咖啡 ☕，或者支持一点 token 费用——你的支持是持续维护与开源分享的最大动力 ❤️

![赞助收款码](sponsor-qr.jpg)
