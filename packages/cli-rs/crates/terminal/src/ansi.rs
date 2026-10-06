/// VT100 ANSI escape sequence parser / stripper.
///
/// Implements a finite state machine that strips ANSI control sequences
/// from terminal output, yielding clean plaintext suitable for forwarding
/// to LLMs or structured logs.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Ground,
    Escape,
    CsiEntry,
    CsiParam,
    OscString,
    DcsPassthrough,
    /// Collecting continuation bytes of a multi-byte UTF-8 character.
    Utf8 {
        remaining: u8,
    },
}

#[derive(Debug)]
pub struct AnsiParser {
    state: State,
    /// Accumulator for multi-byte UTF-8 sequences.
    utf8_buf: [u8; 4],
    utf8_len: u8,
}

impl Default for AnsiParser {
    fn default() -> Self {
        Self::new()
    }
}

impl AnsiParser {
    pub fn new() -> Self {
        Self {
            state: State::Ground,
            utf8_buf: [0; 4],
            utf8_len: 0,
        }
    }

    /// Feed raw bytes from PTY stdout; returns cleaned plaintext.
    pub fn feed(&mut self, input: &[u8]) -> String {
        let mut out = String::with_capacity(input.len());

        for &byte in input {
            match self.state {
                State::Utf8 { remaining } => {
                    if byte & 0xC0 == 0x80 {
                        // Valid continuation byte
                        self.utf8_buf[self.utf8_len as usize] = byte;
                        self.utf8_len += 1;
                        if remaining == 1 {
                            // Sequence complete — decode and emit
                            if let Ok(s) =
                                std::str::from_utf8(&self.utf8_buf[..self.utf8_len as usize])
                            {
                                out.push_str(s);
                            }
                            self.utf8_len = 0;
                            self.state = State::Ground;
                        } else {
                            self.state = State::Utf8 {
                                remaining: remaining - 1,
                            };
                        }
                    } else {
                        // Broken UTF-8 — discard accumulated bytes, reprocess this byte
                        self.utf8_len = 0;
                        self.state = State::Ground;
                        // Re-feed current byte through Ground state
                        self.feed_ground_byte(byte, &mut out);
                    }
                }
                State::Ground => {
                    self.feed_ground_byte(byte, &mut out);
                }
                State::Escape => match byte {
                    b'[' => self.state = State::CsiEntry,
                    b']' => self.state = State::OscString,
                    b'P' => self.state = State::DcsPassthrough,
                    // Two-char sequences: ESC followed by one of these
                    b'(' | b')' | b'*' | b'+' | b'#' => {
                        // Next byte is the designator — skip it too
                        self.state = State::Ground;
                    }
                    // Single-char ESC sequences (e.g., ESC M, ESC D, ESC E, ESC 7, ESC 8)
                    _ => self.state = State::Ground,
                },
                State::CsiEntry => {
                    if (0x30..=0x3f).contains(&byte) {
                        // Parameter byte (digits, semicolons, ?, >, etc.)
                        self.state = State::CsiParam;
                    } else if (0x40..=0x7e).contains(&byte) {
                        // Final byte — sequence complete
                        self.state = State::Ground;
                    } else if (0x20..=0x2f).contains(&byte) {
                        // Intermediate byte
                        self.state = State::CsiParam;
                    }
                    // else stay in CsiEntry
                }
                State::CsiParam => {
                    if (0x40..=0x7e).contains(&byte) {
                        // Final byte — sequence complete
                        self.state = State::Ground;
                    }
                    // else keep consuming parameter/intermediate bytes
                }
                State::OscString => {
                    // OSC is terminated by BEL (0x07) or ST (ESC \)
                    if byte == 0x07 {
                        self.state = State::Ground;
                    } else if byte == 0x1b {
                        // Might be ESC \ (ST) — but we just go back to Escape
                        // which will handle the \ as a single-char sequence
                        self.state = State::Escape;
                    }
                    // else keep consuming OSC payload
                }
                State::DcsPassthrough => {
                    // DCS is terminated by ST (ESC \) or BEL
                    if byte == 0x1b {
                        self.state = State::Escape;
                    } else if byte == 0x07 {
                        self.state = State::Ground;
                    }
                }
            }
        }

        out
    }

