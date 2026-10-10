import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nodeFetch, { Request as NodeFetchRequest } from 'node-fetch';
import { proxyFetch } from '../src/services/proxyService';

vi.mock('../src/config', () => ({ config: { proxyUrl: '' } }));
vi.mock('../src/db', () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));
vi.mock('node-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node-fetch')>();
  return { ...actual, default: vi.fn() };
});

const endpoint = 'https://example.invalid/deployments';
const proxyUrl = 'http://127.0.0.1:7890';

describe('proxyFetch multipart uploads', () => {
  beforeEach(() => {
    vi.mocked(nodeFetch).mockReset();
    vi.mocked(nodeFetch).mockResolvedValue(new Response('{}') as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends manifest, Unicode fields and binary files through the proxy with matching headers', async () => {
    const form = new FormData();
    const manifest = JSON.stringify({ '/index.html': 'asset-hash' });
    const bytes = new Uint8Array([0, 255, 13, 10, 128]);
    form.append('manifest', manifest);
    form.append('commit_message', '部署测试');
    form.append('_worker.bundle', new Blob([bytes]), '_worker.bundle');
    const headers = new Headers({ Authorization: 'Bearer test-token', 'Content-Type': 'application/json', 'Content-Length': '1' });

    await proxyFetch(endpoint, { method: 'POST', headers, body: form }, 1000, proxyUrl);

    const [url, init] = vi.mocked(nodeFetch).mock.calls[0];
    const request = new NodeFetchRequest(url, init);
    const body = await request.buffer();
    const contentType = request.headers.get('content-type');
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(request.headers.get('content-length')).toBe(String(body.length));
    expect(request.headers.get('authorization')).toBe('Bearer test-token');
    const received = await new Response(body, { headers: { 'Content-Type': contentType! } }).formData();
    expect(received.get('manifest')).toBe(manifest);
    expect(received.get('commit_message')).toBe('部署测试');
    const file = received.get('_worker.bundle') as File;
    expect(file.name).toBe('_worker.bundle');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('content-length')).toBe('1');
  });

  it('reuses the complete multipart body and boundary after a connection reset', async () => {
    vi.mocked(nodeFetch).mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
    const form = new FormData();
    form.append('manifest', '{}');

    await proxyFetch(endpoint, { method: 'POST', body: form }, 1000, proxyUrl);

    expect(nodeFetch).toHaveBeenCalledTimes(2);
    const initial = vi.mocked(nodeFetch).mock.calls[0][1]!;
    const retry = vi.mocked(nodeFetch).mock.calls[1][1]!;
    expect(Buffer.isBuffer(initial.body)).toBe(true);
    expect(retry.body).toBe(initial.body);
    expect(retry.headers).toEqual(initial.headers);
    const received = await new Response(retry.body as Buffer, { headers: retry.headers as Record<string, string> }).formData();
    expect(received.get('manifest')).toBe('{}');
  });

  it('preserves JSON requests through the proxy', async () => {
    const body = JSON.stringify({ hashes: ['asset-hash'] });
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' };

    await proxyFetch(endpoint, { method: 'POST', headers, body }, 1000, proxyUrl);

    const init = vi.mocked(nodeFetch).mock.calls[0][1]!;
    expect(init.body).toBe(body);
    expect(init.headers).toBe(headers);
  });

  it('lets native fetch encode multipart requests when no proxy is configured', async () => {
    const directFetch = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', directFetch);
    const form = new FormData();
    form.append('manifest', '{}');

    await proxyFetch(endpoint, { method: 'POST', body: form }, 1000);

    expect(directFetch.mock.calls[0][1].body).toBe(form);
    expect(nodeFetch).not.toHaveBeenCalled();
  });
});
