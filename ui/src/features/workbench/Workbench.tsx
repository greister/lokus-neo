/** @part-of ui.workbench
 * Lokus Neo workbench: a Siyuan-style reading desk over the current vault.
 * It uses only commands the v2 core already provides (vault.tree, tags.list,
 * search.query, note.read) and the v2 read-only markdown renderer, so it needs
 * no Rust changes and stays in step with upstream.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { runCore } from "../../bridge/core";
import { renderMarkdown } from "../../shell/workspace";
import "./workbench.css";

interface Entry {
  name: string;
  path: string;
  kind: "folder" | "note" | "file";
  children: Entry[];
}

interface Hit {
  path: string;
  title: string;
  snippet: string;
}

interface Note {
  path: string;
  title: string;
  text: string;
  hash?: string;
}

type Panel = "tree" | "tags" | "search";

const LS_KEY = "lokus.wb";

function saved<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${LS_KEY}.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function remember(key: string, value: unknown): void {
  try {
    localStorage.setItem(`${LS_KEY}.${key}`, JSON.stringify(value));
  } catch {
    /* storage disabled */
  }
}

/** The notebooks mirror the vault's own top-level folders, plus a root-entry group. */
function notebooksOf(entries: Entry[]): Entry[] {
  const folders = entries.filter((e) => e.kind === "folder");
  const order = ["00_收件箱", "10_Daily", "20_Project", "25_交易日记", "研判信息", "规则", "工作日志"];
  return [...folders].sort((a, b) => {
    const ai = order.indexOf(a.name);
    const bi = order.indexOf(b.name);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.name.localeCompare(b.name, "zh-CN");
  });
}

function isReport(path: string): boolean {
  return /\.html?$/i.test(path);
}

function childrenFlatten(node: Entry, out: Entry[] = []): Entry[] {
  for (const child of node.children ?? []) {
    if (child.kind !== "folder") out.push(child);
    else childrenFlatten(child, out);
  }
  return out;
}

