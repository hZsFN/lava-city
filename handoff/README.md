# 交接文件使用说明

四路会话（S0/S1/S2/S3/S4）各写**一个文件**，文件名不相交，因此同时写不会冲突。

| 会话 | 文件 | 目录 |
|---|---|---|
| S0 控制 | `S0.md` | `E:\demo\lava-city` |
| S1 P2-B（塔+流程） | `S1-p2b.md` | `E:\demo\wt-p2b` |
| S2 P2-A（玩家+战斗） | `S2-p2a.md` | `E:\demo\wt-p2a` |
| S3 Boss | `S3-boss.md` | `E:\demo\wt-boss` |
| S4 渲染（Trae） | `S4-render.md` | `E:\demo\wt-render` |

## 规则

1. **只写自己那一份**，不碰别人的。
2. **每 30 分钟**更新一次并 `git commit`。
3. **每个合并点之前**必须更新。
4. **开工前**先 `git fetch origin && git rebase origin/master`，然后读 `handoff/S0.md` 了解 master 现状。

## 模板

```markdown
# <会话> 交接

> 最后更新：HH:MM

## 状态
- 当前分支：
- 最后提交：
- 本轮进度：进行中 / 完成 / 阻塞

## 已完成
- 

## 对外暴露的接口（别人可以依赖的）
```ts
// 函数签名 / 类型
```

## 未完成 / 阻塞
- 

## 契约申请
（没有就写"无"）

## 跨目录请求
（需要别人改他的文件时写这里，不要自己改）

## 下一步第一件事
- 

## 复现方式
（命令 + 预期现象）
```

## 契约申请格式

```markdown
### 契约申请 #N（HH:MM 提出）
- 事件名：`XxxChanged`
- 字段：`{ id: string; value: number }`
- 触发时机：
- 为什么已有事件不够：
- 提出人：S1
- 状态：待 S0 裁决
```
