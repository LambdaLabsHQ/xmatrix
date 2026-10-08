#![cfg(windows)]

use std::process::Command;

// Exercises the shipped main entrypoint, including native Unicode argv,
// PowerShell 5.1/7 pipelines, host options, and exit status propagation.
#[test]
fn windows_utf8_shell_alias_preserves_unicode_and_exit_status() {
    let cli = env!("CARGO_BIN_EXE_xmatrix");
    let directory = std::env::temp_dir().join(format!("xmatrix-utf8-shell-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let mut tested = 0;
    for (name, key) in [
        ("powershell.exe", "XMATRIX_UTF8_POWERSHELL_REAL"),
        ("pwsh.exe", "XMATRIX_UTF8_PWSH_REAL"),
    ] {
        let real = Command::new("where.exe").arg(name).output().unwrap();
        if !real.status.success() {
            continue;
        }
        tested += 1;
        let target = String::from_utf8(real.stdout)
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .trim()
            .to_owned();
        let alias = directory.join(name);
        std::fs::copy(cli, &alias).unwrap();
        let script = "[Console]::OutputEncoding.CodePage; $OutputEncoding.CodePage; '中文摘要😀' | node -e \"process.stdin.on('data', d => process.stdout.write(d)); process.stdout.write(process.argv[1]);\" '中文标题😀'; exit 7";
        let output = Command::new(&alias)
            .env(key, &target)
            .args(["-NoProfile", "-Command", script])
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(7),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(text.contains("65001"), "{text}");
        assert!(
            text.contains("中文摘要😀") && text.contains("中文标题😀"),
            "{text}"
        );
        std::fs::remove_file(alias).unwrap();
    }
    assert!(
        tested > 0,
        "Windows PowerShell must be available for UTF-8 coverage"
    );
    std::fs::remove_dir(directory).unwrap();
}
