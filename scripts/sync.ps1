#!/usr/bin/env pwsh
# 提交并推送到 GitHub（走 ~/.ssh/config 里的 443 配置）
#
#   pwsh -File scripts/sync.ps1 -Message "feat: 做了某件事" [-Tag v0.9.0A-debug]
#
# 设计取舍：推送失败不静默。用户明确要求"每次更新都自动推送"，
# 那就必须让失败可见 —— 否则会以为推上去了，其实一直在本地。

param(
    [Parameter(Mandatory = $true)][string]$Message,
    [string]$Tag = ''
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

# 公开仓库：推送前先过一遍密钥检查
& pwsh -NoProfile -File "$PSScriptRoot/check-secrets.ps1" | Out-Host
if ($LASTEXITCODE -ne 0) {
    Write-Host '  ❌ 密钥检查未通过，已中止推送' -ForegroundColor Red
    exit 1
}

git add -A
git commit -m $Message
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1) { throw 'commit 失败' }

$branch = git branch --show-current
git push origin $branch
if ($LASTEXITCODE -ne 0) { throw '推送失败' }

if ($Tag) {
    git tag -f -a $Tag -m $Tag
    git push --force origin $Tag
    if ($LASTEXITCODE -ne 0) { throw '推送标签失败' }
}

Write-Host "  ✅ 已推送到 origin/$branch$([string]::IsNullOrEmpty($Tag) ? '' : "  标签 $Tag")" -ForegroundColor Green
