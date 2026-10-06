/// Output detector for prompt completion detection.
///
/// Analyzes cleaned (ANSI-stripped) terminal output to determine whether the
/// wrapped CLI has settled at an interactive prompt.
use std::time::{Duration, Instant};

use regex::Regex;

#[derive(Debug, Clone)]
pub enum DetectResult {
    Ongoing,
    Done,
}

pub struct OutputDetector {
    prompt_patterns: Vec<Regex>,
    last_output_at: Instant,
    silence_threshold: Duration,
    buffer: String,
}

impl Default for OutputDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl OutputDetector {
    pub fn new() -> Self {
        Self {
            prompt_patterns: vec![
                // Common shell prompts
                Regex::new(r"[$#>%]\s*$").unwrap(),
                // Claude Code ❯ prompt (U+276F)
                Regex::new(r"❯\s*$").unwrap(),
                // Claude Code prompt (legacy)
                Regex::new(r"(?i)claude[>\s]*$").unwrap(),
                // Aider prompt
                Regex::new(r"(?i)aider[>\s]*$").unwrap(),
                // Codex prompt with a text cursor rendered as "_"
                Regex::new(r"^>\s*_?\s*$").unwrap(),
                // Codex ready tip shown once the input box is interactive
                Regex::new(r"(?i)Tip:\s+Paste an image with Ctrl\+V").unwrap(),
                // Generic ">>> " or "> " prompt
                Regex::new(r">{1,3}\s*$").unwrap(),
            ],
            last_output_at: Instant::now(),
            silence_threshold: Duration::from_millis(500),
            buffer: String::new(),
        }
    }

    /// Feed cleaned text from ANSI parser. Returns detection result.
    pub fn feed(&mut self, text: &str) -> DetectResult {
        if text.is_empty() {
            // Check silence timeout — if enough time passed since last output
            if self.last_output_at.elapsed() >= self.silence_threshold && self.has_prompt_tail() {
                self.buffer.clear();
                return DetectResult::Done;
            }
            return DetectResult::Ongoing;
        }

        self.last_output_at = Instant::now();
        self.buffer.push_str(text);

        DetectResult::Ongoing
    }

    /// Returns true if the recent buffer tail contains a prompt line.
    /// Unlike `check_idle`, this does NOT require the silence threshold.
    pub fn has_prompt_tail(&self) -> bool {
        if self.buffer.is_empty() {
            return false;
        }

        self.buffer_tail_lines()
            .into_iter()
            .any(|line| self.prompt_patterns.iter().any(|pat| pat.is_match(&line)))
    }

    fn buffer_tail_lines(&self) -> Vec<String> {
        self.buffer
            .lines()
            .rev()
            .take(6)
            .map(str::trim_end)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect()
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;

    #[test]
    fn detects_shell_prompt() {
        let mut d = OutputDetector::new();
        d.feed("some output\nuser@host:~$ ");
        sleep(Duration::from_millis(600));
        assert!(matches!(d.feed(""), DetectResult::Done));
    }

    #[test]
    fn ongoing_while_producing_output() {
        let mut d = OutputDetector::new();
        assert!(matches!(
            d.feed("building project..."),
            DetectResult::Ongoing
        ));
        assert!(matches!(
            d.feed("compiling module 1"),
            DetectResult::Ongoing
        ));
    }

    #[test]
    fn claude_prompt_detected() {
        let mut d = OutputDetector::new();
        d.feed("Done editing file.\nclaude> ");
        sleep(Duration::from_millis(600));
        assert!(matches!(d.feed(""), DetectResult::Done));
    }

    #[test]
    fn claude_unicode_prompt_detected_before_status_line() {
        let mut d = OutputDetector::new();
        d.feed("Welcome back!\n❯ \n◐ medium · /effort");
        assert!(d.has_prompt_tail());
        sleep(Duration::from_millis(600));
        assert!(matches!(d.feed(""), DetectResult::Done));
    }

    #[test]
    fn codex_prompt_with_cursor_detected() {
        let mut d = OutputDetector::new();
        d.feed("Tip: Paste an image with Ctrl+V to attach it to your next message.\n\n>_");
        assert!(d.has_prompt_tail());
    }

    #[test]
    fn codex_ready_tip_detected() {
        let mut d = OutputDetector::new();
        d.feed("Tip: Paste an image with Ctrl+V to attach it to your next message.");
        assert!(d.has_prompt_tail());
    }
}
