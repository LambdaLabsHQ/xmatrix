$ErrorActionPreference = "Stop"

# ── Force UTF-8 for PowerShell/native-process boundaries ─────────────
try {
  $Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [Console]::InputEncoding = $Utf8NoBom
  [Console]::OutputEncoding = $Utf8NoBom
  $OutputEncoding = $Utf8NoBom
} catch {}

# ── Enable VT processing (Windows PowerShell 5.x) ────────────────────
try {
  Add-Type -MemberDefinition @"
    [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int h);
    [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m);
    [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m);
"@ -Namespace Win32 -Name VT -ErrorAction SilentlyContinue
  $h = [Win32.VT]::GetStdHandle(-11)
  $m = 0; [Win32.VT]::GetConsoleMode($h, [ref]$m) | Out-Null
  [Win32.VT]::SetConsoleMode($h, $m -bor 4) | Out-Null
  $VTEnabled = $true
} catch {
  $VTEnabled = $false
}

# ── Terminal styling ─────────────────────────────────────────────────
$esc = [char]27

if ($VTEnabled -or $Host.UI.SupportsVirtualTerminal -or $env:WT_SESSION -or $env:TERM_PROGRAM) {
  $BOLD   = "$esc[1m"
  $DIM    = "$esc[2m"
  $RED    = "$esc[31m"
  $GREEN  = "$esc[32m"
  $YELLOW = "$esc[33m"
  $BLUE   = "$esc[34m"
  $CYAN   = "$esc[36m"
  $RESET  = "$esc[0m"
} else {
  $BOLD = $DIM = $RED = $GREEN = $YELLOW = $BLUE = $CYAN = $RESET = ""
}

# ── Unicode chars (PS5-safe — no `u{} syntax) ────────────────────────
$CHK  = [char]0x2713  # ✓
$CRS  = [char]0x2717  # ✗
$BUL  = [char]0x2022  # •
$CIR  = [char]0x25CB  # ○
$HBAR = [char]0x2501  # ━
$LBAR = [char]0x2500  # ─

function Write-Info    { param([string]$msg) Write-Host "  ${CYAN}${BUL}${RESET} $msg" }
function Write-Step    { param([string]$msg) Write-Host "  ${CYAN}${CIR}${RESET} $msg" }
function Write-Success { param([string]$msg) Write-Host "  ${GREEN}${CHK}${RESET} $msg" }
function Write-Err     { param([string]$msg) Write-Host "  ${RED}${CRS}${RESET} $msg" }
function Write-Dim     { param([string]$msg) Write-Host "    ${DIM}${msg}${RESET}" }

function Write-Header {
  Write-Host ""
  Write-Host "  ${BOLD}${CYAN}xMatrix${RESET} ${DIM}CLI Installer${RESET}"
  Write-Host "  ${DIM}-------------------------${RESET}"
  Write-Host ""
}

function Install-DaemonStartup {
  param([string]$InstallPath)

  & $InstallPath setup daemon --binary $InstallPath
  if ($LASTEXITCODE -ne 0) {
    throw "xmatrix setup daemon failed with exit code $LASTEXITCODE"
  }
  return $InstallPath
}

function Install-PowerShellShim {
  param(
    [string]$InstallDir,
    [string]$BinName
  )

  $shimPath = Join-Path $InstallDir "$BinName.ps1"
  $exeName = "$BinName.exe"
  $shim = @"
`$ErrorActionPreference = "Stop"
try {
  `$Utf8NoBom = [System.Text.UTF8Encoding]::new(`$false)
  [Console]::InputEncoding = `$Utf8NoBom
  [Console]::OutputEncoding = `$Utf8NoBom
  `$OutputEncoding = `$Utf8NoBom
} catch {}

`$ExePath = Join-Path `$PSScriptRoot "$exeName"
if (`$MyInvocation.ExpectingInput) {
  `$input | & `$ExePath @args
} else {
  & `$ExePath @args
}
exit `$LASTEXITCODE
"@
  Set-Content -LiteralPath $shimPath -Value $shim -Encoding UTF8
  return $shimPath
}

function Stop-XMatrixDaemonProcesses {
  Get-CimInstance Win32_Process -Filter "Name = 'xmatrix.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '\sdaemon(\s|$)' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Test-DaemonTaskStartup {
  param(
    [string]$DaemonPath,
    [int]$TimeoutSeconds = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $daemon = Get-CimInstance Win32_Process -Filter "Name = 'xmatrix.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -match '\sdaemon(\s|$)' -and
        (
          $_.ExecutablePath -eq $DaemonPath -or
          $_.CommandLine -like "*$DaemonPath*"
        )
      } |
      Select-Object -First 1

    if ($daemon) {
      return $true
    }

    Start-Sleep -Milliseconds 500
  }

  return $false
}

