import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { defaultUrlTransform } from 'react-markdown';
import { prepareHtmlForPreview } from '../utils/htmlUtils.js';
import {
  NOTEBOOKS,
  DOCK,
  DOCK_TITLES,
  MENUS,
  SHORTCUTS,
  today,
  collectTags,
  groupDocs,
  searchDocs,
  wikiToMarkdown,
  buildTagTree,
  joinWorkspacePath,
  commandFor,
  newLogTemplate,
  clampFont,
} from './workbenchModel.js';
import './Workbench.css';

const LS = {
  get(k, d) {
    try { return localStorage.getItem('lokus.wb.' + k) ?? d; } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('lokus.wb.' + k, String(v)); } catch { /* storage unavailable */ }
  },
};

// Rust derives this from the current user's home directory (no machine-specific
// path in the source tree). Override with localStorage['lokus.wb.skills-dir']
// when the helper script lives somewhere else.
function skillsDir(snapshot) {
  return LS.get(
    'skills-dir',
    snapshot?.skillsDir || '~/.workbuddy/skills/lokus-dual-archive/scripts',
  );
}

function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      return;
    }
  } catch { /* fall through */ }
  fallbackCopy(text);
}

function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch { /* clipboard unavailable */ }
}

function headingId(text) {
  return 'h-' + String(text).toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * In-app SiYuan-style workbench.
 *
 * Rendered as its own WebView (?view=workbench) directly from main.jsx, so it
 * does NOT pass through App's AuthProvider / AuthGate / RemoteConfigProvider.
 * Those providers perform network probes on mount; a hung probe was the cause
 * of the Preferences white screen, and this window must never depend on them.
 *
 * Data is LIVE: `scan_workbench_docs` walks the workspace on demand. There is
 * no embedded snapshot and no `sync` step to keep in sync.
 */
export default function Workbench() {
  const [snapshot, setSnapshot] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);

  const [theme, setTheme] = useState(() => LS.get('theme', 'light'));
  const [fontPct, setFontPct] = useState(() => clampFont(LS.get('font', 100)));
  const [showSide, setShowSide] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [view, setView] = useState('tree');
  const [collapsed, setCollapsed] = useState({});
  const [query, setQuery] = useState('');
  const [filterTag, setFilterTag] = useState('');
  const [tabs, setTabs] = useState(() => {
    try { return JSON.parse(LS.get('tabs', '[]')) || []; } catch { return []; }
  });
  const [current, setCurrent] = useState(() => LS.get('last', ''));
  const [openMenu, setOpenMenu] = useState(null);
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState('');
  const [htmlUrls, setHtmlUrls] = useState({});

  const searchRef = useRef(null);
  const contentRef = useRef(null);
  const toastTimer = useRef(null);
  const blobUrls = useRef({});

  const docs = snapshot?.docs || [];
  const byId = useCallback((id) => docs.find((d) => d.id === id), [docs]);
  const cur = useCallback(() => byId(current), [byId, current]);
  const tags = useMemo(() => collectTags(docs), [docs]);
  const notebooks = useMemo(() => groupDocs(docs), [docs]);
  const tagRows = useMemo(() => buildTagTree(tags), [tags]);
  const hits = useMemo(() => searchDocs(docs, query, filterTag), [docs, query, filterTag]);

  const notify = useCallback((message) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2200);
  }, []);

  // ---- live data -------------------------------------------------------
  const reload = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const snap = await invoke('scan_workbench_docs');
      setSnapshot(snap);
      setLoadError('');
      if (!quiet) notify(`已扫描 ${snap.docs.length} 篇（${snap.mdCount} md / ${snap.htmlCount} HTML）`);
    } catch (err) {
      setLoadError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { reload(true); }, [reload]);

  useEffect(() => {
    let unlisten = null;
    let cancelled = false;
    listen('workbench:refresh', () => reload(true))
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; if (unlisten) unlisten(); };
  }, [reload]);

  useEffect(() => {
    document.documentElement.classList.add('wb-window');
    document.documentElement.dataset.wbTheme = theme;
    return () => {
      document.documentElement.classList.remove('wb-window');
      delete document.documentElement.dataset.wbTheme;
    };
  }, [theme]);

  useEffect(() => { LS.set('theme', theme); }, [theme]);
  useEffect(() => { LS.set('font', fontPct); }, [fontPct]);
  useEffect(() => { LS.set('tabs', JSON.stringify(tabs)); }, [tabs]);
  useEffect(() => { LS.set('last', current); }, [current]);

  // Restore the initial tab once docs arrive (persisted ids may be stale).
  useEffect(() => {
    if (!docs.length) return;
    const persisted = tabs.filter((id) => byId(id));
    if (persisted.length !== tabs.length) setTabs(persisted);
    const wanted = byId(current)
      ? current
      : docs.find((d) => d.path.includes('总入口'))?.id || docs[0].id;
    if (wanted && wanted !== current) setCurrent(wanted);
    if (wanted && !persisted.includes(wanted)) setTabs((t) => [wanted, ...t.filter((x) => x !== wanted)]);
    // Intentionally keyed on docs length: this is a one-time restore per scan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  // ---- tabs ------------------------------------------------------------
  const openDoc = useCallback((id) => {
    if (!byId(id)) { notify('未找到该文档'); return; }
    setTabs((t) => (t.includes(id) ? t : [...t, id]));
    setCurrent(id);
    setOpenMenu(null);
  }, [byId, notify]);

  const closeTab = useCallback((id) => {
    setTabs((t) => {
      const next = t.filter((x) => x !== id);
      setCurrent((c) => (c === id ? (next[next.length - 1] || '') : c));
      return next;
    });
  }, []);

  // ---- HTML reports: lazy read + sandboxed blob iframe ------------------
  const activeDoc = cur();
  useEffect(() => {
    if (!activeDoc || activeDoc.kind !== 'html' || htmlUrls[activeDoc.id]) return undefined;
    let cancelled = false;
    invoke('read_file_content', { path: activeDoc.absPath })
      .then((raw) => {
        if (cancelled) return;
        const prepared = prepareHtmlForPreview(raw);
        // Explicit charset: WebView2 otherwise decodes blob:text/html with the
        // system ANSI code page and turns UTF-8 Chinese into mojibake.
        const url = URL.createObjectURL(new Blob([prepared], { type: 'text/html;charset=utf-8' }));
        blobUrls.current[activeDoc.id] = url;
        setHtmlUrls((m) => ({ ...m, [activeDoc.id]: url }));
      })
      .catch((e) => { if (!cancelled) notify('无法读取 HTML：' + String(e?.message || e)); });
    return () => { cancelled = true; };
  }, [activeDoc, htmlUrls, notify]);

  useEffect(() => () => {
    Object.values(blobUrls.current).forEach((u) => {
      try { URL.revokeObjectURL(u); } catch { /* already gone */ }
    });
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  // ---- helpers ---------------------------------------------------------
  const showModal = useCallback((title, subtitle, body, buttons) => {
    setModal({ title, subtitle, body, buttons: buttons || [['关闭', null]] });
    setOpenMenu(null);
  }, []);

  const setFont = useCallback((v) => setFontPct(clampFont(v)), []);

  const goToPath = useCallback((fragment) => {
    const hit = docs.find((d) => d.path.includes(fragment));
    if (hit) openDoc(hit.id);
    else notify('未找到：' + fragment);
  }, [docs, openDoc, notify]);

  // ---- actions ---------------------------------------------------------
  const actions = useMemo(() => ({
    actRefresh: () => reload(false),
    actHome: () => goToPath('总入口'),
    actNewLog: () => {
      const d = today();
      const tpl = newLogTemplate(d);
      showModal('新建今日工作日志', '工作台不直接写盘；下面是可复制的落盘命令与模板',
        React.createElement('pre', null,
          commandFor(`log --date ${d} --title "标题" --text "正文" --tags "主题/系统"`, skillsDir(snapshot)),
          '\n\n' + tpl),
        [
          ['复制命令', () => copyText(commandFor(`log --date ${d} --title "标题" --text "正文"`, skillsDir(snapshot))), true],
          ['复制模板', () => copyText(tpl)],
          ['关闭', null],
        ]);
    },
    actExport: () => {
      const d = cur();
      if (!d) return notify('未打开文档');
      const text = d.kind === 'md' ? d.body : (d.body || '（HTML 原件请在文件树中导出）');
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = d.title.replace(/[\\/:*?"<>|]/g, '_') + (d.kind === 'md' ? '.md' : '.txt');
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify('已导出');
    },
    actPrint: () => { try { window.print(); } catch { notify('打印不可用'); } },
    actClose: () => (current ? closeTab(current) : notify('没有打开的标签')),
    actCloseAll: () => { setTabs([]); setCurrent(''); },
    actQuit: () => { invoke('close_workbench_window').catch((e) => notify(String(e))); },
    actCopyTitle: () => (cur() ? copyText(cur().title) : notify('未打开文档')),
    actCopyPath: () => (cur()
      ? copyText(joinWorkspacePath(snapshot?.workspace, cur().path))
      : notify('未打开文档')),
    actCopyTags: () => (cur() ? copyText(cur().tags.map((t) => '#' + t).join(' ')) : notify('未打开文档')),
    actFind: () => { setView('search'); searchRef.current?.focus(); notify('在顶部搜索框输入关键词'); },
    actSelectAll: () => {
      if (!contentRef.current) return;
      const range = document.createRange();
      range.selectNodeContents(contentRef.current);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    },
    actTheme: () => setTheme((t) => {
      const next = t === 'light' ? 'dark' : 'light';
      notify(next === 'light' ? '日间' : '夜间');
      return next;
    }),
    actSide: () => setShowSide((v) => !v),
    actRight: () => setShowRight((v) => !v),
    actFontUp: () => setFont(fontPct + 10),
    actFontDown: () => setFont(fontPct - 10),
    actFontReset: () => setFont(100),
    actLatestLog: () => {
      const d = docs.filter((x) => x.nb === '工作日志' && !x.path.endsWith('索引.md'))
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      d ? openDoc(d.id) : notify('暂无工作日志');
    },
    actLatestHtml: () => {
      const d = docs.find((x) => x.kind === 'html');
      d ? openDoc(d.id) : notify('暂无 HTML 报告');
    },
    actTagStat: () => {
      const rows = [...tags].sort((a, b) => b[1] - a[1]).slice(0, 24)
        .map(([t, n]) => '#' + t + '  ×' + n).join('\n');
      showModal('标签统计', `共 ${tags.length} 个标签 · 中文多级 + ASCII 兜底`,
        React.createElement('pre', null, rows));
    },
    actSync: () => showModal('重建预览 / 索引',
      '本体工作台实时扫盘，无需 sync；这条只重建浏览器/插件三份静态页',
      React.createElement('pre', null, commandFor('sync', skillsDir(snapshot))),
      [['复制命令', () => copyText(commandFor('sync', skillsDir(snapshot))), true], ['关闭', null]]),
    actCopyWs: () => copyText(snapshot?.workspace || ''),
    actSkillCmd: () => showModal('双份归档技能', 'lokus-dual-archive · 三区分离 + 中文多级 tag',
      React.createElement('pre', null, [
        commandFor('md <vault文件.md> --kind sop --tags "主题/流程规则"', skillsDir(snapshot)),
        commandFor('html <报告.html> --tags "主题/系统"', skillsDir(snapshot)),
        commandFor('tag <已存在.md> --kind report', skillsDir(snapshot)),
        commandFor('sync', skillsDir(snapshot)),
      ].join('\n'))),
    actKeys: () => showModal('快捷键一览', '思源式工作台 · 键盘操作',
      React.createElement('pre', null, SHORTCUTS.map(([k, v]) => k.padEnd(20) + v).join('\n'))),
    actAbout: () => showModal('关于 Lokus 工作台', '应用内原生视图 · 实时扫盘 · 无快照、无外部 CDN',
      React.createElement('div', null,
        React.createElement('div', { className: 'wb-kv' },
          React.createElement('span', { className: 'wb-k' }, '文档'),
          React.createElement('span', null, `${docs.length} 篇 · ${tags.length} 标签`)),
        React.createElement('div', { className: 'wb-kv' },
          React.createElement('span', { className: 'wb-k' }, '数据源'),
          React.createElement('span', null, snapshot?.workspace || '—')),
        React.createElement('div', { className: 'wb-kv' },
          React.createElement('span', { className: 'wb-k' }, '扫描时间'),
          React.createElement('span', null, snapshot?.generated || '—')),
        React.createElement('div', { className: 'wb-sub', style: { marginTop: 12 } },
          '文档严格分离：工作日志 / 研判信息 / 规则 / HTML 报告。仅供参考，非投资建议。'))),
  }), [reload, goToPath, showModal, cur, current, closeTab, notify, fontPct, setFont,
       docs, tags, openDoc, snapshot, searchRef]);

  const runAction = useCallback((act) => {
    setOpenMenu(null);
    if (!act) return;
    if (act.startsWith('go:')) { goToPath(act.slice(3)); return; }
    const fn = actions[act];
    if (fn) fn();
    else notify('未实现：' + act);
  }, [actions, goToPath, notify]);

  // ---- keyboard --------------------------------------------------------
  useEffect(() => {
    const onKey = (e) => {
      const k = e.key.toLowerCase();
      if (e.key === 'Escape') { setModal(null); setOpenMenu(null); return; }
      if (e.key === 'F1') { e.preventDefault(); runAction('actKeys'); return; }
      if (e.ctrlKey && e.shiftKey && k === 'l') { e.preventDefault(); runAction('actTheme'); return; }
      if (e.ctrlKey && (k === 'k' || k === 'f')) {
        e.preventDefault(); setView('search'); searchRef.current?.focus(); return;
      }
      if (e.ctrlKey && k === 'b') { e.preventDefault(); runAction('actSide'); return; }
      if (e.ctrlKey && k === 'j') { e.preventDefault(); runAction('actRight'); return; }
      if (e.ctrlKey && k === 'w') { e.preventDefault(); runAction('actClose'); return; }
      if (e.ctrlKey && k === 'n') { e.preventDefault(); runAction('actNewLog'); return; }
      if (e.ctrlKey && k === 'r') { e.preventDefault(); runAction('actRefresh'); return; }
      if (e.ctrlKey && k === 'p') { e.preventDefault(); runAction('actPrint'); return; }
      if (e.ctrlKey && (k === '=' || k === '+')) { e.preventDefault(); runAction('actFontUp'); return; }
      if (e.ctrlKey && k === '-') { e.preventDefault(); runAction('actFontDown'); return; }
      if (e.altKey && /^[1-5]$/.test(e.key)) {
        e.preventDefault(); setView(DOCK[Number(e.key) - 1].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runAction]);

  // ---- render helpers --------------------------------------------------
  const renderTree = () => notebooks.map((nb) => {
    const isClosed = !!collapsed[nb.id];
    return (
      <div className={'wb-nb' + (isClosed ? ' wb-closed' : '')} key={nb.id}>
        <div className="wb-nb-h" title={nb.hint}
             onClick={() => setCollapsed((c) => ({ ...c, [nb.id]: !c[nb.id] }))}>
          <span className="wb-arw">▼</span>
          <span className="wb-ico">{nb.icon}</span>
          <span>{nb.id}</span>
          <span className="wb-cnt">{nb.docs.length}</span>
        </div>
        <div className="wb-nb-c">
          {nb.groups.map((g) => (
            <React.Fragment key={g.key || '_'}>
              {g.key && <div className="wb-grp">{g.key}</div>}
              {g.docs.map((d) => (
                <div key={d.id}
                     className={'wb-doc' + (d.id === current ? ' wb-on' : '')}
                     title={d.path + '\n' + d.tags.map((t) => '#' + t).join(' ')}
                     onClick={() => openDoc(d.id)}>
                  <span className="wb-t">{d.title}</span>
                  {d.kind === 'html' && <span className="wb-ext">HTML</span>}
                  <span className="wb-dt">{String(d.date || '').slice(5)}</span>
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      </div>
    );
  });

  const renderTags = () => (
    <>
      {filterTag && (
        <div className="wb-tagline" style={{ cursor: 'pointer' }} onClick={() => setFilterTag('')}>
          筛选：#{filterTag} （点击清除）
        </div>
      )}
      {!filterTag && <div className="wb-tagline">中文多级在前 · ASCII 兜底；点击标签筛选</div>}
      {tagRows.map((row, i) => row.type === 'group'
        ? <div className="wb-grp" key={'g' + i}>▸ {row.label}</div>
        : (
          <div key={row.label}
               className={'wb-tagrow' + (filterTag === row.label ? ' wb-on' : '')}
               style={{ paddingLeft: 10 + row.depth * 10 }}
               onClick={() => setFilterTag((t) => (t === row.label ? '' : row.label))}>
            <span className="wb-dot" />
            <span>#{row.label}</span>
            <span className="wb-n">{row.count}</span>
          </div>
        ))}
      {filterTag && (
        <>
          <div className="wb-tagline">— 命中 {hits.length} 篇 —</div>
          {hits.map((d) => (
            <div className="wb-doc" key={d.id} onClick={() => openDoc(d.id)}>
              <span className="wb-t">{d.title}</span>
            </div>
          ))}
        </>
      )}
    </>
  );

  const renderSearch = () => (
    <>
      <div className="wb-tagline">在顶部搜索框输入 · 匹配标题 / 路径 / 标签 / 正文</div>
      <div className="wb-tagline">{hits.length} 条结果{filterTag ? ` · #${filterTag}` : ''}</div>
      {hits.slice(0, 200).map((d) => (
        <div className="wb-doc" key={d.id} title={d.path} onClick={() => openDoc(d.id)}>
          <span className="wb-t">{d.title}</span>
          {d.kind === 'html' && <span className="wb-ext">HTML</span>}
        </div>
      ))}
    </>
  );

  const renderOutline = () => {
    const d = cur();
    if (!d?.outline?.length) return <div className="wb-tagline">当前文档没有标题</div>;
    return d.outline.map((o, i) => (
      <div key={i} className={'wb-out' + (o.level >= 3 ? ' wb-lv3' : '')}
           onClick={() => document.getElementById(headingId(o.text))?.scrollIntoView({ block: 'start' })}>
        {o.text}
      </div>
    ));
  };

  const renderSettings = () => (
    <>
      <div className="wb-tagline">数据源（实时）</div>
      <div className="wb-props">
        <div className="wb-row"><span className="wb-k">工作区</span><span className="wb-v">{snapshot?.workspace || '—'}</span></div>
        <div className="wb-row"><span className="wb-k">扫描</span><span className="wb-v">{snapshot?.generated || '—'}</span></div>
        <div className="wb-row"><span className="wb-k">文档</span><span className="wb-v">{snapshot?.mdCount || 0} md + {snapshot?.htmlCount || 0} HTML</span></div>
      </div>
      <div className="wb-tagline">界面</div>
      {[
        ['切换日间 / 夜间', 'actTheme'], ['显示 / 隐藏左栏', 'actSide'],
        ['显示 / 隐藏右栏', 'actRight'], ['放大字号', 'actFontUp'],
        ['缩小字号', 'actFontDown'], ['恢复 100%', 'actFontReset'],
        ['刷新工作区', 'actRefresh'],
      ].map(([label, act]) => (
        <div className="wb-doc" key={act} onClick={() => runAction(act)}>
          <span className="wb-t">{label}</span>
        </div>
      ))}
    </>
  );

  const renderSide = () => {
    if (view === 'tree') return renderTree();
    if (view === 'tag') return renderTags();
    if (view === 'search') return renderSearch();
    if (view === 'outline') return renderOutline();
    return renderSettings();
  };

  // ---- main render -----------------------------------------------------
  if (loading && !snapshot) {
    return <div className="wb-root wb-app" data-theme={theme}><div className="wb-spin">正在扫描工作区…</div></div>;
  }
  if (loadError && !snapshot) {
    return (
      <div className="wb-root wb-app" data-theme={theme}>
        <div className="wb-spin" style={{ display: 'block', padding: 40 }}>
          <h2>无法读取工作区</h2>
          <p>{loadError}</p>
          <button className="wb-btn" onClick={() => reload(false)}>重新扫描</button>
          <button className="wb-btn" onClick={() => invoke('close_workbench_window')}>关闭</button>
        </div>
      </div>
    );
  }

  const active = cur();
  const markdownComponents = {
    a: ({ href, children }) => {
      if (href?.startsWith('wikilink:')) {
        const name = decodeURIComponent(href.slice('wikilink:'.length));
        return (
          <a href="#" onClick={(e) => { e.preventDefault(); setQuery(name); setView('search'); notify('搜索：' + name); }}>
            {children}
          </a>
        );
      }
      return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
    },
    h1: ({ children }) => <h1 id={headingId(String(children))}>{children}</h1>,
    h2: ({ children }) => <h2 id={headingId(String(children))}>{children}</h2>,
    h3: ({ children }) => <h3 id={headingId(String(children))}>{children}</h3>,
  };
  const urlTransform = (url) => (url.startsWith('wikilink:') ? url : defaultUrlTransform(url));

  return (
    <div className="wb-root wb-app" data-theme={theme}
         style={{ '--fs': (14 * fontPct / 100) + 'px' }}
         onClick={() => openMenu && setOpenMenu(null)}>
      <header className="wb-topbar">
        <div className="wb-brand">
          <span className="wb-logo">L</span>
          <span>Lokus 工作台</span>
          <small>实时</small>
        </div>
        <div className="wb-menubar">
          {MENUS.map((m) => (
            <div key={m.name}
                 className={'wb-mitem' + (openMenu === m.name ? ' wb-on' : '')}
                 onClick={(e) => { e.stopPropagation(); setOpenMenu((v) => (v === m.name ? null : m.name)); }}>
              {m.name}
              {openMenu === m.name && (
                <div className="wb-dropdown wb-open" onClick={(e) => e.stopPropagation()}>
                  {m.items.map((row, i) => row === '-'
                    ? <hr key={'hr' + i} />
                    : (
                      <button key={row[1]} onClick={() => runAction(row[1])}>
                        <span>{row[0]}</span>
                        {row[2] && <span className="wb-k">{row[2]}</span>}
                      </button>
                    ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="wb-top-right">
          <div className="wb-searchbox" onClick={() => setView('search')}>
            <span>⌕</span>
            <input ref={searchRef} value={query} placeholder="搜索文档 / 标签 / 正文"
                   onFocus={() => setView('search')}
                   onChange={(e) => { setQuery(e.target.value); setView('search'); }} />
            <kbd>Ctrl+K</kbd>
          </div>
          <button className="wb-iconbtn" title="重新扫盘 (Ctrl+R)" onClick={() => runAction('actRefresh')}>⟳</button>
          <button className="wb-iconbtn" title="日间 / 夜间 (Ctrl+Shift+L)" onClick={() => runAction('actTheme')}>◐</button>
          <button className="wb-iconbtn" title="显示 / 隐藏左栏 (Ctrl+B)" onClick={() => runAction('actSide')}>▥</button>
          <button className="wb-iconbtn" title="显示 / 隐藏右栏 (Ctrl+J)" onClick={() => runAction('actRight')}>▤</button>
          <button className="wb-iconbtn wb-close-btn" title="关闭工作台窗口"
                  onClick={() => runAction('actQuit')}>✕</button>
        </div>
      </header>

      <div className="wb-body">
        <div className="wb-dock">
          {DOCK.map((d, i) => (
            <button key={d.id} title={`${d.label} (Alt+${i + 1})`}
                    className={'wb-d' + (view === d.id ? ' wb-on' : '')}
                    onClick={() => setView(d.id)}>{d.icon}</button>
          ))}
          <div className="wb-spacer" />
        </div>

        {showSide && (
          <aside className="wb-sidebar">
            <div className="wb-side-head">
              <span>{DOCK_TITLES[view]}</span>
              <span className="wb-add" title="新建今日工作日志" onClick={() => runAction('actNewLog')}>＋</span>
            </div>
            <div className="wb-side-body">{renderSide()}</div>
            <div className="wb-side-foot">
              {docs.length} 篇文档 · {tags.length} 个标签 · {snapshot?.generated || ''}
            </div>
          </aside>
        )}

        <section className="wb-main">
          <div className="wb-tabs">
            {tabs.map((id) => {
              const d = byId(id);
              if (!d) return null;
              return (
                <div key={id} className={'wb-tab' + (id === current ? ' wb-on' : '')}
                     onClick={() => setCurrent(id)}>
                  <span className="wb-t">{d.title}</span>
                  <span className="wb-x" onClick={(e) => { e.stopPropagation(); closeTab(id); }}>×</span>
                </div>
              );
            })}
          </div>
          <div className="wb-crumb">
            {active ? <><span>{active.nb}</span><span>/</span><b>{active.title}</b></> : <span>未打开文档</span>}
          </div>
          <div className="wb-content" ref={contentRef}>
            {!active && <div className="wb-empty">从左侧文档树选择一篇文档，或用 Ctrl+K 搜索</div>}
            {active?.kind === 'md' && (
              <div className="wb-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}
                               components={markdownComponents}
                               urlTransform={urlTransform}>
                  {wikiToMarkdown(active.body)}
                </ReactMarkdown>
              </div>
            )}
            {active?.kind === 'html' && (
              htmlUrls[active.id]
                ? <iframe title={active.title} src={htmlUrls[active.id]}
                          sandbox="allow-scripts allow-forms allow-popups" />
                : <div className="wb-spin">正在读取 HTML 报告…</div>
            )}
          </div>
        </section>

        {showRight && (
          <aside className="wb-rightbar">
            <div className="wb-rb-h">大纲</div>
            <div className="wb-rb-sec">
              {active?.outline?.length
                ? active.outline.slice(0, 60).map((o, i) => (
                    <div key={i} className={'wb-out' + (o.level >= 3 ? ' wb-lv3' : '')}
                         onClick={() => document.getElementById(headingId(o.text))?.scrollIntoView({ block: 'start' })}>
                      {o.text}
                    </div>
                  ))
                : <div className="wb-tagline">无标题</div>}
            </div>
            <div className="wb-rb-h">文档属性</div>
            <div className="wb-rb-sec">
              <div className="wb-props">
                {active && [
                  ['类型', active.kind === 'md' ? 'Markdown' : 'HTML 报告'],
                  ['日期', active.date],
                  ['大小', (active.size / 1024).toFixed(1) + ' KB'],
                  ['外链', active.external ? '是（CDN）' : '否'],
                  ['路径', active.path],
                ].map(([k, v]) => (
                  <div className="wb-row" key={k}><span className="wb-k">{k}</span><span className="wb-v">{v}</span></div>
                ))}
              </div>
            </div>
            <div className="wb-rb-h">标签</div>
            <div className="wb-rb-sec">
              <div className="wb-tagchips">
                {(active?.tags || []).map((t) => (
                  <span className="wb-chip" key={t}
                        onClick={() => { setFilterTag(t); setView('tag'); }}>#{t}</span>
                ))}
              </div>
            </div>
          </aside>
        )}
      </div>

      <footer className="wb-statusbar">
        <span className="wb-ok">● 实时扫盘</span>
        <span>{snapshot?.mdCount || 0} md · {snapshot?.htmlCount || 0} HTML</span>
        <span className="wb-mid">{active?.path || ''}</span>
        <span>{theme === 'light' ? '日间' : '夜间'}</span>
        <span>{fontPct}%</span>
        <span>UTF-8</span>
      </footer>

      {modal && (
        <div className="wb-modal wb-open" onClick={() => setModal(null)}>
          <div className="wb-card" onClick={(e) => e.stopPropagation()}>
            <h3>{modal.title}</h3>
            <div className="wb-sub">{modal.subtitle}</div>
            {modal.body}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              {(modal.buttons || []).map(([label, fn], i) => (
                <button key={i} className={'wb-btn' + (label.includes('复制') ? ' wb-pri' : '')}
                        onClick={() => {
                          if (fn) fn();
                          if (!label.includes('复制')) setModal(null);
                          else notify('已复制：' + label);
                        }}>{label}</button>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className={'wb-toast' + (toast ? ' wb-show' : '')}>{toast}</div>
    </div>
  );
}
