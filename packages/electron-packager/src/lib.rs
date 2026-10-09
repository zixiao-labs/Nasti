use anyhow::{ensure, Context, Result};
use rayon::prelude::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, Metadata};
use std::io::{BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

const BLOCK: usize = 4 * 1024 * 1024;

#[derive(Debug)]
struct Entry {
    relative: String,
    size: u64,
    modified: SystemTime,
    directory: bool,
    executable: bool,
    unpacked: bool,
    integrity: Value,
}

fn relative_path(s: &str) -> Result<()> {
    ensure!(
        !s.is_empty() && !s.contains('\\'),
        "invalid relative path: {s}"
    );
    ensure!(
        s.split('/').all(|p| !p.is_empty() && p != "." && p != "..")
            && Path::new(s)
                .components()
                .all(|c| matches!(c, Component::Normal(_))),
        "invalid relative path: {s}"
    );
    Ok(())
}

fn executable(meta: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o100 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        false
    }
}

fn scan(root: &Path, dir: &Path, unpack: &[String], entries: &mut Vec<Entry>) -> Result<()> {
    let mut children = fs::read_dir(dir)?.collect::<std::io::Result<Vec<_>>>()?;
    children.sort_by_key(|e| e.file_name());
    for child in children {
        let path = child.path();
        let relative = path
            .strip_prefix(root)?
            .to_str()
            .context("non-UTF8 path")?
            .replace(std::path::MAIN_SEPARATOR, "/");
        relative_path(&relative)?;
        let meta = fs::symlink_metadata(&path)?;
        ensure!(
            !(meta.is_dir() && child.file_name() == ".pnpm"),
            "unstaged pnpm layout: {relative}"
        );
        ensure!(
            meta.is_file() || meta.is_dir(),
            "symlink or special file rejected: {relative}"
        );
        ensure!(
            !meta.is_file() || meta.len() <= u32::MAX as u64,
            "file too large: {relative}"
        );
        entries.push(Entry {
            unpacked: unpack
                .iter()
                .any(|p| relative == *p || relative.starts_with(&format!("{p}/"))),
            relative,
            size: meta.len(),
            modified: meta.modified()?,
            directory: meta.is_dir(),
            executable: executable(&meta),
            integrity: Value::Null,
        });
        if meta.is_dir() {
            scan(root, &path, unpack, entries)?;
        }
    }
    Ok(())
}

fn check(root: &Path, entry: &Entry) -> Result<()> {
    let meta = fs::symlink_metadata(root.join(&entry.relative))?;
    ensure!(
        meta.is_file()
            && meta.len() == entry.size
            && meta.modified()? == entry.modified
            && executable(&meta) == entry.executable,
        "source changed: {}",
        entry.relative
    );
    Ok(())
}

// Match @electron/asar 4.0.1's flush: exact block multiples end with an empty hash.
// A fixed 4 MiB buffer per worker; never buffer a complete large file.
fn stream(root: &Path, entry: &Entry, mut output: impl Write) -> Result<Value> {
    check(root, entry)?;
    let mut file = File::open(root.join(&entry.relative))?;
    let capacity = entry.size.clamp(1, BLOCK as u64) as usize;
    let mut buffer = vec![0; capacity];
    let mut whole = Sha256::new();
    let mut blocks = Vec::new();
    let mut total = 0u64;
    loop {
        let mut n = 0;
        while n < capacity {
            let read = file.read(&mut buffer[n..])?;
            if read == 0 {
                break;
            }
            n += read;
        }
        whole.update(&buffer[..n]);
        blocks.push(format!("{:x}", Sha256::digest(&buffer[..n])));
        output.write_all(&buffer[..n])?;
        total += n as u64;
        if n < BLOCK {
            break;
        }
    }
    ensure!(
        total == entry.size,
        "source size changed: {}",
        entry.relative
    );
    check(root, entry)?;
    Ok(
        json!({"algorithm":"SHA256", "hash":format!("{:x}", whole.finalize()),
        "blockSize":BLOCK, "blocks":blocks}),
    )
}

