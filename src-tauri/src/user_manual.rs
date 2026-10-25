//! Opens only the bundled manual; callers cannot provide a path or URL.
use std::{io, path::Path};

use tauri::{Manager, path::BaseDirectory};

use crate::error::{Error, Result};

const MANUAL_RESOURCE: &str = "help/user-manual.html";

/// Resolve the installed offline manual and launch it outside the application webview.
#[tauri::command]
pub async fn open_user_manual(app: tauri::AppHandle) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = app
            .path()
            .resolve(MANUAL_RESOURCE, BaseDirectory::Resource)
            .map_err(|cause| Error::Manual(Box::new(cause)))?;
        open_manual(&path, webbrowser::open).map_err(|cause| Error::Manual(Box::new(cause)))
    })
    .await
    .map_err(|cause| Error::Manual(Box::new(cause)))?
}

/// Validate the resource and encode filesystem characters before invoking the browser.
fn open_manual(path: &Path, open_browser: impl FnOnce(&str) -> io::Result<()>) -> io::Result<()> {
    // 1. Reject missing resources, directories and relative paths before opening anything.
    let url = url::Url::from_file_path(path)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Manual path must be absolute"))?;
    if !path.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Manual must be a file",
        ));
    }

    // 2. Pass a file URL to the default browser; do not use the HTML file association.
    open_browser(url.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Installation paths containing Unicode and URL delimiters retain their exact meaning.
    #[test]
    fn encodes_manual_path_for_browser() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("使用手册 #1 & demo.html");
        std::fs::write(&path, "<title>Manual</title>").unwrap();
        open_manual(&path, |target| {
            let parsed = url::Url::parse(target).unwrap();
            assert_eq!(parsed.scheme(), "file");
            assert_eq!(parsed.fragment(), None);
            assert_eq!(parsed.query(), None);
            assert_eq!(parsed.to_file_path().unwrap(), path);
            Ok(())
        })
        .unwrap();
    }

    /// Invalid resources never reach the browser launcher.
    #[test]
    fn rejects_invalid_manual_resources() {
        let directory = tempfile::tempdir().unwrap();
        for path in [
            directory.path(),
            &directory.path().join("missing.html"),
            Path::new("relative.html"),
        ] {
            assert!(open_manual(path, |_| panic!("Browser must not launch")).is_err());
        }
    }

    /// Browser failures remain errors with a cause, while IPC omits local filesystem details.
    #[test]
    fn reports_browser_failure_without_exposing_paths() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("manual.html");
        std::fs::write(&path, "<title>Manual</title>").unwrap();
        let cause =
            open_manual(&path, |_| Err(io::Error::other("private-install-path"))).unwrap_err();
        let error = Error::Manual(Box::new(cause));
        assert!(std::error::Error::source(&error).is_some());
        let public = serde_json::to_string(&error).unwrap();
        assert!(public.contains("无法打开离线手册"));
        assert!(!public.contains("private-install-path"));
    }
}
