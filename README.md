# github-repo-search

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）注册一个工具：`search_github_repos`。
Agent 用它直接搜索 GitHub 仓库，无需浏览器 UI。

## 能力

- 工具 `search_github_repos`，参数：
  - `query`（必填）：直接作为 GitHub Search API 的 `q`，不额外限定搜索字段，因此 `language:`、`stars:`、`topic:`、`in:readme` 等 GitHub 搜索语法都能用；
  - `sort`（可选）：`stars` / `forks` / `updated`，默认不传（GitHub 最佳匹配）；
  - `per_page`（可选）：1–30，默认 10。
- **不支持翻页**，不接收 `page` 参数；需要更多结果请提高 `per_page` 或收紧 query。
- 返回纯文本列表：开头是 `total_count`，每个仓库给出 `full_name`、`stars`、`language`、`updated_at`、`html_url`、`description`。
- 认证：优先读环境变量 `GITHUB_TOKEN`，存在时作为 `Authorization: Bearer <token>`；未配置则以未认证方式请求。token 不会出现在任何返回文本里。
- **内存缓存**：相同 `query + sort + per_page` 组合缓存 5 分钟，命中时零网络请求。
- **限流保护**：HTTP 403 / 429，或 `x-ratelimit-remaining: 0` 时抛出「GitHub API 速率限制，请稍后重试」并带重置时间；**不自动重试**。

## 目录

```
github-repo-search/
├── package.json          # dsh.bundle 声明 + peer/dev 依赖
├── cordis.patch.yml      # 一行 insert，把 Host 半身挂进 profile
├── tsconfig.json         # 源码 src/ → 产物 lib/
├── icon.svg
├── locale/{zh,en}.json   # 插件管理卡片上的标题与描述
├── src/
│   ├── index.ts          # 插件入口：导出 apply(ctx)，注册工具
│   └── github.ts         # 请求、缓存、限流、文本渲染（可独立测试）
├── test/github.test.mjs  # node --test，桩掉 fetch，不访问网络
└── lib/                  # npm run build 产物（入口指向这里）
```

## 安装与构建

```powershell
# 1. 安装依赖（peer 依赖由 Harness 运行时提供，这里装一份用于编译）
npm install

# 2. 类型检查 + 测试 + 构建
npm run check

# 3. 只构建
npm run build
```

产物结构：

```
lib/index.js        # 插件入口（package.json 的 main/exports 指向它）
lib/github.js
lib/types/*.d.ts
```

## 装进 DSH

本插件是标准 bundle（`package.json` 里有 `dsh.bundle.patch`），用插件管理器安装：

```text
plugin_manager(action: "install_bundle", target: "<本目录的绝对路径>")
```

首次安装是 `application: applied`，工具会立刻出现在工具列表里；**再次安装同一路径**
（即改完代码重建后）会返回 `application: restart-required` —— 运行中的 Host 仍持有上一代
模块，重启 DSH 后才会加载新代码。

安装后调用 `cordis_inspect_query(platform: "host", provider: "Tool", method: "listTools")`
应能在工具列表里看到 `search_github_repos`，然后直接调用它即可。

> 装进 profile 后，依赖由 Harness 安装目录提供：插件只 import
> `@deepseek-ai/dsh-tools` 和 `@deepseek-ai/cordis`，两者都已在运行时的解析范围内，
> 因此不需要把 `node_modules` 一起复制过去（`npm install` 只为本机编译与测试服务）。

## 配置 GitHub Token（可选）

未配置 token 也能用，但 GitHub 对未认证请求的额度很低（每小时 60 次搜索）。

```powershell
# 当前会话
$env:GITHUB_TOKEN = "ghp_xxx"

# 想持久化，就写进用户环境变量，然后重启 DSH
[Environment]::SetEnvironmentVariable("GITHUB_TOKEN", "ghp_xxx", "User")
```

## 测试

```powershell
npm test
```

用例覆盖：参数归一化与夹取、URL 只带三个参数、缓存键与 TTL、token 读写与不回显、
403/429/`x-ratelimit-remaining: 0` 的限流分支、其他非 2xx、非 JSON、结构异常、
网络错误与取消。

## 调用示例

用户：「帮我找几个用 TypeScript 写的、star 最多的 MCP server 仓库」

Agent 调用：

```json
{ "query": "mcp server language:typescript", "sort": "stars", "per_page": 3 }
```

工具返回：

```text
GitHub 仓库搜索：mcp server language:typescript
匹配总数（total_count）：45,231
排序：stars · 本次返回：3 个 · 不支持翻页

1. microsoft/playwright-mcp
   ★ 38,642 · TypeScript · 更新于 2026-10-26
   https://github.com/microsoft/playwright-mcp
   Playwright MCP server

2. DayuanJiang/next-ai-draw-io
   ★ 36,415 · TypeScript · 更新于 2026-10-26
   https://github.com/DayuanJiang/next-ai-draw-io
   Draw and edit draw.io diagrams by chatting with an AI. Web app, desktop app, and an MCP server for Claude Code, Cursor, Codex and VS Code.

3. activepieces/activepieces
   ★ 25,229 · TypeScript · 更新于 2026-10-26
   https://github.com/activepieces/activepieces
   AI Agents & MCPs & AI Workflow Automation • (~400 MCP servers for AI agents) • AI Automation / AI Agent with MCPs • AI Workflows & AI Agents • MCPs for AI Agents
```

## 行为细节

| 情况 | 行为 |
|---|---|
| 命中缓存 | 直接返回缓存文本，不发请求 |
| 403 / 429 / `x-ratelimit-remaining: 0` | 抛错：速率限制 + 重置时间 + 未配置 token 的提示 |
| 其他非 2xx | 抛错：HTTP 状态码 + GitHub 的 message |
| 非 JSON / 缺字段 | 抛错：解析失败 |
| 网络错误 / 超时（15s） | 抛错：访问 GitHub API 失败 |
| 调用方取消 | 抛错：请求已取消 |
