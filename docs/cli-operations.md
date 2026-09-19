# 绑定 Vault 的 CLI 操作

0.4.1-rc2.3 源码候选在现有 DSH Bridge 内提供操作 skill 和 CLI 工具，不增加桥插件。Obsidian 侧继续使用现有 `obsidian-deepharness-bridge` 的绑定、公开身份和 live 路径证明；无需为本次 CLI 路线修改其插件代码。

## 使用与配置

1. Obsidian 使用支持官方 CLI 的安装器，并启用命令行接口。当前官方文档要求 1.12.7+ 安装器；应用内部自动更新版本不能替代安装器升级。
2. 在现有桥中保持明确的 Vault/DSH 实例绑定。多个目标由用户任务确定，工具始终要求 `vaultId`。
3. DSH 的 skills 服务注册 `obsidian-bound-vault`，tools 服务注册 `dsh_obsidian_guide`、`dsh_obsidian_targets`、`dsh_obsidian_cli`。托管执行器可通过可选 `dshRuntimeSupport.managedTools.exportTool` 接入同一工具定义；未安装 Runtime Support 时原生工具仍独立可用。托管执行器没有选择 skill 时，可读 guide 工具获取相同完整指导。
4. 先读 guide、选择 targets 返回的目标，再调用 CLI 工具。命令参数为 JSON 对象，不是 shell 命令文本。写入及 UI 操作须提供稳定 `requestId`。

可选桥配置：`obsidianCliPath` 为官方原生可执行文件绝对路径；Windows 示例 `D:\app\Obsidian\Obsidian.com`。留空时从当前 DSH 进程 PATH 搜索；应用更新 PATH 后，旧 DSH 进程可能需要配置绝对路径。`obsidianRegistryPath` 默认采用当前用户的 Obsidian `obsidian.json`，测试或特殊安装才覆盖。不要把显示名称或桥 vaultId 直接作为 CLI 原生 Vault ID。

## 本次支持范围

- 精确路径笔记读取、创建、追加、前插、移动、重命名、移到回收站及打开。
- 搜索、属性读取/设置/删除、模板列表/读取及从模板创建笔记。
- 已有 CSS 片段的查看与启用/停用。
- 已有插件的查看与重载。插件源码生成、构建、安装、卸载及启停由其他本地开发工具承担，不属于本桥业务。

CLI 不可用时明确返回 `CLI_UNAVAILABLE`，不静默走文件写入或 HTTP/eval 替代。尚未实现任意面板创建、自定义 Plugin API 执行器或 CSS 片段源码写入；已有片段启停不等于整个样式设计业务完成。本工具的固定参数合同不是逐 Vault 能力识别或授权清单。

## 路由与结果

工具先核对当前 DSH 实例/profile、Vault 绑定及修订、live publisher/boot/origin 与 Vault 实际路径，再将路径映射到 Obsidian 原生 ID。调用总以显式 `vault=<nativeId>` 开始，并通过 `vault info=path` 再核对 CLI 选择结果。离线、外国绑定、重复原生映射及复制目录身份不能成为默认活动 Vault 的回退理由。

使用原生子进程参数数组、关闭 shell 和窗口弹出；限制输入及输出大小。路径不使用活动文件默认值，并检查父目录和符号链接逃逸。CLI 派发前后重新检查绑定及启动身份；CLI 自身不是与 Bridge 绑定原子提交的事务，派发期间发生变化会记为结果待核对。重载 Obsidian 侧桥自身时，最多等待 15 秒重新发现相同 Vault、原生 ID、路径和绑定修订的新启动身份；仅重新读取身份，不重复发送重载。

写操作在宿主 `storageDomain` 的 `dsh_obsidian_cli_receipts_v1` 保存请求摘要和 started/completed/unconfirmed 状态，不保存笔记正文、命令参数或 CLI 输出。相同会话及 requestId 不重复执行；参数改变时拒绝。超时、取消、CLI 报错、无法确认重载后身份或完成回执写入失败均不自动重试。读取结果直接返回调用方，不产生新的会话全文副本。每个存储域最多保留 10000 个写请求回执，满后拒绝新写，不自动删除回执后允许旧请求重放。

## 验证与边界

2026-09-18：类型检查、构建、依赖检查及 144 项测试通过；包括 22 项新增 CLI/注册测试。发行包的隔离 Host 加载与浏览器边界测试通过。

真实只读验证：本机安装器从 1.8.4 更新到官方签名 1.13.7，启用 CLI；桥 resolver 根据实际绑定 revision 1 将 math 的桥身份映射到原生 Vault ID，CLI 返回的路径一致，版本为 1.13.7。随后通过候选源码执行器真实重载一次现有 Obsidian 侧桥，写请求 completed 回执及恢复后的同一目标、绑定均核验通过。首次收集报告时，重载后的单独 version 读取短暂报错；后续只读核对已通过，没有重复发送重载。未写笔记或改变 Vault 绑定；此证据不等于候选桥已在 DSH 加载。

升级前备份位于本机 `D:/AI/DeepSeekHarness-Plugin/artifacts/obsidian-cli-20260918/backup`。本机证据 `bridge-cli-readonly.json`、`bridge-cli-reload.json` 及 `reload-receipts.json` 仅保存身份、版本、状态和计数。配置 CLI 的全局开关及用户 PATH 是本次用户“必须要有 cli”的已授权环境配置。

官方依据：[Obsidian CLI](https://help.obsidian.md/cli)。实际窗口样式、完整引用往返和专用操作真实写入未验收。

后续部署（2026-09-18）：用户正常停止后，Bridge .3 / Sticker .5 已安装到 RC2/web，并通过正式 Start 恢复 running。live 插件目录 active、现有会话 skills/list 包含 obsidian-bound-vault。证据位于本机 artifacts/obsidian-cli-deploy-20260918；Agent 实际调用仍未验收。此后续状态替代最初候选包中未部署的说明，已归档包保持原始哈希。
