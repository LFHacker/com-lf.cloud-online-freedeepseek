#!/usr/bin/env pwsh
# 一键构建：读 VERSION → 构建前端 → 同步到 Android → 打 APK → 落到 delivery/
#
#   pwsh -File scripts/build.ps1                     # 干净构建（发行版用这个）
#   pwsh -File scripts/build.ps1 -PrefillToken xxx   # 预置令牌的私有包（不发布！）
#
# 版本号只看仓库根目录的 VERSION：
#   0.7.0A-debug → 走 assembleDebug，产物名带 -debug
#   0.7.0        → 走 assembleRelease（需要 keystore.properties）

param(
    [string]$PrefillToken = '',
    [string]$ApiOrigin    = 'https://api.l-f-cloud.online:8443'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$version = (Get-Content VERSION -Raw).Trim()
$isDev = $version -match '-debug$'
Write-Host "  版本: $version  ($(if ($isDev) { '开发版' } else { '发行版' }))"

if ($PrefillToken) {
    Write-Host '  ⚠️  预置了令牌：这个包只许本地自用，不得发布或外发' -ForegroundColor Yellow
}

# ── 1. 前端 ────────────────────────────────────────────────
Push-Location app
try {
    $env:NODE_ENV       = 'production'
    $env:APP_VERSION    = $version
    $env:APP_API_ORIGIN = $ApiOrigin
    $env:DEV_API_KEY    = $PrefillToken
    pnpm exec rspack build -c rspack.config.ts
} finally {
    Pop-Location
}

# ── 2. 同步进 Android ──────────────────────────────────────
Push-Location android-app
try {
    if (Test-Path www) { Remove-Item www -Recurse -Force }
    Copy-Item "$root\app\dist" www -Recurse
    Get-ChildItem www -Recurse -File -Include *.ttf,*.woff | Remove-Item -Force
    npx --no-install cap sync android | Out-Null
} finally {
    Pop-Location
}

# ── 3. 打包 ────────────────────────────────────────────────
$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { "$env:LOCALAPPDATA\Android\Sdk" }
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk

$task = if ($isDev) { 'assembleDebug' } else { 'assembleRelease' }
Push-Location "$root\android-app\android"
try {
    & .\gradlew.bat $task --no-daemon --console=plain | Select-Object -Last 3
} finally {
    Pop-Location
}

$built = if ($isDev) {
    "$root\android-app\android\app\build\outputs\apk\debug\app-debug.apk"
} else {
    "$root\android-app\android\app\build\outputs\apk\release\app-release.apk"
}
if (-not (Test-Path $built)) { throw "构建失败：找不到 $built" }

# ── 4. 落到 delivery/（不进仓库）───────────────────────────
New-Item -ItemType Directory -Force -Path "$root\delivery" | Out-Null
$suffix = if ($PrefillToken) { '-prefilled' } else { '' }
$name = "freedeepseek-v$version$suffix.apk"
Copy-Item $built "$root\delivery\$name" -Force

$sizeMb = [math]::Round((Get-Item "$root\delivery\$name").Length / 1MB, 2)
Write-Host "  ✅ delivery\$name  ($sizeMb MB)" -ForegroundColor Green
