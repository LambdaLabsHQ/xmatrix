$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'reclaim-windows-rust-disk.ps1')

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) "xmatrix-windows-disk-$([guid]::NewGuid())"
try {
  $workspace = Join-Path $testRoot 'workspace'
  $localAppData = Join-Path $testRoot 'Local'
  $target = Join-Path $workspace 'packages\cli-rs\target'
  $cache = Join-Path $localAppData 'kache-runners\runner-2\v0.10.0'
  New-Item -ItemType Directory -Force -Path $target, $cache | Out-Null
  Set-Content -LiteralPath (Join-Path $target 'artifact') -Value 'target' -NoNewline
  Set-Content -LiteralPath (Join-Path $cache 'blob') -Value 'cache' -NoNewline

  Invoke-WindowsRustDiskReclamation `
    -Workspace $workspace `
    -GitHubRunnerName 'runner-2' `
    -LocalAppData $localAppData `
    -UserProfileDir $testRoot `
    -ExplicitCacheDir '' `
    -MinimumFreeBytes 1 `
    -AvailableFreeBytes 0

  if (Test-Path -LiteralPath $target) { throw 'low-disk preflight retained Cargo target' }
  if (Test-Path -LiteralPath $cache) { throw 'low-disk preflight retained runner kache' }

  $unsafe = Join-Path $testRoot 'outside'
  $rejected = $false
  try {
    Assert-WindowsRustCleanupPath `
      -Candidate $unsafe `
      -ExpectedParent $workspace `
      -Label 'test' | Out-Null
  } catch {
    $rejected = $true
  }
  if (-not $rejected) { throw 'cleanup boundary accepted a path outside its managed parent' }

  $installation = Join-Path $testRoot 'Projects\runner-2'
  $legacyWorkspace = Join-Path $installation '_work\xmatrix\xmatrix'
  $legacyTarget = Join-Path $legacyWorkspace 'packages\cli-rs\target'
  $legacyCache = Join-Path $localAppData 'kache-runners\runner-2'
  $siblingCache = Join-Path $localAppData 'kache-runners\runner-3'
  New-Item -ItemType Directory -Force -Path $legacyTarget, $legacyCache, $siblingCache | Out-Null
  $registration = Join-Path $installation '.runner'
  Set-Content -LiteralPath $registration -Value '{"agentName":"local-windows-x64-2","workFolder":"_work"}'
  Set-Content -LiteralPath (Join-Path $legacyTarget 'artifact') -Value 'target'
  Set-Content -LiteralPath (Join-Path $legacyCache 'blob') -Value 'cache'
  Set-Content -LiteralPath (Join-Path $siblingCache 'blob') -Value 'sibling'
  $arguments = @{ Workspace=$legacyWorkspace; GitHubRunnerName='local-windows-x64-2';
    LocalAppData=$localAppData; UserProfileDir=$testRoot; ExplicitCacheDir=$legacyCache;
    MinimumFreeBytes=1; AvailableFreeBytes=0 }

  # A healthy disk needs no cleanup authority and preserves custom caches.
  $healthy = $arguments.Clone()
  $healthy.AvailableFreeBytes = 2
  $healthy.ExplicitCacheDir = $siblingCache
  Invoke-WindowsRustDiskReclamation @healthy
  if (-not (Test-Path -LiteralPath $legacyTarget) -or
      -not (Test-Path -LiteralPath (Join-Path $siblingCache 'blob'))) {
    throw 'healthy disk preflight touched rebuildable data'
  }

  # A sibling or arbitrary override fails before touching even the target.
  foreach ($override in @($siblingCache, $unsafe, (Join-Path $localAppData 'kache-runners\shared'))) {
    $bad = $arguments.Clone()
    $bad.ExplicitCacheDir = $override
    $rejected = $false
    try { Invoke-WindowsRustDiskReclamation @bad } catch { $rejected = $true }
    if (-not $rejected) { throw 'unknown or sibling cache override was accepted' }
    if (-not (Test-Path -LiteralPath $legacyTarget)) { throw 'invalid override removed target before rejection' }
  }
  $bad = $arguments.Clone()
  $bad.Workspace = $workspace
  $rejected = $false
  try { Invoke-WindowsRustDiskReclamation @bad } catch { $rejected = $true }
  if (-not $rejected) { throw 'legacy cache accepted an unrelated workspace' }

  Set-Content -LiteralPath $registration -Value '{"agentName":"another-runner","workFolder":"_work"}'
  $rejected = $false
  try { Invoke-WindowsRustDiskReclamation @arguments } catch { $rejected = $true }
  if (-not $rejected) { throw 'legacy cache accepted a mismatched runner registration' }
  Set-Content -LiteralPath $registration -Value '{"agentName":"local-windows-x64-2","workFolder":"_work"}'

  # Metadata validation must finish before any recursive removal starts.
  Set-Content -LiteralPath (Join-Path $legacyCache 'second-blob') -Value 'cache'
  $rejected = $false
  try { Remove-WindowsRustRebuildableDirectory -Path $legacyCache -MaximumEntries 1 }
  catch { $rejected = $true }
  if (-not $rejected -or -not (Test-Path -LiteralPath (Join-Path $legacyCache 'blob'))) {
    throw 'bounded validation deleted an incomplete tree'
  }
  $junction = Join-Path $legacyCache 'foreign-link'
  New-Item -ItemType Junction -Path $junction -Target $siblingCache | Out-Null
  try {
    $rejected = $false
    try { Remove-WindowsRustRebuildableDirectory -Path $legacyCache } catch { $rejected = $true }
    if (-not $rejected) { throw 'cleanup accepted a nested junction' }
    $rejected = $false
    try { Assert-WindowsRustCleanupPath -Candidate (Join-Path $junction 'child') `
      -ExpectedParent $legacyCache -Label 'junction test' | Out-Null }
    catch { $rejected = $true }
    if (-not $rejected) { throw 'cleanup accepted a reparse ancestor' }
    if (-not (Test-Path -LiteralPath (Join-Path $siblingCache 'blob'))) { throw 'junction target was touched' }
  } finally { [IO.Directory]::Delete($junction) }

  Invoke-WindowsRustDiskReclamation @arguments
  if (Test-Path -LiteralPath $legacyTarget) { throw 'legacy target was not reclaimed' }
  if (Test-Path -LiteralPath $legacyCache) { throw 'verified legacy cache was not reclaimed' }
  if (-not (Test-Path -LiteralPath (Join-Path $siblingCache 'blob'))) { throw 'sibling runner cache was removed' }

  Write-Host 'Windows Rust disk reclamation contract passed.'
} finally {
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
