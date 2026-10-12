import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import AdmZip from 'adm-zip';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import workersRouter from '../src/routes/workers';
import { errorHandler } from '../src/middleware/errorHandler';
import { getAccountById, type Account } from '../src/models/account';
import { deployWorker } from '../src/services/workerService';
import { deployPages } from '../src/services/deploy/pagesDeploy';

vi.mock('../src/config', () => ({ config: { demoAccountIds: '' } }));
vi.mock('../src/models/account', () => ({ getAccountById: vi.fn() }));
vi.mock('../src/models/auditLog', () => ({ createAuditLog: vi.fn() }));
vi.mock('../src/services/logger', () => ({ appLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('../src/services/accountRouter', () => ({ getAllZones: vi.fn() }));
vi.mock('../src/services/cfFactory', () => ({ getCfClient: vi.fn(() => ({})) }));
vi.mock('../src/services/deploy/pagesDeploy', () => ({ deployPages: vi.fn() }));
vi.mock('../src/services/workerService', async () => {
  const { extractZipFiles } = await import('../src/services/staticAssets');
  const { validatePagesProjectName } = await import('../src/services/pagesService');
  return { extractZipFiles, validatePagesProjectName, deployWorker: vi.fn() };
});

const account = { id: 7, account_id: 'test-account' } as Account;
const targets = [{ accountId: account.id, workerName: 'upload-test' }];
const vars = [{ name: 'GREETING', value: '部署测试', secret: false }];
const bindings = [{ type: 'kv', name: 'CACHE', mode: 'existing', existingId: 'test-namespace' }];

describe('multipart uploads through the Workers routes', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use('/api/workers', workersRouter);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workers`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAccountById).mockReturnValue(account);
    vi.mocked(deployWorker).mockResolvedValue({ script: {} });
    vi.mocked(deployPages).mockResolvedValue(undefined);
  });

  function pagesForm(): FormData {
    const zip = new AdmZip();
    zip.addFile('dist/index.html', Buffer.from('<h1>部署测试</h1>'));
    zip.addFile('dist/assets/data.bin', Buffer.from([0, 255, 13, 10, 128]));
    const form = new FormData();
    form.append('targets', JSON.stringify(targets));
    form.append('zipFile', new Blob([new Uint8Array(zip.toBuffer())], { type: 'application/zip' }), 'site.zip');
    form.append('vars', JSON.stringify(vars));
    form.append('bindings', JSON.stringify(bindings));
    return form;
  }

  it('passes a single Pages ZIP and text fields to the deployment service', async () => {
    const response = await fetch(`${baseUrl}/batch-deploy-pages`, { method: 'POST', body: pagesForm() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ ...targets[0], success: true }]);
    expect(deployPages).toHaveBeenCalledExactlyOnceWith(account, 'upload-test', expect.arrayContaining([
      { path: 'index.html', buffer: Buffer.from('<h1>部署测试</h1>') },
      { path: 'assets/data.bin', buffer: Buffer.from([0, 255, 13, 10, 128]) },
    ]), {
      deploymentConfigs: {
        production: {
          compatibility_date: '2024-11-01',
          env_vars: { GREETING: { value: '部署测试', type: 'plain_text' } },
          kv_namespaces: { CACHE: { namespace_id: 'test-namespace' } },
        },
        preview: {
          compatibility_date: '2024-11-01',
          env_vars: { GREETING: { value: '部署测试', type: 'plain_text' } },
          kv_namespaces: { CACHE: { namespace_id: 'test-namespace' } },
        },
      },
    });
  });

  it('passes Worker script and binary assets from separate multipart fields', async () => {
    const script = 'export default { fetch() { return new Response("部署测试"); } };';
    const bytes = new Uint8Array([0, 255, 13, 10, 128]);
    const form = new FormData();
    form.append('script', new Blob([script], { type: 'application/javascript' }), 'entry.js');
    form.append('targets', JSON.stringify(targets));
    form.append('vars', JSON.stringify(vars));
    form.append('assets', new Blob([bytes], { type: 'application/octet-stream' }), 'assets.bin');
    form.append('bindings', JSON.stringify(bindings));
    form.append('mainModule', 'entry.js');
    const response = await fetch(`${baseUrl}/batch-deploy`, { method: 'POST', body: form });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ ...targets[0], success: true }]);
    expect(deployWorker).toHaveBeenCalledExactlyOnceWith(account, 'upload-test', script, {
      assets: { source: { kind: 'raw', url: 'assets.bin' } },
      assetsBuffer: Buffer.from(bytes),
      mainModule: 'entry.js',
      createDeployment: true,
      bindings: [
        { type: 'plain_text', name: 'GREETING', text: '部署测试' },
        { type: 'kv_namespace', name: 'CACHE', namespace_id: 'test-namespace' },
      ],
    });
  });

  it('rejects an unexpected file field and accepts the next valid upload', async () => {
    const invalid = pagesForm();
    invalid.append('unexpected', new Blob(['invalid']), 'extra.txt');
    const rejected = await fetch(`${baseUrl}/batch-deploy-pages`, { method: 'POST', body: invalid });

    expect(rejected.ok).toBe(false);
    expect(await rejected.json()).toMatchObject({ success: false, error: { code: 'LIMIT_UNEXPECTED_FILE' } });
    expect(deployPages).not.toHaveBeenCalled();

    const accepted = await fetch(`${baseUrl}/batch-deploy-pages`, { method: 'POST', body: pagesForm() });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual([{ ...targets[0], success: true }]);
    expect(deployPages).toHaveBeenCalledOnce();
  });
});
