// The CLI parser and serialized daemon protocol expose the same closed actions.
macro_rules! harness_action_names {
    () => {
        pub fn as_str(self) -> &'static str {
            match self {
                Self::Install => "install",
                Self::Update => "update",
                Self::Uninstall => "uninstall",
                Self::AutoUpdateOn => "auto_update_on",
                Self::AutoUpdateOff => "auto_update_off",
                Self::Refresh => "refresh",
                Self::Release => "release",
            }
        }
    };
}
