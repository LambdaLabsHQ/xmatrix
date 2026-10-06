use std::io::{Read as _, Write as _};
use std::net::{TcpListener, TcpStream};
use std::os::windows::ffi::OsStrExt as _;
use std::os::windows::io::{AsRawHandle as _, FromRawHandle as _, OwnedHandle, RawHandle};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use ed25519_dalek::{Signature, Signer as _, SigningKey, Verifier as _, VerifyingKey};
use serde::{Deserialize, Serialize};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::JobObjects::{IsProcessInJob, OpenJobObjectW};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use xmatrix_cli_core::hex::sha256_hex;
use xmatrix_windows_continuity::{
    ControlMessage, RunEvidence, SUPERVISOR_PROTOCOL_MAJOR, connect_inherited_control_pipe,
    sha256_file,
};

use super::runtime_broker_proxy_reconnect::{connect_broker_upstream, loopback_broker_address};
use super::{CliError, config, error, write_daemon_private_file};

const BOOTSTRAP_NONCE_ENV: &str = "XMATRIX_RUN_BOOTSTRAP_NONCE";
const JOB_NAME_ENV: &str = "XMATRIX_RUN_JOB_NAME";
const MAX_ADOPTION_FRAME_BYTES: usize = 4 * 1024;
const ADOPTION_IO_TIMEOUT: Duration = Duration::from_secs(3);
const JOB_OBJECT_QUERY: u32 = 0x0004;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdoptionChallenge {
    transaction_id: String,
    nonce: String,
    run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    auth_broker: Option<BrokerTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    request_broker: Option<BrokerTarget>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BrokerTarget {
    pub url: String,
    pub capability: String,
}

#[derive(Default)]
pub(super) struct BrokerRotation {
    pub auth: Option<BrokerTarget>,
    pub request: Option<BrokerTarget>,
}

#[derive(Clone)]
struct ProxyUpstream {
    broker: BrokerTarget,
    discover_profile_broker: bool,
}

#[derive(Clone)]
struct ProxyControl {
    stable_capability: String,
    target: Arc<Mutex<ProxyUpstream>>,
    broker_state_path: PathBuf,
    broker_label: &'static str,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdoptionProof {
    wrapper_nonce: String,
    adoption_public_key: String,
    signature: String,
}

pub(super) fn complete_wrapper_bootstrap() -> error::Result<()> {
    let Some(bootstrap_nonce) = std::env::var(BOOTSTRAP_NONCE_ENV).ok() else {
        return Ok(());
    };
    let run_id = required_env("XMATRIX_RUN_ID")?;
    let execution_key = required_env("XMATRIX_EXECUTION_KEY")?;
    let instance_id = required_env("XMATRIX_AGENT_INSTANCE_ID")?;
    let job_name = required_env(JOB_NAME_ENV)?;
    let executable_path = std::fs::canonicalize(std::env::current_exe()?)?;
    let executable_sha256 = sha256_file(&executable_path).map_err(|error| {
        CliError::Launch(format!("Run wrapper executable digest failed: {error}"))
    })?;
    let process_birth_id = process_birth_id(std::process::id())?;
    let wrapper_nonce = uuid::Uuid::new_v4().simple().to_string();
    let mut secret = [0u8; 32];
    getrandom::fill(&mut secret).map_err(|error| {
        CliError::Launch(format!("Run adoption key generation failed: {error}"))
    })?;
    let signing_key = SigningKey::from_bytes(&secret);
    secret.fill(0);
    let public_key = signing_key.verifying_key().to_bytes();
    let adoption_public_key = base64::engine::general_purpose::STANDARD.encode(public_key);
    let adoption_key_hash = sha256_hex(&public_key);
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    let control_locator = format!("tcp://{}", listener.local_addr()?);
    let evidence = RunEvidence {
        run_id: run_id.clone(),
        execution_key,
        instance_id,
        pid: std::process::id(),
        process_birth_id,
        executable_sha256,
        wrapper_nonce: wrapper_nonce.clone(),
        adoption_key_hash,
        job_name,
        protocol_major: SUPERVISOR_PROTOCOL_MAJOR,
        executable_path,
        adoption_public_key: adoption_public_key.clone(),
        control_locator,
    };
    evidence.validate().map_err(|error| {
        CliError::Launch(format!("Run wrapper adoption evidence is invalid: {error}"))
    })?;
    let event_run_id = evidence.run_id.clone();
    let event_executable_sha256 = evidence.executable_sha256.clone();

    let auth_proxy = install_broker_proxy(
        "XMATRIX_DAEMON_AUTH_URL",
        "XMATRIX_DAEMON_AUTH_CAPABILITY",
        "auth",
    )?;
    let request_proxy = install_broker_proxy(
        "XMATRIX_DAEMON_REQUEST_URL",
        "XMATRIX_DAEMON_REQUEST_CAPABILITY",
        "request",
    )?;
    std::thread::Builder::new()
        .name("xmatrix-run-adoption".into())
        .spawn(move || {
            adoption_server(
                listener,
                signing_key,
                run_id,
                wrapper_nonce,
                auth_proxy,
                request_proxy,
            )
        })
        .map_err(|error| CliError::Launch(format!("Run adoption server failed: {error}")))?;

    let mut control = connect_inherited_control_pipe()
        .map_err(|error| CliError::Launch(format!("Run bootstrap pipe is invalid: {error}")))?;
    clear_bootstrap_environment();
    control
        .send(&ControlMessage::WrapperObserved {
            nonce: bootstrap_nonce.clone(),
            evidence,
        })
        .map_err(|error| CliError::Launch(format!("Run bootstrap evidence failed: {error}")))?;
    match control
        .receive()
        .map_err(|error| CliError::Launch(format!("Run bootstrap authorization failed: {error}")))?
    {
        ControlMessage::LaunchAuthorized { nonce } if nonce == bootstrap_nonce => {
            record_continuity_event(
                "run_launch_authorized",
                Some(&event_run_id),
                Some(&event_executable_sha256),
                Some("launch_authorized"),
                None,
            );
            Ok(())
        }
        _ => Err(CliError::Launch(
            "Run wrapper did not receive exact LaunchAuthorized evidence".into(),
        )),
    }
}

pub(super) fn persist_evidence(status_path: &Path, evidence: &RunEvidence) -> error::Result<()> {
    evidence.validate().map_err(|error| {
        CliError::Launch(format!("Run adoption sidecar evidence is invalid: {error}"))
    })?;
    let path = sidecar_path(status_path)?;
    let temporary = config::unique_temporary_path(&path);
    let bytes = serde_json::to_vec_pretty(evidence)?;
    write_daemon_private_file(&temporary, &bytes)?;
    if let Err(error) = config::replace_file_atomically(&temporary, &path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(CliError::Io(error));
    }
    Ok(())
}

pub(super) fn authorize_spawned_wrapper(
    mut control: xmatrix_windows_continuity::InheritedControlPipe,
    nonce: &str,
    pid: u32,
    run_id: &str,
    execution_key: &str,
    instance_id: &str,
    status_path: &Path,
) -> error::Result<RunEvidence> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("xmatrix-run-bootstrap-read".into())
        .spawn(move || {
            let result = control.receive();
            let _ = send.send((result, control));
        })
        .map_err(|error| CliError::Launch(format!("Run bootstrap reader failed: {error}")))?;
    let (message, mut control) = receive
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| CliError::Launch("Run wrapper bootstrap timed out".into()))?;
    let message = message
        .map_err(|error| CliError::Launch(format!("Run wrapper bootstrap failed: {error}")))?;
    let ControlMessage::WrapperObserved {
        nonce: received_nonce,
        evidence,
    } = message
    else {
        return Err(CliError::Launch(
            "Run wrapper sent an unexpected bootstrap message".into(),
        ));
    };
    if received_nonce != nonce
        || evidence.pid != pid
        || evidence.run_id != run_id
        || evidence.execution_key != execution_key
        || evidence.instance_id != instance_id
    {
        return Err(CliError::Launch(
            "Run wrapper bootstrap identity does not match its exact spawn".into(),
        ));
    }
    evidence.validate().map_err(|error| {
        CliError::Launch(format!(
            "Run wrapper bootstrap evidence is invalid: {error}"
        ))
    })?;
    persist_evidence(status_path, &evidence)?;
    control
        .send(&ControlMessage::LaunchAuthorized {
            nonce: nonce.to_string(),
        })
        .map_err(|error| CliError::Launch(format!("Run LaunchAuthorized failed: {error}")))?;
    Ok(evidence)
}

