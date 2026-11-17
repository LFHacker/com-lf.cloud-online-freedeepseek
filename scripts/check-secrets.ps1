#!/usr/bin/env pwsh
# 密钥检查：公开仓库的守门人。命中即退出码 1。
#
#   pwsh -File scripts/check-secrets.ps1          # 只查已跟踪 + 暂存
#   pwsh -File scripts/check-secrets.ps1 -All     # 连未跟踪一起查（首次提交前用）

param([switch]$All)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

# 明确排除：依赖、构建产物、本地数据
$exclude = '\\(node_modules|dist|www|build|\.gradle|\.git|delivery|research)\\|assets\\public\\'

function Get-TargetFiles {
    if ($All) {
        Get-ChildItem . -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch $exclude }
    } else {
        $tracked = git ls-files 2>$null
        if (-not $tracked) { return @() }
        $tracked | Where-Object { $_ -notmatch $exclude } | ForEach-Object {
            if (Test-Path $_) { Get-Item $_ }
        }
    }
}

# 判据：既查已知值，也查形状（换个令牌也能抓到）
$rules = @(
    @{ Name = 'API Key（sk- 开头）';        Regex = 'sk-[A-Za-z0-9_\-]{20,}';                                  Allow = 'sk-your|sk-xxx|sk-\.\.\.' }
    @{ Name = '阿里云 AccessKey';           Regex = 'LTAI[A-Za-z0-9]{12,}';                                    Allow = $null }
    @{ Name = '签名密码';                   Regex = '(storePassword|keyPassword)\s*[=:]\s*["'']?[^\s"'']{6,}';  Allow = '\*\*\*|your-|<' }
    @{ Name = '网关令牌';                   Regex = 'GATEWAY_TOKEN\s*[=:]\s*["'']?[^\s"'']{16,}';              Allow = [regex]::Escape('***') + '|your-|<|process\.env|os\.environ|env\[' }
    @{ Name = '私钥';                       Regex = 'BEGIN [A-Z ]*PRIVATE KEY';                                 Allow = $null }
    @{ Name = 'Bearer 硬编码';              Regex = 'Bearer\s+[A-Za-z0-9_\-\.]{24,}';                           Allow = '\$\{|\$env|\$\(' }
)

$targets = Get-TargetFiles
if (-not $targets -or $targets.Count -eq 0) {
    Write-Host '  没有可检查的文件（仓库为空？用 -All 扫描工作区）' -ForegroundColor Yellow
    exit 0
}
Write-Host "  检查 $($targets.Count) 个文件…"

$hits = @()
foreach ($file in $targets) {
    $text = $null
    try { $text = Get-Content $file.FullName -Raw -Encoding utf8 } catch { continue }
    if (-not $text) { continue }

    foreach ($rule in $rules) {
        $matches2 = [regex]::Matches($text, $rule.Regex)
        foreach ($m in $matches2) {
            if ($rule.Allow -and $m.Value -match $rule.Allow) { continue }
            # 定位行号
            $idx = $text.Substring(0, $m.Index).Split("`n").Count
            $masked = $m.Value
            if ($masked.Length -gt 12) { $masked = $masked.Substring(0, 8) + '…' + $masked.Substring($masked.Length - 4) }
            $hits += [pscustomobject]@{
                File  = $file.FullName.Replace((Get-Location).Path + '\', '')
                Line  = $idx
                Rule  = $rule.Name
                Value = $masked
            }
        }
    }
}

if ($hits.Count -eq 0) {
    Write-Host '  ✅ 未发现密钥' -ForegroundColor Green
    exit 0
}

Write-Host ''
Write-Host "  ❌ 发现 $($hits.Count) 处疑似密钥，不要提交：" -ForegroundColor Red
$hits | Group-Object File | ForEach-Object {
    Write-Host "     $($_.Name)"
    $_.Group | Select-Object -First 5 | ForEach-Object {
        Write-Host "       L$($_.Line)  [$($_.Rule)]  $($_.Value)"
    }
}
Write-Host ''
Write-Host '  处理办法：换成占位符、挪进不入库的配置文件（.env / keystore.properties），或加进 .gitignore。'
exit 1
