//! User-authored text that the CLI forwards to the Hub: message bodies,
//! channel names and About summaries, page markdown.
//!
//! On Windows, a shell running under a non-UTF-8 ANSI code page (or
//! PowerShell piping with an ASCII `$OutputEncoding`) replaces every character
//! it cannot represent with `?` before xmatrix ever sees the text. The
//! damage is invisible to the CLI except as runs of `?`, so text that looks
//! mangled is refused here instead of being stored. Stdin and files are
//! decoded strictly as UTF-8 for the same reason: a lossy decode would store
//! U+FFFD in place of the author's words.

use std::path::Path;

use crate::error::{self, CliError};

/// Windows code page identifier for UTF-8.
const UTF8_CODE_PAGE: u32 = 65001;
const BYTE_ORDER_MARK: char = '\u{feff}';

/// Where a piece of text entered the process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextSource {
    /// A command-line argument, already converted by the calling shell.
    Argument,
    /// Standard input, encoded by whatever wrote the pipe.
    Stdin,
    /// A file read byte-for-byte from disk; no shell conversion applies.
    File,
}

/// Why a text looks damaged by an encoding conversion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LossyText {
    /// U+FFFD: some decoder already replaced characters it could not read.
    ReplacementCharacter,
    /// Two or more `?` in a row while the shell's code page cannot carry
    /// non-ASCII text.
    QuestionMarkRun { code_page: u32 },
}

/// The process's Windows ANSI code page, or `None` off Windows.
pub fn ansi_code_page() -> Option<u32> {
    #[cfg(windows)]
    {
        // SAFETY: GetACP takes no arguments and only reads process state.
        Some(unsafe { windows_sys::Win32::Globalization::GetACP() })
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Classify `text` given the ANSI code page it may have passed through.
///
/// Conservative by design: `??` is only suspicious when a non-UTF-8 Windows
/// code page could have produced it, and never in text read from a file.
pub fn detect_lossy_text(
    text: &str,
    source: TextSource,
    code_page: Option<u32>,
) -> Option<LossyText> {
    if text.contains(char::REPLACEMENT_CHARACTER) {
        return Some(LossyText::ReplacementCharacter);
    }
    let code_page = code_page.filter(|code_page| *code_page != UTF8_CODE_PAGE)?;
    if source != TextSource::File && text.contains("??") {
        return Some(LossyText::QuestionMarkRun { code_page });
    }
    None
}

/// The UTF-8 routes a command offers besides its arguments, named in the
/// refusal so the author knows how to resend.
#[derive(Clone, Copy, Debug, Default)]
pub struct TextRoutes<'a> {
    /// The command accepts the text on `--stdin`.
    pub stdin: bool,
    /// The command's UTF-8 file flag for this text, such as `--summary-file`.
    pub file_flag: Option<&'a str>,
}

/// Refuse `text` when it looks mangled by the shell's encoding.
///
/// `field` names the input in the error (for example `channel name`).
pub fn ensure_text_intact(
    field: &str,
    text: &str,
    source: TextSource,
    routes: TextRoutes<'_>,
) -> error::Result<()> {
    match detect_lossy_text(text, source, ansi_code_page()) {
        None => Ok(()),
        Some(problem) => Err(CliError::Launch(lossy_text_message(field, problem, routes))),
    }
}

fn lossy_text_message(field: &str, problem: LossyText, routes: TextRoutes<'_>) -> String {
    let cause = match problem {
        LossyText::ReplacementCharacter => format!(
            "The {field} contains U+FFFD (\u{fffd}): characters were already lost by an encoding conversion before xmatrix received them."
        ),
        LossyText::QuestionMarkRun { code_page } => format!(
            "The {field} contains \"??\" and this Windows shell uses ANSI code page {code_page}, not UTF-8: non-ASCII characters (for example Chinese) were most likely replaced with `?` before xmatrix received them."
        ),
    };
    let mut ways = Vec::new();
    if let Some(flag) = routes.file_flag {
        ways.push(format!(
            "write the text to a UTF-8 file and pass `{flag} <path>`"
        ));
    }
    if routes.stdin {
        ways.push(
            "in PowerShell run `$OutputEncoding = [System.Text.UTF8Encoding]::new($false)`, then pipe the text to the command with `--stdin`"
                .to_string(),
        );
    }
    if ways.is_empty() {
        ways.push("run the command again from a shell whose code page is UTF-8".to_string());
    }
    format!(
        "{cause} Nothing was sent. Resend the original text without retyping it into command arguments: {}.",
        ways.join("; or ")
    )
}

/// Decode input bytes strictly as UTF-8, dropping a leading byte order mark.
pub fn decode_utf8_input(bytes: Vec<u8>, origin: &str) -> error::Result<String> {
    let text = String::from_utf8(bytes).map_err(|error| {
        CliError::Launch(format!(
            "{origin} is not valid UTF-8 (invalid byte at offset {}). Save or pipe the text as UTF-8; in PowerShell set `$OutputEncoding = [System.Text.UTF8Encoding]::new($false)` before piping.",
            error.utf8_error().valid_up_to()
        ))
    })?;
    Ok(match text.strip_prefix(BYTE_ORDER_MARK) {
        Some(rest) => rest.to_string(),
        None => text,
    })
}

/// Read all of standard input as strict UTF-8.
pub fn read_stdin_text() -> error::Result<String> {
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut std::io::stdin(), &mut bytes)
        .map_err(|error| CliError::Launch(format!("read stdin: {error}")))?;
    decode_utf8_input(bytes, "stdin")
}

