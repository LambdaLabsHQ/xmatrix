$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'kache-cache.ps1')

# Native Windows counterpart to setup-kache.sh. Keep this script free of
# Git Bash/MSYS dependencies so Windows Rust validation uses the MSVC toolchain
# and native PowerShell end to end.
$version = '0.10.0'
if ($env:KACHE_VERSION -and $env:KACHE_VERSION -ne $version) {
  throw "required Windows CI pins kache $version; refusing override $env:KACHE_VERSION"
}
$homeDir = if ($HOME) { $HOME } else { [Environment]::GetFolderPath('UserProfile') }
if ([string]::IsNullOrWhiteSpace($homeDir)) { throw 'Windows user home is unavailable' }
$pathCurl = Get-Command curl.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$curl = @(
  (Join-Path $env:SystemRoot 'System32\curl.exe')
  $pathCurl.Source
) | Where-Object {
  $_ -and
  (Test-Path -LiteralPath $_ -PathType Leaf) -and
  $_ -notmatch '(?i)\\(?:Git|msys|cygwin|Strawberry|perl)\\'
} | Select-Object -First 1
if (-not $curl -or -not [System.IO.Path]::IsPathRooted($curl)) {
  throw 'native absolute curl.exe was not found'
}
$rustcVerboseVersion = @(rustc -vV)
if ($LASTEXITCODE -ne 0) { throw 'rustc -vV failed before kache setup' }
$hostLine = $rustcVerboseVersion | Where-Object { $_ -like 'host: *' } | Select-Object -First 1
if (-not $hostLine) {
  throw 'rustc did not report a host triple'
}
$target = $hostLine.Substring(6).Trim()
if ($target -notin @('x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc')) {
  throw "kache has no release for Windows rustc host $target"
}

$installDir = Join-Path $homeDir ".local\accelerator-ci\kache\v$version"
$kache = Join-Path $installDir 'kache.exe'
$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$downloadRoot = Join-Path $tempRoot "xmatrix-kache-$([guid]::NewGuid())"
$assetName = "kache-$target.exe"
$asset = Join-Path $downloadRoot $assetName
$checksum = "$asset.sha256"
$baseUrl = "https://github.com/kunobi-ninja/kache/releases/download/v$version"
New-Item -ItemType Directory -Force -Path $installDir, $downloadRoot | Out-Null
try {
  & $curl -fsSL --retry 5 --retry-delay 2 "$baseUrl/$assetName.sha256" -o $checksum
  $checksumOk = ($LASTEXITCODE -eq 0)
  if (-not $checksumOk) {
    if (Test-Path -LiteralPath $kache -PathType Leaf) {
      Write-Host "kache checksum download failed; using already-installed $kache"
    } else {
      throw "failed to download $assetName.sha256"
    }
  } else {
    $expected = ((Get-Content -LiteralPath $checksum -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$') {
      throw "invalid release checksum for $assetName"
    }

    if (Test-Path -LiteralPath $kache -PathType Leaf) {
      $installedHash = (Get-FileHash -LiteralPath $kache -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($installedHash -ne $expected) {
        Remove-Item -Force -LiteralPath $kache
      }
    }
    if (-not (Test-Path -LiteralPath $kache -PathType Leaf)) {
      & $curl -fsSL --retry 5 --retry-delay 2 "$baseUrl/$assetName" -o $asset
      if ($LASTEXITCODE -ne 0) { throw "failed to download $assetName" }
      $actual = (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actual -ne $expected) {
        throw "kache checksum mismatch: expected=$expected actual=$actual"
      }
      Move-Item -Force -LiteralPath $asset -Destination $kache
    }
  }
} finally {
  Remove-Item -LiteralPath $downloadRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$managedCacheDir = [string]::IsNullOrWhiteSpace($env:KACHE_CACHE_DIR)
if (
  $managedCacheDir -and
  $env:GITHUB_ACTIONS -eq 'true' -and
  [string]::IsNullOrWhiteSpace($env:KACHE_GITHUB_RUNNER_NAME)
) {
  throw 'KACHE_GITHUB_RUNNER_NAME must be populated from the runner.name context'
}
$cacheDir = Resolve-KacheCacheDirectory `
  -ExplicitCacheDir $env:KACHE_CACHE_DIR `
  -LocalAppData $env:LOCALAPPDATA `
  -HomeDir $HOME `
  -GitHubRunnerName $env:KACHE_GITHUB_RUNNER_NAME `
  -FallbackRunnerName $env:RUNNER_NAME `
  -Version $version
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
$workspace = $env:GITHUB_WORKSPACE
if ([string]::IsNullOrWhiteSpace($workspace)) {
  $workspace = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
$kacheConfig = Join-Path $workspace 'scripts\kache.toml'
if (-not (Test-Path -LiteralPath $kacheConfig -PathType Leaf)) {
  throw "required kache configuration is missing: $kacheConfig"
}
if ($managedCacheDir) {
  $removedStaleTemps = Remove-KacheStaleBlobTemps -CacheDir $cacheDir
  if ($removedStaleTemps -gt 0) {
    Write-Host "Removed $removedStaleTemps stale kache blob temp file(s) from this runner cache."
  }
}

& $kache --version
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::AppendAllText($env:GITHUB_PATH, "$installDir`n", $utf8)
@(
  "RUSTC_WRAPPER=$kache"
  "KACHE_CACHE_DIR=$cacheDir"
  "KACHE_CONFIG=$kacheConfig"
  # Full kache utilization: restore object and final PE artifacts across clean
  # worktrees. Hardlinks on NTFS make hit restore near-instant without sharing
  # one CARGO_TARGET_DIR across concurrent jobs.
  'KACHE_CACHE_EXECUTABLES=true'
  'KACHE_WINDOWS_HARDLINK=true'
) | ForEach-Object {
  [System.IO.File]::AppendAllText($env:GITHUB_ENV, "$_`n", $utf8)
}
Write-Host "kache enabled: wrapper=$kache cache=$cacheDir config=$kacheConfig cache_executables=true windows_hardlink=true"
