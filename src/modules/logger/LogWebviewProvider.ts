import * as vscode from 'vscode';
import { LogCategory } from './Logger';

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

interface LogEntry {
  id: number;
  level: LogLevel;
  category: LogCategory;
  lines: string[];
  timestamp: string;
}

export class LogWebviewProvider implements vscode.WebviewViewProvider {

  public static readonly viewType = 'mm43.logsView';

  private view: vscode.WebviewView | undefined;
  private entryCounter = 0;

  constructor(private readonly extensionUri: vscode.Uri) { }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'clear') {
        this.clearEntries();
      }
    });
  }

  addEntry(level: LogLevel, category: LogCategory, text: string): void {
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) { return; }

    const entry: LogEntry = {
      id: ++this.entryCounter,
      level,
      category,
      lines,
      timestamp: this.now(),
    };

    this.postEntry(entry);
  }

  private postEntry(entry: LogEntry): void {
    this.view?.webview.postMessage({ type: 'addEntry', entry });
  }

  private clearEntries(): void {
    this.entryCounter = 0;
  }

  private now(): string {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  private getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-panel-border, #333);
    --badge-info: #3794ff;
    --badge-warn: #cca700;
    --badge-error: #f14c4c;
    --badge-debug: #888;
    --text-info: #4da6ff;
    --text-warn: #e0b636;
    --text-error: #f48080;
    --text-debug: #999;
    --border-info: #3794ff;
    --border-warn: #cca700;
    --border-error: #f14c4c;
    --border-debug: #666;
    --hover: var(--vscode-list-hoverBackground, #2a2d2e);
    --font: var(--vscode-editor-font-family, 'Cascadia Code', 'Consolas', monospace);
    --font-size: 12px;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--fg);
    font-family: var(--font);
    font-size: var(--font-size);
    padding: 0;
    overflow-x: hidden;
  }

  /* ── Toolbar ── */
  .toolbar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: var(--vscode-sideBar-background, var(--bg));
    border-bottom: 1px solid var(--border);
  }
  .toolbar-title {
    flex: 1;
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .5px;
    opacity: .7;
  }
  .toolbar button {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg);
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 3px;
    cursor: pointer;
    transition: background .15s;
  }
  .toolbar button:hover { background: var(--hover); }

  /* ── Entries ── */
  #log-container {
    padding: 4px 0;
  }

  .log-entry {
    border-bottom: 1px solid var(--border);
    padding: 6px 10px 6px 12px;
    transition: background .1s;
    border-left: 3px solid transparent;
  }
  .log-entry:hover { background: var(--hover); }
  .log-entry.level-INFO  { border-left-color: var(--border-info); }
  .log-entry.level-WARN  { border-left-color: var(--border-warn); }
  .log-entry.level-ERROR { border-left-color: var(--border-error); }
  .log-entry.level-DEBUG { border-left-color: var(--border-debug); }

  .log-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 2px;
  }

  .log-badge {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    padding: 1px 5px;
    border-radius: 3px;
    color: #fff;
    letter-spacing: .3px;
  }
  .log-badge.INFO  { background: var(--badge-info); }
  .log-badge.WARN  { background: var(--badge-warn); color: #000; }
  .log-badge.ERROR { background: var(--badge-error); }
  .log-badge.DEBUG { background: var(--badge-debug); }

  .log-category {
    font-size: 10px;
    opacity: .6;
  }

  .log-time {
    margin-left: auto;
    font-size: 10px;
    opacity: .5;
    font-variant-numeric: tabular-nums;
  }

  .log-body {
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    margin-top: 2px;
  }
  .log-body.level-INFO  { color: var(--text-info); }
  .log-body.level-WARN  { color: var(--text-warn); }
  .log-body.level-ERROR { color: var(--text-error); }
  .log-body.level-DEBUG { color: var(--text-debug); }

  .log-body.collapsed .log-line:nth-child(n+4) {
    display: none;
  }

  .log-line { display: block; }

  .log-toggle {
    display: inline-block;
    margin-top: 3px;
    font-size: 11px;
    color: var(--badge-info);
    cursor: pointer;
    user-select: none;
    border: none;
    background: none;
    padding: 2px 0;
    font-family: var(--font);
  }
  .log-toggle:hover { text-decoration: underline; }

  /* ── Empty state ── */
  .empty-state {
    padding: 30px 20px;
    text-align: center;
    opacity: .45;
    font-size: 12px;
  }
</style>
</head>
<body>

<div class="toolbar">
  <span class="toolbar-title">Logs mm43</span>
  <button id="btn-clear" title="Limpiar logs">🗑 Limpiar</button>
</div>

<div id="log-container">
  <div class="empty-state" id="empty-msg">Sin entradas de log aún.</div>
</div>

<script>
(function() {
  const container = document.getElementById('log-container');
  const emptyMsg  = document.getElementById('empty-msg');
  const btnClear  = document.getElementById('btn-clear');

  const MAX_VISIBLE = 3;
  const vscode = acquireVsCodeApi();

  btnClear.addEventListener('click', () => {
    container.innerHTML = '';
    emptyMsg.style.display = 'block';
    container.appendChild(emptyMsg);
    vscode.postMessage({ type: 'clear' });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'addEntry') {
      renderEntry(msg.entry);
    }
  });

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderEntry(entry) {
    emptyMsg.style.display = 'none';

    const el = document.createElement('div');
    el.className = 'log-entry level-' + entry.level;
    el.dataset.id = entry.id;

    const totalLines = entry.lines.length;
    const needsCollapse = totalLines > MAX_VISIBLE;

    // Header
    let html = '<div class="log-header">';
    html += '<span class="log-badge ' + entry.level + '">' + entry.level + '</span>';
    html += '<span class="log-category">' + entry.category + '</span>';
    html += '<span class="log-time">' + entry.timestamp + '</span>';
    html += '</div>';

    // Body with level-based color
    html += '<div class="log-body level-' + entry.level + (needsCollapse ? ' collapsed' : '') + '" data-entry-id="' + entry.id + '">';
    for (let i = 0; i < totalLines; i++) {
      html += '<span class="log-line">' + escapeHtml(entry.lines[i]) + '</span>';
    }
    html += '</div>';

    // Toggle button
    if (needsCollapse) {
      const extra = totalLines - MAX_VISIBLE;
      html += '<button class="log-toggle" data-entry-id="' + entry.id + '" data-state="collapsed">';
      html += '▼ Ver más (' + extra + ' líneas)';
      html += '</button>';
    }

    el.innerHTML = html;
    container.appendChild(el);

    // Bind toggle
    if (needsCollapse) {
      const btn = el.querySelector('.log-toggle');
      const body = el.querySelector('.log-body');
      btn.addEventListener('click', () => {
        const collapsed = btn.dataset.state === 'collapsed';
        if (collapsed) {
          body.classList.remove('collapsed');
          btn.dataset.state = 'expanded';
          btn.textContent = '▲ Ver menos';
        } else {
          body.classList.add('collapsed');
          btn.dataset.state = 'collapsed';
          const extra = totalLines - MAX_VISIBLE;
          btn.textContent = '▼ Ver más (' + extra + ' líneas)';
        }
      });
    }

    // Auto-scroll
    container.scrollTop = container.scrollHeight;
  }
})();
</script>
</body>
</html>`;
  }
}
