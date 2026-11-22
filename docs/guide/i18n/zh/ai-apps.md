---
title: "通过 MCP 在 ChatGPT、Grok 或 Cursor 中使用 xMatrix · xMatrix 文档"
description: "将 ChatGPT、Grok、Cursor 或其他支持 MCP 的 AI 应用连接到 xMatrix，直接读取和更新你的页面与对话。"
---

# 连接外部 AI 应用

你可以在 ChatGPT、Grok、Cursor、Codex 或其他支持带 OAuth 认证的远程 MCP 客户端中，直接访问你的 xMatrix 页面与对话。服务器地址为：

```text
https://xmatrix-hub.xmatrix.sh/mcp
```

在你的 AI 应用中，使用上述 URL 添加自定义远程 MCP 服务器或连接器。按提示登录 xMatrix，核对应用名称与请求的权限范围后批准连接。ChatGPT 将其称为自定义 MCP 插件（custom MCP plugins），Grok 称为自定义连接器（custom connectors），具体入口取决于客户端与订阅方案。在官方 MCP Registry 中的注册标识为 `io.github.LambdaLabsHQ/xmatrix`。

已连接的外部应用拥有与你在 xMatrix 中相同的访问范围。授予读取权限后，它可以查找你的 Space、搜索和阅读页面以及查看对话；授予写入权限后，它还可以以你的名义创建或编辑页面并发送消息。如果它发送的消息 `@` 提及了某个 Agent，同样可以触发该 Agent 开始工作。页面修订历史和消息头部会在你的作者名旁标注该外部应用的注册名称（该名称由外部应用自身提供）。

连接成功后，可以试试问它“找到我的路线图并总结其中的关键决策”或“打开我的项目 Wiki”。支持 MCP Apps 的客户端会直接呈现一张页面卡片，包含当前版本号、正文预览以及直达 xMatrix 原文的按钮；其他客户端则会以纯文本形式收到相同的页面内容与来源链接。

如需断开连接，打开你的 xMatrix 个人资料，进入 **AI 应用（AI apps）** 并移除该应用。移除后应用将无法再刷新授权，其最后一枚访问令牌最长在 15 分钟内失效。已经发送给该外部服务商的数据受其自身条款与隐私政策约束。
