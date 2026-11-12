// In-app "SiYuan-style" workbench.
//
// Unlike the generated HTML preview pages (which are an embedded *snapshot*
// rebuilt by html-preview-sync.py), this module scans the workspace on demand
// from Rust and returns live data to the React view. No sync step, no asset://
// reads, no plugin-directory dependency.
//
// The command only returns metadata + markdown bodies. HTML reports are read
// lazily through the existing `read_file_content` IPC so a 500 KB report never
// has to travel through the scan payload.

use chrono::{Local, TimeZone};
use regex::Regex;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_store::StoreBuilder;
use walkdir::WalkDir;

const SKIP_DIRS: [&str; 5] = ["node_modules", "__pycache__", "dist", "reports", ".git"];

// Keep in sync with the three-zone separation discipline: 入口 / 研判信息 /
// 工作日志 / 规则 are markdown notebooks; HTML 报告 is the report viewer.
const NOTEBOOKS: [&str; 5] = ["入口", "研判信息", "工作日志", "规则", "HTML 报告"];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OutlineItem {
    pub level: usize,
    pub text: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchDoc {
    pub id: String,
    /// "md" | "html"
    pub kind: String,
    /// Notebook id, one of NOTEBOOKS.
    pub nb: String,
    /// Sub-group (month for 工作日志, sub-folder for 研判信息).
    pub sub: String,
    pub title: String,
    /// Workspace-relative POSIX path.
    pub path: String,
    /// Absolute path, used for the lazy read_file_content IPC.
    pub abs_path: String,
    pub date: String,
    /// Chinese multi-level tags first, ASCII fallbacks after.
    pub tags: Vec<String>,
    /// Full markdown text; empty for HTML reports (loaded on demand).
    pub body: String,
    pub outline: Vec<OutlineItem>,
    /// Whether the report references external CDN resources.
    pub external: bool,
    pub size: u64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchSnapshot {
    pub docs: Vec<WorkbenchDoc>,
    pub workspace: String,
    pub generated: String,
    pub md_count: usize,
    pub html_count: usize,
    pub notebooks: Vec<String>,
    /// Where the optional `lokus_archive.py` helper lives. Derived from the
    /// current user's home directory so no machine-specific path is baked into
    /// the source tree. The frontend can override it via localStorage.
    pub skills_dir: String,
}

fn default_skills_dir() -> String {
    dirs::home_dir()
        .map(|h| {
            h.join(".workbuddy")
                .join("skills")
                .join("lokus-dual-archive")
                .join("scripts")
        })
        .unwrap_or_else(|| {
            PathBuf::from(".workbuddy")
                .join("skills")
                .join("lokus-dual-archive")
                .join("scripts")
        })
        .to_string_lossy()
        .into_owned()
}

fn resolve_workspace(app: &AppHandle) -> Result<PathBuf, String> {
    let store = StoreBuilder::new(app, PathBuf::from(".settings.dat"))
        .build()
        .map_err(|e| format!("WORKSPACE_STORE: {}", e))?;
    let _ = store.reload();
    let value = store
        .get("last_workspace_path")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .ok_or_else(|| "NO_WORKSPACE: 请先在 Lokus 中打开一个工作区".to_string())?;
    let path = PathBuf::from(&value);
    if !path.is_dir() {
        return Err(format!("NO_WORKSPACE: {} 不是有效目录", value));
    }
    Ok(path)
}

fn notebook_for(rel: &Path) -> (&'static str, String) {
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.is_empty() {
        return ("入口", String::new());
    }
    match parts[0].as_str() {
        "工作日志" if parts.len() > 1 => ("工作日志", parts[1].clone()),
        "研判信息" => (
            "研判信息",
            if parts.len() > 2 {
                parts[1].clone()
            } else {
                String::new()
            },
        ),
        "规则" => ("规则", String::new()),
        _ => ("入口", String::new()),
    }
}

fn date_for(name: &str, fallback: &str, date_re: &Regex) -> String {
    if let Some(c) = date_re.captures(name) {
        return format!("{}-{}-{}", &c[1], &c[2], &c[3]);
    }
    fallback.to_string()
}

fn mtime_date(path: &Path) -> String {
    let secs = fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Local
        .timestamp_opt(secs, 0)
        .single()
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

fn classify_tags(text: &str, tag_line_re: &Regex, token_re: &Regex) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for line in text.lines().take(15) {
        if tag_line_re.is_match(line) {
            for cap in token_re.captures_iter(line) {
                let tag = cap[1].trim().to_string();
                if !tag.is_empty() && !found.contains(&tag) {
                    found.push(tag);
                }
            }
            break;
        }
    }
    // Chinese multi-level tags first, ASCII fallbacks after — matches the
    // archive convention documented in the lokus-dual-archive skill.
    found.sort_by_key(|t| !t.chars().any(|c| c as u32 > 0x2e80));
    found
}

fn outline_of(text: &str, head_re: &Regex) -> Vec<OutlineItem> {
    head_re
        .captures_iter(text)
        .map(|c| OutlineItem {
            level: c[1].len(),
            text: c[2].trim().to_string(),
        })
        .collect()
}

/// Scan the active workspace and return live documents for the workbench view.
#[tauri::command]
pub fn scan_workbench_docs(app: AppHandle) -> Result<WorkbenchSnapshot, String> {
    let root = resolve_workspace(&app)?;

    let date_re = Regex::new(r"(\d{4})-?(\d{2})-?(\d{2})").map_err(|e| e.to_string())?;
    let tag_line_re = Regex::new(r"^(?:\s*#[^\s#]+\s*)+$").map_err(|e| e.to_string())?;
    let token_re = Regex::new(r"#([^\s#]+)").map_err(|e| e.to_string())?;
    let head_re = Regex::new(r"(?m)^(#{1,6})\s+(.+?)\s*$").map_err(|e| e.to_string())?;
    let h1_re = Regex::new(r"(?m)^#\s+(.+?)\s*$").map_err(|e| e.to_string())?;
    let title_re = Regex::new(r"(?is)<title[^>]*>(.*?)</title>").map_err(|e| e.to_string())?;
    let tag_strip_re = Regex::new(r"<[^>]+>").map_err(|e| e.to_string())?;
    let ws_re = Regex::new(r"\s+").map_err(|e| e.to_string())?;
    let external_re =
        Regex::new(r#"(?i)(?:src|href)\s*=\s*["']https?://"#).map_err(|e| e.to_string())?;

    let mut md_docs: Vec<WorkbenchDoc> = Vec::new();
    let mut html_docs: Vec<WorkbenchDoc> = Vec::new();

    let walker = WalkDir::new(&root).into_iter().filter_entry(|e| {
        if e.depth() == 0 {
            return true;
        }
        let name = e.file_name().to_string_lossy();
        !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_ref())
    });

    for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext != "md" && ext != "html" && ext != "htm" {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        // The standalone preview page is a generated shell, never a report.
        if name == "HTML报告预览.html" {
            continue;
        }
        let rel_path = match path.strip_prefix(&root) {
            Ok(p) => p.to_path_buf(),
            Err(_) => continue,
        };
        let rel = rel_path.to_string_lossy().replace('\\', "/");
        let fallback_date = mtime_date(path);
        let date = date_for(&name, &fallback_date, &date_re);
        let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let abs_path = path.to_string_lossy().into_owned();

        if ext == "md" {
            // Skip oversized markdown: the workbench is a reader, not an editor.
            if size > 512 * 1024 {
                continue;
            }
            let text = match fs::read_to_string(path) {
                Ok(t) => t,
                Err(_) => continue,
            };
            if text.trim().is_empty() {
                continue;
            }
            let (nb, sub) = notebook_for(&rel_path);
            let title = h1_re
                .captures(&text)
                .map(|c| c[1].trim().to_string())
                .unwrap_or_else(|| rel_path.file_stem().unwrap_or_default().to_string_lossy().into_owned());
            md_docs.push(WorkbenchDoc {
                id: format!("md:{}", rel),
                kind: "md".to_string(),
                nb: nb.to_string(),
                sub,
                title,
                path: rel.clone(),
                abs_path,
                date,
                tags: classify_tags(&text, &tag_line_re, &token_re),
                body: text.clone(),
                outline: outline_of(&text, &head_re),
                external: false,
                size,
            });
        } else {
            let raw = match fs::read_to_string(path) {
                Ok(t) => t,
                Err(_) => continue,
            };
            let title = title_re
                .captures(&raw)
                .map(|c| {
                    let plain = tag_strip_re.replace_all(&c[1], " ");
                    ws_re.replace_all(plain.trim(), " ").trim().to_string()
                })
                .unwrap_or_default();
            let title = if title.is_empty() {
                rel_path.file_stem().unwrap_or_default().to_string_lossy().into_owned()
            } else {
                title.chars().take(120).collect()
            };
            html_docs.push(WorkbenchDoc {
                id: format!("html:{}", rel),
                kind: "html".to_string(),
                nb: "HTML 报告".to_string(),
                sub: String::new(),
                title,
                path: rel.clone(),
                abs_path,
                date: date.clone(),
                tags: vec![
                    "归档/类型/研判".to_string(),
                    "主题/投资研判".to_string(),
                    "来源/HTML导入".to_string(),
                    "type/report".to_string(),
                    "source/html-import".to_string(),
                    format!("date/{}", date),
                ],
                body: String::new(),
                outline: Vec::new(),
                external: external_re.is_match(&raw),
                size,
            });
        }
    }

    md_docs.sort_by(|a, b| a.path.cmp(&b.path));
    // Newest report first — same ordering rule as html-preview-sync.py.
    html_docs.sort_by(|a, b| b.date.cmp(&a.date).then_with(|| a.title.cmp(&b.title)));

    let md_count = md_docs.len();
    let html_count = html_docs.len();
    let mut docs = md_docs;
    docs.extend(html_docs);

    Ok(WorkbenchSnapshot {
        docs,
        workspace: root.to_string_lossy().into_owned(),
        generated: Local::now().format("%Y-%m-%d %H:%M").to_string(),
        md_count,
        html_count,
        notebooks: NOTEBOOKS.iter().map(|s| s.to_string()).collect(),
        skills_dir: default_skills_dir(),
    })
}

/// Open (or focus) the workbench window. Reuses the Preferences window pattern
/// so the view activates immediately via the `?view=workbench` query param.
#[tauri::command]
pub fn open_workbench_window(app: AppHandle) -> Result<(), String> {
    let label = "workbench";
    if let Some(win) = app.get_webview_window(label) {
        // A window left hidden by a failed close is a zombie: always show first.
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.emit("workbench:refresh", ());
        return Ok(());
    }

    let url = WebviewUrl::App("index.html?view=workbench".into());
    WebviewWindowBuilder::new(&app, label, url)
        .title("Lokus 工作台")
        .inner_size(1360.0, 900.0)
        .min_inner_size(960.0, 620.0)
        .resizable(true)
        .decorations(true)
        .build()
        .map(|_| ())
        .map_err(|e| format!("WORKBENCH_WINDOW: {}", e))
}

/// Explicit close path. The workbench has no native menu, so the window's X is
/// the only affordance; going through a command also lets the toolbar close
/// button work reliably even if the renderer is busy.
#[tauri::command]
pub fn close_workbench_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("workbench") {
        win.destroy().map_err(|e| format!("WORKBENCH_CLOSE: {}", e))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notebook_routes_three_zones() {
        assert_eq!(notebook_for(Path::new("工作日志/2026-11/12.md")).0, "工作日志");
        assert_eq!(notebook_for(Path::new("工作日志/2026-11/12.md")).1, "2026-11");
        assert_eq!(notebook_for(Path::new("研判信息/索引.md")).0, "研判信息");
        assert_eq!(notebook_for(Path::new("规则/SOP.md")).0, "规则");
        assert_eq!(notebook_for(Path::new("00-总入口.md")).0, "入口");
    }

    #[test]
    fn chinese_tags_come_first() {
        let line_re = Regex::new(r"^(?:\s*#[^\s#]+\s*)+$").unwrap();
        let token_re = Regex::new(r"#([^\s#]+)").unwrap();
        let tags = classify_tags("#type/sop #归档/类型/规则 #date/2026-11-12\n", &line_re, &token_re);
        assert_eq!(tags[0], "归档/类型/规则");
        assert!(tags.contains(&"type/sop".to_string()));
    }

    #[test]
    fn date_is_normalised() {
        let re = Regex::new(r"(\d{4})-?(\d{2})-?(\d{2})").unwrap();
        assert_eq!(date_for("20261112-复盘.md", "1999-01-01", &re), "2026-11-12");
        assert_eq!(date_for("2026-11-12.md", "1999-01-01", &re), "2026-11-12");
        assert_eq!(date_for("notes.md", "1999-01-01", &re), "1999-01-01");
    }

    #[test]
    fn skills_dir_is_derived_from_home() {
        let p = default_skills_dir();
        // The path is computed at runtime from the current user's home, so no
        // machine-specific literal needs to live in the source tree. It will
        // legitimately contain the current user name on this machine.
        let home = dirs::home_dir().expect("test environment has a home dir");
        assert!(p.starts_with(&home.to_string_lossy().into_owned()));
        assert!(p.contains("lokus-dual-archive"));
        assert!(p.ends_with("scripts"));
    }
}
