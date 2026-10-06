use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

use fs2::FileExt;
use serde::{Deserialize, Serialize};

use crate::config::{self, replace_file_atomically, unique_temporary_path};
use crate::error::{CliError, Result};
use crate::protocol::{DEFAULT_HUB_URL, TEST_HUB_URL};

pub const PROFILE_REGISTRY_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallationRoot(PathBuf);

impl InstallationRoot {
    pub fn discover() -> Self {
        Self(config::config_dir())
    }

    pub fn new(path: PathBuf) -> Self {
        Self(path)
    }

    pub fn as_path(&self) -> &Path {
        &self.0
    }

    pub fn registry_path(&self) -> PathBuf {
        self.0.join("profiles.json")
    }

    pub fn registry_lock_path(&self) -> PathBuf {
        self.0.join("profiles.lock")
    }

    pub fn daemon_host_root(&self) -> PathBuf {
        self.0.join("daemon-host")
    }

    pub fn profile_state_root(&self, id: &ProfileId) -> ProfileStateRoot {
        ProfileStateRoot(self.0.join("profiles").join(id.directory_component()))
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProfileId(String);

impl ProfileId {
    pub fn new() -> Self {
        Self(format!("profile:{}", uuid::Uuid::new_v4()))
    }

    pub fn parse(value: &str) -> Result<Self> {
        let Some(raw_uuid) = value.strip_prefix("profile:") else {
            return Err(CliError::Auth(
                "Profile ID must start with `profile:`".into(),
            ));
        };
        let parsed = uuid::Uuid::parse_str(raw_uuid)
            .map_err(|_| CliError::Auth("Profile ID must contain a canonical UUID".into()))?;
        let canonical = format!("profile:{parsed}");
        if value != canonical {
            return Err(CliError::Auth(
                "Profile ID must use canonical lowercase UUID form".into(),
            ));
        }
        Ok(Self(canonical))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn directory_component(&self) -> &str {
        self.0
            .strip_prefix("profile:")
            .expect("validated ProfileId always has its prefix")
    }
}

impl Default for ProfileId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for ProfileId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProfileStateRoot(PathBuf);

impl ProfileStateRoot {
    pub fn as_path(&self) -> &Path {
        &self.0
    }

    pub fn join(&self, relative: impl AsRef<Path>) -> PathBuf {
        self.0.join(relative)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileStateKind {
    LegacyRoot,
    Isolated,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRecord {
    pub id: ProfileId,
    pub name: String,
    pub hub_url: String,
    pub enabled: bool,
    pub state_kind: ProfileStateKind,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub removed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub purged_at: Option<String>,
}

impl ProfileRecord {
    pub fn is_selectable(&self) -> bool {
        self.removed_at.is_none() && self.purged_at.is_none()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRegistry {
    pub schema_version: u32,
    pub revision: u64,
    pub default_profile_id: ProfileId,
    pub profiles: Vec<ProfileRecord>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProfileContext {
    pub id: ProfileId,
    pub name: String,
    pub hub_origin: String,
    pub state_root: ProfileStateRoot,
    pub registry_revision: u64,
    pub state_kind: ProfileStateKind,
}

#[derive(Clone, Debug)]
pub struct ProfileStore {
    installation: InstallationRoot,
}

impl ProfileStore {
    pub fn discover() -> Self {
        Self::new(InstallationRoot::discover())
    }

    pub fn new(installation: InstallationRoot) -> Self {
        Self { installation }
    }

    pub fn installation(&self) -> &InstallationRoot {
        &self.installation
    }

    pub fn load_or_bootstrap(&self) -> Result<ProfileRegistry> {
        self.with_lock(|store| store.load_or_bootstrap_locked())
    }

    pub fn context_for_default(&self, registry: &ProfileRegistry) -> Result<ProfileContext> {
        let profile = registry
            .profiles
            .iter()
            .find(|profile| profile.id == registry.default_profile_id)
            .ok_or_else(|| CliError::Auth("Profile registry default is missing".into()))?;
        self.context_for_record(registry, profile, false)
    }

    pub fn enabled_contexts(&self, registry: &ProfileRegistry) -> Result<Vec<ProfileContext>> {
        registry
            .profiles
            .iter()
            .filter(|profile| profile.enabled && profile.is_selectable())
            .map(|profile| self.context_for_record(registry, profile, false))
            .collect()
    }

    pub fn context_for_selector(
        &self,
        registry: &ProfileRegistry,
        selector: &str,
        allow_disabled: bool,
    ) -> Result<ProfileContext> {
        let profile = resolve_selectable_profile(registry, selector)?;
        self.context_for_record(registry, profile, allow_disabled)
    }

    pub fn state_roots(&self, registry: &ProfileRegistry) -> Result<Vec<ProfileStateRoot>> {
        reject_symlink(
            &self.installation.as_path().join("profiles"),
            "profiles state root",
        )?;
        let mut seen = HashSet::new();
        let roots = registry
            .profiles
            .iter()
            .filter(|profile| profile.purged_at.is_none())
            .map(|profile| {
                let root = self.state_root_for(profile);
                if profile.state_kind == ProfileStateKind::Isolated {
                    reject_symlink(&root, "profile state root")?;
                }
                Ok(seen.insert(root.clone()).then_some(ProfileStateRoot(root)))
            })
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect();
        Ok(roots)
    }

    pub fn prepare_context_state_root(&self, context: &ProfileContext) -> Result<()> {
        if context.state_kind == ProfileStateKind::LegacyRoot {
            return Ok(());
        }
        let profiles_root = self.installation.as_path().join("profiles");
        reject_symlink(&profiles_root, "profiles state root")?;
        create_private_dir_all(&profiles_root)?;
        reject_symlink(context.state_root.as_path(), "profile state root")?;
        create_private_dir_all(context.state_root.as_path())
    }

    pub fn create(
        &self,
        expected_revision: u64,
        name: &str,
        hub_url: &str,
        enabled: bool,
    ) -> Result<ProfileRegistry> {
        let name = validate_profile_name(name)?;
        let hub_url = normalize_profile_hub_origin(hub_url)?;
        self.with_revision(expected_revision, |store, mut registry| {
            if registry
                .profiles
                .iter()
                .any(|profile| profile.is_selectable() && profile.name.eq_ignore_ascii_case(&name))
            {
                return Err(CliError::Auth(format!(
                    "Profile name `{name}` is already in use"
                )));
            }
            let now = unix_now_string();
            registry.profiles.push(ProfileRecord {
                id: ProfileId::new(),
                name,
                hub_url,
                enabled,
                state_kind: ProfileStateKind::Isolated,
                created_at: now.clone(),
                updated_at: now,
                removed_at: None,
                purged_at: None,
            });
            bump_and_write(store, registry)
        })
    }

    pub fn rename(&self, expected_revision: u64, old: &str, new: &str) -> Result<ProfileRegistry> {
        let new = validate_profile_name(new)?;
        self.with_revision(expected_revision, |store, mut registry| {
            let target_id = resolve_selectable_profile(&registry, old)?.id.clone();
            if registry.profiles.iter().any(|profile| {
                profile.id != target_id
                    && profile.is_selectable()
                    && profile.name.eq_ignore_ascii_case(&new)
            }) {
                return Err(CliError::Auth(format!(
                    "Profile name `{new}` is already in use"
                )));
            }
            let profile = resolved_profile_mut(&mut registry, &target_id);
            profile.name = new;
            profile.updated_at = unix_now_string();
            bump_and_write(store, registry)
        })
    }

    pub fn set_enabled(
        &self,
        expected_revision: u64,
        selector: &str,
        enabled: bool,
    ) -> Result<ProfileRegistry> {
        self.with_revision(expected_revision, |store, mut registry| {
            let target_id = resolve_selectable_profile(&registry, selector)?.id.clone();
            if !enabled && target_id == registry.default_profile_id {
                return Err(CliError::Auth(
                    "The default profile cannot be disabled; select another default first".into(),
                ));
            }
            let profile = resolved_profile_mut(&mut registry, &target_id);
            if profile.enabled == enabled {
                return Ok(registry);
            }
            profile.enabled = enabled;
            profile.updated_at = unix_now_string();
            bump_and_write(store, registry)
        })
    }

    pub fn set_default(&self, expected_revision: u64, selector: &str) -> Result<ProfileRegistry> {
        self.with_revision(expected_revision, |store, mut registry| {
            let profile = resolve_selectable_profile(&registry, selector)?;
            if !profile.enabled {
                return Err(CliError::Auth(format!(
                    "Profile `{}` is disabled",
                    profile.name
                )));
            }
            if profile.id == registry.default_profile_id {
                return Ok(registry);
            }
            registry.default_profile_id = profile.id.clone();
            bump_and_write(store, registry)
        })
    }

    pub fn remove(&self, expected_revision: u64, selector: &str) -> Result<ProfileRegistry> {
        self.remove_with_host_status(expected_revision, selector, None)
    }

    pub fn remove_with_host_status(
        &self,
        expected_revision: u64,
        selector: &str,
        live_host_status: Option<&crate::daemon_host::DaemonHostStatus>,
    ) -> Result<ProfileRegistry> {
        self.with_revision(expected_revision, |store, mut registry| {
            let target = resolve_selectable_profile(&registry, selector)?.clone();
            if target.id == registry.default_profile_id {
                return Err(CliError::Auth(
                    "The default profile cannot be removed; select another default first".into(),
                ));
            }
            if target.enabled {
                return Err(CliError::Auth(
                    "A profile must be disabled before it can be removed".into(),
                ));
            }
            let (_daemon_inactivity, state_root) =
                store.checked_inactive_state_root(&target, registry.revision, live_host_status)?;

            ensure_no_run_recovery_evidence(&state_root)?;
            let profile = resolved_profile_mut(&mut registry, &target.id);
            profile.removed_at = Some(unix_now_string());
            profile.updated_at = unix_now_string();
            bump_and_write(store, registry)
        })
    }

    pub fn purge(&self, expected_revision: u64, selector: &str) -> Result<ProfileRegistry> {
        self.purge_with_host_status(expected_revision, selector, None)
    }

    pub fn purge_with_host_status(
        &self,
        expected_revision: u64,
        selector: &str,
        live_host_status: Option<&crate::daemon_host::DaemonHostStatus>,
    ) -> Result<ProfileRegistry> {
        self.with_revision(expected_revision, |store, mut registry| {
            let target_index = resolve_removed_profile_index(&registry, selector)?;
            let target = registry.profiles[target_index].clone();
            if target.id == registry.default_profile_id || target.enabled {
                return Err(CliError::Auth(
                    "Only a disabled, removed, non-default profile can be purged".into(),
                ));
            }
            if target.state_kind != ProfileStateKind::Isolated {
                return Err(CliError::Auth(
                    "Legacy-root profile state cannot be purged by this command".into(),
                ));
            }
            let (_daemon_inactivity, state_root) =
                store.checked_inactive_state_root(&target, registry.revision, live_host_status)?;

            let daemon_host_root = store.installation.daemon_host_root();
            reject_symlink(&daemon_host_root, "daemon host root")?;
            create_private_dir_all(&daemon_host_root)?;
            reject_symlink(&daemon_host_root, "daemon host root")?;
            let staging_parent = daemon_host_root.join("purge-staging");
            reject_symlink(&staging_parent, "profile purge staging root")?;
            create_private_dir_all(&staging_parent)?;
            reject_symlink(&staging_parent, "profile purge staging root")?;
            let staging = staging_parent.join(target.id.directory_component());
            reject_symlink(&staging, "profile purge staging directory")?;
            if target.purged_at.is_some() {
                finalize_profile_purge(store, &target, registry.revision, &staging)?;
                return Ok(registry);
            }
            if staging.exists() && state_root.exists() {
                return Err(CliError::Auth(format!(
                    "Both active and staged state exist for profile {}; refusing purge",
                    target.id
                )));
            }
            let moved = if staging.exists() {
                ensure_no_run_recovery_evidence(&staging)?;
                true
            } else if state_root.exists() {
                ensure_no_run_recovery_evidence(&state_root)?;
                std::fs::rename(&state_root, &staging)?;
                true
            } else {
                false
            };

            let purged_at = unix_now_string();
            registry.profiles[target_index].purged_at = Some(purged_at.clone());
            registry.profiles[target_index].updated_at = purged_at.clone();
            let updated = match bump_and_write(store, registry) {
                Ok(updated) => updated,
                Err(err) => {
                    if moved {
                        let _ = std::fs::rename(&staging, &state_root);
                    }
                    return Err(err);
                }
            };

            finalize_profile_purge(
                store,
                &updated.profiles[target_index],
                updated.revision,
                &staging,
            )?;
            Ok(updated)
        })
    }

    fn checked_inactive_state_root(
        &self,
        profile: &ProfileRecord,
        registry_revision: u64,
        live_host_status: Option<&crate::daemon_host::DaemonHostStatus>,
    ) -> Result<(ProfileInactivityGuard, PathBuf)> {
        let guard = acquire_profile_inactivity_guard(
            &self.installation,
            &profile.id,
            registry_revision,
            live_host_status,
        )?;
        let state_root = self.state_root_for(profile);
        if profile.state_kind == ProfileStateKind::Isolated {
            reject_symlink(
                &self.installation.as_path().join("profiles"),
                "profiles state root",
            )?;
            reject_symlink(&state_root, "profile state root")?;
        }
        Ok((guard, state_root))
    }

    fn context_for_record(
        &self,
        registry: &ProfileRegistry,
        profile: &ProfileRecord,
        allow_disabled: bool,
    ) -> Result<ProfileContext> {
        if !profile.is_selectable() {
            return Err(CliError::Auth(format!(
                "Profile `{}` has been removed",
                profile.name
            )));
        }
        if !allow_disabled && !profile.enabled {
            return Err(CliError::Auth(format!(
                "Profile `{}` is disabled",
                profile.name
            )));
        }
        Ok(ProfileContext {
            id: profile.id.clone(),
            name: profile.name.clone(),
            hub_origin: profile.hub_url.clone(),
            state_root: ProfileStateRoot(self.state_root_for(profile)),
            registry_revision: registry.revision,
            state_kind: profile.state_kind,
        })
    }

    fn state_root_for(&self, profile: &ProfileRecord) -> PathBuf {
        match profile.state_kind {
            ProfileStateKind::LegacyRoot => self.installation.as_path().to_path_buf(),
            ProfileStateKind::Isolated => self
                .installation
                .profile_state_root(&profile.id)
                .as_path()
                .to_path_buf(),
        }
    }

    fn load_at_revision_locked(&self, expected_revision: u64) -> Result<ProfileRegistry> {
        let registry = self.load_or_bootstrap_locked()?;
        require_revision(&registry, expected_revision)?;
        Ok(registry)
    }

    fn load_or_bootstrap_locked(&self) -> Result<ProfileRegistry> {
        let path = self.installation.registry_path();
        reject_symlink(&path, "profile registry")?;
        match std::fs::read_to_string(&path) {
            Ok(raw) => parse_and_validate_registry(&raw, &self.installation),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                let registry = self.bootstrap_registry()?;
                write_registry(&self.installation, &registry)?;
                Ok(registry)
            }
            Err(err) => Err(CliError::Io(err)),
        }
    }

    fn bootstrap_registry(&self) -> Result<ProfileRegistry> {
        let legacy_path = self.installation.as_path().join("config.json");
        let legacy_config = match std::fs::read_to_string(&legacy_path) {
            Ok(raw) => {
                let parsed =
                    serde_json::from_str::<serde_json::Value>(raw.trim_start_matches('\u{feff}'))
                        .map_err(|err| {
                        CliError::Auth(format!(
                            "Cannot bootstrap profiles from invalid legacy config at {}: {err}",
                            legacy_path.display()
                        ))
                    })?;
                if !parsed.is_object() {
                    return Err(CliError::Auth(format!(
                        "Cannot bootstrap profiles from invalid legacy config at {}: expected a JSON object",
                        legacy_path.display()
                    )));
                }
                Some(parsed)
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => return Err(CliError::Io(err)),
        };
        let active_environment = match legacy_config
            .as_ref()
            .and_then(|config| config.get("activeEnvironment"))
        {
            None => "production",
            Some(serde_json::Value::String(value))
                if matches!(value.as_str(), "production" | "test") =>
            {
                value.as_str()
            }
            Some(_) => {
                return Err(CliError::Auth(format!(
                    "Cannot bootstrap profiles because activeEnvironment in {} is invalid",
                    legacy_path.display()
                )));
            }
        };
        let hub_url = if active_environment == "test" {
            TEST_HUB_URL
        } else {
            DEFAULT_HUB_URL
        };
        let id = ProfileId::new();
        let now = unix_now_string();
        Ok(ProfileRegistry {
            schema_version: PROFILE_REGISTRY_SCHEMA_VERSION,
            revision: 1,
            default_profile_id: id.clone(),
            profiles: vec![ProfileRecord {
                id,
                name: active_environment.to_string(),
                hub_url: normalize_profile_hub_origin(hub_url)?,
                enabled: true,
                state_kind: ProfileStateKind::LegacyRoot,
                created_at: now.clone(),
                updated_at: now,
                removed_at: None,
                purged_at: None,
            }],
        })
    }

    /// Every registry mutation checks its optimistic revision while holding the same file lock.
    fn with_revision<T>(
        &self,
        expected_revision: u64,
        operation: impl FnOnce(&Self, ProfileRegistry) -> Result<T>,
    ) -> Result<T> {
        self.with_lock(|store| operation(store, store.load_at_revision_locked(expected_revision)?))
    }

    fn with_lock<T>(&self, operation: impl FnOnce(&Self) -> Result<T>) -> Result<T> {
        create_private_dir_all(self.installation.as_path())?;
        let lock_path = self.installation.registry_lock_path();
        reject_symlink(&lock_path, "profile registry lock")?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)?;
        set_private_file_permissions(&lock_path)?;
        lock.lock_exclusive()?;
        let result = operation(self);
        let unlock_result = FileExt::unlock(&lock);
        match (result, unlock_result) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(err), _) => Err(err),
            (Ok(_), Err(err)) => Err(CliError::Io(err)),
        }
    }
}

fn finalize_profile_purge(
    store: &ProfileStore,
    profile: &ProfileRecord,
    registry_revision: u64,
    staging: &Path,
) -> Result<()> {
    let receipt = serde_json::json!({
        "profileId": profile.id,
        "registryRevision": registry_revision,
        "purgedAt": profile.purged_at,
        "stateWasPresent": staging.exists(),
    });
    let daemon_host_root = store.installation.daemon_host_root();
    reject_symlink(&daemon_host_root, "daemon host root")?;
    let logs_root = daemon_host_root.join("logs");
    reject_symlink(&logs_root, "daemon host logs root")?;
    let receipt_path = logs_root.join(format!(
        "profile-purge-{}.json",
        profile.id.directory_component()
    ));
    write_private_json(&receipt_path, &receipt)?;
    if staging.exists() {
        std::fs::remove_dir_all(staging)?;
    }
    Ok(())
}

pub fn normalize_profile_hub_origin(value: &str) -> Result<String> {
    crate::http::normalize_hub_origin(
        value,
        "Hub URL must be an absolute HTTP(S) origin",
        "Hub URL must be an HTTP(S) origin without credentials, path, query, or fragment",
    )
}

fn validate_profile_name(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(CliError::Auth(
            "Profile names must be 1-64 ASCII letters, digits, dots, dashes, or underscores".into(),
        ));
    }
    Ok(value.to_string())
}

fn resolved_profile_mut<'a>(
    registry: &'a mut ProfileRegistry,
    id: &ProfileId,
) -> &'a mut ProfileRecord {
    registry
        .profiles
        .iter_mut()
        .find(|profile| &profile.id == id)
        .expect("resolved profile remains present")
}

fn resolve_selectable_profile<'a>(
    registry: &'a ProfileRegistry,
    selector: &str,
) -> Result<&'a ProfileRecord> {
    let selector = selector.trim();
    let exact_id = selector
        .starts_with("profile:")
        .then(|| ProfileId::parse(selector))
        .transpose()?;
    registry
        .profiles
        .iter()
        .find(|profile| {
            profile.is_selectable()
                && exact_id
                    .as_ref()
                    .map(|id| &profile.id == id)
                    .unwrap_or_else(|| profile.name.eq_ignore_ascii_case(selector))
        })
        .ok_or_else(|| CliError::Auth(format!("Unknown profile `{selector}`")))
}

fn resolve_removed_profile_index(registry: &ProfileRegistry, selector: &str) -> Result<usize> {
    let selector = selector.trim();
    if let Some(index) = registry
        .profiles
        .iter()
        .position(|profile| profile.removed_at.is_some() && profile.id.as_str() == selector)
    {
        return Ok(index);
    }
    let matches = registry
        .profiles
        .iter()
        .enumerate()
        .filter_map(|(index, profile)| {
            (profile.removed_at.is_some() && profile.name.eq_ignore_ascii_case(selector))
                .then_some(index)
        })
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [index] => Ok(*index),
        [] => Err(CliError::Auth(format!(
            "Unknown removed profile `{selector}`; remove it before purge"
        ))),
        _ => Err(CliError::Auth(format!(
            "Removed profile name `{selector}` is ambiguous; purge by immutable profile ID"
        ))),
    }
}

