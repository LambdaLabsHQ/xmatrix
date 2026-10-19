//! Images pasted into a page, as an Agent reads and writes the page's text
//! (docs/design/pages-live-document.md §6.6).
//!
//! On the page an image is `![name](xmatrix:page-media/<sha-256>.<extension>)`.
//! Reading the page saves each image on this machine and names it there by its
//! local path, `…/attachment-cache/page-media/<sha-256>.<extension>`, so the
//! Agent's own file tool opens it where it stands in the text. Writing maps
//! such a path back to the page's reference — by its name alone, so a path
//! read on another machine maps too — and leaves out an image of any other
//! local file: an image reaches a page by being pasted into it.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use crate::attachment_cache::attachment_cache_dir;

pub const PAGE_MEDIA_SCHEME: &str = "xmatrix:page-media/";

/// Where a page's images are saved, below the attachment cache.
const LOCAL_DIR: &str = "page-media";

/// An image whose text is still arriving is held this long at most; past it, it is text.
const MAX_HELD_IMAGE: usize = 4096;

/// The type a page's file is served as, by its extension.
pub fn page_media_type(extension: &str) -> Option<&'static str> {
    Some(match extension {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        _ => return None,
    })
}

/// `<sha-256>.<extension>` when `file` names a file pages show.
fn page_media_file_name(file: &str) -> Option<&str> {
    let (hash, extension) = file.split_once('.')?;
    (hash.len() == 64
        && hash
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        && page_media_type(extension).is_some())
    .then_some(file)
}

/// The file (`<sha-256>.<extension>`) a page's image reference names.
pub fn page_media_file(reference: &str) -> Option<&str> {
    page_media_file_name(reference.strip_prefix(PAGE_MEDIA_SCHEME)?)
}

/// Where this machine saves a page's image.
pub fn local_page_media_path(file: &str) -> PathBuf {
    attachment_cache_dir().join(LOCAL_DIR).join(file)
}

/// The page reference a saved image's path stands for, from any machine.
fn reference_for_local(destination: &str) -> Option<String> {
    let path = destination.replace('\\', "/");
    let marker = format!("attachment-cache/{LOCAL_DIR}/");
    let at = path.rfind(&marker)?;
    if at > 0 && !path[..at].ends_with('/') {
        return None;
    }
    page_media_file_name(&path[at + marker.len()..])
        .map(|file| format!("{PAGE_MEDIA_SCHEME}{file}"))
}

/// Whether an image's destination is a file on some machine, not something a page can show:
/// a path (absolute, home-relative, a drive, a share or relative) or a `file:` URL.
fn local_file(destination: &str) -> bool {
    let destination = destination.trim();
    if destination.is_empty() || destination.starts_with('#') || destination.starts_with("//") {
        return false;
    }
    if destination.starts_with(['/', '~', '\\']) {
        return true;
    }
    match destination.find(':') {
        // A URL scheme; one letter before the colon is a drive.
        Some(colon)
            if colon > 1
                && destination.as_bytes()[0].is_ascii_alphabetic()
                && destination[..colon].bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-')
                }) =>
        {
            destination[..colon].eq_ignore_ascii_case("file")
        }
        _ => true,
    }
}

/// What becomes of one image's destination.
enum Destination {
    Keep,
    Replace(String),
    Drop,
}

/// A whole image, `![alt](destination title)`, at the start of a text: byte ranges into it.
struct Image {
    len: usize,
    alt: std::ops::Range<usize>,
    destination: std::ops::Range<usize>,
    /// Between the destination and the closing parenthesis: a title, if any.
    tail: std::ops::Range<usize>,
}

enum Scan {
    Image(Image),
    NotImage,
    /// It may still become an image as more text arrives.
    Incomplete,
}

/// Reads the image `text` starts with (`![`), as far as one line holds it.
fn scan_image(text: &str) -> Scan {
    let Some(close) = text[2..].find([']', '\n']).map(|at| at + 2) else {
        return Scan::Incomplete;
    };
    if text.as_bytes()[close] == b'\n' {
        return Scan::NotImage;
    }
    match text.as_bytes().get(close + 1) {
        None => return Scan::Incomplete,
        Some(b'(') => {}
        Some(_) => return Scan::NotImage,
    }
    let start = close + 2;
    let (destination, after) = if text[start..].starts_with('<') {
        match text[start..].find(['>', '\n']).map(|at| at + start) {
            None => return Scan::Incomplete,
            Some(end) if text.as_bytes()[end] == b'\n' => return Scan::NotImage,
            Some(end) => (start + 1..end, end + 1),
        }
    } else {
        match text[start..].find(|ch: char| ch.is_whitespace() || ch == ')') {
            None => return Scan::Incomplete,
            Some(end) => (start..start + end, start + end),
        }
    };
    match text[after..].find([')', '\n']).map(|at| at + after) {
        None => Scan::Incomplete,
        Some(end) if text.as_bytes()[end] == b'\n' => Scan::NotImage,
        Some(end) => Scan::Image(Image {
            len: end + 1,
            alt: 2..close,
            destination,
            tail: after..end,
        }),
    }
}