fn node_mut<'a>(tree: &'a mut Value, relative: &str) -> &'a mut Value {
    let mut node = tree;
    for part in relative.split('/') {
        node = node["files"]
            .as_object_mut()
            .unwrap()
            .entry(part)
            .or_insert_with(|| json!({"files":{}}));
    }
    node
}

fn validate_app(root: &Path, entries: &[Entry]) -> Result<()> {
    let files: HashSet<PathBuf> = entries
        .iter()
        .filter(|e| !e.directory)
        .map(|e| PathBuf::from(&e.relative))
        .collect();
    let manifest: Value = serde_json::from_reader(
        File::open(root.join("package.json")).context("staged app needs package.json")?,
    )?;
    ensure!(manifest.is_object(), "package.json must be an object");
    let main = manifest
        .get("main")
        .map(|v| v.as_str().context("main must be a string"))
        .transpose()?
        .unwrap_or("index.js");
    let main = main.strip_prefix("./").unwrap_or(main);
    relative_path(main)?;
    ensure!(
        entries.iter().any(|e| e.relative == main && !e.directory),
        "staged main must name an existing file: {main}"
    );
    validate_dependencies(Path::new(""), &manifest, &files)?;
    for entry in entries
        .iter()
        .filter(|e| !e.directory && e.relative.ends_with("/package.json"))
    {
        let package_dir = Path::new(&entry.relative).parent().unwrap();
        let parent = package_dir.parent().unwrap();
        let is_package = parent.file_name().is_some_and(|n| n == "node_modules")
            || (parent
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with('@'))
                && parent
                    .parent()
                    .and_then(|p| p.file_name())
                    .is_some_and(|n| n == "node_modules"));
        if is_package {
            let manifest: Value = serde_json::from_reader(File::open(root.join(&entry.relative))?)
                .with_context(|| format!("invalid manifest: {}", entry.relative))?;
            ensure!(
                manifest.is_object(),
                "package manifest must be an object: {}",
                entry.relative
            );
            validate_dependencies(package_dir, &manifest, &files)?;
        }
    }
    Ok(())
}

fn validate_dependencies(
    package_dir: &Path,
    manifest: &Value,
    files: &HashSet<PathBuf>,
) -> Result<()> {
    if let Some(deps) = manifest.get("dependencies") {
        for name in deps
            .as_object()
            .context("dependencies must be an object")?
            .keys()
        {
            relative_path(name)?;
            ensure!(
                name.split('/').count() == 1
                    || (name.starts_with('@') && name.split('/').count() == 2),
                "invalid dependency name"
            );
            if manifest
                .get("optionalDependencies")
                .and_then(|v| v.get(name))
                .is_some()
            {
                continue;
            }
            let found = package_dir.ancestors().any(|ancestor| {
                // Node 的 _nodeModulePaths 会跳过 node_modules 本身，不能把
                // node_modules/node_modules 当成可解析的 hoisted 依赖位置。
                if ancestor
                    .file_name()
                    .is_some_and(|name| name == "node_modules")
                {
                    return false;
                }
                let candidate = ancestor
                    .join("node_modules")
                    .join(name)
                    .join("package.json");
                files.contains(&candidate)
            });
            ensure!(
                found,
                "missing staged runtime dependency: {name} required by {}",
                package_dir.display()
            );
        }
    }
    Ok(())
}