fn require_revision(registry: &ProfileRegistry, expected_revision: u64) -> Result<()> {
    if registry.revision != expected_revision {
        return Err(CliError::Auth(format!(
            "Profile registry changed concurrently (expected revision {expected_revision}, found {}); retry the command",
            registry.revision
        )));
    }
    Ok(())
}

fn bump_and_write(store: &ProfileStore, mut registry: ProfileRegistry) -> Result<ProfileRegistry> {
    registry.revision = registry
        .revision
        .checked_add(1)
        .ok_or_else(|| CliError::Auth("Profile registry revision overflow".into()))?;
    validate_registry(&registry, &store.installation)?;
    write_registry(&store.installation, &registry)?;
    Ok(registry)
}

fn parse_and_validate_registry(
    raw: &str,
    installation: &InstallationRoot,
) -> Result<ProfileRegistry> {
    let registry: ProfileRegistry = serde_json::from_str(raw.trim_start_matches('\u{feff}'))
        .map_err(|err| CliError::Auth(format!("Invalid profile registry: {err}")))?;
    validate_registry(&registry, installation)?;
    Ok(registry)
}

fn validate_registry(registry: &ProfileRegistry, installation: &InstallationRoot) -> Result<()> {
    if registry.schema_version != PROFILE_REGISTRY_SCHEMA_VERSION {
        return Err(CliError::Auth(format!(
            "Unsupported profile registry schema version {}",
            registry.schema_version
        )));
    }
    if registry.revision == 0 || registry.profiles.is_empty() {
        return Err(CliError::Auth(
            "Profile registry must have a positive revision and at least one profile".into(),
        ));
    }
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    let mut legacy_roots = 0_u8;
    for profile in &registry.profiles {
        ProfileId::parse(profile.id.as_str())?;
        if !ids.insert(profile.id.clone()) {
            return Err(CliError::Auth(
                "Profile registry contains duplicate IDs".into(),
            ));
        }
        validate_profile_name(&profile.name)?;
        if profile.is_selectable() && !names.insert(profile.name.to_ascii_lowercase()) {
            return Err(CliError::Auth(
                "Profile registry contains case-insensitive duplicate names".into(),
            ));
        }
        let normalized = normalize_profile_hub_origin(&profile.hub_url)?;
        if normalized != profile.hub_url {
            return Err(CliError::Auth(format!(
                "Profile `{}` has a non-canonical Hub origin",
                profile.name
            )));
        }
        if profile.purged_at.is_some() && profile.removed_at.is_none() {
            return Err(CliError::Auth(
                "A purged profile must retain its removal tombstone".into(),
            ));
        }
        if profile.state_kind == ProfileStateKind::LegacyRoot {
            legacy_roots = legacy_roots.saturating_add(1);
        } else {
            let expected = installation.profile_state_root(&profile.id);
            if !expected
                .as_path()
                .starts_with(installation.as_path().join("profiles"))
            {
                return Err(CliError::Auth(
                    "Profile state root escaped the installation root".into(),
                ));
            }
        }
    }
    if legacy_roots > 1 {
        return Err(CliError::Auth(
            "Profile registry may contain at most one legacy-root profile".into(),
        ));
    }
    let default = registry
        .profiles
        .iter()
        .find(|profile| profile.id == registry.default_profile_id)
        .ok_or_else(|| CliError::Auth("Profile registry default ID does not exist".into()))?;
    if !default.enabled || !default.is_selectable() {
        return Err(CliError::Auth(
            "Profile registry default must be enabled and selectable".into(),
        ));
    }
    Ok(())
}

