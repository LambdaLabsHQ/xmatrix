use super::*;

fn scenario_script(
    root: &Path,
    restart: bool,
    has_task: bool,
    fail_candidate: bool,
    fail_rollback: bool,
) -> String {
    let install = root.join("xmatrix.exe");
    let staged = root.join("candidate.exe");
    let log = root.join("daemon-update.log");
    let script = windows_update_handoff_script(
        &staged,
        &install,
        "0.16.295",
        99999,
        "xmatrix-update-handoff-fixture",
        WindowsUpdateHandoff {
            extra_wait_ms: 0,
            restart_daemon: restart,
            hub_url: None,
            token_assignment: String::new(),
            wait_log: String::new(),
            commit_log: "\"committed fixture\"".into(),
            failure_log: "$failureMessage".into(),
        },
    );
    let script = script
        .replace(
            &powershell_single_quoted(&windows_daemon_update_log_path().display().to_string()),
            &powershell_single_quoted(&log.display().to_string()),
        )
        .replace(
            "$previousVersionOutput = @(& $installPath --version 2>$null) | Select-Object -First 1",
            "$previousVersionOutput = 'xmatrix 0.16.289'",
        )
        .replace(
            "$installBackupPath = $installPath +",
            &format!(
                "{}\n$installBackupPath = $installPath +",
                include_str!("../test-support/windows-handoff.ps1")
            ),
        );
    // A nested script block has no MyCommand.Path; self-deletion belongs to the
    // one-shot task boundary, which this fixture does not register.
    let script = script.replace("Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue", "# one-shot self-cleanup is outside this fixture");
    let boolean = |value| if value { "$true" } else { "$false" };
    let expected_starts = if !restart {
        0
    } else if fail_candidate {
        2
    } else {
        1
    };
    let expected_status = if fail_rollback {
        "failed"
    } else if fail_candidate {
        "rolled-back"
    } else {
        "committed"
    };
    let expected_binary = if fail_candidate {
        "previous"
    } else {
        "candidate"
    };
    format!(
        r#"
$ErrorActionPreference = 'Stop'
$script:hasTask = {has_task}
$script:failCandidate = {fail_candidate}
$script:failRollback = {fail_rollback}
New-Item -ItemType Directory -Force -Path {root} | Out-Null
[System.IO.File]::WriteAllText({install}, 'previous')
[System.IO.File]::WriteAllText({staged}, 'candidate')
$caught = $false
try {{ & {{
{script}
}} }} catch {{ $caught = $true; Write-Output $_.Exception.Message }}
if ($caught -ne {fail_candidate}) {{ throw 'unexpected handoff outcome' }}
if ($script:starts -ne {expected_starts}) {{ throw "restart count: $script:starts" }}
if ($script:healthChecks -ne {expected_starts}) {{ throw "health checks: $script:healthChecks" }}
if ($script:stopped -contains 101 -or $script:stopped -contains 102 -or $script:stopped -contains 103) {{ throw 'cleanup killed a wrapper, installer, or another daemon generation' }}
if ([System.IO.File]::ReadAllText({install}) -ne '{expected_binary}') {{ throw 'wrong installed binary' }}
$receipt = Get-Content -Raw {receipt} | ConvertFrom-Json
if ($receipt.status -ne '{expected_status}') {{ throw "receipt status: $($receipt.status)" }}
Write-Output 'handoff scenario passed'
"#,
        has_task = boolean(has_task),
        fail_candidate = boolean(fail_candidate),
        fail_rollback = boolean(fail_rollback),
        root = powershell_single_quoted(&root.display().to_string()),
        install = powershell_single_quoted(&install.display().to_string()),
        staged = powershell_single_quoted(&staged.display().to_string()),
        receipt = powershell_single_quoted(
            &root
                .join("daemon-update-receipt.json")
                .display()
                .to_string()
        )
    )
}

#[test]
fn windows_handoff_restart_and_rollback_preserve_agents() {
    let scenarios = [
        (true, true, false, false),
        (true, true, true, false),
        (true, true, true, true),
        (false, true, false, false),
        (true, false, false, false),
        (true, false, true, false),
    ];
    for (index, (restart, has_task, fail_candidate, fail_rollback)) in
        scenarios.into_iter().enumerate()
    {
        let root =
            std::env::temp_dir().join(format!("xmatrix-handoff-{}-{index}", std::process::id()));
        let script = scenario_script(&root, restart, has_task, fail_candidate, fail_rollback);
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("test.ps1");
        std::fs::write(&path, script).unwrap();
        let output = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&path)
            .output()
            .expect("run native Windows handoff regression");
        assert!(
            output.status.success(),
            "scenario {index}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
