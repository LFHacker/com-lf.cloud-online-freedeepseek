# 密钥检查（提交前必跑）

扫描**将要提交的文件**里是否混入了密钥。仓库是公开的，一旦泄露无法收回。

```powershell
pwsh -File scripts/check-secrets.ps1
```

- 默认检查 `git ls-files`（已跟踪文件）+ 暂存区
- `-All` 会连未跟踪文件一起扫（首次提交前用）
- 命中任意一条即退出码 1

---

## 判据

不只是 grep 固定字符串，还包括**形状**匹配，避免换个令牌又漏掉：

| 类型 | 形状 |
|---|---|
| 各类 API Key | `sk-` 开头、长度 ≥ 20 |
| 阿里云 AccessKey | `LTAI` 开头 |
| 签名密码 | `storePassword=` / `keyPassword=` 后跟非占位值 |
| 网关令牌 | `GATEWAY_TOKEN=` 后跟非占位值 |
| JWK / PEM 私钥 | `BEGIN .*PRIVATE KEY` |

占位值（`***`、`<your-token>`、空串）不算泄露。
