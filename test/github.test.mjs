/**
 * github-repo-search 的行为测试。
 *
 * 直接针对构建产物 `lib/` 运行，因此这些用例同时验证 TypeScript 编译结果。
 * 全程把 `globalThis.fetch` 换成本地桩函数，不会真的访问 GitHub。
 *
 * 运行：npm test
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  CACHE_TTL_MS,
  buildSearchUrl,
  cacheKeyFor,
  clearSearchCache,
  formatSearchResult,
  resolveSearchInput,
  searchCacheSize,
  searchRepositories,
} from '../lib/github.js'

/** 一条最小可用的 GitHub 仓库记录。 */
const item = {
  full_name: 'deepseek-ai/awesome-stuff',
  description: 'A useful repository\nwith a line break',
  stargazers_count: 12345,
  language: 'TypeScript',
  updated_at: '2026-03-04T05:06:07Z',
  html_url: 'https://github.com/deepseek-ai/awesome-stuff',
}

/** 构造一个 2xx 的 GitHub 风格响应。 */
function okResponse(body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '57', ...headers },
  })
}

describe('参数归一化', () => {
  it('默认 per_page 为 10，且不产生 sort', () => {
    const resolved = resolveSearchInput({ query: '  mcp server  ' })
    assert.equal(resolved.query, 'mcp server')
    assert.equal(resolved.sort, undefined)
    assert.equal(resolved.perPage, 10)
  })

  it('per_page 被夹到 1–30', () => {
    assert.equal(resolveSearchInput({ query: 'x', per_page: 0 }).perPage, 1)
    assert.equal(resolveSearchInput({ query: 'x', per_page: 99 }).perPage, 30)
    assert.equal(resolveSearchInput({ query: 'x', per_page: 7.9 }).perPage, 7)
  })

  it('空 query 与非法 sort 会抛出可读错误', () => {
    assert.throws(() => resolveSearchInput({ query: '   ' }), /query 不能为空/u)
    assert.throws(() => resolveSearchInput({ query: 'x', sort: 'wat' }), /sort 只能是/u)
  })

  it('URL 只带 q、sort、per_page，且不限定搜索字段', () => {
    const url = buildSearchUrl(resolveSearchInput({ query: 'react hooks', sort: 'stars', per_page: 5 }))
    assert.equal(url.origin + url.pathname, 'https://api.github.com/search/repositories')
    assert.equal(url.searchParams.get('q'), 'react hooks')
    assert.equal(url.searchParams.get('sort'), 'stars')
    assert.equal(url.searchParams.get('per_page'), '5')
    assert.equal(url.searchParams.has('page'), false)
    assert.equal(url.searchParams.has('order'), false)
  })

  it('缓存键区分 query / sort / per_page 的任意组合', () => {
    const base = resolveSearchInput({ query: 'a' })
    assert.equal(cacheKeyFor(base), cacheKeyFor(resolveSearchInput({ query: 'a', per_page: 10 })))
    assert.notEqual(cacheKeyFor(base), cacheKeyFor(resolveSearchInput({ query: 'a', sort: 'stars' })))
    assert.notEqual(cacheKeyFor(base), cacheKeyFor(resolveSearchInput({ query: 'a', per_page: 11 })))
    assert.notEqual(cacheKeyFor(base), cacheKeyFor(resolveSearchInput({ query: 'b' })))
  })
})

describe('文本渲染', () => {
  it('包含 total_count 与每个仓库的六个字段', () => {
    const text = formatSearchResult(
      { total_count: 56150, items: [item] },
      resolveSearchInput({ query: 'awesome', sort: 'stars' }),
    )
    assert.match(text, /total_count）：56,150/u)
    assert.match(text, /deepseek-ai\/awesome-stuff/u)
    assert.match(text, /★ 12,345/u)
    assert.match(text, /TypeScript/u)
    assert.match(text, /更新于 2026-03-04/u)
    assert.match(text, /https:\/\/github\.com\/deepseek-ai\/awesome-stuff/u)
    assert.match(text, /A useful repository with a line break/u)
    assert.match(text, /不支持翻页/u)
  })

  it('空结果给出可操作的建议', () => {
    const text = formatSearchResult({ total_count: 0, items: [] }, resolveSearchInput({ query: 'zzz' }))
    assert.match(text, /没有找到匹配的仓库/u)
  })

  it('缺字段的仓库退化为占位符而不是崩溃', () => {
    const text = formatSearchResult(
      { total_count: 1, items: [{ full_name: 'only/name', description: null, stargazers_count: 0, language: null, updated_at: '', html_url: '' }] },
      resolveSearchInput({ query: 'x' }),
    )
    assert.match(text, /only\/name/u)
    assert.match(text, /★ 0 · 未标注语言 · 更新于 未知/u)
    assert.match(text, /（无描述）/u)
  })
})

