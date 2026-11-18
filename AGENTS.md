# 本仓库的工作约定（给 AI 与会话用）

> 这个文件会被 DSH 作为工作区指令读取。改动规则请改这里，不要只改对话。

## 一、每次更新都要自动推送（用户明确要求，2026-11-18）

**任何代码/文档改动完成后，立刻提交并推送到 GitHub**，不要等用户开口。

```powershell
pwsh -File scripts/sync.ps1 -Message "feat: 做了什么"            # 只推分支
pwsh -File scripts/sync.ps1 -Message "chore: ..." -Tag v0.9.0A-debug  # 同时打标签
```

- 远端：`git@github.com:LFHacker/com-lf-cloud-online-freedeepseek.git`
- SSH 走 **443**（本机 22 端口被拒），配置在 `~/.ssh/config`，密钥 `~/.ssh/github_freedeepseek`
- `scripts/sync.ps1` 会**先跑密钥检查**再推送；检查不通过就中止
- 推送失败必须报给用户，不要静默跳过

## 二、发行版只在明确同意时更新

| 线 | 分支 | 版本样例 | 何时更新 |
|---|---|---|---|
| 开发版 | `dev` | `0.9.0A-debug` | 随时，每次改动都推 |
| 发行版 | `main` | `0.9.0` | **只有用户说"可以发版"时** |

- 版本号只写在根目录 `VERSION` 一个文件里，`versionCode` 由它自动推导
- 小修小改递增字母：`0.9.0A` → `0.9.0B`
- 加功能升基线：`0.9.0A` → `0.10.0A`
- 发版 = 取开发版版本号去掉字母与 `-debug` 写进 `main` 的 `VERSION`

## 三、这个仓库是公开的

提交前必跑 `pwsh -File scripts/check-secrets.ps1`（`sync.ps1` 已内置）。

绝不入库：网关令牌、DeepSeek / 硅基流动 API Key、签名密钥与密码、`.env`、本机令牌文件。

> 踩过的坑：`.gitignore` 曾因 PowerShell 替换吞掉换行被压成一行，规则全部失效，
> `git add -A` 把令牌文件加了进去（被 GitHub push protection 拦住才发现）。
> **改完 `.gitignore` 必须 `git check-ignore <路径>` 验证。**

## 四、发布物里不能有用户数据或密钥

- 发行版 APK：不带令牌、不带任何本地数据
- 开发版 APK：同样不预置令牌（公开仓库挂着带令牌的包等于公开泄露）
- 需要"免填"的私有包，用 `scripts/build.ps1 -PrefillToken <令牌>` 本地构建，**不外发**

## 五、常用命令

```powershell
pwsh -File scripts/build.ps1            # 构建 APK（版本取自 VERSION）
pwsh -File scripts/check-secrets.ps1    # 密钥检查
node gateway/scripts/test-auth.ts       # 账号/隔离/指纹（53 项）
node gateway/scripts/test-memory.ts     # 记忆检索（73 项）
node gateway/scripts/test-import.ts     # 历史导入（14 项）
```