# The daemon is what makes this machine reachable from chat, so it is part of
# the install rather than a choice.
function Start-DaemonSetup {
  param([string]$InstallPath)

  & $InstallPath whoami *> $null
  if ($env:XMATRIX_CONNECT) {
    # A setup command from xMatrix is approved on the page that showed it, so
    # it needs no console input; a failed approval still installs the daemon.
    Write-Info "Approve this terminal on the xMatrix page that showed this command"
    $previousSkip = $env:XMATRIX_SKIP_DAEMON_AUTOSTART
    $env:XMATRIX_SKIP_DAEMON_AUTOSTART = "1"
    try {
      & $InstallPath login --connect $env:XMATRIX_CONNECT
      if ($LASTEXITCODE -ne 0) {
        Write-Info "This machine is not connected yet. Resume with: xmatrix login --connect $($env:XMATRIX_CONNECT)"
      }
    } finally {
      if ($null -eq $previousSkip) {
        Remove-Item Env:XMATRIX_SKIP_DAEMON_AUTOSTART -ErrorAction SilentlyContinue
      } else {
        $env:XMATRIX_SKIP_DAEMON_AUTOSTART = $previousSkip
      }
    }
  } elseif ($LASTEXITCODE -ne 0 -and -not [Environment]::UserInteractive) {
    # Same rule as install.sh: a non-interactive install must not block on
    # sign-in. The daemon still installs; the next `xmatrix login` reaches it.
    Write-Info "No interactive session for sign-in; run 'xmatrix login' to finish setup"
  } elseif ($LASTEXITCODE -ne 0) {
    Write-Info "Browser sign-in is required before starting the daemon"
    $previousSkip = $env:XMATRIX_SKIP_DAEMON_AUTOSTART
    $env:XMATRIX_SKIP_DAEMON_AUTOSTART = "1"
    try {
      & $InstallPath login
      if ($LASTEXITCODE -ne 0) {
        throw "xmatrix login failed"
      }
    } finally {
      if ($null -eq $previousSkip) {
        Remove-Item Env:XMATRIX_SKIP_DAEMON_AUTOSTART -ErrorAction SilentlyContinue
      } else {
        $env:XMATRIX_SKIP_DAEMON_AUTOSTART = $previousSkip
      }
    }
  } else {
    Write-Info "Existing xMatrix login verified"
  }

  Write-Step "Installing daemon startup entry..."
  $daemonPath = Install-DaemonStartup -InstallPath $InstallPath
  Mark-Done 1

  Write-Step "Verifying daemon task startup..."
  if (-not (Test-DaemonTaskStartup -DaemonPath $daemonPath)) {
    Write-Err "xMatrix daemon task started, but no daemon process answered the local ping"
    Write-Dim "Task: xmatrix-daemon"
    Write-Dim "Expected: $daemonPath daemon"
    exit 1
  }
  Mark-Done 1

  Write-Success "xMatrix daemon will start at login and is running now"
}

# ── Mark step done: cursor up N lines, overwrite ○ with ✓ ────────────
function Mark-Done {
  param([int]$N = 1)
  Write-Host -NoNewline "$esc[$($N)A`r  ${GREEN}${CHK}${RESET}$esc[$($N)B`r"
}

