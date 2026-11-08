# PR 交付流程

> 版本：v1.0 · 2026-11-08
> 生效原因：仓库主人已开启分支保护，**`master` 不再接受直接 push，一切交付必须走 Pull Request**
> 适用范围：所有协作者（含 AI Agent 会话 S0/S1/S2/S3/S4 与 B1/B2/B3）

---

## 零、三十秒版

1. **不许直接 push `master`** —— 保护已开启，推不上去。
2. **开分支 → 提交 → push 分支 → 开 PR**。
3. **PR 必须由 @hZsFN 批准** 才能合并（`CODEOWNERS` 规定 `* @hZsFN`）。
4. **PR 描述必须填完整模板**，没证据不算完成。
5. **合并后删分支**，本地 `git fetch --prune` 同步。

---

## 一、保护现状（已实测确认）

| 项 | 事实 | 证据 |
|---|---|---|
| `master` 保护 | 已开启 | `git push origin master` 被拒 |
| 必需审批人 | `@hZsFN` | `.github/CODEOWNERS` 内容为 `* @hZsFN` |
| 你的角色 | `fireworkPx`，collaborator | 可 push 分支、可开 PR，**不能自己合并** |
| 强制 PR | 是 | 直推 master 不可行 |

**关键含义：你的工作产物必须经过 @hZsFN 审阅。** 这不是障碍，是质量关口——把 PR 描述写好，能大幅提高一次通过率。

---

## 二、完整流程（照抄即可）

### 2.1 开工：同步基线

```powershell
cd E:\demo\lava-city

git fetch --prune origin
git status -sb                    # 确认干净
git merge --ff-only origin/master # 或 git pull --ff-only
```

**为什么要 `--ff-only`**：避免在本地 master 上产生合并提交，保持历史线性。

### 2.2 开分支

分支命名规则：

| 类型 | 格式 | 例 |
|---|---|---|
| 功能 | `feat/<模块>-<简述>` | `feat/towers-ammo` |
| 修复 | `fix/<模块>-<简述>` | `fix/player-iframe` |
| 文档 | `docs/<简述>` | `docs/architecture` |
| 杂务 | `chore/<简述>` | `chore/cleanup` |

```powershell
git switch -c feat/towers-ammo
```

### 2.3 干活 + 提交

```powershell
# 改完先跑门禁
npm run gate:fast          # 快速（contract + typecheck，~5s）
npm run gate               # 全量（提交前必跑，~40s）

# 只 add 自己的文件，不要 git add -A
git add src/towers/ tests/unit/towers/ handoff/S1-p2b.md

# 提交（格式见 §2.4）
git commit -m "towers: 塔弹药消耗与 HUD 数据（T-M2-04）"
```

### 2.4 提交信息格式

```
<模块>: <做了什么>（<票号>）
```

| 模块 | 适用 |
|---|---|
| `towers:` | `src/towers/**` |
| `flow:` | `src/flow/**` |
| `player:` | `src/player/**` |
| `combat:` | `src/combat/**` |
| `boss:` | `src/boss/**` |
| `render:` | `src/render/**` |
| `ui:` | `src/ui/**` |
| `core:` | `src/core/**`（仅 S0） |
| `docs:` | `docs/**` |
| `handoff:` | `handoff/**` |
| `chore:` | 构建/配置/清理 |
| `test:` | 仅测试 |

### 2.5 推分支（不是 master）

```powershell
git push -u origin feat/towers-ammo
```

成功后 GitHub 会返回一条创建 PR 的链接，形如：

```
remote: Create a pull request for 'feat/towers-ammo' on GitHub by visiting:
remote:      https://github.com/hZsFN/lava-city/pull/new/feat/towers-ammo
```

### 2.6 开 PR

**方式 A：浏览器**（推荐，能填完整模板）

打开上面那条链接，或在仓库页点 `Compare & pull request`。

**方式 B：命令行**（gh CLI 未安装，需先装）

```powershell
gh pr create --base master --head feat/towers-ammo `
  --title "towers: 塔弹药消耗与 HUD 数据（T-M2-04）" `
  --body-file .github/PULL_REQUEST_TEMPLATE.md
```

**PR 标题格式与提交信息一致**：`<模块>: <做了什么>（<票号>）`

### 2.7 等审阅

- **不要**自己点 Merge（你没有权限，按钮是灰的）
- 收到 @hZsFN 的修改意见 → 在**同一分支**继续提交，PR 自动更新
- 不要关掉 PR 重开，会丢失讨论上下文

```powershell
# 根据审阅意见修改后
git add <改动文件>
git commit -m "towers: 按审阅意见修正弹药溢出边界（T-M2-04）"
git push
```

### 2.8 合并后清理

```powershell
git switch master
git fetch --prune origin
git merge --ff-only origin/master

# 删除已合并的本地分支
git branch -d feat/towers-ammo
# 删除远程分支（如果 GitHub 没自动删）
git push origin --delete feat/towers-ammo
```