/// Text that may arrive in pieces, with each markdown image's destination
/// decided on: an image is held until it is whole, the rest passes at once.
#[derive(Default)]
struct ImageScanner {
    held: String,
}

impl ImageScanner {
    fn push(
        &mut self,
        text: &str,
        end: bool,
        decide: &mut dyn FnMut(&str) -> Destination,
    ) -> String {
        self.held.push_str(text);
        let held = std::mem::take(&mut self.held);
        let mut out = String::with_capacity(held.len());
        let mut at = 0;
        while at < held.len() {
            let rest = &held[at..];
            let Some(start) = rest.find("![") else {
                // A last `!` may open an image the next piece goes on with.
                let keep = usize::from(!end && rest.ends_with('!'));
                out.push_str(&rest[..rest.len() - keep]);
                at = held.len() - keep;
                break;
            };
            out.push_str(&rest[..start]);
            at += start;
            let rest = &held[at..];
            match scan_image(rest) {
                Scan::Image(image) => {
                    match decide(&rest[image.destination.clone()]) {
                        Destination::Keep => out.push_str(&rest[..image.len]),
                        Destination::Drop => {}
                        Destination::Replace(destination) => {
                            let destination = if destination.contains(char::is_whitespace) {
                                format!("<{destination}>")
                            } else {
                                destination
                            };
                            out.push_str(&format!(
                                "![{}]({destination}{})",
                                &rest[image.alt.clone()],
                                &rest[image.tail.clone()]
                            ));
                        }
                    }
                    at += image.len;
                }
                Scan::Incomplete if !end && rest.len() <= MAX_HELD_IMAGE => break,
                Scan::NotImage | Scan::Incomplete => {
                    out.push('!');
                    at += 1;
                }
            }
        }
        self.held = held[at..].to_string();
        out
    }
}

/// Each image destination in a text, in order.
pub fn image_destinations(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    ImageScanner::default().push(text, true, &mut |destination| {
        found.push(destination.to_string());
        Destination::Keep
    });
    found
}

/// Each image the page's text shows from its own files (`<sha-256>.<extension>`), once.
pub fn page_media_images(text: &str) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    for destination in image_destinations(text) {
        if let Some(file) = page_media_file(&destination)
            && !files.iter().any(|seen| seen == file)
        {
            files.push(file.to_string());
        }
    }
    files
}

/// The page's text as the Agent reads it: each image saved on this machine is
/// named by its local path where it stands.
pub fn to_local(text: &str, saved: &HashMap<String, PathBuf>) -> String {
    ImageScanner::default().push(text, true, &mut |destination| {
        page_media_file(destination)
            .and_then(|file| saved.get(file))
            .map_or(Destination::Keep, |path| {
                Destination::Replace(path.display().to_string())
            })
    })
}

/// Text an Agent writes into a page, as the page takes it, whole or in pieces:
/// a saved image's local path is the page's reference again, and an image of
/// any other local file is left out — unless the page already had it
/// (`existing`), so a page written before keeps what it has.
#[derive(Default)]
pub struct ToPage {
    scanner: ImageScanner,
    existing: HashSet<String>,
    refused: Vec<String>,
}

impl ToPage {
    pub fn new(existing: HashSet<String>) -> Self {
        Self {
            existing,
            ..Self::default()
        }
    }

    /// What of `text` can go to the page now.
    pub fn push(&mut self, text: &str) -> String {
        self.step(text, false)
    }

    /// The rest, once the text has ended.
    pub fn finish(&mut self) -> String {
        self.step("", true)
    }

    /// The local files left out so far.
    pub fn refused(&self) -> &[String] {
        &self.refused
    }

    fn step(&mut self, text: &str, end: bool) -> String {
        let Self {
            scanner,
            existing,
            refused,
        } = self;
        scanner.push(text, end, &mut |destination| {
            if let Some(reference) = reference_for_local(destination) {
                Destination::Replace(reference)
            } else if local_file(destination) && !existing.contains(destination) {
                refused.push(destination.to_string());
                Destination::Drop
            } else {
                Destination::Keep
            }
        })
    }
}

