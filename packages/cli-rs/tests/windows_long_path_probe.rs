//! TEMPORARY probe: reports how Windows treats paths past MAX_PATH on this
//! runner. Panics with the report so CI shows it; removed before merge.
#![cfg(windows)]

use std::path::PathBuf;
use std::process::Command;

fn deep_dir() -> PathBuf {
    let mut dir = std::env::temp_dir().join(format!("xm-lp-{}", std::process::id()));
    while dir.as_os_str().len() < 300 {
        dir = dir.join("a".repeat(40));
    }
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn outcome(result: std::io::Result<std::process::Output>) -> String {
    match result {
        Ok(output) => format!(
            "exit={:?} out={:?} err={:?}",
            output.status.code(),
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim()
        ),
        Err(error) => format!("spawn error: {error}"),
    }
}

#[test]
fn report_windows_long_path_behavior() {
    let mut report = Vec::new();
    report.push(format!(
        "LongPathsEnabled: {}",
        outcome(
            Command::new("reg")
                .args(["query", r"HKLM\SYSTEM\CurrentControlSet\Control\FileSystem", "/v", "LongPathsEnabled"])
                .output()
        )
    ));
    let deep = deep_dir();
    report.push(format!("deep dir length: {}", deep.as_os_str().len()));
    report.push(format!(
        "cmd in long cwd: {}",
        outcome(Command::new("cmd.exe").args(["/c", "echo ok"]).current_dir(&deep).output())
    ));
    let xmatrix = PathBuf::from(env!("CARGO_BIN_EXE_xmatrix"));
    report.push(format!(
        "xmatrix (manifest) in long cwd: {}",
        outcome(Command::new(&xmatrix).arg("--version").current_dir(&deep).output())
    ));
    let deep_exe = deep.join("xmatrix.exe");
    std::fs::copy(&xmatrix, &deep_exe).unwrap();
    report.push(format!(
        "xmatrix at long exe path: {}",
        outcome(Command::new(&deep_exe).arg("--version").output())
    ));
    let cmd_copy = deep.join("cmdcopy.exe");
    std::fs::copy(r"C:\Windows\System32\whoami.exe", &cmd_copy).unwrap();
    report.push(format!(
        "whoami (no manifest opt-in) at long exe path: {}",
        outcome(Command::new(&cmd_copy).output())
    ));
    report.push(format!(
        "node spawning exe at long path: {}",
        outcome(
            Command::new("node")
                .args([
                    "-e",
                    "const r=require('child_process').spawnSync(process.argv[1],['--version']);console.log(r.error?String(r.error):String(r.stdout).trim())",
                    &deep_exe.display().to_string(),
                ])
                .output()
        )
    ));
    report.push(format!(
        "node in long cwd: {}",
        outcome(Command::new("node").args(["-e", "console.log(process.cwd().length)"]).current_dir(&deep).output())
    ));
    report.push(format!(
        "git -C long init: {}",
        outcome(Command::new("git").arg("-C").arg(&deep).arg("init").output())
    ));
    std::fs::write(deep.join("f.txt"), "x").unwrap();
    for longpaths in ["false", "true"] {
        report.push(format!(
            "git -C long add (core.longpaths={longpaths}): {}",
            outcome(
                Command::new("git")
                    .args(["-c", &format!("core.longpaths={longpaths}")])
                    .arg("-C")
                    .arg(&deep)
                    .args(["add", "f.txt"])
                    .output()
            )
        ));
    }
    let _ = std::fs::remove_dir_all(std::env::temp_dir().join(format!("xm-lp-{}", std::process::id())));
    panic!("WINDOWS LONG PATH REPORT\n{}", report.join("\n"));
}
