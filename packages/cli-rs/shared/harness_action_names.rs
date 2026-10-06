// The CLI parser and serialized daemon protocol expose the same closed actions;
// the daemon protocol alone adds the owner's remote sign-in actions.
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
