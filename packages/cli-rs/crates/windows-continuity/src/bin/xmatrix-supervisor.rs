#![deny(warnings)]
#![cfg_attr(windows, windows_subsystem = "windows")]

include!("supervisor_main.rs");

fn main() {
    run_main();
}
