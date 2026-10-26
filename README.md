# GitLab 管理器

批量管理多个 GitLab 仓库的成员权限与 Webhook。

这是独立的开源桌面客户端，与 GitLab 官方没有隶属关系。许可证为 [MIT](LICENSE)。

当前为早期版本：macOS、Windows、Linux x64 和 Linux ARM64 的自动构建与测试已通过，已完成 macOS 本地运行及模拟 GitLab 的批量流程验证；真实 GitLab 环境和 Windows、Linux 的安装运行尚未完成验收。默认使用浅色界面。

在 [Releases](https://github.com/bujueyunjian/gitlab-manager/releases) 下载适合当前系统的安装包。

## 第一次使用

应用侧栏的“使用手册”可离线打开逐页操作说明，包含实际界面截图、字段规则和常见问题。也可下载 [HTML 使用手册](docs/user-manual.html)，用浏览器打开；截图仅使用虚构数据。

1. **选择任务**：在首页选择“配置 Webhook”或“查询成员权限”。尚无连接时先填写实例地址和 PAT，验证后继续该任务；修改需要 `api`，只查看可使用 `read_api`。
2. **选择仓库范围**：搜索名称、完整 Git URL 或 `namespace/project`，也可批量粘贴。核对“本次范围”后进入检查；两项任务的仓库范围各自独立。
3. **检查并选择目标**：Webhook 按完整地址或名称检查，在“未配置”“已有配置”“需处理”中明确选择；成员权限先选具体用户，再按精确角色与授权状态选择仓库。
4. **配置与预览**：设置字段后扫描预览，逐项核对新增、修改、跳过和受阻原因；确认后执行。混合补齐与更新需在“未配置”组勾选“同时更新已有配置”并明确选择两类目标。
5. **查看结果**：本次结果在任务页显示，也可从“任务记录”恢复或导出。未知结果先查询核实；密钥变更需在接收端核实。

### 主要能力

- 两项同级任务，统一采用“仓库范围 → 检查与选择 → 配置 → 预览 → 结果”。切换任务保留各自范围；切换实例清空连接相关范围与表单。
- 仓库搜索、归档与当前账号精确角色筛选、跨页选择、批量地址定位。定位与资源读取最多四路并发；失败逐项保留，其他项目继续完成。
- Webhook 按完整地址或名称精确查询；缺失项与唯一匹配项可明确组合为同一次新增/更新预览。重复 Hook 必须按具体 ID 选择；GitLab 17.1 之前按地址管理。
- 成员权限按所查用户的可见最高角色精确筛选，Developer 不包含 Maintainer 或 Owner。读取失败、未取得结果和访问途径待核实项不会自动进入直接授权。
- 仓库详情、直接与继承成员、已有群组共享、期限调整和直接授权撤销。次级操作仍以当前明确选择的范围为准。
- 执行前状态复查、停止、继续、所选失败项重试、未知项核实及结果导出。任务只保存每项最新结果和累计尝试次数；查询与预览失败不单独写入持久任务。
- 多实例连接；PAT 由系统凭据存储管理，Webhook 新密钥仅在本次执行内存中使用。

补齐和更新以成功读取的实际配置为依据；查询失败不代表不存在。同地址“仅新增”会跳过，同名异址阻止新增；改名不能占用其他 Hook 的名称。重复选择失效后必须重新选择或查询。批量修改只处理本次明确目标；跨仓库没有整体事务或自动回滚。

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

`pnpm desktop:build`、`pnpm tauri build` 与 CI 共用受控构建入口：先生成第三方许可资源，再映射 Rust 和原生依赖中的本机构建路径。构建结束后检查可执行文件、帮助与许可资源的 UTF-8 和两种 UTF-16 字节对齐；发现个人路径或许可校验失败时返回非零状态，阻止 CI 上传。

构建保留 Cargo 当前生效的 `CARGO_ENCODED_RUSTFLAGS` 或 `RUSTFLAGS`，并追加路径映射。不能可靠保留的 Cargo 配置 flags、自定义 C/C++ flags、编译器、`--config`、`--runner` 和 Cargo 输出目录／profile 覆盖会明确报错；开发命令保持原行为。`--target`、`--debug`、`--no-bundle`、`--bundles` 与 `-- --locked` 可正常使用；原生加密依赖使用锁定版本支持的 `cc` 构建器，确保含空格路径的参数边界正确。

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

## 第三方许可

安装包的 `licenses/` 保存本项目许可证、第三方许可原文及 `NOTICE.txt` 索引；索引分别标出运行依赖、构建／测试依赖、工具链和安装组件。上游版权署名及许可中的公开联系信息按原文保留。

桌面构建入口在打包前依据锁文件、当前工具链和目标平台生成许可资源；缺失原始许可或固定来源摘要不符时停止构建。可运行 `node scripts/generate-third-party-notices.mjs` 单独生成，`--target <triple>` 指定目标。缺失原文的补充来源固定在 `scripts/license-sources.json`；更新相关依赖时须核对版本、来源及摘要。

生成内容位于忽略的 `src-tauri/target/third-party-licenses/`。依赖图清单不能替代各平台安装包复核，Linux AppImage 内附的系统库仍须在 Linux 构建环境核验。

标准库声明来自本次实际 Rust 工具链的 `rust-docs`。使用最小工具链时，先运行 `rustup component add rust-docs` 补齐同一版本的材料。

## 隐私与贡献

- 不收集遥测，不内置个人账号、内网域名、个人路径或真实令牌。
- PAT 由系统凭据存储保管；Webhook 接收端密钥通过独立内存字段用于本次请求。HTTP 错误仅保留状态码、请求方法和固定安全提示，不读取或保存失败响应正文。
- 任务和导出包含仓库路径、成员名称、用户备注等业务信息。不要把令牌或密钥放入 URL、名称或备注，分享前需人工检查。
- 连接元数据和任务记录位于操作系统的应用数据目录；它们可能包含组织和成员信息，不应加入源码仓库或公开问题报告。
- 任务记录保存每项最新结果和累计尝试次数；重试或核实会更新该项说明，不保留每次尝试的追加历史。查询与预览不会单独写入持久任务记录。
- 不要提交 `.env`、数据库、运行日志、个人截图或任务导出。原型和本地截图也已排除。
- 提交前运行 `pnpm check`，并人工检查最终 diff。隐私门禁同时检查 Git 暂存 blob、已跟踪工作区文件和未忽略的未跟踪文件，支持 XML/IML 及转义的 Windows 用户路径；误暂存的 IDE 元数据、环境文件和数据库会被拦截。扫描不覆盖图片像素或 Git 历史，不能证明所有隐私信息都已排除。
- 测试和文档仅使用 `example.com` 域名与虚构数据。

## 接口边界

当前使用 GitLab REST API v4 和 Personal Access Token。权限与令牌范围始终由 GitLab 校验。

连接时自动识别 GitLab 版本，无需手选：

- GitLab 13.10.5 至 15.4 使用用户身份与仓库读取接口验证连接。令牌范围和到期时间显示为未知，批量操作仍检查仓库管理权限，实际写权限由 GitLab 校验；读取成功不代表令牌具有写权限。
- GitLab 15.5 及以上继续读取令牌详情并校验 `api` / `read_api` 范围，接口错误不会被忽略或转为旧版模式。
- GitLab 17.1 之前不显示或发送 Webhook 名称；通过地址管理 Hook。17.1 及以上保留名称设置。

自建实例在“连接”中维护，支持 HTTP / HTTPS 地址、自定义端口和路径前缀。HTTP 不加密传输，请仅在可信网络中使用；HTTPS 证书校验始终开启。

Webhook 名称、认证状态等字段在不同 GitLab 版本中存在差异；缺失的认证状态视为未知。已有签名令牌不会被静默替换为普通密钥。已有群组共享的角色变更必须显式撤销后重新授权，不使用隐式“删除再创建”。

不执行本地 Git 操作，不创建仓库，不提供独立群组管理，也不接收或监听 Webhook 事件。
