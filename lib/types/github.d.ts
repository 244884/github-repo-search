/**
 * GitHub 仓库搜索的 Host 侧实现：请求 GitHub Search API、五分钟内存缓存、
 * 速率限制保护与面向模型的可读文本渲染。
 *
 * 该模块不依赖 Harness 的任何运行时对象，因此既能被工具入口直接调用，
 * 也能在 `node --test` 中单独测试。
 *
 * @module github-repo-search/github
 */
/** GitHub 仓库搜索端点。 */
export declare const SEARCH_ENDPOINT = "https://api.github.com/search/repositories";
/** 缓存有效期：5 分钟。 */
export declare const CACHE_TTL_MS: number;
/** 单次请求的协作式超时；工具自身的 `timeoutMs` 比它略长。 */
export declare const REQUEST_TIMEOUT_MS = 15000;
/** 允许的排序字段。 */
export declare const SORT_KEYS: readonly ["stars", "forks", "updated"];
/** 排序字段的联合类型。 */
export type RepoSort = (typeof SORT_KEYS)[number];
/** 工具参数（与 `defineTool` 声明保持一致）。 */
export interface RepoSearchInput {
    readonly query: string;
    readonly sort?: RepoSort;
    readonly per_page?: number;
}
/** 归一化之后的搜索参数。 */
export interface ResolvedRepoSearchInput {
    readonly query: string;
    readonly sort: RepoSort | undefined;
    readonly perPage: number;
}
/** GitHub 仓库对象中本工具会读取的字段。 */
export interface RepoItem {
    readonly full_name: string;
    readonly description: string | null;
    readonly stargazers_count: number;
    readonly language: string | null;
    readonly updated_at: string;
    readonly html_url: string;
}
/** `/search/repositories` 响应中本工具会读取的字段。 */
export interface RepoSearchResponse {
    readonly total_count: number;
    readonly items: readonly RepoItem[];
}
/** 清空缓存（仅供测试使用）。 */
export declare function clearSearchCache(): void;
/** 当前缓存条目数（仅供测试使用）。 */
export declare function searchCacheSize(): number;
/**
 * 归一化模型给出的参数：裁剪空白、校验 query、把 per_page 夹到 1–30。
 * @param input - 未经校验的工具参数。
 * @returns 可直接用于请求与缓存键的参数。
 */
export declare function resolveSearchInput(input: RepoSearchInput): ResolvedRepoSearchInput;
/** 缓存键：相同的 query + sort + per_page 组合共享一份结果。 */
export declare function cacheKeyFor(input: ResolvedRepoSearchInput): string;
/** 构造搜索 URL（不含任何凭据）。 */
export declare function buildSearchUrl(input: ResolvedRepoSearchInput): URL;
/**
 * 读取 `GITHUB_TOKEN`。只读取、不回显；未配置时返回 undefined 并以未认证方式请求。
 * @returns 去除首尾空白后的 token，或 undefined。
 */
export declare function readGithubToken(): string | undefined;
/**
 * 把搜索结果渲染成简洁的纯文本列表。
 * @param response - GitHub 返回的 total_count 与 items。
 * @param input - 归一化后的搜索参数。
 * @returns 可直接作为工具文本返回的多行字符串。
 */
export declare function formatSearchResult(response: RepoSearchResponse, input: ResolvedRepoSearchInput): string;
/**
 * 搜索 GitHub 仓库，命中缓存时直接返回缓存文本且不发起网络请求。
 *
 * 失败语义：网络错误、非 2xx（含 403/429）、`x-ratelimit-remaining: 0`、JSON 解析失败都会
 * 抛出带明确信息的 Error；不会自动重试，以免加重限流。
 *
 * @param input - 工具参数，会在内部归一化。
 * @param callerSignal - 工具运行上下文提供的取消信号。
 * @returns 面向模型的纯文本结果。
 */
export declare function searchRepositories(input: RepoSearchInput, callerSignal?: AbortSignal): Promise<string>;
