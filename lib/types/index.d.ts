/**
 * github-repo-search — 插件入口（Host 半身）。
 *
 * 只做一件事：注册 `search_github_repos`，让 Agent 能直接搜索 GitHub 仓库。
 * 纯工具插件，没有浏览器 UI：package.json 不声明 `dsh.client`，加载器因此
 * 不会向页面注入任何代码。
 *
 * @module github-repo-search
 */
import type { Context } from '@deepseek-ai/cordis';
import { type RepoSort } from './github.js';
/** 加载器诊断使用的插件名。 */
export declare const name = "github-repo-search";
/** 本插件只依赖工具注册表。 */
export declare const inject: string[];
/**
 * 挂载插件。
 * @param ctx - 提供 `tools` 注册表的 Host 上下文；注册在插件 dispose 时回收。
 */
export declare function apply(ctx: Context): void;
/** 明确导出枚举值，方便调用方复用同一份取值。 */
export type { RepoSort };