export function Workbench() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [tags, setTags] = useState<[string, number][]>([]);
  const [panel, setPanel] = useState<Panel>(() => saved("panel", "tree" as Panel));
  const [selected, setSelected] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [note, setNote] = useState<Note | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => saved("collapsed", {}));
  const [fontSize, setFontSize] = useState<number>(() => saved("font", 15));
  const [dark, setDark] = useState<boolean>(() => saved("dark", false));
  const [showRight, setShowRight] = useState<boolean>(() => saved("right", true));
  const [problem, setProblem] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    Promise.all([
      runCore<Entry[]>("vault.tree"),
      runCore<[string, number][]>("tags.list"),
    ]).then(
      ([tree, tagList]) => {
        setEntries(tree);
        setTags(tagList);
        setProblem("");
      },
      (e) => setProblem(e instanceof Error ? e.message : String(e)),
    );
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => remember("panel", panel), [panel]);
  useEffect(() => remember("collapsed", collapsed), [collapsed]);
  useEffect(() => remember("font", fontSize), [fontSize]);
  useEffect(() => remember("dark", dark), [dark]);
  useEffect(() => remember("right", showRight), [showRight]);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      runCore<Hit[]>("search.query", { q: query, limit: 60 }).then(
        (r) => live && setHits(r),
        () => live && setHits([]),
      );
    }, 180);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const open = useCallback((path: string) => {
    setSelected(path);
    if (isReport(path)) {
      setNote(null);
      runCore<{ base64: string }>("file.read", { path }).then(
        (f) => {
          const bin = atob(f.base64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          setReport(new TextDecoder("utf-8").decode(bytes));
        },
        (e) => setProblem(e instanceof Error ? e.message : String(e)),
      );
      return;
    }
    setReport(null);
    runCore<Note>("note.read", { path }).then(
      (n) => setNote(n),
      (e) => setProblem(e instanceof Error ? e.message : String(e)),
    );
  }, []);

  useEffect(() => {
    if (!note || !bodyRef.current) return;
    const el = bodyRef.current;
    el.innerHTML = "";
    const destroy = renderMarkdown(el, note.text);
    return () => destroy();
  }, [note]);

  const notebooks = useMemo(() => notebooksOf(entries), [entries]);

  /** Clicking a tag runs a full-text search for it, reusing v2's indexed search. */
  const filterTag = useCallback((tag: string) => {
    setActiveTag((current) => (current === tag ? null : tag));
    setQuery((current) => (current === `#${tag}` ? "" : `#${tag}`));
    setPanel("search");
  }, []);

  const renderNode = (node: Entry, depth: number) => {
    if (node.kind === "folder") {
      const isOpen = !collapsed[node.path];
      const kids = childrenFlatten(node).filter((e) => !activeTag || e.path.toLowerCase().endsWith(".md"));
      return (
        <div key={node.path}>
          <button
            className="wb-folder"
            style={{ paddingLeft: 10 + depth * 12 }}
            onClick={() => setCollapsed((c) => ({ ...c, [node.path]: isOpen }))}
          >
            <span className="wb-arrow">{isOpen ? "▾" : "▸"}</span>
            <span>{node.name}</span>
            <span className="wb-count">{kids.length}</span>
          </button>
          {isOpen && node.children.map((c) => renderNode(c, depth + 1))}
        </div>
      );
    }
    return (
      <button
        key={node.path}
        className={`wb-doc${selected === node.path ? " active" : ""}`}
        style={{ paddingLeft: 14 + depth * 12 }}
        onClick={() => open(node.path)}
        title={node.path}
      >
        <span className="wb-dot">{isReport(node.path) ? "▧" : "·"}</span>
        <span className="wb-t">{node.name}</span>
      </button>
    );
  };

  return (
    <div className={`wb-root${dark ? " dark" : ""}`}>
      <header className="wb-top">
        <span className="wb-brand">思源工作台</span>
        <span className="wb-sep" />
        <button className={panel === "tree" ? "on" : ""} onClick={() => setPanel("tree")}>文档树</button>
        <button className={panel === "tags" ? "on" : ""} onClick={() => setPanel("tags")}>标签</button>
        <button className={panel === "search" ? "on" : ""} onClick={() => setPanel("search")}>搜索</button>
        <span className="wb-spacer" />
        <button onClick={() => setFontSize((n) => Math.min(24, n + 1))} title="放大字号">A+</button>
        <button onClick={() => setFontSize((n) => Math.max(11, n - 1))} title="缩小字号">A−</button>
        <button onClick={() => setDark((d) => !d)} title="切换主题">{dark ? "☀" : "☾"}</button>
        <button className={showRight ? "on" : ""} onClick={() => setShowRight((s) => !s)} title="显示/隐藏右栏">▥</button>
        <button onClick={refresh} title="刷新">↻</button>
      </header>

      <div className="wb-body">
        <aside className="wb-sidebar">
          {panel === "tags" ? (
            <>
              <div className="wb-side-head">标签</div>
              <div className="wb-side-body">
                {tags.map(([tag, count]) => (
                  <button
                    key={tag}
                    className={`wb-tag${activeTag === tag ? " active" : ""}`}
                    onClick={() => filterTag(tag)}
                  >
                    <span className="wb-dot" />#{tag}<span className="wb-count">{count}</span>
                  </button>
                ))}
              </div>
            </>
          ) : panel === "search" ? (
            <>
              <div className="wb-side-head">搜索</div>
              <div className="wb-search"><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="全文搜索…" autoFocus /></div>
              <div className="wb-side-body">
                {hits.map((h) => (
                  <button key={h.path} className={`wb-doc${selected === h.path ? " active" : ""}`} onClick={() => open(h.path)} title={h.path}>
                    <span className="wb-t">{h.title || h.path}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="wb-side-head">笔记本</div>
              <div className="wb-side-body">{notebooks.map((nb) => renderNode(nb, 0))}</div>
            </>
          )}
        </aside>

        <main className="wb-main">
          {selected && (
            <div className="wb-breadcrumb">
              {selected.split("/").map((part, i, arr) => (
                <span key={i}>{i ? " / " : ""}{i === arr.length - 1 ? part.replace(/\.md$/i, "") : part}</span>
              ))}
            </div>
          )}
          {report !== null ? (
            <iframe className="wb-report" title={selected ?? "report"} sandbox="allow-scripts allow-forms allow-popups allow-modals" srcDoc={report} />
          ) : note ? (
            <div className="wb-content" ref={bodyRef} style={{ fontSize: `${fontSize}px` }} />
          ) : (
            <div className="wb-empty">
              <div className="wb-empty-mark">◇</div>
              <p>从左侧选一篇文档开始阅读</p>
              {problem && <p className="wb-problem">{problem}</p>}
            </div>
          )}
        </main>

        {showRight && (
          <aside className="wb-right">
            <div className="wb-side-head">当前文档</div>
            {selected ? (
              <div className="wb-props">
                <div className="wb-kv"><span className="wb-k">路径</span><span className="wb-v">{selected}</span></div>
                <div className="wb-kv"><span className="wb-k">类型</span><span className="wb-v">{isReport(selected) ? "HTML 报告" : "Markdown"}</span></div>
                {note && <div className="wb-kv"><span className="wb-k">字数</span><span className="wb-v">{note.text.length.toLocaleString()}</span></div>}
                {activeTag && <div className="wb-kv"><span className="wb-k">筛选</span><span className="wb-v">#{activeTag}</span></div>}
              </div>
            ) : (
              <div className="wb-props muted">未选择文档</div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
