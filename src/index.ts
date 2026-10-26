/**
 * github-repo-search — 插件入口（Host 半身）。
 *
 * 只做一件事：注册 `search_github_repos`，让 Agent 能直接搜索 GitHub 仓库。
 * 纯工具插件，没有浏览器 UI：package.json 不声明 `dsh.client`，加载器因此
 * 不会向页面注入任何代码。
 *
 * @module github-repo-search
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { searchRepositories, type RepoSearchInput, type RepoSort } from './github.js'

/** 加载器诊断使用的插件名。 */
export const name = 'github-repo-search'

/** 本插件只依赖工具注册表。 */
export const inject = ['tools']

/** 工具名，同时作为系统提示词段落的定位标识。 */
const TOOL_NAME = 'search_github_repos'

/** 协作式工具调用预算：比内部的 15 秒请求超时留出余量。 */
const TOOL_TIMEOUT_MS = 20_000

/** 把 `search_github_repos` 注册进工具注册表。 */
function applyRepoSearchTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: TOOL_NAME,
      description:
        'Search GitHub repositories through the GitHub Search API. Returns total_count and a plain-text list of matching repositories with full_name, description, stargazers_count, language, updated_at, and html_url. Read-only and not paginated: raise per_page (max 30) or narrow the query instead of paging.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description:
            'Required. Passed straight to the GitHub Search API as the q parameter, with no extra field restriction, so GitHub search qualifiers such as language:typescript, stars:>500, topic:cli, or in:readme all work. Example: "mcp server language:typescript stars:>1000".',
        },
        sort: {
          type: 'string',
          enum: ['stars', 'forks', 'updated'],
          description:
            'Optional. Sort field for the GitHub Search API: stars, forks, or updated (each descending). Omit for GitHub\'s best-match ordering.',
        },
        per_page: {
          type: 'integer',
          description: 'Optional. Number of repositories to return, 1–30. Defaults to 10. Pages are not supported.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return searchRepositories(args as RepoSearchInput, exec.signal)
      },
    }),
  )
}

/**
 * 挂载插件。
 * @param ctx - 提供 `tools` 注册表的 Host 上下文；注册在插件 dispose 时回收。
 */
export function apply(ctx: Context): void {
  applyRepoSearchTool(ctx)
}

/** 明确导出枚举值，方便调用方复用同一份取值。 */
export type { RepoSort }
