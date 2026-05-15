import * as vscode from 'vscode';
import { ServerState, WatcherState } from '../config/types';

/**
 * Administra los ítems del Status Bar de VS Code para MM43.
 * Muestra el estado del Watcher de Java y del servidor Payara.
 */
export class StatusBarManager {
    private watcherItem: vscode.StatusBarItem;
    private serverItem: vscode.StatusBarItem;

    private watcherState: WatcherState = 'stopped';
    private serverState: ServerState = 'unknown';

    constructor() {
        this.watcherItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left, 102
        );
        this.serverItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left, 101
        );

        this.renderWatcher();
        this.renderServer();

        this.watcherItem.show();
        this.serverItem.show();
    }

    // ─── Watcher de Java ─────────────────────────────────────────────────────

    setWatcherState(state: WatcherState): void {
        this.watcherState = state;
        this.renderWatcher();
    }

    private renderWatcher(): void {
        switch (this.watcherState) {
            case 'running':
                this.watcherItem.text = '$(eye) Watcher: ON';
                this.watcherItem.tooltip = 'MM43: Watcher Java activo — click para detener';
                this.watcherItem.command = 'mm43.stopWatcher';
                this.watcherItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                break;
            case 'error':
                this.watcherItem.text = '$(warning) Watcher: ERROR';
                this.watcherItem.tooltip = 'MM43: Error en el watcher — click para reiniciar';
                this.watcherItem.command = 'mm43.startWatcher';
                this.watcherItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                break;
            default: // stopped
                this.watcherItem.text = '$(eye-closed) Watcher: OFF';
                this.watcherItem.tooltip = 'MM43: Watcher Java detenido — click para iniciar';
                this.watcherItem.command = 'mm43.startWatcher';
                this.watcherItem.backgroundColor = undefined;
        }
    }

    // ─── Servidor Payara ─────────────────────────────────────────────────────

    setServerState(state: ServerState): void {
        this.serverState = state;
        this.renderServer();
    }

    private renderServer(): void {
        switch (this.serverState) {
            case 'running':
                this.serverItem.text = '$(server) Payara: ON';
                this.serverItem.tooltip = 'MM43: Servidor Payara activo — click para ver logs';
                this.serverItem.command = 'mm43.showServerLogs';
                this.serverItem.backgroundColor = undefined;
                break;
            case 'starting':
                this.serverItem.text = '$(loading~spin) Payara: Iniciando...';
                this.serverItem.tooltip = 'MM43: Iniciando servidor Payara';
                this.serverItem.command = undefined;
                this.serverItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                break;
            case 'stopping':
                this.serverItem.text = '$(loading~spin) Payara: Deteniendo...';
                this.serverItem.tooltip = 'MM43: Deteniendo servidor Payara';
                this.serverItem.command = undefined;
                this.serverItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                break;
            case 'stopped':
                this.serverItem.text = '$(server) Payara: OFF';
                this.serverItem.tooltip = 'MM43: Servidor detenido — click para iniciar';
                this.serverItem.command = 'mm43.startServer';
                this.serverItem.backgroundColor = undefined;
                break;
            default: // unknown
                this.serverItem.text = '$(server) Payara: ?';
                this.serverItem.tooltip = 'MM43: Estado del servidor desconocido';
                this.serverItem.command = 'mm43.startServer';
                this.serverItem.backgroundColor = undefined;
        }
    }

    dispose(): void {
        this.watcherItem.dispose();
        this.serverItem.dispose();
    }
}