/// Read a UTF-8 text file strictly.
pub fn read_text_file(path: &Path) -> error::Result<String> {
    let bytes = std::fs::read(path)
        .map_err(|error| CliError::Launch(format!("read {}: {error}", path.display())))?;
    decode_utf8_input(bytes, &path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GBK: Option<u32> = Some(936);

    #[test]
    fn question_mark_runs_are_refused_only_under_non_utf8_windows_code_pages() {
        let mangled = "??Hub???????????";
        assert_eq!(
            detect_lossy_text(mangled, TextSource::Argument, GBK),
            Some(LossyText::QuestionMarkRun { code_page: 936 })
        );
        assert_eq!(
            detect_lossy_text(mangled, TextSource::Stdin, Some(1252)),
            Some(LossyText::QuestionMarkRun { code_page: 1252 })
        );
        // Linux/macOS (no code page) and Windows with the UTF-8 code page.
        assert_eq!(detect_lossy_text(mangled, TextSource::Argument, None), None);
        assert_eq!(
            detect_lossy_text(mangled, TextSource::Stdin, Some(UTF8_CODE_PAGE)),
            None
        );
    }

    #[test]
    fn single_question_marks_and_file_text_pass() {
        assert_eq!(
            detect_lossy_text("Is it ready? Yes? Ok.", TextSource::Argument, GBK),
            None
        );
        assert_eq!(detect_lossy_text("really??", TextSource::File, GBK), None);
        assert_eq!(
            detect_lossy_text("频道 About", TextSource::Argument, GBK),
            None
        );
    }

    #[test]
    fn replacement_characters_are_refused_everywhere() {
        for source in [TextSource::Argument, TextSource::Stdin, TextSource::File] {
            for code_page in [None, Some(UTF8_CODE_PAGE), GBK] {
                assert_eq!(
                    detect_lossy_text("broken \u{fffd} text", source, code_page),
                    Some(LossyText::ReplacementCharacter)
                );
            }
        }
    }

    #[test]
    fn refusal_names_the_field_and_the_utf8_routes() {
        let mangled = LossyText::QuestionMarkRun { code_page: 936 };
        let file_only = lossy_text_message(
            "channel name",
            mangled,
            TextRoutes {
                stdin: false,
                file_flag: Some("--name-file"),
            },
        );
        assert!(file_only.contains("channel name"));
        assert!(file_only.contains("code page 936"));
        assert!(file_only.contains("Nothing was sent"));
        assert!(file_only.contains("`--name-file <path>`"));
        assert!(!file_only.contains("--stdin"));

        let stdin_only = lossy_text_message(
            "message",
            LossyText::ReplacementCharacter,
            TextRoutes {
                stdin: true,
                file_flag: None,
            },
        );
        assert!(stdin_only.contains("U+FFFD"));
        assert!(stdin_only.contains("$OutputEncoding = [System.Text.UTF8Encoding]::new($false)"));
        assert!(stdin_only.contains("`--stdin`"));
        assert!(!stdin_only.contains("UTF-8 file"));

        let neither = lossy_text_message("channel name", mangled, TextRoutes::default());
        assert!(neither.contains("shell whose code page is UTF-8"));
    }

    #[test]
    fn ensure_text_intact_passes_ordinary_text_on_this_platform() {
        let routes = TextRoutes::default();
        ensure_text_intact("message", "中文 summary", TextSource::Argument, routes).unwrap();
        assert!(ensure_text_intact("message", "a\u{fffd}b", TextSource::File, routes).is_err());
    }

    #[test]
    fn utf8_input_is_decoded_strictly() {
        assert_eq!(
            decode_utf8_input("中文".as_bytes().to_vec(), "stdin").unwrap(),
            "中文"
        );
        // GBK bytes for 中文 are not UTF-8: refuse instead of storing U+FFFD.
        let error = decode_utf8_input(vec![0xd6, 0xd0, 0xce, 0xc4], "stdin").unwrap_err();
        let message = error.to_string();
        assert!(message.contains("stdin is not valid UTF-8"), "{message}");
        assert!(message.contains("offset 0"), "{message}");
    }

    #[test]
    fn utf8_input_drops_a_leading_byte_order_mark() {
        let mut bytes = vec![0xef, 0xbb, 0xbf];
        bytes.extend_from_slice("频道".as_bytes());
        assert_eq!(decode_utf8_input(bytes, "file").unwrap(), "频道");
    }

    #[test]
    fn text_files_are_read_strictly() {
        let dir = std::env::temp_dir().join(format!("xmatrix-text-input-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let good = dir.join("good.txt");
        std::fs::write(&good, "\u{feff}频道简介").unwrap();
        assert_eq!(read_text_file(&good).unwrap(), "频道简介");
        let bad = dir.join("bad.txt");
        std::fs::write(&bad, [b'a', 0xff]).unwrap();
        let message = read_text_file(&bad).unwrap_err().to_string();
        assert!(message.contains("not valid UTF-8"), "{message}");
        assert!(read_text_file(&dir.join("missing.txt")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