# ── Progress bar download ─────────────────────────────────────────────
function Invoke-DownloadWithProgress {
  param(
    [string]$Url,
    [string]$OutFile
  )

  $barWidth = 30

  try {
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Method = "GET"
    $req.AllowAutoRedirect = $true
    if ($env:GITHUB_TOKEN) {
      $req.Headers.Add("Authorization", "token $($env:GITHUB_TOKEN)")
    }
    $resp = $req.GetResponse()
    $totalBytes = $resp.ContentLength
    $stream = $resp.GetResponseStream()
    $fileStream = [System.IO.File]::Create($OutFile)
    $buffer = New-Object byte[] 65536
    $downloaded = 0

    while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $fileStream.Write($buffer, 0, $read)
      $downloaded += $read

      if ($totalBytes -gt 0) {
        $pct = [math]::Min(100, [math]::Floor($downloaded * 100 / $totalBytes))
        $filled = [math]::Floor($pct * $barWidth / 100)
        $empty  = $barWidth - $filled

        $filledBar = if ($filled -gt 0) { [string]::new($HBAR, $filled) } else { "" }
        $emptyBar  = if ($empty  -gt 0) { [string]::new($LBAR, $empty)  } else { "" }

        $dlMB    = "{0:F1}" -f ($downloaded / 1MB)
        $totalMB = "{0:F1}" -f ($totalBytes / 1MB)

        Write-Host -NoNewline "`r    ${CYAN}${filledBar}${RESET}${DIM}${emptyBar} $("{0,3}" -f $pct)%  ${dlMB}/${totalMB} MB${RESET}"
      } else {
        $dlMB = "{0:F1}" -f ($downloaded / 1MB)
        $spinChars = @([char]0x280B, [char]0x2819, [char]0x2839, [char]0x2838, [char]0x283C, [char]0x2834, [char]0x2826, [char]0x2827, [char]0x2807, [char]0x280F)
        $spinIdx = ($downloaded / 65536) % $spinChars.Count
        Write-Host -NoNewline "`r    ${DIM}$($spinChars[$spinIdx]) ${dlMB} MB downloaded${RESET}"
      }
    }

    # Final line
    if ($totalBytes -gt 0) {
      $fullBar  = [string]::new($HBAR, $barWidth)
      $totalMBf = "{0:F1}" -f ($totalBytes / 1MB)
      Write-Host "`r    ${CYAN}${fullBar}${RESET}${DIM} 100%  ${totalMBf} MB${RESET}            "
    } else {
      $finalMB = "{0:F1}" -f ($downloaded / 1MB)
      Write-Host "`r    ${DIM}${CHK} ${finalMB} MB downloaded${RESET}            "
    }

    $fileStream.Close()
    $stream.Close()
    $resp.Close()
  } catch {
    if ($fileStream) { $fileStream.Close() }
    if ($stream) { $stream.Close() }
    if ($resp) { $resp.Close() }
    throw
  }
}

# ── Architecture detection ────────────────────────────────────────────
function Get-ArchName {
  try {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  } catch {
    $arch = $env:PROCESSOR_ARCHITECTURE.ToLowerInvariant()
  }
  switch ($arch) {
    "x64"   { return "x64"   }
    "amd64" { return "x64"   }
    "arm64" { return "arm64" }
    default { throw "Unsupported architecture: $arch" }
  }
}

