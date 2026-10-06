//! Kitty Keyboard Protocol (KKP) helpers.
//!
//! xmat wraps other TUIs in a PTY. Some of them — notably codex — push KKP
//! (`\x1b[>Nu`) on startup and then expect Enter to arrive as `\x1b[13u`
//! instead of raw `\r`. We need to (a) observe downstream push/pop/set so we
//! know the active flags, (b) parse KKP key CSIs that the user's terminal
//! sends back, and (c) encode Enter correctly when we inject text ourselves.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KkpControl {
    Push(u32),
    Pop(u16),
    Set(u32),
}

/// Streaming scanner that detects `\x1b[>Nu`, `\x1b[=N[;M]u`, `\x1b[<[N]u`
/// inside a byte stream, buffering partial CSI sequences across calls.
pub struct KkpScanner {
    pending: Vec<u8>,
}

impl KkpScanner {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    pub fn scan(&mut self, bytes: &[u8]) -> Vec<KkpControl> {
        let mut out = Vec::new();
        let mut i = 0;

        while i < bytes.len() {
            let b = bytes[i];

            if self.pending.is_empty() {
                if b == 0x1b {
                    self.pending.push(b);
                }
                i += 1;
                continue;
            }

            if self.pending.len() == 1 {
                if b == b'[' {
                    self.pending.push(b);
                    i += 1;
                    continue;
                }
                self.pending.clear();
                continue;
            }

            self.pending.push(b);
            i += 1;

            if matches!(b, 0x40..=0x7e) {
                if b == b'u'
                    && let Some(ctrl) = parse_kkp_control(&self.pending)
                {
                    out.push(ctrl);
                }
                self.pending.clear();
            }

            if self.pending.len() > 256 {
                self.pending.clear();
            }
        }

        out
    }
}

impl Default for KkpScanner {
    fn default() -> Self {
        Self::new()
    }
}

fn parse_kkp_control(csi: &[u8]) -> Option<KkpControl> {
    if csi.len() < 3 || csi[0] != 0x1b || csi[1] != b'[' || csi[csi.len() - 1] != b'u' {
        return None;
    }
    let params = &csi[2..csi.len() - 1];
    if params.is_empty() {
        return None;
    }

    match params[0] {
        b'>' => {
            let text = std::str::from_utf8(&params[1..]).ok()?;
            let num: u32 = text.trim().parse().ok()?;
            Some(KkpControl::Push(num))
        }
        b'=' => {
            let rest = &params[1..];
            let first_end = rest.iter().position(|&b| b == b';').unwrap_or(rest.len());
            let text = std::str::from_utf8(&rest[..first_end]).ok()?;
            let num: u32 = text.trim().parse().ok()?;
            Some(KkpControl::Set(num))
        }
        b'<' => {
            let rest = &params[1..];
            if rest.is_empty() {
                Some(KkpControl::Pop(1))
            } else {
                let text = std::str::from_utf8(rest).ok()?;
                let n: u16 = text.trim().parse().ok()?;
                Some(KkpControl::Pop(n))
            }
        }
        _ => None,
    }
}

/// Encode an Enter press for the current downstream KKP state. flags==0 (KKP
/// disabled) yields raw `\r`; any non-zero flags yield the KKP-encoded form.
#[cfg_attr(windows, allow(dead_code))]
pub fn encode_enter(flags: u32) -> &'static [u8] {
    if flags == 0 { b"\r" } else { b"\x1b[13u" }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_push_pop_set() {
        let mut s = KkpScanner::new();
        let events = s.scan(b"hello \x1b[>7u world \x1b[<u tail \x1b[=5;1u end");
        assert_eq!(
            events,
            vec![KkpControl::Push(7), KkpControl::Pop(1), KkpControl::Set(5),]
        );
    }

    #[test]
    fn scans_pop_with_explicit_count() {
        let mut s = KkpScanner::new();
        let events = s.scan(b"\x1b[<3u");
        assert_eq!(events, vec![KkpControl::Pop(3)]);
    }

    #[test]
    fn ignores_non_u_csi() {
        let mut s = KkpScanner::new();
        let events = s.scan(b"\x1b[>0c\x1b[H\x1b[?25h");
        assert!(events.is_empty());
    }

    #[test]
    fn continues_partial_esc_across_calls() {
        let mut s = KkpScanner::new();
        assert!(s.scan(b"\x1b").is_empty());
        assert!(s.scan(b"[>").is_empty());
        let events = s.scan(b"7u");
        assert_eq!(events, vec![KkpControl::Push(7)]);
    }

    #[test]
    fn continues_partial_csi_across_calls() {
        let mut s = KkpScanner::new();
        assert!(s.scan(b"\x1b[>1").is_empty());
        let events = s.scan(b"2u");
        assert_eq!(events, vec![KkpControl::Push(12)]);
    }

    #[test]
    fn resets_after_bogus_escape() {
        let mut s = KkpScanner::new();
        // ESC followed by a non-[ should abandon and still find the next one.
        let events = s.scan(b"\x1bZ\x1b[>7u");
        assert_eq!(events, vec![KkpControl::Push(7)]);
    }

    #[test]
    fn encode_enter_follows_flags() {
        assert_eq!(encode_enter(0), b"\r");
        assert_eq!(encode_enter(1), b"\x1b[13u");
        assert_eq!(encode_enter(7), b"\x1b[13u");
    }
}