pub(super) fn read_evidence(status_path: &Path) -> error::Result<RunEvidence> {
    let path = sidecar_path(status_path)?;
    let bytes = std::fs::read(&path)?;
    if bytes.len() > MAX_ADOPTION_FRAME_BYTES {
        return Err(CliError::Launch("Run adoption sidecar is oversized".into()));
    }
    let evidence: RunEvidence = serde_json::from_slice(&bytes)?;
    evidence
        .validate()
        .map_err(|error| CliError::Launch(format!("Run adoption sidecar is invalid: {error}")))?;
    Ok(evidence)
}

pub(super) fn remove_evidence(status_path: &Path) {
    if let Ok(path) = sidecar_path(status_path) {
        let _ = std::fs::remove_file(path);
    }
}

pub(super) fn challenge(
    evidence: &RunEvidence,
    transaction_id: &str,
    nonce: &str,
    rotation: BrokerRotation,
) -> error::Result<()> {
    let result = challenge_inner(evidence, transaction_id, nonce, rotation);
    record_continuity_event(
        if result.is_ok() {
            "run_adopted"
        } else {
            "run_quarantined"
        },
        Some(transaction_id),
        Some(&evidence.executable_sha256),
        Some(if result.is_ok() {
            "adopted"
        } else {
            "quarantined"
        }),
        result.as_ref().err().map(|_| "evidence_conflict"),
    );
    result
}

