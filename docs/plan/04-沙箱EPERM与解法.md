# 沙箱 EPERM 问题与解法

> 症状：`spawn EPERM`，出现在 `npm run gate` 的 test 阶段（vitest → esbuild）
> 版本：v1.0 · 2026-11-08 11:55

---

## 一、根因（已确认，不是猜的）

报错原文：

```
允许本次操作使用 danger-full-access 权限：gate 的 test 阶段需要
vitest/esbuild 启动子进程并使用管道 stdio，受限沙箱下报 spawn EPERM，
必须提权才能跑出真实的 gate 结果。
```

DSH 沙箱在受限模式下**禁止子进程创建命名管道**。而：

```
npm run gate
  └─ vitest
       └─ 启动 esbuild 子进程
            └─ stdio: 'pipe'   ← 这里被拒，spawn EPERM
```

同一原因还会命中：
- `vite build`（也用 esbuild）
- `tsc --noEmit`（一般不涉及，但有时会）
- 任何 `child_process.spawn` 带 `stdio: 'pipe'` 的调用

**这不是 bug，是沙箱的既定边界。** 官方说明写得很清楚：

> 在两种受限模式下，程序不能打开命名管道，所以用管道捕获另一个程序输出的命令会失败（Node.js `child_process.spawn`/`exec` 默认 `stdio: 'pipe'` 时报 EPERM），而 `stdio: 'inherit'` 和 `stdio: 'ignore'` 的 spawn 可以工作。

---

## 二、四条解法（按推荐度排序）

### 方案 A：新对话开局就设 `danger-full-access`（**推荐，最彻底**）

沙箱模式是**每个会话独立**的，不继承。所以：

新开对话时，在第一条消息里明确写：

```
【会话配置要求】
本对话请使用：
  文件策略：danger-full-access
  审批策略：never
```

如果 DSH 界面有沙箱选择器，直接在界面上选。

**注意**：即使文件策略是 `danger-full-access`，**审批策略仍可能是 `ask`**，那样还是会弹"允许一次"。两个都要设。

截图里那个弹窗正是 `danger-full-access` + `ask` 的组合——它不是在拦沙箱，是在等你点"允许一次"。

### 方案 B：点"允许一次"（最快，但每次都要点）

截图里点「允许一次」就能跑通。

**问题**：每跑一次 gate 弹一次，三路 × 每 30 分钟 = 一天几十次。

### 方案 C：改 gate 脚本，让 test 阶段不弹窗（**折中，推荐配合 A**）

把 `scripts/gate.ps1` 的 test 步骤改成**先尝试普通跑，失败则提示**，而不是每次都触发提权。

更彻底的做法：**把 test 拆成独立命令**，agent 日常只跑 `npm run gate:fast`（不含 test），合并点才跑全量。

```jsonc
// package.json
"gate:fast": "powershell -File scripts/gate.ps1 -SkipTest -SkipPack",
"gate": "powershell -File scripts/gate.ps1"
```

`gate:fast` 只跑 contract + typecheck，**不启动子进程，不会弹窗**。
agent 每改完一个文件跑 `gate:fast`，快且无摩擦；我合并时跑全量 `gate`。

### 方案 D：`stdio: 'inherit'`（理论上可行，实际不可控）

理论上让 esbuild 用 `inherit` 就能绕过，但 esbuild 的 stdio 是 vitest 内部定的，**我们改不了**。

---

## 三、我建议的组合

| 场景 | 做法 |
|---|---|
| 三个开发对话 | 开局设 `danger-full-access` + `never`；日常跑 `gate:fast` |
| 我（S0 集成会话） | 已经是 `danger-full-access` + `never`，跑全量 `gate` 没问题 |
| 合并点 | 我跑全量 `gate`，一次性验证 |

**关键洞察**：`spawn EPERM` 只影响 **test 阶段**。contract 和 typecheck 都是纯 Node 单进程，不受影响。

所以让三路日常跑 `gate:fast`，能消掉 90% 的弹窗；只有我合并时才需要全量。

---

## 四、现在就能做的两件事

### 1. 给 gate 加 fast 模式（我来做，约 5 分钟）

改 `scripts/gate.ps1` 支持 `-SkipTest`，`package.json` 加 `gate:fast`。

三路提示词里改成：
```
日常自检：npm run gate:fast   （约 8 秒，不弹窗）
提交前：  npm run gate        （全量，可能弹一次"允许一次"）
```

### 2. 三个对话补发会话配置要求

```
【会话配置要求】
本对话请使用 danger-full-access + never 审批策略。
如果无法设置，遇到 spawn EPERM 弹窗时点「允许一次」即可，
这是 vitest/esbuild 需要子进程管道导致的，不是配置错误。
日常自检用 npm run gate:fast（不弹窗），
只在提交前跑一次完整 npm run gate。
```

---

## 五、为什么不能"彻底取消沙箱"

技术上可以，但**不建议**，理由：

1. **沙箱不是主要摩擦来源**。真正让你停下来的是"协议要求放行"（已有预授权段解决）和"这个 EPERM 弹窗"（用 `gate:fast` 解决）。
2. **三路共享同一个 `.git`**。无护栏时一条 `git reset --hard` 就能毁掉一路的未提交工作。
3. **`git push` 必须单点控制**。三路同时 push 必炸。

**结论**：把沙箱开到 `danger-full-access`（够用），但**保留审批策略的意义**——它在你手滑执行破坏性命令时是最后一道闸。

---

## 六、快速判断：这个报错是沙箱还是别的

| 特征 | 结论 |
|---|---|
| 带 `[sandbox: file access denied under <mode> mode]` | 沙箱文件拦截 |
| 带 `spawn EPERM` / `EPERM: operation not permitted` | 沙箱禁止子进程管道 |
| 弹窗有「拒绝 / 允许一次」按钮 | 审批策略 `ask` |
| agent 回"请确认是否开始" | 协议等待，不是沙箱 |