    /// Process a single byte in Ground state.
    fn feed_ground_byte(&mut self, byte: u8, out: &mut String) {
        if byte == 0x1b {
            self.state = State::Escape;
        } else if byte == b'\n' || byte == b'\r' || byte == b'\t' {
            out.push(byte as char);
        } else if (0x20..=0x7e).contains(&byte) {
            // Printable ASCII
            out.push(byte as char);
        } else if byte & 0xE0 == 0xC0 {
            // UTF-8 2-byte lead (110xxxxx)
            self.utf8_buf[0] = byte;
            self.utf8_len = 1;
            self.state = State::Utf8 { remaining: 1 };
        } else if byte & 0xF0 == 0xE0 {
            // UTF-8 3-byte lead (1110xxxx) — covers ❯ U+276F
            self.utf8_buf[0] = byte;
            self.utf8_len = 1;
            self.state = State::Utf8 { remaining: 2 };
        } else if byte & 0xF8 == 0xF0 {
            // UTF-8 4-byte lead (11110xxx) — emoji etc.
            self.utf8_buf[0] = byte;
            self.utf8_len = 1;
            self.state = State::Utf8 { remaining: 3 };
        }
        // All other bytes (C0 controls 0x00-0x1f, DEL 0x7f, bare
        // continuation bytes 0x80-0xBF) are swallowed.
    }

    /// Feed a UTF-8 string (convenience wrapper).
    #[allow(dead_code)]
    pub fn feed_str(&mut self, input: &str) -> String {
        self.feed(input.as_bytes())
    }

    /// Reset parser to initial state.
    #[allow(dead_code)]
    pub fn reset(&mut self) {
        self.state = State::Ground;
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_passthrough() {
        let mut p = AnsiParser::new();
        assert_eq!(p.feed_str("hello world"), "hello world");
    }

    #[test]
    fn strips_sgr_color_codes() {
        let mut p = AnsiParser::new();
        // \x1b[31m = red, \x1b[0m = reset
        assert_eq!(
            p.feed_str("\x1b[31mERROR\x1b[0m: something"),
            "ERROR: something"
        );
    }

    #[test]
    fn strips_cursor_movement() {
        let mut p = AnsiParser::new();
        // \x1b[2J = clear screen, \x1b[H = cursor home
        assert_eq!(p.feed_str("\x1b[2J\x1b[Hhello"), "hello");
    }

    #[test]
    fn strips_osc_title() {
        let mut p = AnsiParser::new();
        // OSC 0 ; title BEL
        assert_eq!(p.feed_str("\x1b]0;my terminal\x07prompt$ "), "prompt$ ");
    }

    #[test]
    fn preserves_newlines_and_tabs() {
        let mut p = AnsiParser::new();
        assert_eq!(p.feed_str("line1\nline2\ttab"), "line1\nline2\ttab");
    }

    #[test]
    fn strips_c0_control_chars() {
        let mut p = AnsiParser::new();
        assert_eq!(p.feed_str("hel\x08\x08lo"), "hello");
    }

    #[test]
    fn strips_bold_and_256_color() {
        let mut p = AnsiParser::new();
        // Bold + 256-color: \x1b[1;38;5;202m
        assert_eq!(p.feed_str("\x1b[1;38;5;202mORANGE\x1b[0m"), "ORANGE");
    }

    #[test]
    fn complex_mixed_output() {
        let mut p = AnsiParser::new();
        let input = "\x1b]0;user@host:~\x07\x1b[32muser\x1b[0m@\x1b[34mhost\x1b[0m:~$ ls\n\x1b[1;34mdir1\x1b[0m  file.txt\n";
        let expected = "user@host:~$ ls\ndir1  file.txt\n";
        assert_eq!(p.feed_str(input), expected);
    }

    #[test]
    fn handles_incomplete_sequence() {
        let mut p = AnsiParser::new();
        // Feed ESC [ in one chunk, then the rest in another
        assert_eq!(p.feed_str("\x1b["), "");
        assert_eq!(p.feed_str("31mhello\x1b[0m"), "hello");
    }

    #[test]
    fn dcs_passthrough_stripped() {
        let mut p = AnsiParser::new();
        // DCS ... ST
        assert_eq!(p.feed_str("\x1bPsome data\x1b\\hello"), "hello");
    }

    #[test]
    fn preserves_unicode_characters() {
        let mut p = AnsiParser::new();
        // ❯ is U+276F, UTF-8: E2 9D AF (3 bytes)
        assert_eq!(p.feed_str("❯ "), "❯ ");
    }

    #[test]
    fn unicode_with_ansi_codes() {
        let mut p = AnsiParser::new();
        assert_eq!(p.feed_str("\x1b[32m❯\x1b[0m prompt"), "❯ prompt");
    }

    #[test]
    fn unicode_split_across_chunks() {
        let mut p = AnsiParser::new();
        // Feed ❯ (E2 9D AF) one byte at a time
        assert_eq!(p.feed(&[0xE2]), "");
        assert_eq!(p.feed(&[0x9D]), "");
        assert_eq!(p.feed(&[0xAF, b' ']), "❯ ");
    }

    #[test]
    fn preserves_emoji_4byte() {
        let mut p = AnsiParser::new();
        // 🚀 is U+1F680, 4-byte UTF-8
        assert_eq!(p.feed_str("🚀 launch"), "🚀 launch");
    }
}
