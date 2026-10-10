import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { Agent } from 'http';
import nodeFetch from 'node-fetch';
import { config } from '../config';
import { getSetting, setSetting } from '../db';
import type { Account } from '../models/account';

export interface FetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<any>;
  arrayBuffer(): Promise<ArrayBuffer>;
  body: any;
}

let cachedAgent: Agent | undefined;
let cachedUrl = '';

// Per-account agent cache
const accountAgentCache = new Map<number, { agent: Agent; url: string }>();

function isSocks(url: string): boolean {
  return /^socks([45][ah]?)?:\/\//i.test(url);
}

// ==================== Resin 代理池配置 ====================

export interface ResinConfig {
  enabled: boolean;
  url: string;       // e.g. http://127.0.0.1:2260
  token: string;     // RESIN_PROXY_TOKEN
  platform: string;  // Platform name, default 'Default'
}

export function getResinConfig(): ResinConfig {
  return {
    enabled: getSetting('resin_enabled') === '1',
    url: getSetting('resin_url') || '',
    token: getSetting('resin_token') || '',
    platform: getSetting('resin_platform') || 'Default',
  };
}

export function setResinConfig(cfg: Partial<ResinConfig>): void {
  if (cfg.enabled !== undefined) setSetting('resin_enabled', cfg.enabled ? '1' : '0');
  if (cfg.url !== undefined) setSetting('resin_url', cfg.url);
  if (cfg.token !== undefined) setSetting('resin_token', cfg.token);
  if (cfg.platform !== undefined) setSetting('resin_platform', cfg.platform);
  // Clear all caches when Resin config changes
  cachedAgent = undefined;
  cachedUrl = '';
  accountAgentCache.clear();
}

export function isResinEnabled(): boolean {
  return getSetting('resin_enabled') === '1';
}

/**
 * 为指定账户构建 Resin sticky 代理 URL
 * 格式: http://Platform.AccountId:Token@host:port
 */
export function buildResinProxyUrl(accountId: number): string {
  const { url, token, platform } = getResinConfig();
  if (!url || !token) return '';

  try {
    const parsed = new URL(url);
    // Resin 认证格式: Platform.Account:Token
    parsed.username = `${platform}.${accountId}`;
    parsed.password = token;
    return parsed.toString();
  } catch {
    return '';
  }
}

// ==================== 经典代理配置 ====================

export function isProxyEnabled(): boolean {
  const val = getSetting('proxy_enabled');
  if (val !== undefined) return val === '1';
  return !!config.proxyUrl;
}

export function setProxyEnabled(enabled: boolean): void {
  setSetting('proxy_enabled', enabled ? '1' : '0');
  cachedAgent = undefined;
  cachedUrl = '';
  accountAgentCache.clear();
}

export function getProxyUrl(): string {
  const dbVal = getSetting('proxy_url');
  if (dbVal !== undefined) return dbVal;
  return config.proxyUrl;
}

export function setProxyUrl(url: string): void {
  setSetting('proxy_url', url);
  cachedAgent = undefined;
  cachedUrl = '';
  accountAgentCache.clear();
}

/**
 * 获取指定账户的代理 URL
 * 优先级：账户专属代理(已启用) > Resin(已启用) > 全局代理(设置页) > 环境变量 PROXY_URL
 * 返回空字符串表示不使用代理
 */
export function getAccountProxyUrl(account?: Account | null): string {
  // 1. 优先使用账户专属代理（已启用）
  if (account?.proxy_url && account.proxy_url.trim() && account.proxy_enabled === 1) {
    return account.proxy_url.trim();
  }
  // 2. Resin 代理池（已启用）
  if (isResinEnabled() && account?.id) {
    const resinUrl = buildResinProxyUrl(account.id);
    if (resinUrl) return resinUrl;
  }
  // 3. 回退到全局代理
  return getProxyUrl();
}