fn write_registry(installation: &InstallationRoot, registry: &ProfileRegistry) -> Result<()> {
    let json = serde_json::to_value(registry)?;
    write_private_json(&installation.registry_path(), &json)
}

pub(crate) fn write_private_json(path: &Path, value: &serde_json::Value) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| CliError::Auth("Invalid private JSON path".into()))?;
    reject_symlink(parent, "private JSON parent")?;
    create_private_dir_all(parent)?;
    reject_symlink(parent, "private JSON parent")?;
    reject_symlink(path, "private JSON destination")?;
    let temporary = unique_temporary_path(path);
    let bytes = serde_json::to_vec_pretty(value)?;
    {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        use std::io::Write as _;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    set_private_file_permissions(&temporary)?;
    if let Err(err) = replace_file_atomically(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(CliError::Io(err));
    }
    #[cfg(unix)]
    if let Ok(directory) = File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

enum ProfileInactivityGuard {
    DaemonStopped(File),
    HostAcknowledged,
}

impl Drop for ProfileInactivityGuard {
    fn drop(&mut self) {
        if let Self::DaemonStopped(file) = self {
            let _ = FileExt::unlock(file);
        }
    }
}

fn acquire_profile_inactivity_guard(
    installation: &InstallationRoot,
    profile_id: &ProfileId,
    registry_revision: u64,
    live_host_status: Option<&crate::daemon_host::DaemonHostStatus>,
) -> Result<ProfileInactivityGuard> {
    let path = installation.as_path().join("daemon.lock");
    reject_symlink(&path, "daemon lock")?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)?;
    set_private_file_permissions(&path)?;
    match file.try_lock_exclusive() {
        Ok(()) => Ok(ProfileInactivityGuard::DaemonStopped(file)),
        Err(err) if file_lock_is_contended(&err) => {
            let control_path = crate::daemon_host::control_state_path(installation);
            let state_path = crate::daemon_host::host_state_path(installation);
            reject_symlink(&control_path, "daemon host control state")?;
            reject_symlink(&state_path, "daemon host state")?;
            let control: crate::daemon_host::DaemonHostControlState =
                std::fs::read_to_string(&control_path)
                    .ok()
                    .and_then(|raw| serde_json::from_str(&raw).ok())
                    .ok_or_else(|| {
                        CliError::Auth(
                            "Stop the local daemon before removing or purging profile state".into(),
                        )
                    })?;
            let persisted_state: crate::daemon_host::DaemonHostStatus =
                std::fs::read_to_string(&state_path)
                    .ok()
                    .and_then(|raw| serde_json::from_str(&raw).ok())
                    .ok_or_else(|| {
                        CliError::Auth(
                            "Stop the local daemon before removing or purging profile state".into(),
                        )
                    })?;
            // A persisted control/state pair can survive a crash and later
            // coexist with an old daemon holding the installation lock. Only
            // accept a status obtained from this command's authenticated live
            // endpoint request, and bind it to the persisted generation.
            let state = live_host_status.ok_or_else(|| {
                CliError::Auth(
                    "Stop the local daemon before removing or purging profile state".into(),
                )
            })?;
            let profile_is_inactive = state
                .profiles
                .iter()
                .find(|profile| &profile.profile_id == profile_id)
                .is_none_or(|profile| profile.lifecycle == "disabled");
            if control.generation != state.generation
                || persisted_state.generation != state.generation
                || state.loaded_registry_revision < registry_revision
                || !profile_is_inactive
            {
                return Err(CliError::Auth(
                    "Wait for the selected profile runtime to stop before removing or purging it"
                        .into(),
                ));
            }
            Ok(ProfileInactivityGuard::HostAcknowledged)
        }
        Err(err) => Err(CliError::Io(err)),
    }
}