describe('searchRepositories', () => {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.GITHUB_TOKEN
  let calls

  beforeEach(() => {
    calls = []
    clearSearchCache()
    delete process.env.GITHUB_TOKEN
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = originalToken
    clearSearchCache()
  })

  it('未配置 token 时不发送 Authorization，也不在文本里提及 token', async () => {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      return okResponse({ total_count: 1, items: [item] })
    }
    const text = await searchRepositories({ query: 'awesome' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].init.headers.Authorization, undefined)
    assert.equal(calls[0].init.headers['User-Agent'], 'dsh-github-repo-search')
    assert.equal(calls[0].init.headers.Accept, 'application/vnd.github+json')
    assert.doesNotMatch(text, /token|GITHUB_TOKEN/iu)
  })

  it('配置 token 时使用 Authorization: Bearer，且不回显 token', async () => {
    process.env.GITHUB_TOKEN = '  ghp_example_token  '
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      return okResponse({ total_count: 1, items: [item] })
    }
    const text = await searchRepositories({ query: 'awesome' })
    assert.equal(calls[0].init.headers.Authorization, 'Bearer ghp_example_token')
    assert.doesNotMatch(text, /ghp_example_token/u)
  })

  it('相同 query + sort + per_page 命中缓存，不发起第二次请求', async () => {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      return okResponse({ total_count: 1, items: [item] })
    }
    const first = await searchRepositories({ query: 'awesome', sort: 'stars', per_page: 3 })
    const second = await searchRepositories({ query: 'awesome', sort: 'stars', per_page: 3 })
    assert.equal(calls.length, 1)
    assert.equal(second, first)
    assert.equal(searchCacheSize(), 1)
  })

  it('参数不同则绕过缓存', async () => {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      return okResponse({ total_count: 2, items: [item] })
    }
    await searchRepositories({ query: 'awesome' })
    await searchRepositories({ query: 'awesome', sort: 'forks' })
    await searchRepositories({ query: 'awesome', per_page: 2 })
    assert.equal(calls.length, 3)
  })

  it('过期缓存会失效（TTL 为 5 分钟）', async () => {
    assert.equal(CACHE_TTL_MS, 5 * 60 * 1000)
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      return okResponse({ total_count: 1, items: [item] })
    }
    await searchRepositories({ query: 'awesome' })
    const realNow = Date.now
    Date.now = () => realNow() + CACHE_TTL_MS + 1
    try {
      await searchRepositories({ query: 'awesome' })
    } finally {
      Date.now = realNow
    }
    assert.equal(calls.length, 2)
  })

  it('403 抛速率限制错误，包含重置时间与未认证提示', async () => {
    const reset = Math.floor(Date.now() / 1000) + 900
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
      })
    await assert.rejects(searchRepositories({ query: 'awesome' }), (error) => {
      assert.match(error.message, /GitHub API 速率限制，请稍后重试/u)
      assert.match(error.message, /配额重置时间：/u)
      assert.match(error.message, /未配置 GITHUB_TOKEN，当前使用未认证请求，可能受速率限制/u)
      assert.doesNotMatch(error.message, /ghp_|Bearer/u)
      return true
    })
    assert.equal(searchCacheSize(), 0)
  })

  it('429 与 x-ratelimit-remaining: 0 都按速率限制处理', async () => {
    globalThis.fetch = async () => new Response('{}', { status: 429 })
    await assert.rejects(searchRepositories({ query: 'a' }), /GitHub API 速率限制/u)

    clearSearchCache()
    // 即使 HTTP 是 2xx，只要配额归零也抛错，避免返回一份无法续查的结果。
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ total_count: 0, items: [] }), {
        status: 200,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60) },
      })
    await assert.rejects(searchRepositories({ query: 'b' }), (error) => {
      assert.match(error.message, /GitHub API 速率限制/u)
      // 2xx 的 JSON 正文不应被当成错误原文塞进信息里。
      assert.doesNotMatch(error.message, /total_count|items/u)
      return true
    })
    assert.equal(searchCacheSize(), 0)
  })

  it('其他非 2xx 抛出带状态码的错误，且不重试', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })
    await assert.rejects(searchRepositories({ query: 'a' }), /HTTP 401/u)
  })

  it('非 JSON 响应抛出解析错误', async () => {
    globalThis.fetch = async () => new Response('<html>oops</html>', { status: 200 })
    await assert.rejects(searchRepositories({ query: 'a' }), /不是合法 JSON/u)
  })

  it('缺字段的 2xx 响应抛出结构错误', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ items: [] }), { status: 200 })
    await assert.rejects(searchRepositories({ query: 'a' }), /缺少 total_count 或 items/u)
  })

  it('网络错误被包装成可读错误', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed')
    }
    await assert.rejects(searchRepositories({ query: 'a' }), /访问 GitHub API 失败（fetch failed）/u)
  })

  it('调用方取消时给出取消错误', async () => {
    const controller = new AbortController()
    controller.abort()
    globalThis.fetch = async (_url, init) => {
      init.signal.throwIfAborted()
      return okResponse({ total_count: 0, items: [] })
    }
    await assert.rejects(searchRepositories({ query: 'a' }, controller.signal), /请求已取消/u)
  })
})