export function getHttpAgent(): Agent | undefined {
  if (!isProxyEnabled()) return undefined;
  const url = getProxyUrl();
  if (!url) return undefined;
  if (url === cachedUrl && cachedAgent) return cachedAgent;

  cachedAgent = isSocks(url)
    ? new SocksProxyAgent(url, { timeout: 30000 })
    : new HttpsProxyAgent(url, { timeout: 30000 });
  cachedUrl = url;
  return cachedAgent;
}

/**
 * 获取指定账户的 HTTP Agent（支持账户专属代理 + Resin 代理池）
 * 优先级：账户专属代理(已启用) > Resin(已启用) > 全局代理(已启用)
 */
export function getHttpAgentForAccount(account?: Account | null): Agent | undefined {
  // 1. 账户专属代理：只要账户有 URL 且开关开启，就用它（不受全局开关限制）
  if (account?.proxy_url && account.proxy_url.trim() && account.proxy_enabled === 1) {
    const url = account.proxy_url.trim();
    const accountId = account.id;
    const cached = accountAgentCache.get(accountId);
    if (cached && cached.url === url) return cached.agent;

    const agent = isSocks(url)
      ? new SocksProxyAgent(url, { timeout: 30000 })
      : new HttpsProxyAgent(url, { timeout: 30000 });
    accountAgentCache.set(accountId, { agent, url });
    return agent;
  }

  // 2. Resin 代理池（已启用）— 自动为每个账户构建 sticky 代理 URL
  if (isResinEnabled() && account?.id) {
    const resinUrl = buildResinProxyUrl(account.id);
    if (resinUrl) {
      const accountId = account.id;
      const cached = accountAgentCache.get(accountId);
      if (cached && cached.url === resinUrl) return cached.agent;

      const agent = isSocks(resinUrl)
        ? new SocksProxyAgent(resinUrl, { timeout: 30000 })
        : new HttpsProxyAgent(resinUrl, { timeout: 30000 });
      accountAgentCache.set(accountId, { agent, url: resinUrl });
      return agent;
    }
  }

  // 3. 账户没有专属代理 / Resin 未启用 → 回退到全局代理（受全局开关控制）
  if (!isProxyEnabled()) return undefined;
  return getHttpAgent();
}

export async function proxyFetch(input: string | URL, init?: any, timeoutMs: number = 300000, accountProxyUrl?: string, account?: Account | null): Promise<FetchResponse> {
  let agent: Agent | undefined;

  // 优先级：accountProxyUrl (显式传入) > account 对象 (含 Resin/账户代理) > 全局代理
  if (accountProxyUrl) {
    agent = isSocks(accountProxyUrl)
      ? new SocksProxyAgent(accountProxyUrl, { timeout: 30000 })
      : new HttpsProxyAgent(accountProxyUrl, { timeout: 30000 });
  } else if (account) {
    agent = getHttpAgentForAccount(account);
  } else if (isProxyEnabled()) {
    agent = getHttpAgent();
  }

  // Create AbortController for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let proxyInit = init;
  
  try {
    if (!agent) {
      const response = await fetch(input, { ...init, signal: controller.signal }) as unknown as FetchResponse;
      clearTimeout(timeoutId);
      return response;
    }

    // node-fetch v2 不支持原生 FormData；先序列化为可重试的 multipart Buffer。
    if (init?.body instanceof FormData) {
      const multipart = new Response(init.body);
      const body = Buffer.from(await multipart.arrayBuffer());
      const headers = new Headers(init.headers);
      headers.set('Content-Type', multipart.headers.get('Content-Type')!);
      headers.set('Content-Length', String(body.length));
      proxyInit = { ...init, headers: Object.fromEntries(headers), body };
    }

    const doFetch = () => nodeFetch(input.toString(), { ...proxyInit, agent, timeout: timeoutMs });
    const result = await doFetch() as unknown as FetchResponse;
    clearTimeout(timeoutId);
    return result;
  } catch (err: any) {
    clearTimeout(timeoutId);
    
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
      cachedAgent = undefined;
      cachedUrl = '';
      // 重建 agent 进行重试（优先级与首次请求一致）
      let newAgent: Agent | undefined;
      if (accountProxyUrl) {
        newAgent = isSocks(accountProxyUrl)
          ? new SocksProxyAgent(accountProxyUrl, { timeout: 30000 })
          : new HttpsProxyAgent(accountProxyUrl, { timeout: 30000 });
      } else if (account) {
        newAgent = getHttpAgentForAccount(account);
      } else if (isProxyEnabled()) {
        newAgent = getHttpAgent();
      }
      // Retry with new agent
      const retryController = new AbortController();
      const retryTimeoutId = setTimeout(() => retryController.abort(), timeoutMs);
      try {
        if (!newAgent) {
          const response = await fetch(input, { ...proxyInit, signal: retryController.signal }) as unknown as FetchResponse;
          clearTimeout(retryTimeoutId);
          return response;
        }
        const result = await nodeFetch(input.toString(), { ...proxyInit, agent: newAgent, timeout: timeoutMs }) as unknown as FetchResponse;
        clearTimeout(retryTimeoutId);
        return result;
      } catch (retryErr) {
        clearTimeout(retryTimeoutId);
        throw retryErr;
      }
    }
    
    // Handle timeout error
    if (err.name === 'AbortError' || err.type === 'request-timeout') {
      const timeoutErr = new Error(`Request timeout after ${timeoutMs}ms`);
      timeoutErr.name = 'TimeoutError';
      throw timeoutErr;
    }
    
    throw err;
  }
}