fn file_lock_is_contended(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::WouldBlock
        // LockFileEx reports ERROR_LOCK_VIOLATION without mapping it to
        // WouldBlock, including when another handle in this process owns it.
        || cfg!(windows) && error.raw_os_error() == Some(33)
}

fn ensure_no_run_recovery_evidence(state_root: &Path) -> Result<()> {
    for file_name in ["daemon-run-registry.json"] {
        let path = state_root.join(file_name);
        let raw = match std::fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(CliError::Io(err)),
        };
        let value: serde_json::Value = serde_json::from_str(&raw).map_err(|err| {
            CliError::Auth(format!(
                "Refusing profile removal because recovery evidence at {} is malformed: {err}",
                path.display()
            ))
        })?;
        let empty = value.as_array().is_some_and(Vec::is_empty)
            || value.as_object().is_some_and(serde_json::Map::is_empty);
        if !empty {
            return Err(CliError::Auth(format!(
                "Refusing profile removal while recovery evidence remains at {}",
                path.display()
            )));
        }
    }
    let runs_root = state_root.join("runs");
    reject_symlink(&runs_root, "profile runs root")?;
    let entries = match std::fs::read_dir(&runs_root) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(CliError::Io(err)),
    };
    for entry in entries {
        let entry = entry?;
        let is_sidecar = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.ends_with(".registry.json"));
        if is_sidecar {
            return Err(CliError::Auth(format!(
                "Refusing profile removal while Run recovery sidecar remains at {}",
                entry.path().display()
            )));
        }
    }
    Ok(())
}