---

## 三、PR 描述模板（必须填完整）

新建 `.github/PULL_REQUEST_TEMPLATE.md` 后会自动带入。手动写时照抄：

```markdown
## 交付内容

<!-- 一句话说清这个 PR 做了什么 -->

## 票号

<!-- 如 T-M2-01；无票号写"无" -->

## 改动范围

| 文件/目录 | 改动类型 | 说明 |
|---|---|---|
| `src/towers/TowerSystem.ts` | 修改 | 新增弹药字段与消耗逻辑 |
| `tests/unit/towers/ammo.test.ts` | 新增 | 覆盖 5 种塔的弹药边界 |

## 验收证据

<!-- 必须贴实际命令输出，不能只说"通过了" -->

```
$ npm run gate
===== [contract] =====
[gate] OK   contract (0.5s)
===== [typecheck] =====
[gate] OK   typecheck (4.5s)
===== [test] =====
 Test Files  18 passed (18)
      Tests  87 passed (87)
[gate] OK   test (10.2s)
===== [build] =====
[gate] OK   build (14.8s)
[gate] ===== 全部通过 =====
```

## 契约变更

<!-- 有就写：新增/修改了哪个事件、哪个字段、谁批准；没有写"无" -->

无

## 跨目录影响

<!-- 是否改了别人作用域的文件？是否需要别人配合？没有写"无" -->

无

## 已知遗留

<!-- 这个 PR 里明知没做完的部分 -->

无

## 自查清单

- [ ] `npm run gate` 全绿（贴了输出）
- [ ] 只改了本作用域内的文件
- [ ] 没有 `import three` 进逻辑层
- [ ] 没有改 `src/core/events.ts`（除 S0）
- [ ] 没有 `alert` / `confirm` / `top.location`
- [ ] `handoff/<我的会话>.md` 已更新
- [ ] 提交信息符合 `<模块>: <做了什么>（<票号>）` 格式
```

---

## 四、写作用域（PR 会被按此审查）

| 会话/角色 | ✅ 可写 | ❌ 禁碰 |
|---|---|---|
| **S0 控制** | `docs/**` `AGENTS.md` `package.json` `tsconfig.json` `vite.config.ts` `vitest.config.ts` `.npmrc` `.gitignore` `src/core/**` `scripts/**` `tools/**` `index.html` `src/main.ts` `src/render/App.ts` `handoff/S0.md` | 各路业务源码 |
| **S1 P2-B** | `src/towers/**` `src/flow/**` `src/telemetry/**` `tests/unit/towers/**` `tests/unit/flow/**` `handoff/S1-p2b.md` | `src/core/**` `src/render/**` `src/main.ts` `package.json` `three` |
| **S2 P2-A** | `src/player/**` `src/combat/**` `tests/unit/player/**` `tests/unit/combat/**` `handoff/S2-p2a.md` | `src/core/**` `src/towers/**` `src/flow/**` `src/render/**` `package.json` `three` |
| **S3 Boss** | `src/boss/**` `tests/unit/boss/**` `src/ui/BossDebugPanel.ts` `handoff/S3-boss.md` | `src/core/**` `src/render/**` `src/towers/**` `src/flow/**` `src/player/**` `src/combat/**` `package.json` |
| **S4 渲染** | `src/render/**`（除 `App.ts`）`src/core/config/visual.json` `docs/shots/**` `handoff/S4-render.md` | `src/core/**` 其他 `src/main.ts` 逻辑层全部 `package.json` |

**越界即拒。** 一个 PR 里出现别人作用域的文件，会被直接退回。

---

## 五、契约变更的 PR 特殊流程

`src/core/events.ts` 和 `src/core/config/*.json` **只有 S0 能改**。

### 非 S0 需要新事件时

**不能**在 PR 里改 `events.ts`。正确做法：

1. 在 `handoff/<你的会话>.md` 的「契约申请」写清：

```markdown
### 契约申请 #1（11:42 提出）
- 事件名：`TowerAmmoChanged`
- 字段：`{ towerId: string; ammo: number; maxAmmo: number }`
- 触发时机：塔每次开火后
- 为什么已有事件不够：`TowerTargetHit` 不带剩余弹药，HUD 显示不了
- 提出人：S1
- 状态：待 S0 裁决
```

2. 提交 handoff 并 push 分支、开 PR（只含 handoff 改动）
3. 在 PR 里明确写「本 PR 含契约申请 #1，需 S0 先合入 events.ts 后本 PR 才能通过 typecheck」
4. S0 合并契约后广播 → 你 `git merge --ff-only origin/master` 后继续

### S0 改契约时

PR 里必须包含：

- `src/core/events.ts` 的改动
- `docs/plan/CONTRACT.lock` 的哈希更新（`npm run contract` 会自动校验）
- PR 描述里列出「新增了哪些事件/字段，影响哪些模块」

