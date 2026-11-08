param(
  [switch]$SkipTest,
  [switch]$SkipBuild,
  [switch]$SkipPack
)

# ============================================================================
# 门禁脚本。两种用法：
#
#   npm run gate:fast   只跑 contract + typecheck（约 8 秒，不启动子进程，不弹沙箱）
#                       —— 日常每改完一个文件跑这个
#
#   npm run gate        全量（contract → typecheck → test → build → pack）
#                       —— 提交前跑一次；test/build 阶段会启动 esbuild 子进程，
#                          受限沙箱下可能弹「允许一次」，这是已知边界不是错误
#
# 任何一步非零退出，整条门禁失败（fail-fast）。
# ============================================================================

$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

# esbuild 在沙箱里删不掉 %TEMP% 下的临时文件会报 Access denied。
# 把 TEMP 指到仓库内 .tmp/，问题消失且不污染系统临时目录。
$tmpDir = Join-Path $root '.tmp'
if (-not (Test-Path $tmpDir)) { New-Item -ItemType Directory -Force $tmpDir | Out-Null }
$env:TEMP = $tmpDir
$env:TMP = $tmpDir

function Invoke-Step {
  param([string]$Name, [string]$Cmd)
  Write-Host ""
  Write-Host "===== [$Name] =====" -ForegroundColor Cyan
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Invoke-Expression $Cmd 2>&1 | Out-Host
  $code = $LASTEXITCODE
  $sw.Stop()
  if ($code -ne 0) {
    Write-Host ("[gate] FAIL {0} (exit {1}, {2:n1}s)" -f $Name, $code, $sw.Elapsed.TotalSeconds) -ForegroundColor Red
    return $false
  }
  Write-Host ("[gate] OK   {0} ({1:n1}s)" -f $Name, $sw.Elapsed.TotalSeconds) -ForegroundColor Green
  return $true
}

# 0. 契约红线（events.ts 未被篡改 / 逻辑层没 import three / 没禁用 API / 没 IP 词汇）
if (-not (Invoke-Step 'contract' "& powershell -NoProfile -ExecutionPolicy Bypass -File '$(Join-Path $PSScriptRoot 'check-contract.ps1')'")) {
  Write-Host "[gate] 契约红线未通过，后续步骤跳过。" -ForegroundColor Red
  exit 1
}

# 1. 类型
if (-not (Invoke-Step 'typecheck' 'npx tsc --noEmit')) { exit 1 }

# 2. 单测（会启动 esbuild 子进程，受限沙箱下可能弹提权）
if (-not $SkipTest) {
  if (-not (Invoke-Step 'test' 'npx vitest run')) { exit 1 }
}

# 3. 构建
if (-not $SkipBuild) {
  if (-not (Invoke-Step 'build' 'npx vite build')) { exit 1 }
}

# 4. 打包 + 官方 check.mjs（体积/扩展名/相对路径/禁用 API/道具声明）
if (-not $SkipPack -and -not $SkipBuild) {
  if (-not (Invoke-Step 'pack' "& powershell -NoProfile -ExecutionPolicy Bypass -File '$(Join-Path $root 'tools\pack-level.ps1')'")) { exit 1 }
}

Write-Host ""
if ($SkipTest -or $SkipBuild) {
  Write-Host "[gate] ===== 快速检查通过（未含 test/build/pack）=====" -ForegroundColor Yellow
  Write-Host "[gate] 提交前请跑完整 npm run gate。" -ForegroundColor Yellow
} else {
  Write-Host "[gate] ===== 全部通过 =====" -ForegroundColor Green
  Write-Host "[gate] 可以 commit。推送前请再确认 handoff/<你的会话>.md 已更新。" -ForegroundColor Green
}
exit 0
