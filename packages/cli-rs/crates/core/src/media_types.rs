//! The file types xMatrix names by extension: the same table the Web and the
//! Hub read (`@xmatrix/protocol` media-types.json). Sending, saving and page
//! media all answer from it, so a type added there reaches every client.
use std::path::Path;
use std::sync::LazyLock;

use serde::Deserialize;

#[derive(Deserialize)]
struct Table {
    version: u8,
    types: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    #[serde(rename = "type")]
    mime_type: String,
    #[serde(default)]
    aliases: Vec<String>,
    /// The first is the one a saved copy gets.
    extensions: Vec<String>,
    /// Shown inline in a conversation and handed to a model as an image.
    #[serde(default)]
    image: bool,
    /// Shown inline in a page.
    #[serde(default)]
    page: bool,
}

static TABLE: LazyLock<Table> = LazyLock::new(|| {
    let table: Table =
        serde_json::from_str(include_str!("../../../../protocol/src/media-types.json"))
            .expect("checked-in media type table");
    assert_eq!(table.version, 1);
    table
});

fn by_extension(extension: &str) -> Option<&'static Entry> {
    let extension = extension.to_ascii_lowercase();
    TABLE
        .types
        .iter()
        .find(|entry| entry.extensions.contains(&extension))
}

fn by_type(mime_type: &str) -> Option<&'static Entry> {
    let bare = mime_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    TABLE
        .types
        .iter()
        .find(|entry| entry.mime_type == bare || entry.aliases.contains(&bare))
}

fn name_entry(path: &Path) -> Option<&'static Entry> {
    by_extension(path.extension()?.to_str()?)
}

/// The type a file's extension names, or `application/octet-stream`.
pub fn media_type_for_path(path: &Path) -> &'static str {
    name_entry(path).map_or("application/octet-stream", |entry| entry.mime_type.as_str())
}

/// The type of a file a conversation shows inline as an image (and a model
/// reads as one), by its extension.
pub fn image_media_type_for_path(path: &Path) -> Option<&'static str> {
    name_entry(path)
        .filter(|entry| entry.image)
        .map(|entry| entry.mime_type.as_str())
}

/// The type a page's file is served as, by its extension; `None` for a type
/// pages do not show.
pub fn page_media_type(extension: &str) -> Option<&'static str> {
    by_extension(extension)
        .filter(|entry| entry.page)
        .map(|entry| entry.mime_type.as_str())
}

/// The extension a saved copy gets: the stated type's own, else the name's
/// known one, else `bin`.
pub fn media_extension(mime_type: &str, name: &str) -> &'static str {
    by_type(mime_type)
        .or_else(|| name_entry(Path::new(name)))
        .map_or("bin", |entry| entry.extensions[0].as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entry_answers_the_same_from_each_reader() {
        for entry in &TABLE.types {
            for extension in &entry.extensions {
                let name = format!("file.{}", extension.to_ascii_uppercase());
                assert_eq!(media_type_for_path(Path::new(&name)), entry.mime_type);
                assert_eq!(
                    image_media_type_for_path(Path::new(&name)),
                    entry.image.then_some(entry.mime_type.as_str()),
                );
                assert_eq!(
                    page_media_type(extension),
                    entry.page.then_some(entry.mime_type.as_str())
                );
                assert_eq!(
                    media_extension("application/octet-stream", &name),
                    entry.extensions[0]
                );
            }
            for mime_type in std::iter::once(&entry.mime_type).chain(&entry.aliases) {
                assert_eq!(
                    media_extension(&format!("{mime_type}; charset=utf-8"), "x.bin"),
                    entry.extensions[0]
                );
            }
        }
    }

    #[test]
    fn unknown_files_stay_generic() {
        assert_eq!(
            media_type_for_path(Path::new("blob.bin")),
            "application/octet-stream"
        );
        assert_eq!(
            media_type_for_path(Path::new("logo.svg")),
            "application/octet-stream"
        );
        assert_eq!(image_media_type_for_path(Path::new("photo.avif")), None);
        assert_eq!(media_extension("application/x-unknown", "noext"), "bin");
        assert_eq!(media_extension("audio/mp4", "voice.m4a"), "m4a");
    }
}
