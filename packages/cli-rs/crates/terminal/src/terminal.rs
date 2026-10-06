pub fn configure_process_utf8() {
    configure_platform_process_utf8();
}

#[cfg(windows)]
fn configure_platform_process_utf8() {
    use windows_sys::Win32::System::Console::{SetConsoleCP, SetConsoleOutputCP};

    const UTF8_CODE_PAGE: u32 = 65001;

    unsafe {
        let _ = SetConsoleCP(UTF8_CODE_PAGE);
        let _ = SetConsoleOutputCP(UTF8_CODE_PAGE);
    }
}

#[cfg(not(windows))]
fn configure_platform_process_utf8() {}