fn challenge_inner(
    evidence: &RunEvidence,
    transaction_id: &str,
    nonce: &str,
    rotation: BrokerRotation,
) -> error::Result<()> {
    evidence
        .validate()
        .map_err(|error| CliError::Launch(format!("Run adoption evidence is invalid: {error}")))?;
    if process_birth_id(evidence.pid)? != evidence.process_birth_id {
        return Err(CliError::Launch(
            "Run wrapper process birth identity changed".into(),
        ));
    }
    let executable = process_executable(evidence.pid)?;
    if std::fs::canonicalize(&executable)? != std::fs::canonicalize(&evidence.executable_path)?
        || sha256_file(&executable).map_err(|error| CliError::Launch(error.to_string()))?
            != evidence.executable_sha256
    {
        return Err(CliError::Launch(
            "Run wrapper executable identity changed".into(),
        ));
    }
    if !process_in_named_job(evidence.pid, &evidence.job_name)? {
        return Err(CliError::Launch(
            "Run wrapper is not in its exact nested Job".into(),
        ));
    }
    let address = evidence
        .control_locator
        .strip_prefix("tcp://")
        .ok_or_else(|| CliError::Launch("Run adoption locator is invalid".into()))?;
    let mut stream = TcpStream::connect_timeout(
        &address
            .parse()
            .map_err(|_| CliError::Launch("Run adoption address is invalid".into()))?,
        ADOPTION_IO_TIMEOUT,
    )?;
    stream.set_read_timeout(Some(ADOPTION_IO_TIMEOUT))?;
    stream.set_write_timeout(Some(ADOPTION_IO_TIMEOUT))?;
    let challenge = AdoptionChallenge {
        transaction_id: transaction_id.to_string(),
        nonce: nonce.to_string(),
        run_id: evidence.run_id.clone(),
        auth_broker: rotation.auth,
        request_broker: rotation.request,
    };
    write_frame(&mut stream, &challenge)?;
    let proof: AdoptionProof = read_frame(&mut stream)?;
    if proof.wrapper_nonce != evidence.wrapper_nonce
        || proof.adoption_public_key != evidence.adoption_public_key
    {
        return Err(CliError::Launch(
            "Run adoption proof identity mismatch".into(),
        ));
    }
    let public_bytes = base64::engine::general_purpose::STANDARD
        .decode(&proof.adoption_public_key)
        .map_err(|_| CliError::Launch("Run adoption public key is invalid".into()))?;
    let public_bytes: [u8; 32] = public_bytes
        .try_into()
        .map_err(|_| CliError::Launch("Run adoption public key length is invalid".into()))?;
    if sha256_hex(&public_bytes) != evidence.adoption_key_hash {
        return Err(CliError::Launch(
            "Run adoption public key hash mismatch".into(),
        ));
    }
    let signature = base64::engine::general_purpose::STANDARD
        .decode(&proof.signature)
        .map_err(|_| CliError::Launch("Run adoption signature is invalid".into()))?;
    let signature = Signature::from_slice(&signature)
        .map_err(|_| CliError::Launch("Run adoption signature length is invalid".into()))?;
    VerifyingKey::from_bytes(&public_bytes)
        .map_err(|_| CliError::Launch("Run adoption public key is invalid".into()))?
        .verify(
            &challenge_bytes(&challenge, &evidence.wrapper_nonce),
            &signature,
        )
        .map_err(|_| CliError::Launch("Run wrapper challenge signature was rejected".into()))
}