/// Archive a staged application without replacing an existing archive or sidecar.
pub fn pack(input: &Path, output: &Path, unpack: &[String]) -> Result<()> {
    // Components remove trailing separators and `.` without following the final
    // symlink. Canonicalization below still permits symlinked system ancestors.
    let input: PathBuf = input.components().collect();
    ensure!(
        !fs::symlink_metadata(&input)?.file_type().is_symlink(),
        "input symlink rejected"
    );
    let root = input.canonicalize()?;
    ensure!(root.is_dir(), "input must be a directory");
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
        .canonicalize()?;
    let name = output.file_name().context("output must name a file")?;
    let destination = parent.join(name);
    let sidecar = parent.join(format!(
        "{}.unpacked",
        name.to_str().context("non-UTF8 output")?
    ));
    ensure!(
        !destination.starts_with(&root)
            && !root.starts_with(&destination)
            && !sidecar.starts_with(&root)
            && !root.starts_with(&sidecar),
        "input/output overlap"
    );
    ensure!(
        fs::symlink_metadata(&destination).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            && fs::symlink_metadata(&sidecar)
                .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound),
        "output or sidecar already exists"
    );
    for path in unpack {
        relative_path(path)?;
    }
    let mut entries = Vec::new();
    scan(&root, &root, unpack, &mut entries)?;
    entries.sort_by(|a, b| a.relative.cmp(&b.relative));
    validate_app(&root, &entries)?;
    for path in unpack {
        ensure!(
            entries.iter().any(|e| &e.relative == path),
            "unpack path not found: {path}"
        );
    }
    let workers = std::thread::available_parallelism()?.get().min(8);
    rayon::ThreadPoolBuilder::new()
        .num_threads(workers)
        .build()?
        .install(|| {
            entries
                .par_iter_mut()
                .filter(|e| !e.directory)
                .try_for_each(|entry| -> Result<()> {
                    entry.integrity = stream(&root, entry, std::io::sink())?;
                    Ok(())
                })
        })?;
    let mut tree = json!({"files":{}});
    let mut offset = 0u64;
    for entry in &entries {
        let node = node_mut(&mut tree, &entry.relative);
        if entry.directory {
            if entry.unpacked {
                node["unpacked"] = json!(true);
            }
        } else {
            *node = json!({"size":entry.size, "integrity":entry.integrity});
            if entry.executable {
                node["executable"] = json!(true);
            }
            if entry.unpacked {
                node["unpacked"] = json!(true);
            } else {
                node["offset"] = json!(offset.to_string());
                offset = offset
                    .checked_add(entry.size)
                    .context("archive size overflow")?;
            }
        }
    }
    let header = serde_json::to_vec(&tree)?;
    let (length, padded, pickle_size) = pickle_lengths(header.len())?;
    let temporary = tempfile::tempdir_in(&parent)?;
    let archive_path = temporary.path().join("archive");
    let staging_sidecar = temporary.path().join("unpacked");
    let mut archive = BufWriter::new(File::create(&archive_path)?);
    for word in [4, pickle_size, pickle_size - 4, length] {
        archive.write_all(&word.to_le_bytes())?;
    }
    archive.write_all(&header)?;
    archive.write_all(&vec![0; (padded - length) as usize])?;
    let has_sidecar = entries.iter().any(|e| e.unpacked);
    if has_sidecar {
        fs::create_dir(&staging_sidecar)?;
    }
    for entry in &entries {
        if entry.directory {
            if entry.unpacked {
                fs::create_dir_all(staging_sidecar.join(&entry.relative))?;
            }
            continue;
        }
        let integrity = if entry.unpacked {
            let path = staging_sidecar.join(&entry.relative);
            fs::create_dir_all(path.parent().unwrap())?;
            let mut file = BufWriter::new(File::create(&path)?);
            let integrity = stream(&root, entry, &mut file)?;
            file.flush()?;
            fs::set_permissions(
                path,
                fs::metadata(root.join(&entry.relative))?.permissions(),
            )?;
            integrity
        } else {
            stream(&root, entry, &mut archive)?
        };
        ensure!(
            integrity == entry.integrity,
            "source contents changed: {}",
            entry.relative
        );
    }
    // Detect ordinary additions/removals and metadata changes before publishing.
    let mut after = Vec::new();
    scan(&root, &root, unpack, &mut after)?;
    after.sort_by(|a, b| a.relative.cmp(&b.relative));
    ensure!(
        after.len() == entries.len()
            && after
                .iter()
                .zip(&entries)
                .all(|(a, b)| a.relative == b.relative
                    && a.directory == b.directory
                    && a.size == b.size
                    && a.modified == b.modified
                    && a.executable == b.executable),
        "source tree changed"
    );
    archive.flush()?;
    archive.get_ref().sync_all()?;
    drop(archive);
    // hard_link is an atomic no-clobber publication on the same filesystem.
    // Sidecar is reserved with create_dir, never renamed over an existing directory.
    if has_sidecar {
        fs::create_dir(&sidecar).context("sidecar appeared during packing")?;
        let publication = (|| -> Result<()> {
            for child in fs::read_dir(&staging_sidecar)? {
                let child = child?;
                fs::rename(child.path(), sidecar.join(child.file_name()))?;
            }
            fs::hard_link(&archive_path, &destination)?;
            Ok(())
        })();
        if publication.is_err() {
            fs::remove_dir_all(&sidecar).context("failed to clean incomplete sidecar")?;
        }
        publication?;
    } else {
        fs::hard_link(&archive_path, &destination)?;
    }
    Ok(())
}

