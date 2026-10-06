$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'kache-cache.ps1')

function Assert-Equal {
  param(
    [Parameter(Mandatory = $true)]$Actual,
    [Parameter(Mandatory = $true)]$Expected,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if ($Actual -ne $Expected) {
    throw "$Label expected=<$Expected> actual=<$Actual>"
  }
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) "xmatrix-kache-contract-$([guid]::NewGuid())"
try {
  $localAppData = Join-Path $testRoot 'Local'
  $resolved = Resolve-KacheCacheDirectory `
    -LocalAppData $localAppData `
    -HomeDir $testRoot `
    -GitHubRunnerName 'local-windows-x64-2' `
    -FallbackRunnerName 'runner-2' `
    -Version '0.10.0'
  Assert-Equal `
    -Actual $resolved `
    -Expected (Join-Path $localAppData 'kache-runners\local-windows-x64-2\v0.10.0') `
    -Label 'explicit GitHub runner identity wins over host fallback'

  $sanitized = Resolve-KacheCacheDirectory `
    -LocalAppData $localAppData `
    -HomeDir $testRoot `
    -GitHubRunnerName 'runner name/unsafe' `
    -Version '0.10.0'
  Assert-Equal `
    -Actual $sanitized `
    -Expected (Join-Path $localAppData 'kache-runners\runner_name_unsafe\v0.10.0') `
    -Label 'runner cache key sanitization'

  $override = Join-Path $testRoot 'explicit-cache'
  $resolvedOverride = Resolve-KacheCacheDirectory `
    -ExplicitCacheDir $override `
    -LocalAppData $localAppData `
    -HomeDir $testRoot `
    -GitHubRunnerName 'ignored' `
    -Version '0.10.0'
  Assert-Equal -Actual $resolvedOverride -Expected $override -Label 'explicit cache override'

  $blobDir = Join-Path $resolved 'store\blobs\aa'
  New-Item -ItemType Directory -Force -Path $blobDir | Out-Null
  $hash = ('a' * 64) -join ''
  $staleTemp = Join-Path $blobDir ".$hash.2147483647.0.tmp"
  $freshTemp = Join-Path $blobDir ".$hash.101.0.tmp"
  $activeTemp = Join-Path $blobDir ".$hash.$PID.0.tmp"
  $unrelatedTemp = Join-Path $blobDir 'notes.tmp'
  Set-Content -LiteralPath $staleTemp -Value 'stale' -NoNewline
  Set-Content -LiteralPath $freshTemp -Value 'fresh' -NoNewline
  Set-Content -LiteralPath $activeTemp -Value 'active' -NoNewline
  Set-Content -LiteralPath $unrelatedTemp -Value 'unrelated' -NoNewline
  (Get-Item -LiteralPath $staleTemp).LastWriteTimeUtc = [DateTime]::UtcNow.AddHours(-25)
  (Get-Item -LiteralPath $activeTemp).LastWriteTimeUtc = [DateTime]::UtcNow.AddHours(-25)
  (Get-Item -LiteralPath $unrelatedTemp).LastWriteTimeUtc = [DateTime]::UtcNow.AddHours(-25)

  $removed = Remove-KacheStaleBlobTemps -CacheDir $resolved
  Assert-Equal -Actual $removed -Expected 1 -Label 'stale blob temp cleanup count'
  Assert-Equal -Actual (Test-Path -LiteralPath $staleTemp) -Expected $false -Label 'stale blob temp removed'
  Assert-Equal -Actual (Test-Path -LiteralPath $freshTemp) -Expected $true -Label 'fresh blob temp preserved'
  Assert-Equal -Actual (Test-Path -LiteralPath $activeTemp) -Expected $true -Label 'active-process temp preserved'
  Assert-Equal -Actual (Test-Path -LiteralPath $unrelatedTemp) -Expected $true -Label 'unrecognized temp preserved'

  Write-Host 'Windows kache cache contract passed.'
} finally {
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
