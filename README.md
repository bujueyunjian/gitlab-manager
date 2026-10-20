# GitLab 管理器

批量管理多个 GitLab 仓库的成员权限与 Webhook。

这是独立的开源桌面客户端，与 GitLab 官方没有隶属关系。许可证为 [MIT](LICENSE)。

当前为早期版本：macOS、Windows、Linux x64 和 Linux ARM64 的自动构建与测试已通过，已完成 macOS 本地运行及模拟 GitLab 的批量流程验证；真实 GitLab 环境和 Windows、Linux 的安装运行尚未完成验收。默认使用浅色界面。

在 [Releases](https://github.com/bujueyunjian/gitlab-manager/releases) 下载适合当前系统的安装包。

## 第一次使用

1. **连接 GitLab**：填写实例地址和个人访问令牌。批量修改需要 `api` 范围，仅查看可使用 `read_api`。
2. **选择仓库**：搜索、筛选，或逐行粘贴仓库地址、`namespace/project` 路径、应用名。同名项目需要明确选择。
3. **预览后执行**：选择“批量授权”或“批量设置 Webhook”，核对每个仓库的具体变更，再执行。
4. **查看结果**：成功、失败、未发送和结果未知分别记录。未知结果应先查询核实；密钥变更需要在接收端核实。

### 主要能力

- 仓库搜索、权限与归档状态筛选、跨页多选、批量地址定位。
- 成员授权、角色和到期时间修改、直接授权撤销、继承权限查看。
- Webhook 查询、新增、选定字段修改、删除，以及“补齐并更新”。
- 批量预览、重复 Hook 选择、执行前状态复查、停止、继续、手动重试和结果导出。
- 多实例连接；访问令牌由系统凭据存储管理。

“补齐并更新”仅在成功读取全部配置后判断是否缺失。重复匹配需要选择具体 Hook，查询失败不会被当作不存在。跨仓库操作没有事务性；执行前的复查也不能替代 GitLab 服务端的原子并发控制。

## 构建安装包

工作流使用 [Tauri 官方 Action](https://github.com/tauri-apps/tauri-action) 构建并上传安装包。推送 `v*` 版本标签后会自动构建；全部平台成功后，自动发布 GitHub Release 并标记为最新版本。

开发测试也可以在 **Actions → Build installers → Run workflow** 中选择分支手动构建，在该次运行的 **Artifacts** 下载产物。分支构建不会发布 Release。

| 系统    | 架构                                   | 安装包              |
| ------- | -------------------------------------- | ------------------- |
| macOS   | Universal，包含 Apple Silicon 与 Intel | `.dmg`              |
| Windows | x64                                    | `.exe`、`.msi`      |
| Linux   | x64、ARM64                             | `.deb`、`.AppImage` |

macOS 使用 ad-hoc 签名，尚未使用开发者证书或完成公证；Windows 安装包尚未代码签名。Linux 需要图形桌面及可用的 Secret Service（如 GNOME Keyring）来保存令牌。构建成功不等于已完成各系统的安装与真实 GitLab 验收。

Linux 的 AppImage 从构建产物解压后，需要在文件属性中开启“允许作为程序执行”；也可以选择 `.deb` 安装。

发布前同步更新 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 的版本及锁文件，再提交并推送对应标签，例如 `v0.1.1`。标签必须与应用版本一致；某个平台失败时，Release 保持草稿状态，失败原因可在 Actions 查看。

已有成功构建时，可先为同一源码提交创建标签和 Release 草稿，再运行 **Publish installers**，填写构建运行 ID 与标签。它会核对源码一致后直接上传原安装包并发布，避免重新构建；已发布的版本不能通过此流程覆盖。

## 开发

需要 Node.js 24 LTS、pnpm 12、Rust 稳定版（最低 1.95）及当前平台的 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)。构建工具版本由 `packageManager` 和锁文件固定。

```sh
pnpm install --frozen-lockfile
pnpm desktop:dev
```

`pnpm dev` 仅预览界面。真实 GitLab 请求、凭据读写和任务执行必须在桌面应用中完成，网页不会模拟成功结果。

```sh
pnpm check
pnpm format:check
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm desktop:build
```

安装包位于 `src-tauri/target/release/bundle/`；指定 `--target` 时位于对应目标目录下。本地构建采用相同的打包配置，不自动公证或发布。

macOS 的钥匙串可能在应用重建后要求重新授权访问令牌，需要用户在系统窗口中处理。开发版使用独立的数据目录和凭据命名空间，避免影响正式版连接。

## 代码结构

```text
src/
  pages/             仓库、Webhook 和权限页面
  Workspace.tsx      当前连接与所选仓库范围
  BatchDialogs.tsx   配置与变更预览
  Tasks.tsx          逐项结果与恢复操作
  api.ts             类型化 IPC 调用
src-tauri/src/
  gitlab.rs          HTTP、分页与仓库地址解析
  planner.rs         只读扫描及变更计划
  runner.rs          状态复查、执行与未知结果核实
  service.rs         应用操作与凭据协调
  storage.rs         本地连接元数据与任务存储
  credentials.rs     系统凭据存储
```

注释用于解释权限边界、接口语义和状态处理，不重复描述代码表面行为。

## 隐私与贡献

- 不收集遥测，不内置个人账号、内网域名、个人路径或真实令牌。
- 令牌不写入 SQLite、任务记录、请求日志或导出结果。Webhook 接收端密钥仅在执行会话中使用。
- 连接元数据和任务记录位于操作系统的应用数据目录；它们可能包含组织和成员信息，不应加入源码仓库或公开问题报告。
- 不要提交 `.env`、数据库、运行日志、个人截图或任务导出。原型和本地截图也已排除。
- 提交前运行 `pnpm privacy:check`，并人工检查最终 diff。自动扫描不能证明所有隐私信息都已排除。
- 测试和文档仅使用 `example.com` 域名与虚构数据。

## 接口边界

当前使用 GitLab REST API v4 和 Personal Access Token。权限与令牌范围始终由 GitLab 校验。

连接时自动识别 GitLab 版本，无需手选：

- GitLab 13.10.5 至 15.4 使用用户身份与仓库读取接口验证连接。令牌范围和到期时间显示为未知，批量操作仍检查仓库管理权限，实际写权限由 GitLab 校验；读取成功不代表令牌具有写权限。
- GitLab 15.5 及以上继续读取令牌详情并校验 `api` / `read_api` 范围，接口错误不会被忽略或转为旧版模式。
- GitLab 17.1 之前不显示或发送 Webhook 名称；通过地址管理 Hook。17.1 及以上保留名称设置。

自建实例在“连接配置”中维护，支持 HTTP / HTTPS 地址、自定义端口和路径前缀。HTTP 不加密传输，请仅在可信网络中使用；HTTPS 证书校验始终开启。

Webhook 名称、认证状态等字段在不同 GitLab 版本中存在差异；缺失的认证状态视为未知。已有签名令牌不会被静默替换为普通密钥。已有群组共享的角色变更必须显式撤销后重新授权，不使用隐式“删除再创建”。

不执行本地 Git 操作，不创建仓库，不提供独立群组管理，也不接收或监听 Webhook 事件。
