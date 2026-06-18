/**
 * MM43 - Motor de Aplanamiento Cronológico Semántico
 * VersionControlWebviewPanel.ts - Panel webview con visualización de topología DAG
 *
 * Muestra:
 *   - Grafo de commits con sus Vectores de Versión
 *   - Timeline de features
 *   - Conflictos semánticos detectados
 *   - Formularios de acción integrados
 */

import * as vscode from 'vscode';
import { VersionControlState, Feature, ConflictInfo } from '../config/types';

export class VersionControlWebviewPanel {

  private static currentPanel: VersionControlWebviewPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  static createOrShow(context: vscode.ExtensionContext, state: VersionControlState): VersionControlWebviewPanel {
    const column = vscode.ViewColumn.Beside;

    if (VersionControlWebviewPanel.currentPanel) {
      VersionControlWebviewPanel.currentPanel._panel.reveal(column);
      VersionControlWebviewPanel.currentPanel.update(state);
      return VersionControlWebviewPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'mm43VersionControl',
      '⚡ MM43 · Control de Versión',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    VersionControlWebviewPanel.currentPanel = new VersionControlWebviewPanel(panel, context, state);
    return VersionControlWebviewPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private state: VersionControlState
  ) {
    this._panel = panel;
    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        await this.handleMessage(message);
      },
      null,
      this._disposables
    );
  }

  update(state: VersionControlState): void {
    this.state = state;
    this._update();
  }

  private async handleMessage(message: { command: string;[key: string]: any }): Promise<void> {
    switch (message.command) {
      case 'startFeature':
        await vscode.commands.executeCommand('mm43.vc.startFeature');
        break;
      case 'commitWithVector':
        await vscode.commands.executeCommand('mm43.vc.commitWithVector', message.featureId);
        break;
      case 'flattenFeature':
        await vscode.commands.executeCommand('mm43.vc.flattenFeature', message.featureId);
        break;
      case 'flattenActive':
        await vscode.commands.executeCommand('mm43.vc.flattenActive');
        break;
      case 'refresh':
        await vscode.commands.executeCommand('mm43.vc.refresh');
        break;
      case 'syncUp':
        await vscode.commands.executeCommand('mm43.vc.syncUp');
        break;
      case 'syncDown':
        await vscode.commands.executeCommand('mm43.vc.syncDown');
        break;
      case 'closeFeature':
        await vscode.commands.executeCommand('mm43.vc.closeFeature', message.featureId);
        break;
      case 'openFeature':
        await vscode.commands.executeCommand('mm43.vc.openFeature', message.featureId);
        break;
      case 'assignCommit':
        await vscode.commands.executeCommand('mm43.vc.assignCommit', { sha: message.sha, featureId: message.featureId });
        break;
      case 'deleteFeature':
        await vscode.commands.executeCommand('mm43.vc.deleteFeature', message.featureId);
        break;
      case 'unassignCommit':
        await vscode.commands.executeCommand('mm43.vc.unassignCommit', message.sha);
        break;
      case 'fullSync':
        await vscode.commands.executeCommand('mm43.vc.fullSync');
        break;
      case 'sanitize':
        await vscode.commands.executeCommand('mm43.vc.sanitize');
        break;
      case 'stageFile':
        await vscode.commands.executeCommand('mm43.vc.stageFile', message.file);
        break;
      case 'unstageFile':
        await vscode.commands.executeCommand('mm43.vc.unstageFile', message.file);
        break;
      case 'discardChanges':
        await vscode.commands.executeCommand('mm43.vc.discardChanges', message.file);
        break;
      case 'applyStash':
        await vscode.commands.executeCommand('mm43.vc.applyStash', message.index);
        break;
      case 'createStash':
        await vscode.commands.executeCommand('mm43.vc.createStash');
        break;
    }
  }

  private _update(): void {
    this._panel.webview.html = this._getHtml();
  }

  private _getHtml(): string {
    const s = this.state;
    const featuresJson = JSON.stringify(s.allFeatures);
    const conflictsJson = JSON.stringify(s.pendingConflicts);

    const featureCards = s.allFeatures.map(f => this._featureCard(f, s)).join('');
    const conflictCards = s.pendingConflicts.map(c => this._conflictCard(c)).join('');
    const orphanCards = s.orphanCommits?.map(c => this._orphanCard(c)).join('') || '';

    const stagedList = s.stagedFiles?.map(f => this._fileCard(f, true)).join('') || '<div style="color:var(--fg2);padding:8px">No hay cambios preparados.</div>';
    const unstagedList = s.unstagedFiles?.map(f => this._fileCard(f, false)).join('') || '';
    const untrackedList = s.untrackedFiles?.map(f => this._fileCard(f, false)).join('') || '';
    const stashList = s.stashes?.map(st => this._stashCard(st)).join('') || '<div style="color:var(--fg2);padding:8px">No hay stashes.</div>';
    const hasUnstaged = (s.unstagedFiles?.length || 0) + (s.untrackedFiles?.length || 0) > 0;
    const unstagedContent = hasUnstaged ? unstagedList + untrackedList : '<div style="color:var(--fg2);padding:8px">No hay cambios sin preparar.</div>';

    return /* html */`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MM43 Control de Versión</title>
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --bg2: var(--vscode-sideBar-background);
    --bg3: var(--vscode-editorGroupHeader-tabsBackground);
    --fg: var(--vscode-editor-foreground);
    --fg2: var(--vscode-descriptionForeground);
    --accent: var(--vscode-button-background);
    --accent-fg: var(--vscode-button-foreground);
    --accent-hover: var(--vscode-button-hoverBackground);
    --border: var(--vscode-panel-border);
    --warn: #e5a000;
    --ok: #4ec94e;
    --err: #f14c4c;
    --info: #3794ff;
    --radius: 6px;
    --font-mono: var(--vscode-editor-font-family, 'Consolas', monospace);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--fg);
    font-family: var(--vscode-font-family, sans-serif);
    font-size: 13px;
    line-height: 1.5;
    padding: 0;
    overflow-x: hidden;
  }

  /* ── Header ── */
  .header {
    background: var(--bg3);
    border-bottom: 1px solid var(--border);
    padding: 14px 20px;
    display: flex;
    align-items: center;
    gap: 12px;
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .header-logo {
    font-size: 20px;
    font-weight: 800;
    letter-spacing: -1px;
    color: var(--accent);
    font-family: var(--font-mono);
  }
  .header-title {
    flex: 1;
    font-size: 13px;
    font-weight: 600;
    color: var(--fg2);
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }
  .branch-badge {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 3px 12px;
    font-family: var(--font-mono);
    font-size: 11px;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--fg);
  }
  .branch-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--ok);
    animation: pulse 2s infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  /* ── Layout ── */
  .content {
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  /* ── Section ── */
  .section {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .section-header {
    padding: 10px 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--fg2);
  }
  .section-icon { font-size: 14px; }
  .section-count {
    margin-left: auto;
    background: var(--bg3);
    border-radius: 10px;
    padding: 1px 8px;
    font-size: 10px;
    font-family: var(--font-mono);
  }
  .section-body { padding: 12px 14px; }

  /* ── Status row ── */
  .status-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .stat-box {
    background: var(--bg3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 12px;
  }
  .stat-label {
    font-size: 10px;
    color: var(--fg2);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
  }
  .stat-value {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 600;
  }
  .stat-value.mono-small {
    font-size: 11px;
    color: var(--info);
  }

  /* ── Buttons ── */
  .btn {
    background: var(--accent);
    color: var(--accent-fg);
    border: none;
    border-radius: var(--radius);
    padding: 7px 14px;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    transition: background 0.15s;
    white-space: nowrap;
  }
  .btn:hover { background: var(--accent-hover); }
  .btn.btn-sm { padding: 4px 10px; font-size: 11px; }
  .btn.btn-ghost {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg);
  }
  .btn.btn-ghost:hover { background: var(--bg3); }
  .btn.btn-danger {
    background: var(--err);
    color: white;
  }
  .btn.btn-danger:hover { filter: brightness(0.85); }
  .btn.btn-success {
    background: #1a7f3c;
    color: white;
  }
  .btn.btn-success:hover { filter: brightness(0.85); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Action bar ── */
  .action-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  /* ── Feature list ── */
  .feature-card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    margin-bottom: 8px;
  }
  .feature-card:last-child { margin-bottom: 0; }
  .feature-card-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    background: var(--bg3);
    border-bottom: 1px solid var(--border);
  }
  .feature-id {
    font-family: var(--font-mono);
    font-weight: 700;
    font-size: 13px;
  }
  .feature-status {
    margin-left: auto;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .status-active { background: var(--ok); color: #000; }
  .status-conflict { background: #e5a00033; color: var(--warn); border: 1px solid var(--warn)33; }
  .status-integrated { background: var(--info); color: #fff; }
  .status-closed { background: var(--err); color: #fff; }
  .feature-card-body {
    padding: 10px 12px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .feature-meta { flex: 1; font-size: 11px; color: var(--fg2); }
  .sha-chip {
    font-family: var(--font-mono);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 10px;
    color: var(--info);
  }

  /* ── Commit timeline (mini) ── */
  .commit-line {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    font-size: 11px;
    border-bottom: 1px solid var(--border)44;
  }
  .commit-line:last-child { border-bottom: none; }
  .commit-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--info);
    flex-shrink: 0;
  }
  .commit-dot.has-vv { background: var(--ok); }
  .commit-sha { font-family: var(--font-mono); color: var(--info); }
  .commit-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .commit-vv {
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--fg2);
    background: var(--bg3);
    border-radius: 3px;
    padding: 1px 4px;
  }

  .btn-link {
    background: none;
    border: none;
    color: var(--info);
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
  }
  .btn-link:hover { color: var(--accent); }
  .commit-dot { position: relative; display: flex; align-items: center; justify-content: center; }
  .commit-remove {
      display: none;
      position: absolute;
      color: white;
      font-size: 10px;
      font-weight: bold;
      pointer-events: none;
  }
  .commit-dot:hover .commit-remove { display: block; }

  /* ── Rebasing overlay ── */
  .rebasing-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    backdrop-filter: blur(4px);
  }
  .rebasing-box {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 24px 32px;
    text-align: center;
  }
  .spinner {
    width: 32px; height: 32px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin: 0 auto 12px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .empty-state {
    text-align: center;
    color: var(--fg2);
    padding: 20px;
    font-size: 12px;
  }
  .empty-state .empty-icon { font-size: 24px; margin-bottom: 8px; }
</style>
</head>
<body>

${s.isRebasing ? `
<div class="rebasing-overlay">
  <div class="rebasing-box">
    <div class="spinner"></div>
    <div style="font-weight:600;margin-bottom:4px">Aplanando historial...</div>
    <div style="color:var(--fg2);font-size:11px">Motor MM43 ejecutando rebase semántico</div>
  </div>
</div>` : ''}

<!-- HEADER -->
<div class="header">
  <div class="header-logo">MM43</div>
  <div class="header-title">Maven M4nag3r</div>
  <div class="branch-badge">
    <span class="branch-dot"></span>
    <span>${escapeHtml(s.currentBranch)}</span>
    ${s.trunkHead ? `<span style="color:var(--fg2);font-size:10px">${s.trunkHead.substring(0, 8)}</span>` : ''}
  </div>
</div>

<div class="content">

  <!-- STATUS GRID -->
  <div class="section">
    <div class="section-header">
      <span class="section-icon">📊</span>
      Estado del Motor
    </div>
    <div class="section-body">
      <div class="status-grid">
        <div class="stat-box">
          <div class="stat-label">Rama (Trunk)</div>
          <div class="stat-value">${escapeHtml(s.currentBranch)}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">HEAD</div>
          <div class="stat-value mono-small">${s.trunkHead ? s.trunkHead.substring(0, 12) : 'N/A'}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Features Activas</div>
          <div class="stat-value">${s.allFeatures.length}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Conflictos</div>
          <div class="stat-value" style="color:${s.pendingConflicts.length > 0 ? 'var(--warn)' : 'var(--ok)'}">
            ${s.pendingConflicts.length}
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ACCIONES -->
  <div class="section">
    <div class="section-header">
      <span class="section-icon">⚙</span>
      Acciones Rápidas
    </div>
    <div class="section-body">
      <div class="action-bar">
        <button class="btn" onclick="send('startFeature')">
          ＋ Nueva Feature
        </button>
        <button class="btn btn-ghost" onclick="send('commitWithVector')">
          ⊙ Commit con Vector
        </button>
        <button class="btn btn-ghost" onclick="send('refresh')" style="margin-left:auto">
          ↻ Actualizar
        </button>
        <button class="btn btn-ghost" onclick="send('sanitize')" title="Saneamiento profundo de refs">
          🧹 Sanear
        </button>
        <button class="btn btn-success" style="background-color: #0e639c;" onclick="send('fullSync')">
          🔄 Sincronizar con Origen
        </button>

        <button class="btn btn-ghost" onclick="send('syncDown')">
          ↓ Bajar
        </button>
        <button class="btn btn-ghost" onclick="send('syncUp')">
          ↑ Subir
        </button>
      </div>
    </div>
  </div>

  <!-- GESTIÓN DE GIT (COLLAPSIBLE) -->
  <div class="section">
    <div class="section-header" style="cursor:pointer;" onclick="document.getElementById('git-mgmt').style.display = document.getElementById('git-mgmt').style.display === 'none' ? 'block' : 'none'">
      <span class="section-icon">🗂</span>
      Control de Cambios / Git
      <span style="float:right; font-size:10px;">(Click para expandir)</span>
    </div>
    <div class="section-body" id="git-mgmt" style="display:none; padding-top: 10px;">
        <div style="display:flex; gap: 16px;">
            <div style="flex:1;">
                <h4 style="margin-bottom:8px; border-bottom:1px solid var(--border); padding-bottom:4px;">Staged Changes</h4>
                <div style="max-height: 200px; overflow-y: auto;">
                    ${stagedList}
                </div>
            </div>
            <div style="flex:1;">
                <h4 style="margin-bottom:8px; border-bottom:1px solid var(--border); padding-bottom:4px;">Changes (Unstaged/Untracked)</h4>
                <div style="max-height: 200px; overflow-y: auto;">
                    ${unstagedContent}
                </div>
            </div>
            <div style="flex:1;">
                <h4 style="margin-bottom:8px; border-bottom:1px solid var(--border); padding-bottom:4px;">Stashes</h4>
                <div style="margin-bottom: 8px;">
                    <button class="btn btn-sm btn-ghost" onclick="send('createStash')">✚ Nuevo Stash</button>
                </div>
                <div style="max-height: 160px; overflow-y: auto;">
                    ${stashList}
                </div>
            </div>
        </div>
    </div>
  </div>

  <!-- COMMITS HUÉRFANOS -->
  ${s.orphanCommits && s.orphanCommits.length > 0 ? `
  <div class="section" style="border-color: var(--warn)">
    <div class="section-header" style="color: var(--warn)">
      <span class="section-icon">⚠</span>
      Commits Locales Sin Feature
      <span class="section-count">${s.orphanCommits.length}</span>
    </div>
    <div class="section-body">
      ${orphanCards}
    </div>
  </div>` : ''}

  <!-- FEATURES -->
  <div class="section">
    <div class="section-header">
      <span class="section-icon">🗂</span>
      Features Registradas
      <span class="section-count">${s.allFeatures.length}</span>
    </div>
    <div class="section-body">
      ${s.allFeatures.length === 0 ? `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        Sin features registradas. Usa "Nueva Feature" para comenzar.
      </div>` : featureCards}
    </div>
  </div>

  <!-- CONFLICTOS -->
  <div class="section">
    <div class="section-header">
      <span class="section-icon">⚠</span>
      Conflictos Semánticos
      <span class="section-count" style="color:${s.pendingConflicts.length > 0 ? 'var(--warn)' : 'var(--ok)'}">
        ${s.pendingConflicts.length}
      </span>
    </div>
    <div class="section-body">
      ${s.pendingConflicts.length === 0 ? `
      <div class="empty-state">
        <div class="empty-icon"> </div>
        Sin conflictos detectados. La topología es consistente.
      </div>` : conflictCards}
    </div>
  </div>

</div>

<script>
  const vscode = acquireVsCodeApi();
  function send(command, data) {
    vscode.postMessage({ command, ...data });
  }
  function flattenFeature(featureId) {
    vscode.postMessage({ command: 'flattenFeature', featureId });
  }
  function closeFeature(featureId) {
    vscode.postMessage({ command: 'closeFeature', featureId });
  }
  function openFeature(featureId) {
    vscode.postMessage({ command: 'openFeature', featureId });
  }
  function assignCommit(sha) {
    vscode.postMessage({ command: 'assignCommit', sha });
  }
  function deleteFeature(featureId) {
    vscode.postMessage({ command: 'deleteFeature', featureId });
  }
  function stageFile(file) {
    vscode.postMessage({ command: 'stageFile', file });
  }
  function unstageFile(file) {
    vscode.postMessage({ command: 'unstageFile', file });
  }
  function unassignCommit(sha) {
    vscode.postMessage({ command: 'unassignCommit', sha });
  }
  function toggleExpansion(featureId) {
    const list = document.querySelectorAll('.extra-' + featureId.replace(/\./g, '\\.'));
    const btn = document.getElementById('btn-' + featureId);
    const isHidden = list[0].style.display === 'none';
    list.forEach(el => el.style.display = isHidden ? 'flex' : 'none');
    btn.innerText = isHidden ? 'Ver menos' : 'Ver más (+' + list.length + ')';
  }
  function discardChanges(file) {
    vscode.postMessage({ command: 'discardChanges', file });
  }
  function applyStash(index) {
    vscode.postMessage({ command: 'applyStash', index });
  }
</script>
</body>
</html>`;

    function escapeHtml(str: string): string {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
  }

  private _featureCard(f: Feature, s: VersionControlState): string {
    const isOpen = f.status === 'active' || f.status === 'open';
    const isClosed = f.status === 'closed';

    const statusClass = isOpen ? 'status-active' : (isClosed ? 'status-closed' : 'status-integrated');
    const statusLabel = isOpen ? 'Activa' : (isClosed ? 'Cerrada' : f.status);
    const isActive = s.currentFeature?.id === f.id;

    const commitLines = f.commits.map((c, i) => `
            <div class="commit-line ${i >= 4 ? 'extra-' + f.id : ''}" style="${i >= 4 ? 'display:none' : ''}">
                <div class="commit-dot" style="background-color: ${c.isOnServer ? 'var(--ok)' : 'var(--err)'}; ${!c.isOnServer ? 'cursor:pointer' : ''}" 
                     ${!c.isOnServer ? `onclick="unassignCommit('${c.sha}')" title="Quitar de esta feature"` : ''}>
                    ${!c.isOnServer ? '<span class="commit-remove">×</span>' : ''}
                </div>
                <span class="commit-sha">${c.shortSha}</span>
                <span class="commit-msg">${c.message}</span>
                ${c.metadata ? `<span class="commit-vv">VV✓</span>` : ''}
            </div>
        `).join('');

    const moreBtn = f.commits.length > 4
      ? `<button class="btn-link" id="btn-${f.id}" onclick="toggleExpansion('${f.id}')" style="font-size:10px; margin-top:4px">Ver más (+${f.commits.length - 4})</button>`
      : '';

    return `
        <div class="feature-card">
            <div class="feature-card-header">
                <span class="feature-id">${f.id}</span>
                <span class="sha-chip">${f.headSha.substring(0, 8)}</span>
                <span class="feature-status ${statusClass}">${statusLabel}</span>
            </div>
            <div class="feature-card-body">
                <div style="flex:1">
                    <div class="feature-meta" style="margin-bottom:6px">
                        Start: <span class="sha-chip">${f.startSha.substring(0, 8)}</span>
                        &nbsp;|&nbsp; ${f.commits.length} commit(s)
                    </div>
                    ${commitLines}
                    ${moreBtn}
                </div>
                <div style="display: flex; flex-direction: column; gap: 4px;">
                    <button class="btn btn-sm" onclick="send('commitWithVector', { featureId: '${f.id}' })">
                        ⊙ Commit VV
                    </button>
                    ${f.status === 'active' || f.status === 'open' ? `
                    <button class="btn btn-sm" onclick="closeFeature('${f.id}')">
                        Cerrar
                    </button>` : `
                    <button class="btn btn-sm btn-ghost" onclick="openFeature('${f.id}')">
                        Abrir
                    </button>`}
                    <button class="btn btn-sm btn-danger" onclick="deleteFeature('${f.id}')">
                        Eliminar
                    </button>
                    ${!isActive ? `
                    <button class="btn btn-sm btn-success" onclick="flattenFeature('${f.id}')">
                        ⬆ Aplanar
                    </button>` : ''}
                </div>
            </div>
        </div>`;
  }

  private _orphanCard(c: import('../config/types').EnrichedCommit): string {
    return `
        <div class="feature-card" style="border-left: 3px solid var(--warn);">
            <div class="feature-card-body" style="justify-content: space-between;">
                <div>
                    <span class="sha-chip">${c.shortSha}</span>
                    <span style="font-size: 12px; margin-left: 8px;">${c.message}</span>
                </div>
                <button class="btn btn-sm btn-ghost" onclick="assignCommit('${c.sha}')">
                    Asociar a Feature...
                </button>
            </div>
        </div>`;
  }

  private _conflictCard(c: ConflictInfo): string {
    return `
        <div class="conflict-card">
            <div class="conflict-title">⚠ Conflicto Semántico Concurrente</div>
            <div>Commit A: <span style="font-family:var(--font-mono);color:var(--info)">${c.commitA.substring(0, 10)}</span></div>
            <div>Commit B: <span style="font-family:var(--font-mono);color:var(--info)">${c.commitB.substring(0, 10)}</span></div>
            <div class="conflict-files">Archivos: ${c.filesAffected.join(', ')}</div>
            <div style="color:var(--fg2);font-size:10px;margin-top:4px">Detectado: ${c.detectedAt}</div>
        </div>`;
  }

  private _fileCard(f: import('../config/types').GitFileStatus, isStaged: boolean): string {
    const color = f.status === 'M' || f.status === ' M' ? 'var(--warn)' : f.status === 'D' || f.status === ' D' ? 'var(--err)' : 'var(--ok)';
    return `
        <div style="display:flex; justify-content:space-between; align-items:center; padding: 4px; border-bottom: 1px solid var(--border);">
            <div>
                <span style="color: ${color}; font-weight: bold; margin-right: 8px;">${f.status.trim()}</span>
                <span>${f.path}</span>
            </div>
            <div>
                ${isStaged ? `
                <button class="btn btn-sm btn-ghost" title="Unstage" onclick="unstageFile('${f.path}')">-</button>
                ` : `
                <button class="btn btn-sm btn-ghost" title="Discard" onclick="discardChanges('${f.path}')">↺</button>
                <button class="btn btn-sm btn-ghost" title="Stage" onclick="stageFile('${f.path}')">+</button>
                `}
            </div>
        </div>`;
  }

  private _stashCard(st: import('../config/types').GitStash): string {
    return `
        <div style="display:flex; justify-content:space-between; align-items:center; padding: 4px; border-bottom: 1px solid var(--border);">
            <div>
                <span class="sha-chip">stash@{${st.index}}</span>
                <span style="font-size: 11px; margin-left: 4px;">${st.message.substring(0, 30)}...</span>
            </div>
            <button class="btn btn-sm btn-ghost" title="Apply" onclick="applyStash(${st.index})">Aplicar</button>
        </div>`;
  }

  dispose(): void {
    VersionControlWebviewPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
  }
}