fn record_continuity_event(
    kind: &str,
    transaction_id: Option<&str>,
    artifact_sha256: Option<&str>,
    phase: Option<&str>,
    detail_code: Option<&str>,
) {
    let Some(root) = std::env::current_exe()
        .ok()
        .and_then(|path| super::managed_daemon_executable_root(&path).map(Path::to_path_buf))
    else {
        return;
    };
    let _ =
        xmatrix_windows_continuity::ContinuityEventLog::new(root.join("continuity-events.json"))
            .append(
                "wrapper",
                kind,
                transaction_id,
                artifact_sha256,
                phase,
                detail_code,
            );
}

fn adoption_server(
    listener: TcpListener,
    signing_key: SigningKey,
    run_id: String,
    wrapper_nonce: String,
    auth_proxy: Option<ProxyControl>,
    request_proxy: Option<ProxyControl>,
) {
    for incoming in listener.incoming() {
        let Ok(mut stream) = incoming else { continue };
        let _ = stream.set_read_timeout(Some(ADOPTION_IO_TIMEOUT));
        let _ = stream.set_write_timeout(Some(ADOPTION_IO_TIMEOUT));
        let Ok(challenge) = read_frame::<AdoptionChallenge>(&mut stream) else {
            continue;
        };
        if challenge.run_id != run_id
            || challenge.transaction_id.trim().is_empty()
            || challenge.nonce.len() < 32
        {
            continue;
        }
        if update_proxy_target(auth_proxy.as_ref(), challenge.auth_broker.as_ref()).is_err()
            || update_proxy_target(request_proxy.as_ref(), challenge.request_broker.as_ref())
                .is_err()
        {
            continue;
        }
        let proof = AdoptionProof {
            wrapper_nonce: wrapper_nonce.clone(),
            adoption_public_key: base64::engine::general_purpose::STANDARD
                .encode(signing_key.verifying_key().to_bytes()),
            signature: base64::engine::general_purpose::STANDARD.encode(
                signing_key
                    .sign(&challenge_bytes(&challenge, &wrapper_nonce))
                    .to_bytes(),
            ),
        };
        let _ = write_frame(&mut stream, &proof);
    }
}

fn challenge_bytes(challenge: &AdoptionChallenge, wrapper_nonce: &str) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(challenge).unwrap_or_default();
    bytes.push(0);
    bytes.extend_from_slice(wrapper_nonce.as_bytes());
    bytes
}

fn install_broker_proxy(
    url_env: &str,
    capability_env: &str,
    label: &'static str,
) -> error::Result<Option<ProxyControl>> {
    let url = std::env::var(url_env)
        .ok()
        .filter(|value| !value.trim().is_empty());
    let capability = std::env::var(capability_env)
        .ok()
        .filter(|value| !value.trim().is_empty());
    let (Some(url), Some(capability)) = (url, capability) else {
        return Ok(None);
    };
    let target = BrokerTarget { url, capability };
    validate_broker_target(&target)?;
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    let proxy_url = format!("http://{}", listener.local_addr()?);
    let stable_capability = uuid::Uuid::new_v4().to_string();
    let control = ProxyControl {
        stable_capability: stable_capability.clone(),
        target: Arc::new(Mutex::new(ProxyUpstream {
            broker: target,
            discover_profile_broker: true,
        })),
        broker_state_path: config::profile_state_dir().join(format!("daemon-{label}-broker.json")),
        broker_label: label,
    };
    let worker = control.clone();
    std::thread::Builder::new()
        .name(format!("xmatrix-run-{label}-proxy"))
        .spawn(move || proxy_server(listener, worker))
        .map_err(|error| CliError::Launch(format!("Run {label} proxy failed: {error}")))?;
    unsafe {
        std::env::set_var(url_env, proxy_url);
        std::env::set_var(capability_env, stable_capability);
    }
    Ok(Some(control))
}

