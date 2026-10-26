# github-repo-search

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-1.0.0-green.svg)
![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）加一个工具：`search_github_repos`。
装上之后，Agent 就能自己搜 GitHub 仓库——不用你切浏览器复制粘贴。

纯工具插件，**没有浏览器 UI**，不向页面注入任何代码。

---

## 目录

- [能做什么](#能做什么)
- [快速开始](#快速开始)
- [安装到 DSH](#安装到-dsh)
- [配置 GitHub Token](#配置-github-token)
- [工具参数](#工具参数)
- [返回格式](#返回格式)
- [调用示例](#调用示例)
- [缓存与限流](#缓存与限流)
- [错误处理](#错误处理)
- [项目结构](#项目结构)
- [开发](#开发)
- [实现说明](#实现说明)
- [已知限制](#已知限制)
- [License](#license)

---

## 能做什么

一句话：**把 GitHub 仓库搜索接进 Agent 的工具箱。**

| 特性 | 说明 |
|---|---|
| 🔍 直接搜 GitHub | 调用官方 [`GET /search/repositories`](https://docs.github.com/en/rest/search/search#search-repositories) |
| 🎯 原生搜索语法 | `query` 原样作为 `q` 传入，`language:` / `stars:>` / `topic:` / `in:readme` 全都能用 |
| ⚡ 5 分钟缓存 | 相同 `query + sort + per_page` 命中缓存，零网络请求 |
| 🛡️ 限流保护 | 撞额度时明确报错并给出重置时间，不自动重试 |
| 🔑 可选 Token | 有 `GITHUB_TOKEN` 就走认证，没有就匿名，token 永不回显 |
| 📦 零运行时依赖 | 只用 Node 内置 `fetch`，不引任何 HTTP 库 |

---

## 快速开始

```bash
git clone https://github.com/244884/github-repo-search.git
cd github-repo-search
npm install
npm run check        # 类型检查 → 构建 → 测试
```

`npm run check` 全绿之后，产物在 `lib/`，就可以装进 DSH 了。

---

## 安装到 DSH

本包是标准 DSH bundle（`package.json` 里声明了 `dsh.bundle.patch`），用插件管理器安装：

```text
plugin_manager(action: "install_bundle", target: "<本目录的绝对路径>")
```

安装结果有两种：

| `application` | 含义 |
|---|---|
| `applied` | 首次安装，工具**立即**出现在工具列表里 |
| `restart-required` | 重复安装同一路径（改完代码重新构建后），运行中的 Host 仍持有上一代模块，**重启 DSH** 才会加载新代码 |

装好后验证一下：

```text
cordis_inspect_query(platform: "host", provider: "Tool", method: "listTools")
```

列表里应该能看到 `search_github_repos`，然后直接调用它即可。

> **关于依赖**：装进 profile 后，`@deepseek-ai/dsh-tools` 和 `@deepseek-ai/cordis` 由 Harness 安装目录提供，不需要把 `node_modules` 复制过去。`npm install` 只是为了在本机编译和跑测试。

---

## 配置 GitHub Token

**可以跳过这一步**，匿名也能用，只是额度很低。

| 认证方式 | 搜索额度 |
|---|---|
| 未认证 | 约 10 次/分钟（Search API 单独限额） |
| 带 Token | 约 30 次/分钟 |

### 当前会话临时生效

```powershell
$env:GITHUB_TOKEN = "ghp_xxxxxxxxxxxx"
```

```bash
export GITHUB_TOKEN="ghp_xxxxxxxxxxxx"
```

### 持久化（推荐）

Windows：

```powershell
[Environment]::SetEnvironmentVariable("GITHUB_TOKEN", "ghp_xxxxxxxxxxxx", "User")
```

设置完要**重启 DSH** 才会读到新变量。

### Token 怎么来

1. 打开 https://github.com/settings/tokens
2. **Generate new token (classic)**
3. 勾选 `public_repo` 就够（只搜公开仓库的话，连这个都可以不勾，token 主要作用是提额度）
4. 生成后复制，**只显示一次**

> ⚠️ Token 只放在环境变量里。本插件不会把它写进磁盘、日志、缓存或任何返回文本。

---

## 工具参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `query` | string | ✅ | — | 直接作为 GitHub Search API 的 `q`，**不额外限定搜索字段**，按 GitHub 默认搜索范围 |
| `sort` | enum | ❌ | 不传 | `stars` / `forks` / `updated`，均为降序。不传则用 GitHub 最佳匹配 |
| `per_page` | integer | ❌ | `10` | 返回条数，范围 `1–30`（超出会被夹到边界） |

### 关于翻页

**不支持翻页**，也不接受 `page` 参数。GitHub 单页上限 100 条，但本工具刻意收紧到 30 条，够 Agent 用且不会把上下文撑爆。

需要更多结果时：

- 提高 `per_page`（最多 30）
- 或者**收紧 query**，例如加 `stars:>1000`、`language:typescript`
- 或者换个更精确的关键词再搜一次

### query 写法

`query` 不做任何预处理，GitHub 的搜索限定符全部可用：

```text
mcp server language:typescript          # 语言限定
react stars:>10000                      # star 下限
topic:cli fork:false                    # 按 topic
dsh plugin in:readme                    # 搜 README 内容
user:deepseek-ai                        # 按组织
language:rust created:>2024-01-01       # 按创建时间
```

组合起来更准：

```text
mcp server language:typescript stars:>1000 pushed:>2025-01-01
```

---

## 返回格式

返回**纯文本**，适合 Agent 直接展示给用户。

开头三行是总览：

```text
GitHub 仓库搜索：mcp server language:typescript
匹配总数（total_count）：45,231
排序：stars · 本次返回：3 个 · 不支持翻页
```

下面每个仓库给出 6 个字段：

```text
1. microsoft/playwright-mcp                                   ← full_name
   ★ 38,642 · TypeScript · 更新于 2026-10-26                  ← stars / language / updated_at
   https://github.com/microsoft/playwright-mcp                ← html_url
   Playwright MCP server                                      ← description
```

要点：

- `total_count` 是 GitHub 返回的**总匹配数**，不是本次返回条数
- 描述会被压成单行并截断到 200 字符
- `updated_at` 裁剪成 `YYYY-MM-DD`
- 缺字段时降级为占位符（`（无描述）`、`未标注语言`、`未知`），不会报错

---

## 调用示例

**用户说：**

> 帮我找几个用 TypeScript 写的、star 最多的 MCP server 仓库

**Agent 调用：**

```json
{
  "query": "mcp server language:typescript",
  "sort": "stars",
  "per_page": 3
}
```

**工具返回：**

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

**Agent 接着用：** 可以再补一次 `web_fetch` 读某个仓库的 README，或者直接按返回的 `html_url` 给用户。

---

## 缓存与限流

### 缓存

- 用**进程内 `Map`**，不引任何外部缓存库
- 键：`JSON.stringify([query, sort ?? null, per_page])`
- TTL：**5 分钟**
- 命中时**直接返回缓存文本，不发起网络请求**
- 最多存 100 条，写入时顺带清理过期项，防止长时间运行内存膨胀

注意：缓存是**进程内**的，DSH 重启即清空。

### 限流保护

以下任一情况触发，立即抛错：

- HTTP `403`
- HTTP `429`
- 响应头 `x-ratelimit-remaining: 0`（**即使 HTTP 是 2xx**）

错误信息长这样：

```text
GitHub API 速率限制，请稍后重试。
配额重置时间：2026-10-26 10:15:00 UTC（约 8 分钟后）。
GitHub 返回：API rate limit exceeded for 1.2.3.4.
（HTTP 403；本工具不会自动重试，请稍后再让用户重试。）
提示：未配置 GITHUB_TOKEN，当前使用未认证请求，可能受速率限制。
```

**不会自动重试**——重试只会让额度更紧张。由 Agent 把情况反馈给用户。

---

## 错误处理

所有失败都在 `execute` 里抛出带 `search_github_repos：` 前缀的 `Error`：

| 情况 | 错误信息 |
|---|---|
| `query` 为空 | `query 不能为空，请提供要搜索的仓库关键词。` |
| `query` 过长 | `query 过长（N 字符），GitHub 最多接受 256 个字符。` |
| `sort` 非法 | `sort 只能是 stars、forks、updated 之一，收到 X。` |
| `per_page` 非数字 | `per_page 必须是数字。` |
| 网络/超时（15s） | `访问 GitHub API 失败（fetch failed）。请检查网络连通性或代理设置。` |
| 403 / 429 | 见上文限流保护 |
| 其他非 2xx | `GitHub API 返回 HTTP 401（Unauthorized）：Bad credentials` |
| 响应非 JSON | `GitHub API 返回的内容不是合法 JSON，无法解析搜索结果。` |
| 缺 `total_count`/`items` | `GitHub API 返回的搜索结果缺少 total_count 或 items 字段，无法解析。` |
| 调用方取消 | `请求已取消。` |

参数类型、必填、枚举这些由 `defineTool` 在 **execute 之前**就校验掉了，非法参数会变成 `ToolArgsError`，根本进不到网络请求。

---

## 项目结构

```text
github-repo-search/
├── package.json            # dsh.bundle 声明 + peer/dev 依赖 + scripts
├── cordis.patch.yml        # 一行 insert，把 Host 半身挂进 profile
├── tsconfig.json           # src/ → lib/
├── .gitignore
├── icon.svg                # 插件管理卡片图标
├── README.md
├── locale/
│   ├── zh.json             # 管理界面的标题与描述（中文）
│   └── en.json             # 同上（英文）
├── src/
│   ├── index.ts            # 插件入口：导出 apply(ctx)，注册工具
│   └── github.ts           # 请求 / 缓存 / 限流 / 文本渲染
├── test/
│   └── github.test.mjs     # 20 个用例，桩掉 fetch，不访问网络
└── lib/                    # npm run build 产物（入口指向这里）
    ├── index.js
    ├── github.js
    └── types/*.d.ts
```

`lib/` 一并提交，好处是别人 clone 之后**不构建也能直接装进 DSH**（`package.json` 的入口指向 `lib/index.js`）。

---

## 开发

```bash
npm install          # 安装 dev 依赖
npm run typecheck    # 仅类型检查
npm run build        # 编译 src/ → lib/
npm test             # 跑测试（20 个用例）
npm run check        # typecheck + build + test 一条龙
```

### 测试覆盖面

测试全程把 `globalThis.fetch` 换成本地桩函数，**不访问网络**：

- 参数归一化：默认值、`per_page` 夹取、空 query、非法 sort
- URL 构造：只带 `q` / `sort` / `per_page`，确认没有 `page` 和 `order`
- 缓存键：区分 query / sort / per_page 的任意组合
- 缓存行为：命中不重复请求、参数不同绕过缓存、TTL 过期
- Token：未配置不发 `Authorization`、配置了用 `Bearer`、返回文本不回显
- 限流：403 / 429 / `x-ratelimit-remaining: 0` 三个分支都抛错
- 异常：其他非 2xx、非 JSON、缺字段、网络错误、调用方取消
- 渲染：六个字段齐全、空结果提示、缺字段降级

> 测试脚本用了 `--test-isolation=none`：部分沙箱环境里 Node 默认的「每个测试文件起一个子进程」会因 EPERM 失败，进程内跑则正常。

### 改完代码之后

```bash
npm run check
```

然后在 DSH 里重新 `install_bundle` 同一个路径。**注意**：重复安装会返回 `restart-required`，需要重启 DSH 才会加载新代码。

---

## 实现说明

### 为什么用 `defineTool`

`@deepseek-ai/dsh-tools` 的 `defineTool` 会：

1. 把参数 schema 编译成 JSON Schema 交给模型
2. 在 `execute` 之前校验参数（非法参数根本到不了 `execute`）
3. 校验返回值是否符合 `output.schema`

所以 `execute` 里可以专心处理业务逻辑。

### 参数 schema 的一个细节

`per_page` 声明成 `integer` 但**没有**声明最小/最大值——`defineTool` 的 schema DSL 不支持 `minimum`/`maximum`。范围夹取放在 `resolveSearchInput()` 里做，超出就夹到 `1` 或 `30`，不报错。

### 请求头

```http
Accept: application/vnd.github+json
User-Agent: dsh-github-repo-search
X-GitHub-Api-Version: 2022-11-28
Authorization: Bearer <token>        # 仅在 GITHUB_TOKEN 存在时
```

`User-Agent` 是 GitHub 强制要求的，缺了直接 403。

### 超时

- 内部请求超时 **15 秒**（`AbortSignal.timeout`）
- 工具声明 `timeoutMs: 20000`，给请求留余量
- 调用方的取消信号通过 `AbortSignal.any()` 与超时合并，任一触发都中断

### 并发

`isConcurrencySafe: () => true`——只读的搜索，多个可以并行跑。

---

## 已知限制

- **不能翻页**：设计上就不做，见[关于翻页](#关于翻页)
- **缓存是进程内的**：多进程不共享，重启即失效
- **未认证额度低**：Search API 对匿名请求限制很紧，建议配 token
- **`per_page` 上限 30**：比 GitHub 允许的 100 更严格，为了避免撑爆上下文
- **只读**：不涉及创建、修改、删除任何仓库资源
- **描述截断**：超过 200 字符会被截断并加 `…`

---

## License

[MIT](./LICENSE)

---

## 相关链接

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [GitHub Search API 文档](https://docs.github.com/en/rest/search/search#search-repositories)
- [GitHub 搜索语法](https://docs.github.com/en/search-github/getting-started-with-searching-on-github/understanding-the-search-syntax)
