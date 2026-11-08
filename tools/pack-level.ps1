param()

# Pack out/ into a platform-compliant ZIP and run the official checker on it.
# Usage: npm run pack   (or: powershell -NoProfile -File tools/pack-level.ps1)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$gameDir = Join-Path $root 'out'
$releaseDir = Join-Path $root 'release'
$zipPath = Join-Path $releaseDir 'lava-city.zip'

if (-not (Test-Path (Join-Path $gameDir 'index.html'))) {
  Write-Host '[pack] out/index.html missing. Run `npm run build` first.' -ForegroundColor Red
  exit 1
}

$files = Get-ChildItem $gameDir -Recurse -File | Where-Object {
  $rel = $_.FullName.Substring($gameDir.Length + 1)
  $parts = $rel -split '\\'
  if ($parts | Where-Object { $_ -match '^\.' }) { return $false }
  if ($parts -contains 'node_modules' -or $parts -contains '.git') { return $false }
  return $true
}

$total = ($files | Measure-Object Length -Sum).Sum
if ($null -eq $total) { $total = 0 }
$tooBig = $files | Where-Object { $_.Length -gt 35MB }
if ($total -gt 40MB) {
  Write-Host ('[pack] unpacked size {0} MB exceeds 40 MB' -f [math]::Round($total / 1MB, 1)) -ForegroundColor Red
  exit 1
}
if ($files.Count -gt 250) {
  Write-Host ('[pack] {0} files exceeds the 250 file limit' -f $files.Count) -ForegroundColor Red
  exit 1
}
if ($tooBig) {
  Write-Host ('[pack] single file over 35 MB: {0}' -f $tooBig[0].Name) -ForegroundColor Red
  exit 1
}

if (-not (Test-Path $releaseDir)) { New-Item -ItemType Directory -Force $releaseDir | Out-Null }
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($gameDir.Length + 1) -replace '\\', '/'
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip, $f.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $zip.Dispose() }

$size = (Get-Item $zipPath).Length
if ($size -gt 12MB) {
  Write-Host ('[pack] zip size {0} MB exceeds 12 MB' -f [math]::Round($size / 1MB, 2)) -ForegroundColor Red
  exit 1
}

& node (Join-Path $root 'kit\tools\check.mjs') $zipPath
if ($LASTEXITCODE -ne 0) {
  Write-Host '[pack] check.mjs failed on the generated zip.' -ForegroundColor Red
  exit 1
}

Write-Host ('[pack] OK -> {0}' -f $zipPath) -ForegroundColor Green
Write-Host ('[pack] files {0} | zip {1} MB | unpacked {2} MB' -f $files.Count, [math]::Round($size / 1MB, 2), [math]::Round($total / 1MB, 1))