function Assert-ReleaseAssetIntegrity($Asset, [string]$Path) {
  if ([string]$Asset.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or [string]$Asset.size -notmatch '^[1-9][0-9]*$') {
    throw "Release asset requires SHA-256 and positive size"
  }
  if ((Get-Item -LiteralPath $Path).Length -ne [long]$Asset.size -or
      (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne [string]$Asset.sha256) {
    throw "Release asset integrity check failed; nothing was executed"
  }
}

# ── Main ──────────────────────────────────────────────────────────────
Write-Header

$BinName       = if ($env:XMATRIX_BIN_NAME)       { $env:XMATRIX_BIN_NAME }       else { "xmatrix" }
$InstallDir    = if ($env:XMATRIX_INSTALL_DIR)     { $env:XMATRIX_INSTALL_DIR }     else { Join-Path $HOME ".local\bin" }
$ReleaseApiUrl = if ($env:XMATRIX_RELEASE_API_URL) { $env:XMATRIX_RELEASE_API_URL } else { "https://xmatrix.sh/api/cli/releases/latest" }

$ArchName  = Get-ArchName
$AssetName = "$BinName-windows-$ArchName.exe"

Write-Info "Found environment: ${BOLD}windows-${ArchName}${RESET}"

# ── Fetch release metadata ──
Write-Step "Fetching release metadata..."
try {
  $headers = @{}
  if ($env:GITHUB_TOKEN) {
    $headers["Authorization"] = "token $($env:GITHUB_TOKEN)"
  }
  $release = Invoke-RestMethod -Uri $ReleaseApiUrl -Headers $headers
} catch {
  Write-Err "Could not fetch release metadata"
  Write-Dim "Checked: $ReleaseApiUrl"
  exit 1
}
Mark-Done 1

$asset = $release.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1

if (-not $asset) {
  Write-Err "Could not find release asset named ${BOLD}${AssetName}${RESET}"
  Write-Dim "Checked: $ReleaseApiUrl"
  exit 1
}

# ── Download ──
$TempDir    = Join-Path ([System.IO.Path]::GetTempPath()) ("xmatrix-" + [System.Guid]::NewGuid().ToString("N"))
$TempBinary = Join-Path $TempDir "$BinName.exe"

New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

try {
  Write-Step "Downloading binary..."
  Write-Dim "URL: $($asset.browser_download_url)"

  Invoke-DownloadWithProgress -Url $asset.browser_download_url -OutFile $TempBinary
  Assert-ReleaseAssetIntegrity -Asset $asset -Path $TempBinary
  Mark-Done 3

  # ── Validate ──
  Write-Step "Validating downloaded binary..."
  try {
    & $TempBinary --help | Out-Null
  } catch {
    Write-Err "Downloaded release asset failed to start"
    exit 1
  }
  Mark-Done 1

  # ── Install ──
  Write-Step "Installing to ${BOLD}${InstallDir}${RESET}..."
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

  $InstallPath = Join-Path $InstallDir "$BinName.exe"
  Stop-ScheduledTask -TaskName "xmatrix-daemon" -ErrorAction SilentlyContinue
  Stop-ScheduledTask -TaskName "xMatrix Daemon" -ErrorAction SilentlyContinue
  Stop-XMatrixDaemonProcesses
  if (Test-Path -LiteralPath $InstallPath) {
    $installBackupPath = $InstallPath + ".bak-" + [System.Guid]::NewGuid().ToString("N")
    [System.IO.File]::Replace($TempBinary, $InstallPath, $installBackupPath, $true)
    Remove-Item -Force -LiteralPath $installBackupPath -ErrorAction SilentlyContinue
  } else {
    [System.IO.File]::Move($TempBinary, $InstallPath)
  }
  $ShimPath = Install-PowerShellShim -InstallDir $InstallDir -BinName $BinName
  Mark-Done 1

  # ── Version ──
  $Version = ""
  try {
    $versionOutput = & $InstallPath --version 2>$null
    if ($versionOutput -match '(\S+)$') {
      $Version = $Matches[1]
    }
  } catch {}

  Write-Host ""
  if ($Version) {
    Write-Success "Installed ${BOLD}${BinName}@${Version}${RESET} successfully!"
  } else {
    Write-Success "Installed ${BOLD}${BinName}${RESET} successfully!"
  }

  Write-Dim "Location: $InstallPath"
  Write-Dim "PowerShell shim: $ShimPath"
  Write-Host ""

  # ── PATH check ──
  $pathDirs = $env:PATH -split ";"
  if ($pathDirs -notcontains $InstallDir) {
    Write-Info "Add to PATH: ${BOLD}${YELLOW}${InstallDir}${RESET}"
    Write-Dim "Run: [Environment]::SetEnvironmentVariable('PATH', `$env:PATH + ';$InstallDir', 'User')"
    Write-Host ""
  }

  Start-DaemonSetup -InstallPath $InstallPath
  Write-Info "Run ${BOLD}${GREEN}${BinName} --help${RESET} to get started"
  Write-Host ""

} finally {
  if (Test-Path $TempDir) {
    Remove-Item -Recurse -Force $TempDir
  }
}
