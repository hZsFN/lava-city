param(
  [Parameter(Mandatory = $true)][string]$GameDir,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'
Get-Command node -ErrorAction Stop | Out-Null

# 把你的关卡目录打成合规 ZIP（零依赖，只用系统 .NET 压缩）
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = (Resolve-Path $GameDir).Path
$outPath = if ([IO.Path]::IsPathRooted($Out)) { [IO.Path]::GetFullPath($Out) }
           else { [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Out)) }

if (-not (Test-Path (Join-Path $root 'index.html'))) {
  Write-Host "❌ 根目录缺少 index.html：$root" -ForegroundColor Red
  Write-Host "   请把入口文件放在关卡目录最外层，不要多套一层文件夹。" -ForegroundColor Yellow
  exit 1
}
if (Test-Path $outPath) {
  Write-Host "❌ 目标文件已存在，请换个名字：$outPath" -ForegroundColor Red
  exit 1
}

$files = Get-ChildItem $root -Recurse -File | Where-Object {
  $rel = $_.FullName.Substring($root.Length + 1)
  $parts = $rel -split '\\'
  if ($parts | Where-Object { $_ -match '^\.' }) { return $false }
  if (($parts -contains 'node_modules') -or ($parts -contains '.git')) { return $false }
  return $true
}

$total = ($files | Measure-Object Length -Sum).Sum
$tooBig = $files | Where-Object { $_.Length -gt 35MB }
if ($total -gt 40MB) {
  Write-Host "❌ 解压后 $([math]::Round($total / 1MB, 1))MB，超过 40MB" -ForegroundColor Red
  exit 1
}
if ($files.Count -gt 250) {
  Write-Host "❌ 文件数 $($files.Count)，超过 250 个" -ForegroundColor Red
  exit 1
}
if ($tooBig) {
  Write-Host "❌ 单文件超过 35MB：$($tooBig[0].Name)" -ForegroundColor Red
  exit 1
}

$zip = [System.IO.Compression.ZipFile]::Open($outPath, 'Create')
try {
foreach ($f in $files) {
  $rel = $f.FullName.Substring($root.Length + 1) -replace '\\','/'
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
    $zip, $f.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
}
} finally { $zip.Dispose() }

# 对实际生成的 ZIP 使用与选手自检相同的条目名、扩展名和体积规则。
& node (Join-Path $PSScriptRoot 'check.mjs') $outPath
if ($LASTEXITCODE -ne 0) {
  throw 'ZIP 预检未通过，不能提交；请修复上面的具体条目后重新打包。'
}

$size = (Get-Item $outPath).Length
if ($size -gt 20MB) {
  Write-Host "❌ 压缩后 $([math]::Round($size / 1MB, 2))MB，超过 20MB" -ForegroundColor Red
  exit 1
}

Write-Host "✅ 已生成：$outPath" -ForegroundColor Green
Write-Host "   文件数：$($files.Count)　压缩后：$([math]::Round($size / 1MB, 2))MB　解压后：$([math]::Round($total / 1MB, 1))MB"
