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
export const SEARCH_ENDPOINT = 'https://api.github.com/search/repositories';
/** 缓存有效期：5 分钟。 */
export const CACHE_TTL_MS = 5 * 60 * 1000;
/** 单次请求的协作式超时；工具自身的 `timeoutMs` 比它略长。 */
export const REQUEST_TIMEOUT_MS = 15_000;
/** `per_page` 的默认值与上限（GitHub Search API 单页最多 100，本工具刻意收紧到 30）。 */
const DEFAULT_PER_PAGE = 10;
const MAX_PER_PAGE = 30;
/** `q` 参数的长度上限，超出会被 GitHub 直接拒绝。 */
const MAX_QUERY_LENGTH = 256;
/** 缓存条目上限，防止长时间运行时内存无限增长。 */
const CACHE_MAX_ENTRIES = 100;
/** GitHub 要求的 User-Agent，同时也是本插件的标识。 */
const USER_AGENT = 'dsh-github-repo-search';
/** 允许的排序字段。 */
export const SORT_KEYS = ['stars', 'forks', 'updated'];
/** 简单的进程内缓存，键为 query + sort + per_page 的组合。 */
const cache = new Map();
/** 数值千分位格式化，固定 en-US 以免随系统区域变化。 */
const numberFormat = new Intl.NumberFormat('en-US');
/** 清空缓存（仅供测试使用）。 */
export function clearSearchCache() {
    cache.clear();
}
/** 当前缓存条目数（仅供测试使用）。 */
export function searchCacheSize() {
    return cache.size;
}
/**
 * 归一化模型给出的参数：裁剪空白、校验 query、把 per_page 夹到 1–30。
 * @param input - 未经校验的工具参数。
 * @returns 可直接用于请求与缓存键的参数。
 */
export function resolveSearchInput(input) {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (query.length === 0) {
        throw new Error('search_github_repos：query 不能为空，请提供要搜索的仓库关键词。');
    }
    if (query.length > MAX_QUERY_LENGTH) {
        throw new Error(`search_github_repos：query 过长（${query.length} 字符），GitHub 最多接受 ${MAX_QUERY_LENGTH} 个字符。`);
    }
    let sort;
    if (input.sort !== undefined && input.sort !== null) {
        if (!SORT_KEYS.includes(input.sort)) {
            throw new Error(`search_github_repos：sort 只能是 ${SORT_KEYS.join('、')} 之一，收到 ${String(input.sort)}。`);
        }
        sort = input.sort;
    }
    let perPage = DEFAULT_PER_PAGE;
    if (input.per_page !== undefined && input.per_page !== null) {
        if (typeof input.per_page !== 'number' || !Number.isFinite(input.per_page)) {
            throw new Error('search_github_repos：per_page 必须是数字。');
        }
        perPage = Math.min(MAX_PER_PAGE, Math.max(1, Math.trunc(input.per_page)));
    }
    return { query, sort, perPage };
}
/** 缓存键：相同的 query + sort + per_page 组合共享一份结果。 */
export function cacheKeyFor(input) {
    return JSON.stringify([input.query, input.sort ?? null, input.perPage]);
}
/** 构造搜索 URL（不含任何凭据）。 */
export function buildSearchUrl(input) {
    const url = new URL(SEARCH_ENDPOINT);
    url.searchParams.set('q', input.query);
    // 不传 order，交给 GitHub 的默认顺序（stars/forks/updated 均为降序）。
    if (input.sort !== undefined)
        url.searchParams.set('sort', input.sort);
    url.searchParams.set('per_page', String(input.perPage));
    return url;
}
/**
 * 读取 `GITHUB_TOKEN`。只读取、不回显；未配置时返回 undefined 并以未认证方式请求。
 * @returns 去除首尾空白后的 token，或 undefined。
 */