**漏更新 `CONTRACT.lock` → 门禁必红。**

---

## 六、常见拒绝原因与自查

| 拒绝原因 | 自查命令 |
|---|---|
| 门禁没过 | `npm run gate` |
| 改了别人作用域 | `git diff --name-only origin/master...HEAD` |
| 逻辑层 import three | `npm run contract` |
| 改了 `events.ts` | `git diff --name-only origin/master...HEAD \| findstr core` |
| 提交信息格式错 | `git log --oneline origin/master..HEAD` |
| handoff 没更新 | `git diff --name-only origin/master...HEAD \| findstr handoff` |
| 用了 `alert`/`confirm` | `npm run contract` |
| 打包体积超限 | `npm run pack` 看输出 |
| 有 IP 词汇 | `npm run contract` |

### 提交前一次性自查脚本

```powershell
cd E:\demo\lava-city

Write-Host "=== 改动文件 ===" -ForegroundColor Cyan
git diff --name-only origin/master...HEAD

Write-Host "`n=== 提交信息 ===" -ForegroundColor Cyan
git log --oneline origin/master..HEAD

Write-Host "`n=== 门禁 ===" -ForegroundColor Cyan
npm run gate

Write-Host "`n=== 是否越界 ===" -ForegroundColor Cyan
$changed = git diff --name-only origin/master...HEAD
$core = $changed | Where-Object { $_ -match '^src/core/' }
if ($core) { Write-Host "⚠ 改了 core（仅 S0 允许）: $core" -ForegroundColor Yellow }
```

---

## 七、多路并行时的 PR 顺序

当多个分支同时待合并，**合并顺序会影响冲突**。规则：

1. **契约变更 PR 最先合**（S0 的 `events.ts` 改动）
2. **被依赖的模块其次**（如 `combat` 先于 `boss`）
3. **纯文档/渲染最后**

合并后其他分支必须 `git merge --ff-only origin/master` 或 rebase，**不要拖到冲突堆积**。

```powershell
# 别的分支合并后，同步自己的分支
git switch feat/towers-ammo
git fetch origin
git merge origin/master        # 或 git rebase origin/master
npm run gate:fast              # 确认没被别人的改动搞坏
```

---

## 八、紧急情况

### 8.1 PR 卡住，但必须尽快交付

在 PR 里 @hZsFN 并写清：

```markdown
@hZsFN 本 PR 阻塞后续 X 的工作，请优先审阅。
关键改动：<一句话>
风险点：<如有>
```

### 8.2 合错了要回滚

**不要** force push master（保护会拒）。用 revert：

```powershell
git switch -c fix/revert-bad-merge
git revert <坏提交sha> --no-edit
npm run gate
git push -u origin fix/revert-bad-merge
# 开 PR
```

### 8.3 分支落后太多

```powershell
git fetch origin
git rebase origin/master
# 有冲突：解决后 git add && git rebase --continue
npm run gate
git push --force-with-lease     # 只对自己分支可用，绝不对 master
```

**`--force-with-lease` 不是 `--force`**：前者在远程有新提交时会拒绝，避免覆盖别人的工作。

---

## 九、Git 连接（已配好，不用重复配）

工作区配置在 `E:\demo\.gitconfig`，通过 `E:\demo\lava-city\.git\config` 的 `include` 继承。**新建 worktree 自动继承。**

| 项 | 值 |
|---|---|
| 账号 | `fireworkPx` |
| 提交邮箱 | `206211283+fireworkPx@users.noreply.github.com` |
| TLS 后端 | `openssl`（本机 schannel 取不到凭证） |
| 代理 | `http://127.0.0.1:12334` |
| 认证 | `http.https://github.com/.extraheader`（base64 token） |

### 验证

```powershell
git -C E:\demo\lava-city ls-remote --heads origin
```

能列出 `refs/heads/master` 就通了。**不需要跑脚本、不需要设环境变量。**

### 排障

| 现象 | 修法 |
|---|---|
| `could not read Username` | `git config --get-all include.path` 应含 `E:/demo/.gitconfig` |
| `Duplicate header: "Authorization"` / HTTP 400 | `git config --local --unset-all "http.https://github.com/.extraheader"` |
| `schannel: AcquireCredentialsHandle failed` | `git config http.sslBackend` 应为 `openssl` |
| `Failed to connect to github.com:443` | `Test-NetConnection 127.0.0.1 -Port 12334 -InformationLevel Quiet` 应为 True |

> 安全：`E:\demo\.gitconfig` 内是 base64 明文 token（至 2026-12-08 过期）。**不要提交、不要贴进对话、不要外传。**

---

## 十、一句话总结

**分支 → 门禁 → 提交 → push → PR → 等 @hZsFN 批准 → 合并 → 清理。**

没有例外，没有捷径。直推 master 推不上去。
