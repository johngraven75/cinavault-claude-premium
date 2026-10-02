use crate::db::{Database, MediaItem};
use crate::library_unify::{content_fingerprint, group_items};
use crate::AppState;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateFile {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub size: u64,
    pub hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateGroup {
    pub key: String,
    pub count: usize,
    pub total_size: u64,
    pub files: Vec<DuplicateFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateScanResult {
    pub groups: Vec<DuplicateGroup>,
    pub total_wasted_bytes: u64,
    pub scanned_files: usize,
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn calculate_key_hash(key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    bytes_to_hex(&hasher.finalize())
}

pub fn calculate_file_hash(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];

    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }

    Ok(bytes_to_hex(&hasher.finalize()))
}

fn file_name_of(path: &str) -> String {
    path.rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(path)
        .to_string()
}

fn to_duplicate_file(item: &MediaItem) -> DuplicateFile {
    DuplicateFile {
        id: item.id.unwrap_or_default(),
        path: item.file_path.clone(),
        name: if item.title.trim().is_empty() {
            file_name_of(&item.file_path)
        } else {
            item.title.clone()
        },
        size: item.file_size.unwrap_or(0).max(0) as u64,
        hash: None,
    }
}

/// Keys files into candidate groups for every mode except `work`.
fn keyed_groups(
    mode: &str,
    files: Vec<DuplicateFile>,
) -> Result<HashMap<String, Vec<DuplicateFile>>, String> {
    let mut map: HashMap<String, Vec<DuplicateFile>> = HashMap::new();
    match mode {
        "content" => {
            // Only files that share a size can share content; fingerprint those.
            let mut by_size: HashMap<u64, Vec<DuplicateFile>> = HashMap::new();
            for file in files.into_iter().filter(|file| file.size > 0) {
                by_size.entry(file.size).or_default().push(file);
            }
            for (_, same_size) in by_size.into_iter().filter(|(_, f)| f.len() > 1) {
                for mut file in same_size {
                    match content_fingerprint(Path::new(&file.path)) {
                        Ok(fingerprint) => {
                            file.hash = Some(fingerprint.clone());
                            map.entry(format!("content:{fingerprint}"))
                                .or_default()
                                .push(file);
                        }
                        Err(error) => {
                            log::debug!("Skipping unreadable duplicate candidate: {error}")
                        }
                    }
                }
            }
        }
        _ => {
            for file in files {
                let key = match mode {
                    "size" if file.size > 0 => format!("size:{}", file.size),
                    "size" => continue,
                    "name" => format!("name:{}", file.name.trim().to_lowercase()),
                    _ if file.size > 0 => {
                        format!(
                            "name_size:{}_{}",
                            file.name.trim().to_lowercase(),
                            file.size
                        )
                    }
                    _ => continue,
                };
                map.entry(key).or_default().push(file);
            }
        }
    }
    Ok(map)
}

/// Group library copies that duplicate each other.
///
/// Modes: `name_size` (default: same title and byte size), `size`, `name`,
/// `work` (same unified-library work, e.g. a 4K and a 1080p copy of one film),
/// and `content` (same size plus SHA-256 of the first/middle/last 4 MiB).
#[tauri::command]
pub async fn find_duplicates(
    state: State<'_, AppState>,
    mode: Option<String>,
) -> Result<DuplicateScanResult, String> {
    let scan_mode = mode
        .map(|mode| mode.trim().to_ascii_lowercase())
        .filter(|mode| !mode.is_empty())
        .unwrap_or_else(|| "name_size".to_string());
    if !["name_size", "size", "name", "work", "content"].contains(&scan_mode.as_str()) {
        return Err(format!(
            "Unknown duplicate mode '{scan_mode}'. Use name_size, size, name, work or content."
        ));
    }

    let items = {
        let db = state
            .db
            .lock()
            .map_err(|e| format!("Failed to lock DB state: {}", e))?;
        db.get_media_items_data(None, None, None)
            .map_err(|e| e.to_string())?
    };
    let scanned_files = items.len();

    let raw_groups: Vec<(String, Vec<DuplicateFile>)> = if scan_mode == "work" {
        group_items(items)
            .into_iter()
            .filter(|entry| entry.copy_count > 1)
            .map(|entry| {
                let files = entry
                    .copies
                    .iter()
                    .map(|copy| DuplicateFile {
                        id: copy.id,
                        path: copy.file_path.clone(),
                        name: entry.primary.title.clone(),
                        size: copy.file_size.unwrap_or(0).max(0) as u64,
                        hash: None,
                    })
                    .collect();
                (entry.work_key, files)
            })
            .collect()
    } else {
        let files: Vec<DuplicateFile> = items.iter().map(to_duplicate_file).collect();
        let mode = scan_mode.clone();
        tokio::task::spawn_blocking(move || keyed_groups(&mode, files))
            .await
            .map_err(|e| format!("Duplicate scan failed: {e}"))??
            .into_iter()
            .filter(|(_, files)| files.len() > 1)
            .collect()
    };

    let mut groups: Vec<DuplicateGroup> = Vec::new();
    let mut total_wasted_bytes: u64 = 0;
    for (key, files) in raw_groups {
        let count = files.len();
        let total_size: u64 = files.iter().map(|f| f.size).sum();
        // Keeping the largest copy, everything else is reclaimable.
        let kept = files.iter().map(|f| f.size).max().unwrap_or(0);
        total_wasted_bytes += total_size.saturating_sub(kept);
        groups.push(DuplicateGroup {
            key,
            count,
            total_size,
            files,
        });
    }
    groups.sort_by(|a, b| b.total_size.cmp(&a.total_size).then(a.key.cmp(&b.key)));

    Ok(DuplicateScanResult {
        groups,
        total_wasted_bytes,
        scanned_files,
    })
}

#[tauri::command]
pub async fn get_duplicate_groups(
    state: State<'_, AppState>,
    mode: Option<String>,
) -> Result<Vec<DuplicateGroup>, String> {
    let result = find_duplicates(state, mode).await?;
    Ok(result.groups)
}

#[tauri::command]
pub async fn remove_duplicate(state: State<'_, AppState>, item_id: i64) -> Result<bool, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("Failed to lock DB state: {}", e))?;
    remove_duplicate_in(&db, item_id)
}

fn remove_duplicate_in(db: &Database, item_id: i64) -> Result<bool, String> {
    let source_path: Option<String> = db
        .conn
        .query_row(
            "SELECT file_path FROM media_items WHERE id = ?1",
            params![item_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some(path) = source_path {
        // Keep the library row when the file could not be deleted, so the
        // copy stays visible and the caller sees the failure.
        remove_media_file(&PathBuf::from(&path))?;
    }

    db.conn
        .execute("DELETE FROM media_items WHERE id = ?1", params![item_id])
        .map_err(|e| e.to_string())?;

    Ok(true)
}

/// Rename, falling back to copy + delete when the quarantine folder is on a
/// different volume than the media file.
fn move_file(source: &Path, dest: &Path) -> Result<(), String> {
    if std::fs::rename(source, dest).is_ok() {
        return Ok(());
    }
    std::fs::copy(source, dest)
        .map_err(|e| format!("Failed to move {} to quarantine: {e}", source.display()))?;
    std::fs::remove_file(source).map_err(|e| {
        let _ = std::fs::remove_file(dest);
        format!(
            "Failed to remove {} after copying to quarantine: {e}",
            source.display()
        )
    })
}

fn remove_media_file(path: &std::path::Path) -> Result<(), String> {
    if path.is_file() {
        std::fs::remove_file(path)
            .map_err(|e| format!("Failed to delete {}: {}", path.display(), e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn quarantine(state: State<'_, AppState>, item_id: i64) -> Result<String, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("Failed to lock DB state: {}", e))?;
    quarantine_in(&db, &state.app_data_dir.join("quarantine"), item_id)
}

fn quarantine_in(db: &Database, quarantine_dir: &Path, item_id: i64) -> Result<String, String> {
    let source_path: String = db
        .conn
        .query_row(
            "SELECT file_path FROM media_items WHERE id = ?1",
            params![item_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Item {item_id} not found: {e}"))?;

    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err(format!("File does not exist: {}", source.display()));
    }

    std::fs::create_dir_all(quarantine_dir).map_err(|e| e.to_string())?;

    let file_name = source
        .file_name()
        .ok_or_else(|| "Missing file name".to_string())?;
    let mut dest = quarantine_dir.join(file_name);
    if dest.exists() {
        dest = quarantine_dir.join(format!("{item_id}-{}", file_name.to_string_lossy()));
    }

    move_file(&source, &dest)?;

    db.conn
        .execute(
            "UPDATE media_items SET file_path = ?1 WHERE id = ?2",
            params![dest.to_string_lossy().to_string(), item_id],
        )
        .map_err(|e| e.to_string())?;

    Ok(dest.to_string_lossy().to_string())
}

#[cfg(test)]
mod remove_media_file_tests {
    use super::remove_media_file;

    #[test]
    fn deletes_existing_file_and_tolerates_missing_one() {
        let path =
            std::env::temp_dir().join(format!("cinavault-remove-dup-{}.mkv", std::process::id()));
        std::fs::write(&path, b"x").unwrap();
        assert!(remove_media_file(&path).is_ok());
        assert!(!path.exists());
        assert!(remove_media_file(&path).is_ok());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library_unify::test_item;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cinavault-dup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn file(id: i64, name: &str, path: &str, size: u64) -> DuplicateFile {
        DuplicateFile {
            id,
            path: path.into(),
            name: name.into(),
            size,
            hash: None,
        }
    }

    #[test]
    fn name_size_size_and_name_modes() {
        let files = vec![
            file(1, "Movie", "/a/m.mkv", 10),
            file(2, "movie", "/b/m.mkv", 10),
            file(3, "Other", "/c/o.mkv", 10),
            file(4, "Movie", "/d/m.mkv", 20),
        ];
        let groups = keyed_groups("name_size", files.clone()).unwrap();
        assert_eq!(groups["name_size:movie_10"].len(), 2);
        let groups = keyed_groups("size", files.clone()).unwrap();
        assert_eq!(groups["size:10"].len(), 3);
        let groups = keyed_groups("name", files).unwrap();
        assert_eq!(groups["name:movie"].len(), 3);
    }

    #[test]
    fn content_mode_matches_identical_bytes() {
        let dir = temp_dir();
        let paths: Vec<PathBuf> = ["a.mkv", "b.mkv", "c.mkv"]
            .iter()
            .map(|name| dir.join(name))
            .collect();
        std::fs::write(&paths[0], b"0123456789").unwrap();
        std::fs::write(&paths[1], b"0123456789").unwrap();
        std::fs::write(&paths[2], b"9876543210").unwrap();
        let files = paths
            .iter()
            .enumerate()
            .map(|(i, p)| file(i as i64, "x", p.to_str().unwrap(), 10))
            .collect();
        let groups: Vec<_> = keyed_groups("content", files)
            .unwrap()
            .into_iter()
            .filter(|(_, f)| f.len() > 1)
            .collect();
        assert_eq!(groups.len(), 1);
        let ids: Vec<i64> = groups[0].1.iter().map(|f| f.id).collect();
        assert!(ids.contains(&0) && ids.contains(&1));
        assert!(groups[0].1[0].hash.is_some());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn quarantine_and_remove_use_file_path_column() {
        let dir = temp_dir();
        let db = Database::new(dir.join("lib.db").to_str().unwrap()).unwrap();
        let media = dir.join("Movie.mkv");
        std::fs::write(&media, b"x").unwrap();
        let mut item = test_item(0, "Movie", media.to_str().unwrap(), "movie");
        item.id = None;
        let id = db.add_media_item_data(&item).unwrap();

        let moved = quarantine_in(&db, &dir.join("quarantine"), id).unwrap();
        assert!(!media.exists());
        assert!(Path::new(&moved).is_file());
        let stored: String = db
            .conn
            .query_row(
                "SELECT file_path FROM media_items WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, moved);

        assert!(remove_duplicate_in(&db, id).unwrap());
        assert!(!Path::new(&moved).exists());
        let remaining: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM media_items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 0);
        drop(db);
        std::fs::remove_dir_all(dir).ok();
    }
}
