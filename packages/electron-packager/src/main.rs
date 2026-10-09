use anyhow::{ensure, Context, Result};
use std::path::PathBuf;

fn run() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    ensure!(args.next().as_deref() == Some(std::ffi::OsStr::new("pack")),
        "usage: nasti-electron-packager pack <staged-app-dir> <app.asar> [--unpack <relative-path>]...");
    let input = PathBuf::from(args.next().context("missing staged-app-dir")?);
    let output = PathBuf::from(args.next().context("missing app.asar")?);
    let mut unpack = Vec::new();
    while let Some(flag) = args.next() {
        ensure!(flag == "--unpack", "unknown argument: {flag:?}");
        unpack.push(
            args.next()
                .context("missing --unpack path")?
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 unpack path"))?,
        );
    }
    nasti_electron_packager::pack(&input, &output, &unpack)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("pack failed: {error:#}");
        std::process::exit(1);
    }
}
