function ConvertTo-KacheRunnerCacheKey {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RunnerName
  )

  $key = $RunnerName.Trim() -replace '[^A-Za-z0-9_.-]', '_'
  if ([string]::IsNullOrWhiteSpace($key) -or $key -in @('.', '..')) {
    throw "GitHub runner name cannot form a safe kache cache key"
  }
  if ($key -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$') {
    $key = "_$key"
  }
  return $key
}

function Resolve-KacheCacheDirectory {
  param(
    [string]$ExplicitCacheDir,
    [string]$LocalAppData,
    [string]$HomeDir,
    [string]$GitHubRunnerName,
    [string]$FallbackRunnerName,
    [Parameter(Mandatory = $true)]
    [string]$Version
  )

  if (-not [string]::IsNullOrWhiteSpace($ExplicitCacheDir)) {
    return $ExplicitCacheDir
  }
  if ($Version -notmatch '^[A-Za-z0-9_.-]+$') {
    throw "kache version cannot form a safe cache path"
  }

  $cacheBase = if (-not [string]::IsNullOrWhiteSpace($LocalAppData)) {
    $LocalAppData
  } else {
    Join-Path $HomeDir 'AppData\Local'
  }
  $runnerName = if (-not [string]::IsNullOrWhiteSpace($GitHubRunnerName)) {
    $GitHubRunnerName
  } else {
    $FallbackRunnerName
  }
  if ([string]::IsNullOrWhiteSpace($runnerName)) {
    return Join-Path $cacheBase 'kache'
  }

  $runnerCacheKey = ConvertTo-KacheRunnerCacheKey -RunnerName $runnerName
  $runnerCacheDir = Join-Path (Join-Path $cacheBase 'kache-runners') $runnerCacheKey
  return Join-Path $runnerCacheDir "v$Version"
}

function Remove-KacheStaleBlobTemps {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CacheDir,
    [datetime]$BeforeUtc = [DateTime]::UtcNow.AddHours(-24)
  )

  $blobRoot = Join-Path $CacheDir 'store\blobs'
  if (-not (Test-Path -LiteralPath $blobRoot -PathType Container)) {
    return 0
  }

  $removed = 0
  $tempPattern = '^\.[0-9a-f]{64}\.([0-9]+)\.[0-9]+\.tmp$'
  Get-ChildItem -LiteralPath $blobRoot -File -Recurse -Force -ErrorAction Stop |
    Where-Object {
      $match = [regex]::Match($_.Name, $tempPattern)
      if ($_.LastWriteTimeUtc -ge $BeforeUtc -or -not $match.Success) {
        $false
      } else {
        $ownerPid = $match.Groups[1].Value -as [int]
        $null -ne $ownerPid -and
          $null -eq (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)
      }
    } |
    ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
      $removed++
    }
  return $removed
}
