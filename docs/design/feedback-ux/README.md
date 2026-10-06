# Feedback UX — 用户体验设计（重设计版）

每一屏都是**真实 xMatrix 界面**的截图：`apps/web` 生产构建 + 固定数据，不连 hub、不登录、不联网。还没写的部分以带标签的浮层画在真实界面之上，所以哪些像素是已发布的、哪些是提案，一眼可分。

重新生成：

```bash
cd apps/web
NEXT_PUBLIC_XMATRIX_MOCK_AUTH_TOKEN=xmatrix-e2e-mock-token \
NEXT_PUBLIC_XMATRIX_MOCK_AUTH_USER_ID=e2e-user \
NEXT_PUBLIC_XMATRIX_MOCK_AUTH_EMAIL=e2e@xmatrix.test \
NEXT_PUBLIC_XMATRIX_MOCK_AUTH_NAME="E2E Tester" \
NEXT_PUBLIC_XMATRIX_MOBILE_LIST_FIXTURE=1 \
NEXT_PUBLIC_XMATRIX_RELAY_V2_BROWSER_FIXTURE=1 \
pnpm build && pnpm exec next start -p 4733 &
SHOTS_BASE_URL=http://localhost:4733 pnpm exec node scripts/feedback-ux-screenshots.mjs
```

`NEXT_PUBLIC_*` 在**构建期**就固化进产物，所以 `pnpm build` 必须带着这组 env 跑，否则 `/app` 会跳登录页。

图例：🟩 已有能力 · 🟦 新增代码 · 🟥 产品缺口

---

## ① 图标栏里的 Feedback 入口 — `01-rail-entry.jpg`

入口在**最左边那条竖的图标栏**（`WorkspaceRail`），和 Docs / 主题 / 退出同一组：永远在那儿，不属于任何工作区。点它进反馈，点图标栏**最上面的头像**回到刚才的工作区。

**实现**：加一个 `RailButton`（`workspace-shell-chrome.tsx:643`）到底部那一组（`:551-562`）。那里已经有一个硬编码的 Docs 按钮（`:562`，直接 `window.open`），是现成的先例。点击不要用 `onChangeView`（那只切视图，不切 space），要走 `openInternalChannelLink({spaceKey, channelKey})`（`use-workspace-shell-actions.ts:2262`）——它在频道不在本地 state 时会先重新拉再跳，还带「无权限」提示；`navigateToChannel` 在这种情况下会静默什么都不做。

🟥 **「点上面的头像回到刚才的工作区」不是白送的。** 那个按钮（`:529`）走的是 `onChangeView("messages")`，回到的是**当前 working space**；而进反馈会把 working space 改成 feedback（`selectSpace` 会写 `workingSpaceId` 并持久化，`use-workspace-shell-actions.ts:2082`、`use-workspace-shell-state.ts:4085`）。所以直接接上去的话，点头像只会**留在反馈里**。要么进反馈时不覆盖记住的工作区，要么让头像跳回「最后一个非 feedback 的 space」。这条不处理的话，用户会觉得回不去。

space id **不要走 `NEXT_PUBLIC_*`**（构建期固化，改一次要重新构建三端），由 hub 下发。

**移动端**：web 的移动布局是 `MobileChannelChatList`（`:2615`），底部是 `MobileTabDock`（`workspace-shell-chrome.tsx:571`，items 硬编码）。iOS 是**原生 UITabBar**，不走 web 的 dock，要单独改一次。

## ② 进去之后 — `02-inside-feedback.jpg`

进来就是一个正常工作区：侧边栏是它自己的频道（`#feedback` / `#announcements` / `#general`），顶部是工作区名。主流程一屏走完：报告 → 追问 → 复现 → issue 回链。

- 🟦 置顶指引横条 = PR #1253（复用 `message_annotations` 的 `channel.pin.v1`，hub 零改动）
- 🟥 agent 归属徽章：用户看不出这个 agent 是官方的还是别人的
- 🟩 issue 链接就是普通消息；附件也已能发（#1321 + #1365）
- 🟩 从顶部工作区名切回自己的工作区

## ③ 怎么进得去（待定） — `03-join.jpg`

🟥 **这是唯一的真缺口，也是整条链的前提。**

`/api/xmatrix/spaces` 按**成员身份**过滤（hub 侧 `list-spaces` 带 `principal`），而且进 space 只有「邀请 → 接受」一条路，**没有公开空间发现或自助加入接口**；协议里 Space 没有 public 这一类。所以对还不是成员的用户，那个工作区在切换器里根本不会出现。

三条路：

| 方案 | 入口对新用户 | 工作量 | 和 100 人上限的关系 |
| --- | --- | --- | --- |
| 只对已加入的人显示 | 不出现 | 最小 | 无关 |
| 注册时自动加入 | 出现 | 中 | 满 100 后新用户又没有了 |
| 新增自助加入接口 | 出现 | 最大 | 满 100 显示「名额已满」 |

图里画的是第三种（含名额提示）。**未定，等拍板。**

## ④ 修复通知与公告 — `04-announcements.jpg`

发版点名感谢反馈者，闭环回到用户。

🟥 频道没有「只读 / 仅管理员发言」策略（`ChannelMode` 只管可见性），公告频道人人可发，内测先靠约定。

## ⑤ 手机端 — `05-mobile-feedback.jpg`

同一套布局已适配，0 代码。

---

## 待定清单

1. **怎么进得去**（②的三选一）——阻塞项。
2. **建几个频道**：只建 `#feedback`，还是 `#feedback / #announcements / #general` 都建。建频道只能 space owner/admin 且必须人类身份。
3. **agent 第 0 阶段**：先只接待（不复现、不建 issue、不带凭证，跑哪都行），还是等云盒一步到位。
4. **100 人上限**：目前代码里没有任何 space 成员上限，要新写；最省事的位置是核心的 `space_member_put`。
