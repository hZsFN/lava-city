param(
  [switch]$Quiet
)

# ============================================================================
# 契约红线检查（四路会话共用的「不许违反」清单）
#   ① src/core/events.ts 的哈希必须等于 docs/plan/CONTRACT.lock
#   ② 逻辑层（towers/flow/player/combat/boss）不得 import three
#   ③ 不得出现禁用 API：alert / confirm / window.top.location / parent.location
#   ④ 不得出现 IP 词汇（版权红线）
# 用法： npm run contract   或   pwsh -File scripts/check-contract.ps1
# ============================================================================

$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

$violations = @()
function Fail([string]$msg) { $script:violations += $msg }

# ---------- ① 契约文件哈希 ----------
$lockPath = Join-Path $root 'docs\plan\CONTRACT.lock'
$eventsPath = Join-Path $root 'src\core\events.ts'
if (-not (Test-Path $lockPath)) {
  Fail "缺少 docs/plan/CONTRACT.lock —— 无法校验契约完整性"
} elseif (-not (Test-Path $eventsPath)) {
  Fail "缺少 src/core/events.ts"
} else {
  $expect = (Get-Content $lockPath -Raw).Trim().ToLower()
  $actual = (Get-FileHash $eventsPath -Algorithm SHA256).Hash.ToLower()
  if ($expect -ne $actual) {
    Fail "src/core/events.ts 被修改（期望 $($expect.Substring(0,12))…，实际 $($actual.Substring(0,12))…）。契约只有 S0 能改；需要新事件请在 handoff 里提「契约申请」。"
  }
}

# ---------- ② 逻辑层禁止 import three ----------
$logicDirs = @('src\towers', 'src\flow', 'src\player', 'src\combat', 'src\boss')
$threePattern = "from\s+['""]three(/[a-z]+)?['""]|require\(\s*['""]three"
foreach ($dir in $logicDirs) {
  $full = Join-Path $root $dir
  if (-not (Test-Path $full)) { continue }
  Get-ChildItem $full -Recurse -File -Include *.ts,*.tsx -ErrorAction SilentlyContinue | ForEach-Object {
    $hits = Select-String -Path $_.FullName -Pattern $threePattern -AllMatches -ErrorAction SilentlyContinue
    foreach ($h in $hits) {
      $rel = $h.Path.Substring($root.Length + 1)
      Fail "逻辑层 import three：$rel`:$($h.LineNumber)"
    }
  }
}

# ---------- ③ 禁用 API ----------
$scanRoots = @('src', 'index.html')
$bannedApi = 'alert\s*\(|confirm\s*\(|window\.top\.location|parent\.location|top\.location\s*='
foreach ($target in $scanRoots) {
  $full = Join-Path $root $target
  if (-not (Test-Path $full)) { continue }
  $files = if (Test-Path $full -PathType Leaf) { @(Get-Item $full) } else {
    Get-ChildItem $full -Recurse -File -Include *.ts,*.tsx,*.js,*.mjs,*.html -ErrorAction SilentlyContinue
  }
  foreach ($f in $files) {
    $hits = Select-String -Path $f.FullName -Pattern $bannedApi -AllMatches -ErrorAction SilentlyContinue
    foreach ($h in $hits) {
      # 允许注释里出现（用于说明「禁止」）
      if ($h.Line.TrimStart().StartsWith('//') -or $h.Line.TrimStart().StartsWith('*')) { continue }
      $rel = $h.Path.Substring($root.Length + 1)
      Fail "禁用 API：$rel`:$($h.LineNumber) → $($h.Line.Trim())"
    }
  }
}

# ---------- ④ IP 词汇（版权红线） ----------
$ipPattern = '任天堂|Nintendo|迪士尼|Disney|原神|Genshin|米哈游|宝可梦|Pok[eé]mon|Mario|马里奥|漫威|Marvel|Minecraft|我的世界'
foreach ($target in $scanRoots) {
  $full = Join-Path $root $target
  if (-not (Test-Path $full)) { continue }
  $files = if (Test-Path $full -PathType Leaf) { @(Get-Item $full) } else {
    Get-ChildItem $full -Recurse -File -Include *.ts,*.tsx,*.js,*.mjs,*.html -ErrorAction SilentlyContinue
  }
  foreach ($f in $files) {
    $hits = Select-String -Path $f.FullName -Pattern $ipPattern -AllMatches -ErrorAction SilentlyContinue
    foreach ($h in $hits) {
      $rel = $h.Path.Substring($root.Length + 1)
      Fail "IP 词汇：$rel`:$($h.LineNumber) → $($h.Matches[0].Value)"
    }
  }
}

# ---------- 汇总 ----------
if ($violations.Count -eq 0) {
  if (-not $Quiet) { Write-Host "[contract] OK · 契约哈希一致 / 逻辑层无 three / 无禁用 API / 无 IP 词汇" -ForegroundColor Green }
  exit 0
}

Write-Host "[contract] 发现 $($violations.Count) 处红线违规：" -ForegroundColor Red
$violations | ForEach-Object { Write-Host "  ✗ $_" -ForegroundColor Red }
Write-Host ""
Write-Host "修正方式：" -ForegroundColor Yellow
Write-Host "  · events.ts 被改 → git checkout -- src/core/events.ts，改走契约申请"
Write-Host "  · 逻辑层 import three → 改成通过 Bus 事件 + snapshot() 取数据"
Write-Host "  · 禁用 API → 换成 UI 内自绘提示，不用原生弹窗"
exit 1
