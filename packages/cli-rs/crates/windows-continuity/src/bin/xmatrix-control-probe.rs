#![deny(warnings)]

#[cfg(windows)]
fn main() {
    use xmatrix_windows_continuity::{
        ControlMessage, SUPERVISOR_PROTOCOL_MAJOR, connect_inherited_control_pipe,
    };

    let nonce =
        std::env::var("XMATRIX_SUPERVISOR_TRANSACTION_NONCE").expect("probe transaction nonce");
    let mut control = connect_inherited_control_pipe().expect("probe inherited control pipe");
    control
        .send(&ControlMessage::Hello {
            protocol_major: SUPERVISOR_PROTOCOL_MAJOR,
            nonce: nonce.clone(),
        })
        .expect("probe handshake");
    control
        .send_authenticated(&xmatrix_windows_continuity::AuthenticatedControlFrame {
            protocol_major: SUPERVISOR_PROTOCOL_MAJOR,
            sequence: 1,
            nonce,
            message: ControlMessage::StableReady { hub_epoch: 1 },
        })
        .expect("probe stable receipt");
}

#[cfg(not(windows))]
fn main() {}
