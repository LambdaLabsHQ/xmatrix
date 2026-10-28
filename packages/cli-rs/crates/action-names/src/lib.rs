//! The CLI parser and serialized daemon protocol expose the same closed actions.
//! The daemon protocol alone adds the owner's remote sign-in actions.
//!
//! One macro, expanded in each crate. CodeQL's rust-analyzer extractor does not
//! load an include! that leaves its crate, and the duplicate-code gate rejects
//! a second copy.
#![deny(warnings)]

#[macro_export]
macro_rules! harness_action_names {
    ($($variant:ident => $name:literal),* $(,)?) => {
        pub fn as_str(self) -> &'static str {
            match self {
                Self::Install => "install",
                Self::Update => "update",
                Self::Uninstall => "uninstall",
                Self::AutoUpdateOn => "auto_update_on",
                Self::AutoUpdateOff => "auto_update_off",
                Self::Refresh => "refresh",
                Self::Release => "release",
                $(Self::$variant => $name,)*
            }
        }
    };
}
