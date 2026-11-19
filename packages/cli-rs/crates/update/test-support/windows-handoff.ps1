# OS boundaries are mocked; binary replacement, rollback, process selection,
# restart decisions, and receipt writes execute the generated production script.
$script:starts = 0
$script:healthChecks = 0
$script:healthPaths = @()
$script:stopped = @()
$script:processes = @(
  [pscustomobject]@{ProcessId=101;ExecutablePath=$installPath;CommandLine=('"' + $installPath + '" codex --task "inspect logs"')},
  [pscustomobject]@{ProcessId=102;ExecutablePath=$installPath;CommandLine=('"' + $installPath + '" update')}
)
function Get-CimInstance { param($ClassName,$Filter,$ErrorAction) $script:processes }
function Stop-Process {
  param($Id,[switch]$Force,$ErrorAction)
  $script:stopped += $Id
  $script:processes = @($script:processes | Where-Object {$_.ProcessId -ne $Id})
}
function Wait-Process { param($Id,$ErrorAction) }
function Get-ScheduledTask {
  param($TaskName,$ErrorAction)
  if ($script:hasTask) {
    if ($script:conhostTask) {
      $conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
      $argument = '--headless "' + $installPath + '" daemon'
      [pscustomobject]@{State='Ready';Actions=[pscustomobject]@{Execute=$conhost;Arguments=$argument;WorkingDirectory=(Split-Path -Parent $installPath)}}
    } else {
      [pscustomobject]@{State='Ready';Actions=[pscustomobject]@{Execute=$installPath;Arguments='daemon';WorkingDirectory=(Split-Path -Parent $installPath)}}
    }
  }
}
function Start-FakeDaemon {
  $script:starts += 1
  $script:processes += [pscustomobject]@{ProcessId=(200+$script:starts);ExecutablePath=$installPath;CommandLine=('"' + $installPath + '" daemon')}
}
function Start-ScheduledTask { param($TaskName) Start-FakeDaemon }
function Start-Process { param($FilePath,$ArgumentList,$WindowStyle) Start-FakeDaemon }
function Unregister-ScheduledTask { param($TaskName,$Confirm,$ErrorAction) }
# The watchdog path schedules a real task when these stay unbound. Keep the
# fixture off the machine's Task Scheduler.
function Set-ScheduledTask { param($TaskName,$Action,$Trigger,$ErrorAction) }
function Register-ScheduledTask { param($TaskName,$Action,$Trigger,$Settings,$Description,[switch]$Force,$ErrorAction) }
function Wait-UpdatedDaemonHealthy {
  param($expectedPath,$expectedVersion,$startedAtUtc,$timeoutSeconds)
  $script:healthChecks += 1
  $script:healthPaths += [string]$expectedPath
  if ($script:healthChecks -eq 1) { return -not $script:failCandidate }
  return -not $script:failRollback
}

# Independently exercise the cleanup selector with misleading arguments and a
# different daemon path, then restore the no-daemon handoff starting state.
$fixtureProcesses = $script:processes
$script:processes = @(
  [pscustomobject]@{ProcessId=301;ExecutablePath=$installPath;CommandLine=('"' + $installPath + '" daemon')},
  [pscustomobject]@{ProcessId=302;ExecutablePath=$installPath;CommandLine=('"' + $installPath + '" setup daemon')},
  [pscustomobject]@{ProcessId=303;ExecutablePath=$installPath;CommandLine=('"' + $installPath + '" codex --task "inspect daemon logs"')},
  [pscustomobject]@{ProcessId=304;ExecutablePath=($installPath + '.other');CommandLine='"C:\other\xmatrix.exe" daemon'}
)
Stop-ExactDaemonGeneration $installPath
if (($script:stopped -join ',') -ne '301') { throw 'exact daemon cleanup selected another process' }
$script:processes = $fixtureProcesses
$script:stopped = @()
