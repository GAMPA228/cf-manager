# 依赖安全修复（2026-10-12）

- 从用户 fork 的 master（34659f5）建立独立 worktree，保护原工作区既有未提交修改；三端分别维护锁文件，不添加根锁文件。
- 使用官方 npm registry 审计；本机子项目默认镜像站不支持 audit API，已显式指定 registry。
- npm 10.9.3 在更新 Vitest 的 peer 依赖树时连续两次抛出 `edgesOut` 空引用；改用临时 npm 11，不修改全局 npm，不使用 `--force` 或忽略 peer 校验。
- `braces` 当前没有安全版本，移除后端 nodemon 依赖链，使用 Node 内置 watch + 现有 ts-node；不降级到 audit 建议的古旧 nodemon。
- Docker 启动修复沿用已在目标服务器验证的最小改动：仅修复数据目录权限，并显式指定持久日志目录。
