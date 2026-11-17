# 自由的deepseek

自用的 DeepSeek 客户端：React + Capacitor 打包 Android，配套一个自建网关（记忆库 / 语义召回 / 额度与日志）。
**不对外发布、不上架**（见 `BACKLOG.md` 的范围决定）。

---

## 两条线：开发版与发行版

仓库里同时维护两条线，各自一条分支，各自一个版本号。

| 线 | 分支 | 版本号样例 | 说明 |
|---|---|---|---|
| 开发版 | `dev` | `0.7.0A-debug` | 开发过程中始终在更新 |
| 发行版 | `main` | `0.7.0` | **只在明确允许发版时更新** |

### 版本号规则

```
开发版   0.7.0A-debug   →  0.7.0B-debug  →  0.7.0C-debug   （修 bug / 小优化：只动字母）
         0.8.0A-debug                                    （加功能 / 大更新：动前三位）
发行版   0.8.11                                          （= 取开发版版本号去掉字母与 -debug）
```

- 发行版**从对应的开发版裁剪而来**：`0.8.11A-debug` 通过后，发行版就是 `0.8.11`
- 开发版与发行版**不共用版本号**，只有第一个版本（`0.7.0A-debug` / `0.7.0`）恰好同基线
- `versionCode` 由 `VERSION` 自动推导，保证单调递增：
  `major×1000000 + minor×10000 + patch×100 + 后缀`，后缀开发版 = 字母序号（A=1…Z=26）、发行版 = 99

### 发行版必须是「初始化状态」

发行版 APK 不携带任何本地数据与开发期状态：

- 不带任何令牌（首次启动由使用者自己填）
- 不带聊天记录 / 记忆 / 设置残留
- 只用 `main` 分支的干净源码构建

> 开发期为了方便，本地可以构建「预置地址与令牌」的私有包（`scripts/build.ps1 -PrefillToken`），
> 那种包**不进仓库、不上 Release、不外发**。

---

## 目录

| 路径 | 内容 |
|---|---|
| `app/` | 前端（React + Zustand + CSS Modules，rspack 构建） |
| `gateway/` | 网关（Node 22 直跑 TS）：记忆库、语义召回、日志、健康检查 |
| `android-app/` | Capacitor Android 壳 |
| `shared/` | 前后端共用类型 |
| `scripts/` | 构建与安全检查脚本 |
| `VERSION` | **当前分支的版本号**（改版本只改这一个文件） |
| `BACKLOG.md` | 已知问题、设计决定、踩坑记录 |

---

## 构建

前置：Node 22+、pnpm、JDK 21、Android SDK。

```powershell
# 前端 + APK（版本取自 VERSION；0.7.0A-debug 走 debug 构建，0.7.0 走 release 构建）
pwsh -File scripts/build.ps1

# 本地自用：把网关地址与令牌预置进包（不发布！）
pwsh -File scripts/build.ps1 -PrefillToken <网关令牌>
```

产物落在 `delivery/`（已被 gitignore）。

### 网关

```bash
cd gateway
node src/index.ts          # 生产用 systemd 托管
```

环境变量见 `gateway/.env.example`；**真实密钥只放在服务器上，不进仓库**。

---

## 安全约束（公开仓库，务必遵守）

```powershell
pwsh -File scripts/check-secrets.ps1        # 提交前必跑
```

绝不入库：网关令牌、DeepSeek / 硅基流动 API Key、签名密钥与密码、任何 `.env`。

发版流程：

1. `dev` 分支开发，`VERSION` 递增字母（`A→B→C`）或升基线（`0.8.0A`）
2. 明确允许发版后：以该开发版版本号**去掉字母和 `-debug`** 写入 `main` 的 `VERSION`
3. `git tag v<版本>` 并在 Releases 附上 APK
4. 发行版必须是干净构建：`scripts/build.ps1` 不加 `-PrefillToken`