/// A whole text an Agent writes into a page, and the local files left out of it.
pub fn to_page(text: &str, existing: HashSet<String>) -> (String, Vec<String>) {
    let mut writing = ToPage::new(existing);
    let mut out = writing.push(text);
    out.push_str(&writing.finish());
    (out, writing.refused)
}

/// What the Agent is told about images of local files it tried to write into a page.
pub fn refused_images_note(refused: &[String]) -> String {
    format!(
        "images of local files do not go into pages (an image reaches a page by being pasted into it in the editor): {}",
        refused.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(byte: char) -> String {
        byte.to_string().repeat(64)
    }

    #[test]
    fn reading_names_saved_images_by_their_local_path_and_writing_maps_them_back() {
        let image = format!("{}.png", hash('a'));
        let video = format!("{}.mp4", hash('b'));
        let page = format!(
            "# Notes\n\n![shot.png](xmatrix:page-media/{image} \"Before\") and `![x](xmatrix:page-media/{video})`\n\n![clip](xmatrix:page-media/{video})\n"
        );
        assert_eq!(page_media_images(&page), vec![image.clone(), video.clone()]);
        // Joined as this platform joins paths: on Windows, its last separator is a backslash.
        let local =
            PathBuf::from("/home/me/.config/xmatrix/attachment-cache/page-media").join(&image);
        let saved = HashMap::from([(image.clone(), local.clone())]);
        let read = to_local(&page, &saved);
        assert!(read.contains(&format!("![shot.png]({} \"Before\")", local.display())));
        assert!(
            read.contains(&format!("![clip](xmatrix:page-media/{video})")),
            "a video stays on the page"
        );
        assert_eq!(to_page(&read, HashSet::new()), (page, Vec::new()));
    }

    #[test]
    fn a_path_saved_on_another_machine_maps_back_by_its_name() {
        let image = format!("{}.webp", hash('c'));
        let written = format!(
            "![a](<C:\\Users\\Jo Ann\\.config\\xmatrix\\attachment-cache\\page-media\\{image}>) ![b](file:///Users/jo/.config/xmatrix/attachment-cache/page-media/{image})"
        );
        assert_eq!(
            to_page(&written, HashSet::new()).0,
            format!("![a](xmatrix:page-media/{image}) ![b](xmatrix:page-media/{image})")
        );
    }

    #[test]
    fn an_image_of_any_other_local_file_is_left_out_unless_the_page_had_it() {
        let written = "Before ![chart](/tmp/chart.png) ![me](~/me.jpg) ![d](C:\\x.png) ![r](./diagram.png) \
             ![f](file:///tmp/a.png) ![ok](https://example.com/a.png) ![data](data:image/png;base64,AA) [link](/tmp/x.txt) after";
        let (page, refused) = to_page(written, HashSet::new());
        assert_eq!(
            page,
            "Before      ![ok](https://example.com/a.png) ![data](data:image/png;base64,AA) [link](/tmp/x.txt) after"
        );
        assert_eq!(
            refused,
            [
                "/tmp/chart.png",
                "~/me.jpg",
                "C:\\x.png",
                "./diagram.png",
                "file:///tmp/a.png"
            ]
        );
        let existing = HashSet::from(["./diagram.png".to_string()]);
        assert_eq!(
            to_page("![r](./diagram.png)", existing),
            ("![r](./diagram.png)".to_string(), Vec::new()),
            "an image the page already showed stays"
        );
    }

    #[test]
    fn written_in_pieces_an_image_is_held_until_it_is_whole() {
        let image = format!("{}.gif", hash('d'));
        let local = format!("/x/attachment-cache/page-media/{image}");
        let text =
            format!("one ![a]({local}) two ![b](/tmp/b.png) three! ![c](https://e.com/c.png)");
        let expected =
            format!("one ![a](xmatrix:page-media/{image}) two  three! ![c](https://e.com/c.png)");
        for size in 1..text.len() {
            let mut writing = ToPage::default();
            let mut out = String::new();
            let mut piece = String::new();
            for ch in text.chars() {
                piece.push(ch);
                if piece.len() >= size {
                    out.push_str(&writing.push(&piece));
                    piece.clear();
                }
            }
            out.push_str(&writing.push(&piece));
            out.push_str(&writing.finish());
            assert_eq!(out, expected, "pieces of {size}");
            assert_eq!(writing.refused(), ["/tmp/b.png"]);
        }
        let mut writing = ToPage::default();
        assert_eq!(writing.push("words and ![an"), "words and ");
        assert_eq!(writing.push(" unfinished image"), "");
        assert_eq!(
            writing.finish(),
            "![an unfinished image",
            "an image never closed is text"
        );
    }
}