fn update_proxy_target(
    proxy: Option<&ProxyControl>,
    target: Option<&BrokerTarget>,
) -> error::Result<()> {
    match (proxy, target) {
        (None, None) => Ok(()),
        (Some(proxy), Some(target)) => {
            validate_broker_target(target)?;
            *proxy
                .target
                .lock()
                .map_err(|_| CliError::Launch("Run broker proxy state is poisoned".into()))? =
                ProxyUpstream {
                    broker: target.clone(),
                    discover_profile_broker: false,
                };
            Ok(())
        }
        _ => Err(CliError::Launch(
            "Run broker rotation does not match its original scope".into(),
        )),
    }
}

fn validate_broker_target(target: &BrokerTarget) -> error::Result<std::net::SocketAddr> {
    if target.capability.trim().is_empty() || target.capability.len() > 256 {
        return Err(CliError::Launch("Run broker capability is invalid".into()));
    }
    loopback_broker_address(&target.url).map_err(CliError::Io)
}

fn proxy_server(listener: TcpListener, control: ProxyControl) {
    for incoming in listener.incoming() {
        let Ok(client) = incoming else { continue };
        let control = control.clone();
        let _ = std::thread::Builder::new()
            .name("xmatrix-run-broker-request".into())
            .spawn(move || {
                let _ = proxy_request(client, &control);
            });
    }
}

fn proxy_request(mut client: TcpStream, control: &ProxyControl) -> error::Result<()> {
    client.set_read_timeout(Some(Duration::from_secs(30)))?;
    client.set_write_timeout(Some(Duration::from_secs(30)))?;
    let mut header = Vec::new();
    let mut byte = [0u8; 1];
    while header.len() < 64 * 1024 && !header.ends_with(b"\r\n\r\n") {
        client.read_exact(&mut byte)?;
        header.push(byte[0]);
    }
    if !header.ends_with(b"\r\n\r\n") {
        return Err(CliError::Launch(
            "Run broker request header is oversized".into(),
        ));
    }
    let snapshot = control
        .target
        .lock()
        .map_err(|_| CliError::Launch("Run broker proxy state is poisoned".into()))?
        .clone();
    let target = &snapshot.broker;
    validate_broker_target(&target)?;
    let stable = control.stable_capability.as_bytes();
    let replacement = target.capability.as_bytes();
    let mut rewritten = Vec::with_capacity(header.len());
    let mut offset = 0;
    while let Some(index) = header[offset..]
        .windows(stable.len())
        .position(|window| window == stable)
    {
        let index = offset + index;
        rewritten.extend_from_slice(&header[offset..index]);
        rewritten.extend_from_slice(replacement);
        offset = index + stable.len();
    }
    rewritten.extend_from_slice(&header[offset..]);
    let content_length = String::from_utf8_lossy(&header)
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<u64>().ok())
                .flatten()
        })
        .unwrap_or(0);
    let connected = if snapshot.discover_profile_broker {
        connect_broker_upstream(&target.url, &control.broker_state_path, ADOPTION_IO_TIMEOUT)
    } else {
        TcpStream::connect_timeout(&loopback_broker_address(&target.url)?, ADOPTION_IO_TIMEOUT)
            .map(|stream| (stream, target.url.clone()))
    };
    let (mut upstream, connected_url) = match connected {
        Ok(connected) => connected,
        Err(_) => {
            let body = serde_json::json!({ "error": format!(
                "Local daemon {} broker unavailable: waiting for daemon replacement",
                control.broker_label,
            ) })
            .to_string();
            write!(
                client,
                "HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\ncache-control: no-store\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body,
            )?;
            client.flush()?;
            return Ok(());
        }
    };
    if connected_url != target.url {
        let mut current = control
            .target
            .lock()
            .map_err(|_| CliError::Launch("Run broker proxy state is poisoned".into()))?;
        // Do not overwrite a concurrent signed adoption or rotate its capability.
        if current.discover_profile_broker
            && current.broker.url == target.url
            && current.broker.capability == target.capability
        {
            current.broker.url = connected_url;
        }
    }
    upstream.set_read_timeout(Some(Duration::from_secs(30)))?;
    upstream.set_write_timeout(Some(Duration::from_secs(30)))?;
    upstream.write_all(&rewritten)?;
    if content_length > 0 {
        std::io::copy(&mut (&mut client).take(content_length), &mut upstream)?;
    }
    upstream.flush()?;
    std::io::copy(&mut upstream, &mut client)?;
    client.flush()?;
    Ok(())
}