export function readGithubToken() {
    const raw = process.env.GITHUB_TOKEN;
    if (typeof raw !== 'string')
        return undefined;
    const token = raw.trim();
    return token.length === 0 ? undefined : token;
}
/** 组装请求头；token 只出现在 Authorization 里，绝不进入任何返回文本。 */
function buildHeaders(token) {
    const headers = {
        Accept: 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token !== undefined)
        headers.Authorization = `Bearer ${token}`;
    return headers;
}
/** 未配置 token 时追加到错误信息里的提示（不会出现在正常结果中）。 */
function unauthenticatedHint(token) {
    return token === undefined
        ? '提示：未配置 GITHUB_TOKEN，当前使用未认证请求，可能受速率限制。'
        : '';
}
/** 把 `x-ratelimit-reset`（Unix 秒）渲染成可读时间加上剩余分钟数。 */
function formatResetTime(headers) {
    const reset = headers.get('x-ratelimit-reset');
    if (reset === null || reset.trim() === '')
        return '';
    const seconds = Number(reset);
    if (!Number.isFinite(seconds) || seconds <= 0)
        return '';
    const at = new Date(seconds * 1000);
    const iso = `${at.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
    const remainingMs = at.getTime() - Date.now();
    const minutes = Math.ceil(remainingMs / 60_000);
    return minutes > 0 ? `${iso}（约 ${minutes} 分钟后）` : iso;
}
/** 判断响应是否表示配额耗尽。 */
function isRateLimited(status, headers) {
    if (status === 403 || status === 429)
        return true;
    const remaining = headers.get('x-ratelimit-remaining');
    return remaining !== null && remaining.trim() === '0';
}
/** 构造速率限制错误；信息里带上重置时间、GitHub 的原始说明与未认证提示。 */
function rateLimitError(status, headers, bodyText) {
    const parts = ['GitHub API 速率限制，请稍后重试。'];
    const reset = formatResetTime(headers);
    if (reset !== '')
        parts.push(`配额重置时间：${reset}。`);
    const retryAfter = headers.get('retry-after');
    if (retryAfter !== null && retryAfter.trim() !== '') {
        parts.push(`GitHub 建议 ${retryAfter.trim()} 秒后再试。`);
    }
    const upstream = extractUpstreamMessage(bodyText);
    if (upstream !== '')
        parts.push(`GitHub 返回：${upstream}`);
    parts.push(`（HTTP ${status}；本工具不会自动重试，请稍后再让用户重试。）`);
    const hint = unauthenticatedHint(readGithubToken());
    if (hint !== '')
        parts.push(hint);
    return new Error(parts.join(''));
}
/**
 * 从错误响应体里取出 GitHub 的 `message`。
 *
 * 合法 JSON 但没有 `message`（例如配额归零时返回的正常搜索结果）时不返回任何原文，
 * 避免把整段 JSON 塞进错误信息；只有非 JSON 的错误页才退回截断的原文。
 */
function extractUpstreamMessage(bodyText) {
    const trimmed = bodyText.trim();
    if (trimmed === '')
        return '';
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === 'object' && 'message' in parsed) {
            const { message } = parsed;
            if (typeof message === 'string' && message.trim() !== '')
                return message.trim();
        }
        return '';
    }
    catch {
        // 非 JSON 响应：退回到截断的原文。
    }
    return trimmed.slice(0, 200);
}
/** 校验并收窄 GitHub 的响应体，字段缺失时抛出可读错误。 */
function parseSearchResponse(bodyText) {
    let parsed;
    try {
        parsed = JSON.parse(bodyText);
    }
    catch {
        throw new Error('GitHub API 返回的内容不是合法 JSON，无法解析搜索结果。');
    }
    if (parsed === null || typeof parsed !== 'object') {
        throw new Error('GitHub API 返回的搜索结果结构异常，无法解析。');
    }
    const record = parsed;
    if (typeof record.total_count !== 'number' || !Array.isArray(record.items)) {
        throw new Error('GitHub API 返回的搜索结果缺少 total_count 或 items 字段，无法解析。');
    }
    const items = [];
    for (const raw of record.items) {
        if (raw === null || typeof raw !== 'object')
            continue;
        const item = raw;
        items.push({
            full_name: typeof item.full_name === 'string' ? item.full_name : '(未知仓库)',
            description: typeof item.description === 'string' ? item.description : null,
            stargazers_count: typeof item.stargazers_count === 'number' ? item.stargazers_count : 0,
            language: typeof item.language === 'string' ? item.language : null,
            updated_at: typeof item.updated_at === 'string' ? item.updated_at : '',
            html_url: typeof item.html_url === 'string' ? item.html_url : '',
        });
    }
    return { total_count: record.total_count, items };
}
/** 把 ISO 时间裁剪成 `YYYY-MM-DD`；无法解析时原样返回。 */
function formatUpdatedAt(updatedAt) {
    if (updatedAt === '')
        return '未知';
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(updatedAt);
    return match?.[1] ?? updatedAt;
}
/** 把描述压成单行并截断，避免列表被超长文本撑爆。 */
function formatDescription(description) {
    if (description === null)
        return '（无描述）';
    const singleLine = description.replace(/\s+/gu, ' ').trim();
    if (singleLine === '')
        return '（无描述）';
    return singleLine.length <= 200 ? singleLine : `${singleLine.slice(0, 197)}…`;
}
/**
 * 把搜索结果渲染成简洁的纯文本列表。
 * @param response - GitHub 返回的 total_count 与 items。
 * @param input - 归一化后的搜索参数。
 * @returns 可直接作为工具文本返回的多行字符串。
 */
export function formatSearchResult(response, input) {
    const total = numberFormat.format(response.total_count);
    const sortLabel = input.sort === undefined ? '默认（最佳匹配）' : input.sort;
    const lines = [
        `GitHub 仓库搜索：${input.query}`,
        `匹配总数（total_count）：${total}`,
        `排序：${sortLabel} · 本次返回：${response.items.length} 个 · 不支持翻页`,
    ];
    if (response.items.length === 0) {
        lines.push('', '没有找到匹配的仓库。可以尝试更换关键词，或用 GitHub 搜索语法缩小范围（如 language:typescript stars:>500）。');
    }
    else {
        lines.push('');
        response.items.forEach((item, index) => {
            lines.push(`${index + 1}. ${item.full_name}`);
            lines.push(`   ★ ${numberFormat.format(item.stargazers_count)} · ${item.language ?? '未标注语言'} · 更新于 ${formatUpdatedAt(item.updated_at)}`);
            if (item.html_url !== '')
                lines.push(`   ${item.html_url}`);
            lines.push(`   ${formatDescription(item.description)}`);
            if (index < response.items.length - 1)
                lines.push('');
        });
    }
    return lines.join('\n');
}
/** 组合调用方信号与请求超时；任一触发都会中断 fetch。 */
function requestSignal(callerSignal) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout]);
}
/** 如果命中未过期缓存，返回缓存文本。 */
function readCache(key) {
    const entry = cache.get(key);
    if (entry === undefined)
        return undefined;
    if (entry.expiresAt <= Date.now()) {
        cache.delete(key);
        return undefined;
    }
    return entry.text;
}
/** 写入缓存并顺带清理过期条目与超量条目。 */
function writeCache(key, text) {
    const now = Date.now();
    for (const [existingKey, entry] of cache) {
        if (entry.expiresAt <= now)
            cache.delete(existingKey);
    }
    if (cache.size >= CACHE_MAX_ENTRIES && !cache.has(key)) {
        const oldest = cache.keys().next();
        if (!oldest.done)
            cache.delete(oldest.value);
    }
    cache.set(key, { text, expiresAt: now + CACHE_TTL_MS });
}
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
export async function searchRepositories(input, callerSignal) {
    const resolved = resolveSearchInput(input);
    const key = cacheKeyFor(resolved);
    const cached = readCache(key);
    if (cached !== undefined)
        return cached;
    const token = readGithubToken();
    let response;
    try {
        response = await globalThis.fetch(buildSearchUrl(resolved), {
            method: 'GET',
            headers: buildHeaders(token),
            signal: requestSignal(callerSignal),
        });
    }
    catch (error) {
        if (callerSignal?.aborted === true) {
            throw new Error('search_github_repos：请求已取消。');
        }
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error(`search_github_repos：访问 GitHub API 失败（${cause}）。请检查网络连通性或代理设置。`);
    }
    let bodyText = '';
    try {
        bodyText = await response.text();
    }
    catch {
        throw new Error(`search_github_repos：读取 GitHub API 响应失败（HTTP ${response.status}）。`);
    }
    // 403 / 429 / `x-ratelimit-remaining: 0` 一律视为额度耗尽并抛错（即使 HTTP 是 2xx，
    // 配额已归零时继续请求只会失败，交给 Agent 反馈比返回一份注定无法续查的结果更明确）。
    if (isRateLimited(response.status, response.headers)) {
        throw rateLimitError(response.status, response.headers, bodyText);
    }
    if (!response.ok) {
        const upstream = extractUpstreamMessage(bodyText);
        const message = upstream === '' ? '' : `：${upstream}`;
        throw new Error(`search_github_repos：GitHub API 返回 HTTP ${response.status}（${response.statusText}）${message}`);
    }
    const parsed = parseSearchResponse(bodyText);
    const text = formatSearchResult(parsed, resolved);
    writeCache(key, text);
    return text;
}
