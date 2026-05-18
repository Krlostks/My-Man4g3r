import * as vscode from 'vscode';
import { ConfigManager } from '../config/ConfigManager';
import { ServerState, WatcherState } from '../config/types';
import { DeployedApp } from '../modules/server/ServerManager';

type ServerActionKind = 'status' | 'action';

class ServerActionItem extends vscode.TreeItem {
    constructor(
        label: string,
        command?: vscode.Command,
        iconId?: string,
        description?: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.command = command;
        this.iconPath = iconId ? new vscode.ThemeIcon(iconId) : undefined;
        this.description = description;
        this.contextValue = 'mm43ServerAction';
    }
}

/** Nodo padre colapsable para la sección de apps desplegadas */
class DeployedAppsParentItem extends vscode.TreeItem {
    constructor(appCount?: number) {
        const label = appCount !== undefined
            ? `Aplicaciones Desplegadas (${appCount})`
            : 'Aplicaciones Desplegadas';
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.contextValue = 'mm43DeployedAppsParent';
        this.iconPath = new vscode.ThemeIcon('cloud');
    }
}

/** Nodo hijo representando una aplicación desplegada */
class DeployedAppItem extends vscode.TreeItem {
    constructor(public readonly app: DeployedApp) {
        super(app.name, vscode.TreeItemCollapsibleState.None);
        this.description = `<${app.type}>`;
        this.iconPath = new vscode.ThemeIcon('globe');
        this.contextValue = 'mm43DeployedApp';
        this.tooltip = `Aplicación: ${app.name}\nTipo: ${app.type}\n\nClic derecho → Undeploy`;
    }
}

/**
 * TreeDataProvider para el panel "Servidor Payara" en el sidebar.
 * Muestra el estado del servidor y las acciones disponibles.
 */
export class ServerProvider implements vscode.TreeDataProvider<vscode.TreeItem> {

    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private serverState: ServerState = 'unknown';
    private watcherState: WatcherState = 'stopped';
    private deployedApps: DeployedApp[] = [];
    private deployedAppsLoaded = false;

    /** Callback para obtener la lista de apps — se inyecta desde Context.ts */
    private listAppsFn: (() => Promise<DeployedApp[]>) | undefined;

    constructor() {
        ConfigManager.onDidChange(() => this.refresh());
    }

    /** Inyectar la función que lista apps del servidor */
    setListAppsFn(fn: () => Promise<DeployedApp[]>): void {
        this.listAppsFn = fn;
    }

    setServerState(state: ServerState): void {
        this.serverState = state;
        this.refresh();
    }

    setWatcherState(state: WatcherState): void {
        this.watcherState = state;
        this.refresh();
    }

