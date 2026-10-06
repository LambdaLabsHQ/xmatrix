param(
  [string]$Workspace,
  [string]$GitHubRunnerName,
  [UInt64]$MinimumFreeBytes = 20GB
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'kache-cache.ps1')

function Get-NormalizedWindowsPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  return [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Assert-WindowsRustCleanupPath {
  param(
    [Parameter(Mandatory = $true)][string]$Candidate,
    [Parameter(Mandatory = $true)][string]$ExpectedParent,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $normalizedCandidate = Get-NormalizedWindowsPath -Path $Candidate
  $normalizedParent = Get-NormalizedWindowsPath -Path $ExpectedParent
  $prefix = "$normalizedParent\"
  if (-not $normalizedCandidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label cleanup path escaped its managed parent: $normalizedCandidate"
  }
  $ancestor = $normalizedCandidate
  while (-not [string]::IsNullOrWhiteSpace($ancestor)) {
    $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction SilentlyContinue
    if ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label cleanup path has a reparse ancestor"
    }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
  }
  return $normalizedCandidate
}

function Resolve-WindowsRustCleanupCache {
  param([string]$Workspace, [string]$GitHubRunnerName, [string]$LocalAppData,
    [string]$UserProfileDir, [string]$ExplicitCacheDir)

  $cacheBase = if (-not [string]::IsNullOrWhiteSpace($LocalAppData)) {
    $LocalAppData
  } else { Join-Path $UserProfileDir 'AppData\Local' }
  $cacheParent = Join-Path $cacheBase 'kache-runners'
  $canonical = Resolve-KacheCacheDirectory -LocalAppData $LocalAppData `
    -HomeDir $UserProfileDir -GitHubRunnerName $GitHubRunnerName -Version '0.10.0'
  if ([string]::IsNullOrWhiteSpace($ExplicitCacheDir)) { $ExplicitCacheDir = $canonical }
  $cache = Assert-WindowsRustCleanupPath -Candidate $ExplicitCacheDir `
    -ExpectedParent $cacheParent -Label 'kache'
  if ($cache -eq (Get-NormalizedWindowsPath $canonical)) { return $cache }

  # Existing Windows runner services use runner[-N] instead of their public
  # local-windows-x64[-N]/v0.10.0 directory. Accept only that exact legacy
  # mapping, with both the workspace and non-secret registration metadata
  # proving it belongs to this runner. An arbitrary override is never cleanup
  # authority, even when it is somewhere below kache-runners.
  if ($GitHubRunnerName -notmatch '^local-windows-x64(?<suffix>-[1-9][0-9]*)?$') {
    throw 'Unknown kache override; no runner-owned cleanup mapping'
  }
  $legacyName = 'runner' + $Matches['suffix']
  $legacyCache = Get-NormalizedWindowsPath (Join-Path $cacheParent $legacyName)
  if ($cache -ne $legacyCache) { throw 'Kache override belongs to another or unknown runner' }
  $projects = Join-Path $UserProfileDir 'Projects'
  $installation = Assert-WindowsRustCleanupPath -Candidate (Join-Path $projects $legacyName) `
    -ExpectedParent $projects -Label 'runner registration'
  $work = Join-Path $installation '_work'
  Assert-WindowsRustCleanupPath -Candidate $Workspace -ExpectedParent $work `
    -Label 'runner workspace' | Out-Null
  $registrationPath = Assert-WindowsRustCleanupPath -Candidate (Join-Path $installation '.runner') `
    -ExpectedParent $installation -Label 'runner registration'
  try { $registration = Get-Content -LiteralPath $registrationPath -Raw | ConvertFrom-Json }
  catch { throw 'Cannot verify non-secret runner registration metadata' }
  if ($registration.agentName -ne $GitHubRunnerName -or $registration.workFolder -ne '_work') {
    throw 'Kache override does not match this runner registration'
  }
  return $cache
}

function Remove-WindowsRustRebuildableDirectory {
  param([string]$Path, [int]$MaximumEntries = 200000, [int]$MaximumSeconds = 60)

  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return }
  # Validate the complete bounded tree before deleting anything. Windows
  # junctions must not let recursive removal cross into unrelated files.
  $pending = [Collections.Generic.Queue[string]]::new()
  $pending.Enqueue($Path)
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $entries = 0
  while ($pending.Count -gt 0) {
    $directory = $pending.Dequeue()
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
      $entries++
      if ($entries -gt $MaximumEntries -or $clock.Elapsed.TotalSeconds -gt $MaximumSeconds) {
        throw 'CI cleanup tree exceeds validation bounds; nothing in this tree was removed'
      }
      $item = Get-Item -LiteralPath $entry -Force -ErrorAction Stop
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'CI cleanup tree contains a reparse point; nothing in this tree was removed'
      }
      if ($item.PSIsContainer) { $pending.Enqueue($item.FullName) }
    }
  }
  Write-Host "Removing validated rebuildable CI directory: $Path"
  Remove-Item -LiteralPath $Path -Recurse -Force
}

function Invoke-WindowsRustDiskReclamation {
  param(
    [Parameter(Mandatory = $true)][string]$Workspace,
    [Parameter(Mandatory = $true)][string]$GitHubRunnerName,
    [UInt64]$MinimumFreeBytes = 20GB,
    [string]$LocalAppData = $env:LOCALAPPDATA,
    [string]$UserProfileDir = ([Environment]::GetFolderPath('UserProfile')),
    [string]$ExplicitCacheDir = $env:KACHE_CACHE_DIR,
    [Nullable[UInt64]]$AvailableFreeBytes
  )

  if ([string]::IsNullOrWhiteSpace($Workspace)) { throw 'GitHub workspace is unavailable' }
  if ([string]::IsNullOrWhiteSpace($GitHubRunnerName)) { throw 'GitHub runner name is unavailable' }

  $normalizedWorkspace = Get-NormalizedWindowsPath -Path $Workspace
  $target = Assert-WindowsRustCleanupPath `
    -Candidate (Join-Path $normalizedWorkspace 'packages\cli-rs\target') `
    -ExpectedParent $normalizedWorkspace `
    -Label 'Cargo target'
  $workspaceRoot = [System.IO.Path]::GetPathRoot($normalizedWorkspace)
  if ([string]::IsNullOrWhiteSpace($workspaceRoot)) {
    throw "GitHub workspace has no drive root: $normalizedWorkspace"
  }
  function Read-FreeBytes {
    if ($null -ne $AvailableFreeBytes) { return [UInt64]$AvailableFreeBytes }
    return [UInt64]([System.IO.DriveInfo]::new($workspaceRoot).AvailableFreeSpace)
  }
  function Report-Free([string]$Label) {
    $free = Read-FreeBytes
    Write-Host ("Windows Rust disk {0}: {1:N2} GiB free (floor {2:N2} GiB)" -f `
      $Label, ($free / 1GB), ($MinimumFreeBytes / 1GB))
    return $free
  }

  $free = Report-Free 'before preflight'
  if ($free -ge $MinimumFreeBytes) { return }

  $cache = Resolve-WindowsRustCleanupCache -Workspace $normalizedWorkspace `
    -GitHubRunnerName $GitHubRunnerName -LocalAppData $LocalAppData `
    -UserProfileDir $UserProfileDir -ExplicitCacheDir $ExplicitCacheDir

  if (Test-Path -LiteralPath $target -PathType Container) {
    Remove-WindowsRustRebuildableDirectory -Path $target
  }
  $free = Report-Free 'after Cargo target cleanup'
  if ($free -ge $MinimumFreeBytes) { return }

  # kache uses NTFS hard links for restored artifacts. Removing only target/
  # may therefore release no blocks until this runner's matching cache link is
  # removed too. The cache is runner-scoped and entirely rebuildable.
  if (Test-Path -LiteralPath $cache -PathType Container) {
    Remove-WindowsRustRebuildableDirectory -Path $cache
  }
  $free = Report-Free 'after kache cleanup'
  if ($free -lt $MinimumFreeBytes) {
    Write-Warning ("Windows runner remains below the {0:N2} GiB disk floor; build will continue with reduced Rust artifact settings." -f ($MinimumFreeBytes / 1GB))
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  Invoke-WindowsRustDiskReclamation `
    -Workspace $Workspace `
    -GitHubRunnerName $GitHubRunnerName `
    -MinimumFreeBytes $MinimumFreeBytes
}