fn pickle_lengths(size: usize) -> Result<(u32, u32, u32)> {
    ensure!(size <= i32::MAX as usize, "ASAR Pickle string exceeds i32");
    let length = u32::try_from(size)?;
    let padded = length.checked_add(3).context("header overflow")? & !3;
    let pickle_size = padded
        .checked_add(8)
        .context("header payload exceeds u32")?;
    Ok((length, padded, pickle_size))
}

#[cfg(feature = "binding")]
pub mod binding;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pickle_length_boundaries_without_allocation() {
        assert_eq!(pickle_lengths(0).unwrap(), (0, 0, 8));
        assert_eq!(
            pickle_lengths(i32::MAX as usize).unwrap(),
            (i32::MAX as u32, 2_147_483_648, 2_147_483_656)
        );
        assert!(pickle_lengths(i32::MAX as usize + 1).is_err());
        assert!(pickle_lengths(u32::MAX as usize).is_err());
    }

    #[test]
    fn reject_escaping_paths() {
        for path in ["", "/x", "../x", "x/../y", "x//y", "x\\y", "./x"] {
            assert!(relative_path(path).is_err(), "{path}");
        }
        assert!(relative_path("嵌套/a.txt").is_ok());
    }

    #[test]
    fn failed_pack_leaves_no_output() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let input = dir.path().join("app");
        fs::create_dir(&input)?;
        let output = dir.path().join("app.asar");
        assert!(pack(&input, &output, &[]).is_err());
        assert!(!output.exists());
        assert!(!dir.path().join("app.asar.unpacked").exists());
        Ok(())
    }

    #[test]
    fn empty_integrity_and_no_clobber() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let input = dir.path().join("app");
        fs::create_dir(&input)?;
        fs::write(input.join("package.json"), r#"{"main":"index.js"}"#)?;
        fs::write(input.join("index.js"), [])?;
        let output = dir.path().join("app.asar");
        pack(&input, &output, &["index.js".into()])?;
        let before = fs::read(&output)?;
        assert!(pack(&input, &output, &[]).is_err());
        assert_eq!(before, fs::read(output)?);
        Ok(())
    }

    #[test]
    fn transitive_runtime_dependencies_must_be_staged() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let input = dir.path().join("app");
        fs::create_dir_all(input.join("node_modules/a"))?;
        fs::write(
            input.join("package.json"),
            r#"{"main":"index.js","dependencies":{"a":"1"}}"#,
        )?;
        fs::write(input.join("index.js"), [])?;
        fs::write(
            input.join("node_modules/a/package.json"),
            r#"{"dependencies":{"b":"1"}}"#,
        )?;
        let output = dir.path().join("app.asar");
        assert!(pack(&input, &output, &[]).is_err());
        assert!(!output.exists());
        fs::create_dir_all(input.join("node_modules/node_modules/b"))?;
        fs::write(input.join("node_modules/node_modules/b/package.json"), "{}")?;
        assert!(pack(&input, &output, &[]).is_err());
        assert!(!output.exists());
        fs::create_dir_all(input.join("node_modules/b"))?;
        fs::write(input.join("node_modules/b/package.json"), "{}")?;
        pack(&input, &output, &[])?;
        Ok(())
    }
}