    /** Refresca las aplicaciones desplegadas consultando al servidor */
    async refreshDeployedApps(): Promise<void> {
        if (this.listAppsFn) {
            this.deployedApps = await this.listAppsFn();
            this.deployedAppsLoaded = true;
        }
        this._onDidChangeTreeData.fire();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        const { serverPath, domain } = ConfigManager.getServerConfig();

        // ── Si no hay configuración, solo mostrar botón de agregar ──
        if (!serverPath || !domain) {
            return [
                new ServerActionItem('Configurar Servidor de Aplicaciones', {
                    command: 'mm43.addServer', title: 'Configurar Servidor'
                }, 'add'),
                new vscode.TreeItem('Estado: No configurado', vscode.TreeItemCollapsibleState.None)
            ];
        }

        // ── Sub-nodos del padre "Aplicaciones Desplegadas" ────────────
        if (element instanceof DeployedAppsParentItem) {
            // Cargar lazily la primera vez que se expande
            if (!this.deployedAppsLoaded && this.listAppsFn) {
                this.deployedApps = await this.listAppsFn();
                this.deployedAppsLoaded = true;
                // Re-fire para actualizar el conteo en el parent label
                setTimeout(() => this._onDidChangeTreeData.fire(), 100);
            }

            if (this.deployedApps.length === 0) {
                const empty = new vscode.TreeItem(
                    'No hay aplicaciones desplegadas',
                    vscode.TreeItemCollapsibleState.None
                );
                empty.iconPath = new vscode.ThemeIcon('info');
                return [empty];
            }

            return this.deployedApps.map(app => new DeployedAppItem(app));
        }

        // ── Raíz del árbol ────────────────────────────────────────────
        const serverLabel = this.getServerLabel();

        const statusItem = new vscode.TreeItem(serverLabel, vscode.TreeItemCollapsibleState.None);
        statusItem.iconPath = new vscode.ThemeIcon(this.getServerIcon());
        statusItem.description = `${domain} @ ${serverPath}`;
        statusItem.contextValue = 'mm43ServerStatus';

        const watcherLabel = this.watcherState === 'running'
            ? 'Watcher Java: ACTIVO'
            : 'Watcher Java: DETENIDO';
        const watcherItem = new vscode.TreeItem(watcherLabel, vscode.TreeItemCollapsibleState.None);
        watcherItem.contextValue = 'mm43WatcherStatus';

        const separator = new vscode.TreeItem('─────────────────', vscode.TreeItemCollapsibleState.None);

        // ── Nodo desplegable de apps ──────────────────────────────────
        const deployedParent = new DeployedAppsParentItem(
            this.deployedAppsLoaded ? this.deployedApps.length : undefined
        );

        return [
            statusItem,
            watcherItem,
            this.buildAgentStatusItem(),
            separator,
            deployedParent,
            new vscode.TreeItem('─────────────────', vscode.TreeItemCollapsibleState.None),
            // Acciones del servidor
            new ServerActionItem('Consultar Estado del Servidor', {
                command: 'mm43.checkServerStatus', title: 'Consultar Estado'
            }, 'pulse'),
            new ServerActionItem('Iniciar Servidor', {
                command: 'mm43.startServer', title: 'Iniciar Servidor'
            }, 'play'),
            new ServerActionItem('Detener Servidor', {
                command: 'mm43.stopServer', title: 'Detener Servidor'
            }, 'debug-stop'),
            new ServerActionItem('Redeploy Completo', {
                command: 'mm43.restartServer', title: 'Redeploy Completo'
            }, 'refresh'),
            new ServerActionItem('Ver Logs', {
                command: 'mm43.showServerLogs', title: 'Ver Logs'
            }, 'output'),
            new ServerActionItem('Limpiar Caches', {
                command: 'mm43.clearServerCache', title: 'Limpiar Caches'
            }, 'trash'),
            new ServerActionItem('Limpiar server.log', {
                command: 'mm43.clearServerLogs', title: 'Limpiar server.log'
            }, 'close'),
            new ServerActionItem('Agregar Proyecto al Servidor', {
                command: 'mm43.deployExploded', title: 'Agregar Proyecto'
            }, 'add'),
            new vscode.TreeItem('── Agente Hot-Reload ──', vscode.TreeItemCollapsibleState.None),
            ...this.buildAgentActions(),
            new vscode.TreeItem('─────────────────', vscode.TreeItemCollapsibleState.None),
            new ServerActionItem('Configurar/Cambiar Servidor', {
                command: 'mm43.addServer', title: 'Configurar Servidor'
            }, 'edit'),
            new ServerActionItem('Eliminar Configuración de Servidor', {
                command: 'mm43.removeServer', title: 'Eliminar Servidor'
            }, 'trash'),
        ];
    }

    private buildAgentStatusItem(): vscode.TreeItem {
        const agentPath = ConfigManager.getAgentPath();
        const agentMode = ConfigManager.getAgentMode();

        if (!agentPath || agentMode === 'none') {
            const item = new vscode.TreeItem('Agente: No importado', vscode.TreeItemCollapsibleState.None);
            item.contextValue = 'mm43AgentStatus';
            return item;
        }

        const modeLabel = agentMode === 'dcevm' ? 'DCEVM (Completo)' : 'Básico';
        const icon = agentMode === 'dcevm' ? '$(zap)' : '$(warning)';
        const item = new vscode.TreeItem(`${icon} Agente: ${modeLabel}`, vscode.TreeItemCollapsibleState.None);
        item.tooltip = `Ruta: ${agentPath}\nModo: ${modeLabel}`;
        item.contextValue = 'mm43AgentStatus';
        return item;
    }

    private buildAgentActions(): vscode.TreeItem[] {
        const agentPath = ConfigManager.getAgentPath();
        const agentMode = ConfigManager.getAgentMode();

        if (!agentPath || agentMode === 'none') {
            return [
                new ServerActionItem('Importar Agente', {
                    command: 'mm43.importAgent', title: 'Importar Agente'
                }, 'cloud-download'),
            ];
        }

        return [
            new ServerActionItem('$(cloud-download) Cambiar Agente', {
                command: 'mm43.importAgent', title: 'Cambiar Agente'
            }, 'cloud-download'),
            new ServerActionItem('$(zap) Inyectar Agente en Servidor (asadmin)', {
                command: 'mm43.injectAgentOptions', title: 'Inyectar Opciones'
            }, 'zap'),
            new ServerActionItem('$(code) Abrir domain.xml (Config manual)', {
                command: 'mm43.openDomainXml', title: 'Abrir domain.xml'
            }, 'code'),
            new ServerActionItem('$(trash) Eliminar Agente', {
                command: 'mm43.removeAgent', title: 'Eliminar Agente'
            }, 'trash'),
        ];
    }

    private getServerLabel(): string {
        switch (this.serverState) {
            case 'running': return 'Servidor: ACTIVO';
            case 'starting': return 'Servidor: Iniciando...';
            case 'stopping': return 'Servidor: Deteniendo...';
            case 'stopped': return 'Servidor: DETENIDO';
            default: return 'Servidor: ?';
        }
    }

    private getServerIcon(): string {
        switch (this.serverState) {
            case 'running': return 'pass-filled';
            case 'starting':
            case 'stopping': return 'loading~spin';
            case 'stopped': return 'circle-slash';
            default: return 'question';
        }
    }
}