fn write_frame(stream: &mut TcpStream, value: &impl Serialize) -> error::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_ADOPTION_FRAME_BYTES {
        return Err(CliError::Launch("Run adoption frame is oversized".into()));
    }
    stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
    stream.write_all(&bytes)?;
    stream.flush()?;
    Ok(())
}

#[cfg(test)]
mod proxy_reconnect_tests {
    use super::*;

    fn request_proxy(control: &ProxyControl) -> String {
        let front = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(front.local_addr().unwrap()).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let (incoming, _) = front.accept().unwrap();
        let proxy_control = control.clone();
        let proxy = std::thread::spawn(move || proxy_request(incoming, &proxy_control));
        client
            .write_all(
                b"GET /auth/token HTTP/1.1\r\nx-xmatrix-auth-capability: front-run-proof\r\n\r\n",
            )
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        proxy.join().unwrap().unwrap();
        response
    }

    #[test]
    fn stable_auth_proxy_survives_daemon_replacement_with_the_same_run_proof() {
        let old = TcpListener::bind("127.0.0.1:0").unwrap();
        let old_url = format!("http://{}", old.local_addr().unwrap());
        let replacement = TcpListener::bind("127.0.0.1:0").unwrap();
        let new_url = format!("http://{}", replacement.local_addr().unwrap());
        let state_path = std::env::temp_dir().join(format!(
            "xmatrix-auth-proxy-replacement-{}.json",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &state_path,
            serde_json::json!({ "url": new_url }).to_string(),
        )
        .unwrap();
        let control = ProxyControl {
            stable_capability: "front-run-proof".into(),
            target: Arc::new(Mutex::new(ProxyUpstream {
                broker: BrokerTarget {
                    url: old_url,
                    capability: "upstream-run-proof".into(),
                },
                discover_profile_broker: true,
            })),
            broker_state_path: state_path.clone(),
            broker_label: "auth",
        };
        let backend = std::thread::spawn(move || {
            replacement.set_nonblocking(true).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let (mut stream, _) = loop {
                match replacement.accept() {
                    Ok(accepted) => break accepted,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && std::time::Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => {
                        panic!("replacement broker did not receive a connection: {error}")
                    }
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                header.push(byte[0]);
            }
            let text = String::from_utf8(header).unwrap();
            assert!(text.contains("x-xmatrix-auth-capability: upstream-run-proof"));
            assert!(!text.contains("front-run-proof"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nOK")
                .unwrap();
        });
        old.set_nonblocking(true).unwrap();
        let response = request_proxy(&control);
        backend.join().unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        let target = control.target.lock().unwrap();
        assert_eq!(target.broker.url, new_url);
        assert_eq!(target.broker.capability, "upstream-run-proof");
        assert_eq!(
            old.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        std::fs::remove_file(state_path).unwrap();
    }

    #[test]
    fn absent_replacement_reports_retryable_auth_unavailability_without_leaking_proofs() {
        let old = tokio::net::TcpSocket::new_v4().unwrap();
        old.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let control = ProxyControl {
            stable_capability: "front-run-proof".into(),
            target: Arc::new(Mutex::new(ProxyUpstream {
                broker: BrokerTarget {
                    url: format!("http://{}", old.local_addr().unwrap()),
                    capability: "upstream-run-proof".into(),
                },
                discover_profile_broker: true,
            })),
            broker_state_path: std::env::temp_dir()
                .join(format!("missing-broker-{}", uuid::Uuid::new_v4())),
            broker_label: "auth",
        };
        let response = request_proxy(&control);
        assert!(response.starts_with("HTTP/1.1 503 Service Unavailable"));
        let body: serde_json::Value =
            serde_json::from_str(response.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .starts_with("Local daemon auth broker unavailable:")
        );
        assert!(!response.contains("front-run-proof"));
        assert!(!response.contains("upstream-run-proof"));
    }

    #[test]
    fn explicit_adoption_never_falls_back_to_the_legacy_profile_locator() {
        let legacy = TcpListener::bind("127.0.0.1:0").unwrap();
        legacy.set_nonblocking(true).unwrap();
        let legacy_url = format!("http://{}", legacy.local_addr().unwrap());
        let state_path = std::env::temp_dir().join(format!(
            "xmatrix-adopted-proxy-{}.json",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &state_path,
            serde_json::json!({ "url": legacy_url }).to_string(),
        )
        .unwrap();
        let control = ProxyControl {
            stable_capability: "front-run-proof".into(),
            target: Arc::new(Mutex::new(ProxyUpstream {
                broker: BrokerTarget {
                    url: legacy_url,
                    capability: "upstream-run-proof".into(),
                },
                discover_profile_broker: true,
            })),
            broker_state_path: state_path.clone(),
            broker_label: "auth",
        };
        let adopted = tokio::net::TcpSocket::new_v4().unwrap();
        adopted.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let target = BrokerTarget {
            url: format!("http://{}", adopted.local_addr().unwrap()),
            capability: "adopted-run-proof".into(),
        };
        update_proxy_target(Some(&control), Some(&target)).unwrap();
        let response = request_proxy(&control);
        assert!(response.starts_with("HTTP/1.1 503 Service Unavailable"));
        assert_eq!(
            legacy.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        let current = control.target.lock().unwrap();
        assert_eq!(current.broker.url, target.url);
        assert_eq!(current.broker.capability, target.capability);
        assert!(!current.discover_profile_broker);
        std::fs::remove_file(state_path).unwrap();
    }
}

fn read_frame<T: for<'de> Deserialize<'de>>(stream: &mut TcpStream) -> error::Result<T> {
    let mut header = [0u8; 4];
    stream.read_exact(&mut header)?;
    let size = u32::from_be_bytes(header) as usize;
    if size > MAX_ADOPTION_FRAME_BYTES {
        return Err(CliError::Launch("Run adoption frame is oversized".into()));
    }
    let mut bytes = vec![0u8; size];
    stream.read_exact(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn sidecar_path(status_path: &Path) -> error::Result<PathBuf> {
    let name = status_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| CliError::Launch("Run status path has no safe name".into()))?;
    Ok(status_path.with_file_name(format!("{name}.adoption-v2.json")))
}

fn required_env(name: &str) -> error::Result<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| CliError::Launch(format!("{name} is required for Run bootstrap")))
}

fn clear_bootstrap_environment() {
    for name in [
        BOOTSTRAP_NONCE_ENV,
        JOB_NAME_ENV,
        xmatrix_windows_continuity::CONTROL_PROTOCOL_ENV,
        xmatrix_windows_continuity::CONTROL_READ_HANDLE_ENV,
        xmatrix_windows_continuity::CONTROL_WRITE_HANDLE_ENV,
    ] {
        unsafe { std::env::remove_var(name) };
    }
}

fn process_handle(pid: u32) -> error::Result<OwnedHandle> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        Err(CliError::Io(std::io::Error::last_os_error()))
    } else {
        Ok(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) })
    }
}

pub(super) fn process_birth_id(pid: u32) -> error::Result<u64> {
    let handle = process_handle(pid)?;
    xmatrix_process_tree::process_file_times(&handle)
        .map(|(creation, _)| creation)
        .map_err(CliError::Io)
}

fn process_executable(pid: u32) -> error::Result<PathBuf> {
    let handle = process_handle(pid)?;
    let mut buffer = vec![0u16; 32_768];
    let mut size = buffer.len() as u32;
    if unsafe {
        QueryFullProcessImageNameW(
            handle.as_raw_handle() as HANDLE,
            0,
            buffer.as_mut_ptr(),
            &mut size,
        )
    } == 0
    {
        return Err(CliError::Io(std::io::Error::last_os_error()));
    }
    buffer.truncate(size as usize);
    Ok(PathBuf::from(String::from_utf16(&buffer).map_err(
        |_| CliError::Launch("Run wrapper executable path is invalid UTF-16".into()),
    )?))
}

fn process_in_named_job(pid: u32, job_name: &str) -> error::Result<bool> {
    let process = process_handle(pid)?;
    let mut wide = std::ffi::OsStr::new(job_name)
        .encode_wide()
        .collect::<Vec<_>>();
    wide.push(0);
    let job = unsafe { OpenJobObjectW(JOB_OBJECT_QUERY, 0, wide.as_ptr()) };
    if job.is_null() {
        return Err(CliError::Io(std::io::Error::last_os_error()));
    }
    let job = unsafe { OwnedHandle::from_raw_handle(job as RawHandle) };
    let mut member = 0;
    if unsafe {
        IsProcessInJob(
            process.as_raw_handle() as HANDLE,
            job.as_raw_handle() as HANDLE,
            &mut member,
        )
    } == 0
    {
        return Err(CliError::Io(std::io::Error::last_os_error()));
    }
    Ok(member != 0)
}