export function buildCurlCommand(url: string, init?: any): string {
  const proxyUrl = getProxyUrl();
  const parts = ['curl -s'];
  if (proxyUrl) parts.push(`-x '${proxyUrl}'`);
  if (init?.method && init.method !== 'GET') parts.push(`-X ${init.method}`);
  if (init?.headers) {
    for (const [k, v] of Object.entries(init.headers)) {
      const val = k.toLowerCase() === 'authorization' ? (v as string).replace(/^(Bearer\s+).+/, '$1***') : v;
      parts.push(`-H '${k}: ${val}'`);
    }
  }
  if (init?.body) {
    const body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    const truncated = body.length > 500 ? body.substring(0, 500) + '...' : body;
    parts.push(`-d '${truncated.replace(/'/g, "'\\''")}'`);
  }
  parts.push(`'${url}'`);
  return parts.join(' \\\n  ');
}

export async function testProxyConnection(proxyUrl: string): Promise<{ latency_ms: number; status: number }> {
  const agent = isSocks(proxyUrl)
    ? new SocksProxyAgent(proxyUrl)
    : new HttpsProxyAgent(proxyUrl);

  const start = Date.now();
  const resp = await nodeFetch('https://api.cloudflare.com/client/v4/ips', {
    agent,
    timeout: 10000,
  });
  const latency = Date.now() - start;

  if (!resp.ok) {
    throw new Error(`Upstream returned HTTP ${resp.status}`);
  }
  return { latency_ms: latency, status: resp.status };
}

/**
 * 测试 Resin 代理池连接
 * 使用 Resin 代理访问 Cloudflare API，验证连通性和延迟
 */
export async function testResinConnection(accountId?: number): Promise<{ latency_ms: number; status: number; exit_ip?: string }> {
  const testAccountId = accountId || 0;
  const resinUrl = buildResinProxyUrl(testAccountId);
  if (!resinUrl) {
    throw new Error('Resin 配置不完整（需要服务地址和 Token）');
  }

  const agent = isSocks(resinUrl)
    ? new SocksProxyAgent(resinUrl, { timeout: 10000 })
    : new HttpsProxyAgent(resinUrl, { timeout: 10000 });
  const start = Date.now();
  const resp = await nodeFetch('https://api.cloudflare.com/client/v4/ips', {
    agent,
    timeout: 10000,
  });
  const latency = Date.now() - start;

  if (!resp.ok) {
    throw new Error(`Upstream returned HTTP ${resp.status}`);
  }
  return { latency_ms: latency, status: resp.status };
}
