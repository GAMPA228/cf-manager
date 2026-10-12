# v2.3.2 依赖安全修复验证

验证日期：2026-10-12；本地 Node 22.19.0；使用官方 npm registry。

## 审计结果

| 范围 | 修复前（完整依赖） | 修复后（完整依赖 / 生产依赖） |
| --- | --- | --- |
| backend | 21（3 critical、12 high、5 moderate、1 low） | 0 / 0 |
| frontend | 12（8 high、4 moderate） | 0 / 0 |
| worker | 12（2 critical、6 high、4 moderate） | 0 / 0 |

Docker 后端生产依赖修复前为 10（1 critical、6 high、2 moderate、1 low），修复后为 0。以上是 npm 当前公告中的受影响包计数，不是对所有应用漏洞的保证。

主要后端运行依赖版本：adm-zip 0.6.1、multer 2.4.0、compression 1.8.2、proxy-addr 2.0.8、body-parser 2.3.0、fast-uri 3.1.8、form-data 4.0.6、ip-address 10.7.4、moment 2.31.0、qs 6.16.0。两端 Vitest 更新到 4.1.11；Worker 构建也使用 adm-zip 0.6.1。

## 自动检查

- 三端 `npm ci` 通过。
- backend：build、typecheck、lint、test 通过，7 个测试文件 / 39 个测试。
- frontend：build（包含 vue-tsc 类型检查）、lint 通过。
- worker：build:worker、typecheck、lint、test 通过，4 个测试文件 / 28 个测试。
- Worker 完整构建与 ZIP 打包通过，包内 34 个文件与 public 输出逐字节一致（包括前端与 `_worker.js`）。
- backend/worker 数据库 schema 对齐检查通过；没有数据库结构变更。
- 新增 ZIP 回归验证公共目录剥离、Unicode 文件名、二进制内容、根目录路径、空 ZIP 和损坏 ZIP。
- 新增真实 Workers 路由上传回归验证 Pages single ZIP 和 Worker fields 文件/文本传递，以及意外文件字段拒绝后的正常请求；Cloudflare 写服务和数据模型均隔离。
- 保留出站代理 multipart 测试，验证 FormData 字段、文件、boundary 和连接重试行为。
- 替代 nodemon 的 `npm run dev` 在隔离 SQLite/日志目录启动，健康接口返回 200，测试进程已清理。
- Lint 均无错误，现有代码仍有 warning；前端大 chunk 提示仍存在，本次未扩大为格式或打包重构。

## 发布与回滚

保留部署环境原 `.env` 与 `data/`。发布前用 better-sqlite3 backup API 保存一致性数据库快照，并给当前健康镜像打回滚标签。

发布命令：`GIT_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build --wait --wait-timeout 180`。受限网络环境继续使用部署机器现有 Compose override 的构建代理参数。

上线验收：健康接口、前端及 gzip 解压内容、鉴权拒绝/成功、版本、数据库完整性和账户数据、只读代理连通测试、Node 用户与容器健康状态。

回滚容器时用保留的旧镜像标签指定 Compose image，并执行 `docker compose ... up -d --no-build --wait`；保持原密钥和现有数据。本版本没有 schema 迁移，常规镜像回滚无需恢复数据库备份。

未覆盖：真实 Cloudflare DNS/Workers 等写操作和 Cloudflare Pages 线上部署；本次未为验证而修改真实外部资源。