pub(crate) fn reject_symlink(path: &Path, label: &str) -> Result<()> {
    let metadata = crate::fs::metadata_if_exists(path)?;
    if metadata.is_some_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(CliError::Auth(format!(
            "Refusing symlinked {label}: {}",
            path.display()
        )));
    }
    Ok(())
}

fn create_private_dir_all(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn set_private_file_permissions(path: &Path) -> Result<()> {
    #[cfg(not(unix))]
    let _ = path;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn unix_now_string() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(name: &str) -> (PathBuf, ProfileStore) {
        let root =
            std::env::temp_dir().join(format!("xmatrix-profile-{name}-{}", uuid::Uuid::new_v4()));
        let store = ProfileStore::new(InstallationRoot::new(root.clone()));
        (root, store)
    }

    fn disabled_profile_fixture(
        name: &str,
        profile_name: &str,
    ) -> (PathBuf, ProfileStore, ProfileRegistry, ProfileContext) {
        let (root, store) = store(name);
        let initial = store.load_or_bootstrap().unwrap();
        let created = store
            .create(initial.revision, profile_name, "https://example.com", false)
            .unwrap();
        let context = store
            .context_for_selector(&created, profile_name, true)
            .unwrap();
        (root, store, created, context)
    }

    fn lock_test_daemon(root: &Path) -> std::fs::File {
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join("daemon.lock"))
            .unwrap();
        lock.lock_exclusive().unwrap();
        lock
    }

    fn prepare_profile_marker(context: &ProfileContext) {
        std::fs::create_dir_all(context.state_root.as_path()).unwrap();
        std::fs::write(context.state_root.join("marker"), "owned").unwrap();
    }

    #[cfg(unix)]
    fn assert_empty_outside_and_cleanup(root: &Path, outside: &Path) {
        assert!(std::fs::read_dir(outside).unwrap().next().is_none());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn bootstrap_preserves_the_legacy_environment_and_root() {
        let (root, store) = store("bootstrap");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("config.json"), r#"{"activeEnvironment":"test"}"#).unwrap();

        let registry = store.load_or_bootstrap().unwrap();
        let context = store.context_for_default(&registry).unwrap();

        assert_eq!(registry.revision, 1);
        assert_eq!(context.name, "test");
        assert_eq!(context.hub_origin, TEST_HUB_URL);
        assert_eq!(context.state_kind, ProfileStateKind::LegacyRoot);
        assert_eq!(context.state_root.as_path(), root);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn mutations_use_revision_cas_and_rename_keeps_the_id() {
        let (root, store) = store("cas");
        let initial = store.load_or_bootstrap().unwrap();
        let created = store
            .create(initial.revision, "isolated", "https://example.com/", true)
            .unwrap();
        let created_profile = resolve_selectable_profile(&created, "isolated")
            .unwrap()
            .clone();
        let renamed = store
            .rename(created.revision, "ISOLATED", "renamed")
            .unwrap();
        assert_eq!(
            resolve_selectable_profile(&renamed, "renamed").unwrap().id,
            created_profile.id
        );
        assert_eq!(
            store
                .context_for_selector(&renamed, created_profile.id.as_str(), false)
                .unwrap()
                .name,
            "renamed"
        );
        let error = store
            .set_default(created.revision, "renamed")
            .unwrap_err()
            .to_string();
        assert!(error.contains("changed concurrently"), "{error}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn default_and_enabled_invariants_fail_closed() {
        let (root, store) = store("default-guards");
        let registry = store.load_or_bootstrap().unwrap();
        assert!(
            store
                .set_enabled(registry.revision, "production", false)
                .unwrap_err()
                .to_string()
                .contains("default profile")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn hub_origins_are_strict_and_canonical() {
        assert_eq!(
            normalize_profile_hub_origin("https://EXAMPLE.com:443/").unwrap(),
            "https://example.com"
        );
        for invalid in [
            "ftp://example.com",
            "https://user@example.com",
            "https://example.com/path",
            "https://example.com?q=1",
            "https://example.com/#fragment",
        ] {
            assert!(normalize_profile_hub_origin(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn malformed_registry_is_not_replaced_by_bootstrap() {
        let (root, store) = store("malformed");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("profiles.json"), "not json").unwrap();
        assert!(store.load_or_bootstrap().is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("profiles.json")).unwrap(),
            "not json"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_legacy_config_does_not_create_a_registry() {
        let (root, store) = store("malformed-legacy");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("config.json"), "not json").unwrap();

        let error = store.load_or_bootstrap().unwrap_err().to_string();
        assert!(error.contains("invalid legacy config"), "{error}");
        assert!(!root.join("profiles.json").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("config.json")).unwrap(),
            "not json"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn remove_then_purge_deletes_only_the_derived_isolated_root() {
        let (root, store, created, context) = disabled_profile_fixture("purge", "throwaway");
        prepare_profile_marker(&context);

        let removed = store.remove(created.revision, "throwaway").unwrap();
        let purged = store.purge(removed.revision, context.id.as_str()).unwrap();

        assert_eq!(purged.revision, removed.revision + 1);
        assert!(!context.state_root.as_path().exists());
        assert!(
            root.join("daemon-host")
                .join("logs")
                .join(format!(
                    "profile-purge-{}.json",
                    context.id.directory_component()
                ))
                .is_file()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn remove_refuses_nonempty_run_recovery_evidence() {
        let (root, store, created, context) = disabled_profile_fixture("remove-live", "busy");
        std::fs::create_dir_all(context.state_root.as_path()).unwrap();
        std::fs::write(
            context.state_root.join("daemon-run-registry.json"),
            r#"[{"pid":42}]"#,
        )
        .unwrap();

        let error = store.remove(created.revision, "busy").unwrap_err();
        assert!(error.to_string().contains("recovery evidence"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn remove_refuses_run_recovery_sidecars() {
        let (root, store, created, context) = disabled_profile_fixture("remove-sidecar", "busy");
        std::fs::create_dir_all(context.state_root.join("runs")).unwrap();
        std::fs::write(
            context.state_root.join("runs/run-1.registry.json"),
            r#"{"pid":42}"#,
        )
        .unwrap();

        let error = store.remove(created.revision, "busy").unwrap_err();
        assert!(error.to_string().contains("recovery sidecar"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn remove_refuses_while_the_installation_daemon_lock_is_held() {
        let (root, store) = store("remove-live-daemon");
        let initial = store.load_or_bootstrap().unwrap();
        let created = store
            .create(initial.revision, "busy", "https://example.com", false)
            .unwrap();
        let daemon_lock = lock_test_daemon(&root);

        let error = store.remove(created.revision, "busy").unwrap_err();
        assert!(error.to_string().contains("Stop the local daemon"));
        FileExt::unlock(&daemon_lock).unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn remove_accepts_an_exact_disabled_runtime_ack_from_the_live_host() {
        let (root, store, created, context) =
            disabled_profile_fixture("remove-disabled-live-host", "retired");
        let daemon_lock = lock_test_daemon(&root);
        let generation = "00000000-0000-0000-0000-000000000099".to_string();
        let installation = InstallationRoot::new(root.clone());
        crate::daemon_host::persist_control_state(
            &installation,
            &crate::daemon_host::DaemonHostControlState {
                schema_version: 1,
                generation: generation.clone(),
                pid: std::process::id(),
                url: "http://127.0.0.1:49199".into(),
                capability: "a".repeat(32),
                updated_at: "1".into(),
            },
        )
        .unwrap();
        let live_status = crate::daemon_host::DaemonHostStatus {
            schema_version: 1,
            generation,
            loaded_registry_revision: created.revision,
            default_profile_id: created.default_profile_id.clone(),
            profiles: vec![crate::daemon_host::DaemonHostProfileState {
                profile_id: context.id.clone(),
                name: context.name.clone(),
                hub_url: context.hub_origin.clone(),
                lifecycle: "disabled".into(),
                detail: None,
            }],
            updated_at: "1".into(),
        };
        crate::daemon_host::persist_host_state(&installation, &live_status).unwrap();

        assert!(store.remove(created.revision, "retired").is_err());
        let removed = store
            .remove_with_host_status(created.revision, "retired", Some(&live_status))
            .unwrap();
        assert_eq!(removed.revision, created.revision + 1);
        FileExt::unlock(&daemon_lock).unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_registry_is_rejected() {
        use std::os::unix::fs::symlink;

        let (root, store) = store("symlink");
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("outside.json");
        std::fs::write(&target, "{}").unwrap();
        symlink(&target, root.join("profiles.json")).unwrap();
        let error = store.load_or_bootstrap().unwrap_err().to_string();
        assert!(error.contains("symlinked profile registry"), "{error}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn isolated_state_rejects_a_symlinked_profiles_parent() {
        use std::os::unix::fs::symlink;

        let (root, store) = store("state-parent-symlink");
        let initial = store.load_or_bootstrap().unwrap();
        let created = store
            .create(initial.revision, "isolated", "https://example.com", true)
            .unwrap();
        let context = store
            .context_for_selector(&created, "isolated", false)
            .unwrap();
        let outside = root.with_extension("outside");
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("profiles")).unwrap();

        let error = store.prepare_context_state_root(&context).unwrap_err();
        assert!(error.to_string().contains("symlinked profiles state root"));
        assert_empty_outside_and_cleanup(&root, &outside);
    }

    #[cfg(unix)]
    #[test]
    fn purge_rejects_a_symlinked_daemon_host_before_staging_state() {
        use std::os::unix::fs::symlink;

        let (root, store, created, context) =
            disabled_profile_fixture("purge-daemon-host-symlink", "throwaway");
        let outside = std::env::temp_dir().join(format!(
            "xmatrix-profile-purge-outside-{}",
            uuid::Uuid::new_v4()
        ));

        prepare_profile_marker(&context);
        let removed = store.remove(created.revision, "throwaway").unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("daemon-host")).unwrap();

        let error = store
            .purge(removed.revision, context.id.as_str())
            .unwrap_err()
            .to_string();
        assert!(error.contains("symlinked daemon host root"), "{error}");
        assert!(context.state_root.join("marker").is_file());
        assert_empty_outside_and_cleanup(&root, &outside);
    }
}
