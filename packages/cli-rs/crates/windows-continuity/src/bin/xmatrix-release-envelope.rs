#![deny(warnings)]
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    // The release workflow appends one bounded JSON envelope trailer and then
    // Authenticode-signs this PE. Consumers verify the PE signature and read
    // the trailer as data; they never execute this container.
    eprintln!("xmatrix release envelope is a signed data container");
    std::process::exit(2);
}
