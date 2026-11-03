import * as vscode from 'vscode';
import { ConfigManager } from '../config/ConfigManager';
import { ServerState, WatcherState } from '../config/types';
import { DeployedApp } from '../modules/server/ServerManager';
import { AgenteHotReloadManager } from '../modules/hotreload/AgenteHotReloadManager';
import { HotReloadClient } from '../modules/hotreload/HotReloadClient';

type ServerGroupId = 'quick' | 'agent' | 'maintenance' | 'config';

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

/** Nodo agrupador colapsable real (reemplaza los separadores de texto anteriores) */
class ServerGroupItem extends vscode.TreeItem {
    constructor(
        public readonly groupId: ServerGroupId,
        label: string,
        iconId: string,
        collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Collapsed
    ) {
        super(label, collapsibleState);
        this.iconPath = new vscode.ThemeIcon(iconId);
        this.contextValue = 'mm43ServerGroup';
    }
}

/** Nodo padre colapsable para la seccion de apps desplegadas */
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

/** Nodo hijo representando una aplicacion desplegada */
class DeployedAppItem extends vscode.TreeItem {
    constructor(public readonly app: DeployedApp) {
        super(app.name, vscode.TreeItemCollapsibleState.None);
        this.description = `<${app.type}>`;
        this.iconPath = new vscode.ThemeIcon('globe');
        this.contextValue = 'mm43DeployedApp';
        this.tooltip = `Aplicacion: ${app.name}\nTipo: ${app.type}\n\nClic derecho para Undeploy`;
    }
}

/**
 * TreeDataProvider para el panel "Servidor" en el sidebar.
 * Muestra el estado del servidor, del watcher y del pipeline Hot-Reload
 * (cola de compilacion + conexion viva con el agente JVM), y las acciones
 * agrupadas por frecuencia de uso (flujo diario vs avanzado).
 */
export class ServerProvider implements vscode.TreeDataProvider<vscode.TreeItem> {

    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private serverState: ServerState = 'unknown';
    private watcherState: WatcherState = 'stopped';
    private deployedApps: DeployedApp[] = [];
    private deployedAppsLoaded = false;

    /** Resultado del ultimo ping TCP al agente Hot-Reload (independiente de si esta "configurado") */
    private agentAlive = false;

    /** Callback para obtener la lista de apps — se inyecta desde Context.ts */
    private listAppsFn: (() => Promise<DeployedApp[]>) | undefined;

    constructor() {
        ConfigManager.onDidChange(() => this.refresh());
        // Cualquier cambio en la cola de compilacion Hot-Reload refresca el panel en vivo
        AgenteHotReloadManager.onQueueChange(() => this.refresh());
    }

    /** Inyectar la funcion que lista apps del servidor */
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

    /**
     * Verifica si el agente Hot-Reload responde en el puerto TCP configurado.
     * Se llama periodicamente desde Context.ts mientras el servidor esta activo,
     * y tras acciones que pueden afectar la conexion (start/restart/importar agente).
     */
    async refreshAgentStatus(): Promise<void> {
        const agentPath = ConfigManager.getAgentPath();
        const agentMode = ConfigManager.getAgentMode();

        if (!agentPath || agentMode === 'none') {
            this.agentAlive = false;
            this.refresh();
            return;
        }

        this.agentAlive = await HotReloadClient.isAgentAlive();
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        const { serverPath, domain } = ConfigManager.getServerConfig();

        // ── Si no hay configuracion, solo mostrar boton de agregar ──
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
            if (!this.deployedAppsLoaded && this.listAppsFn) {
                this.deployedApps = await this.listAppsFn();
                this.deployedAppsLoaded = true;
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

        // ── Sub-nodos de cada grupo colapsable ─────────────────────────
        if (element instanceof ServerGroupItem) {
            return this.buildGroupChildren(element.groupId);
        }

        // ── Raiz del arbol ──────────────────────────────────────────────
        return [
            this.buildServerStatusItem(),
            this.buildWatcherStatusItem(),
            this.buildAgentStatusItem(),
            this.buildQueueStatusItem(),
            new ServerGroupItem('quick', 'Acciones Rapidas', 'rocket', vscode.TreeItemCollapsibleState.Expanded),
            new DeployedAppsParentItem(this.deployedAppsLoaded ? this.deployedApps.length : undefined),
            new ServerGroupItem('agent', 'Agente Hot-Reload', 'zap'),
            new ServerGroupItem('maintenance', 'Mantenimiento', 'wrench'),
            new ServerGroupItem('config', 'Configuracion', 'settings-gear'),
        ];
    }

    private buildGroupChildren(groupId: ServerGroupId): vscode.TreeItem[] {
        switch (groupId) {
            case 'quick':
                return [
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
                ];

            case 'agent':
                return this.buildAgentActions();

            case 'maintenance':
                return [
                    new ServerActionItem('Consultar Estado del Servidor', {
                        command: 'mm43.checkServerStatus', title: 'Consultar Estado'
                    }, 'pulse'),
                    new ServerActionItem('Agregar Proyecto al Servidor', {
                        command: 'mm43.deployExploded', title: 'Agregar Proyecto'
                    }, 'add'),
                    new ServerActionItem('Limpiar Caches', {
                        command: 'mm43.clearServerCache', title: 'Limpiar Caches'
                    }, 'trash'),
                    new ServerActionItem('Limpiar server.log', {
                        command: 'mm43.clearServerLogs', title: 'Limpiar server.log'
                    }, 'close'),
                ];

            case 'config':
                return [
                    new ServerActionItem('Configurar/Cambiar Servidor', {
                        command: 'mm43.addServer', title: 'Configurar Servidor'
                    }, 'edit'),
                    new ServerActionItem('Eliminar Configuracion de Servidor', {
                        command: 'mm43.removeServer', title: 'Eliminar Servidor'
                    }, 'trash'),
                ];

            default:
                return [];
        }
    }

    // ── Nodos de estado (raiz, siempre visibles) ───────────────────────

    private buildServerStatusItem(): vscode.TreeItem {
        const { serverPath, domain } = ConfigManager.getServerConfig();
        const item = new vscode.TreeItem(this.getServerLabel(), vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(this.getServerIcon());
        item.description = `${domain} @ ${serverPath}`;
        item.contextValue = 'mm43ServerStatus';
        return item;
    }

    private buildWatcherStatusItem(): vscode.TreeItem {
        const label = this.watcherState === 'running'
            ? 'Watcher Java: Activo'
            : 'Watcher Java: Detenido';
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(this.watcherState === 'running' ? 'eye' : 'eye-closed');
        item.contextValue = 'mm43WatcherStatus';
        return item;
    }

    /** Indicador vivo de la cola interna de AgenteHotReloadManager (debounce + compilacion) */
    private buildQueueStatusItem(): vscode.TreeItem {
        const queueSize = AgenteHotReloadManager.getQueueSize();
        const lastResult = AgenteHotReloadManager.getLastResult();

        let label: string;
        let icon: string;

        if (queueSize > 0) {
            label = `Cola Hot-Reload: ${queueSize} pendiente${queueSize === 1 ? '' : 's'}`;
            icon = 'sync~spin';
        } else if (lastResult) {
            const secs = Math.max(0, Math.round((Date.now() - lastResult.timestamp) / 1000));
            label = `Cola Hot-Reload: vacia (ultimo hace ${secs}s)`;
            icon = lastResult.success ? 'check' : 'error';
        } else {
            label = 'Cola Hot-Reload: vacia';
            icon = 'check';
        }

        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(icon);
        if (lastResult) {
            const separadorIndex = Math.max(lastResult.file.lastIndexOf('\\'), lastResult.file.lastIndexOf('/'));
            const nombre = lastResult.file.substring(separadorIndex + 1);
            item.tooltip = `Ultimo archivo: ${nombre}\nResultado: ${lastResult.success ? 'OK' : 'ERROR'}`;
        }
        item.contextValue = 'mm43QueueStatus';
        return item;
    }

    /** Estado de conexion real con el agente JVM (distinto de "esta configurado") */
    private buildAgentStatusItem(): vscode.TreeItem {
        const agentPath = ConfigManager.getAgentPath();
        const agentMode = ConfigManager.getAgentMode();

        if (!agentPath || agentMode === 'none') {
            const item = new vscode.TreeItem('Agente Hot-Reload: No importado', vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('circle-slash');
            item.contextValue = 'mm43AgentStatus';
            return item;
        }

        const modeLabel = agentMode === 'dcevm' ? 'DCEVM (Completo)' : 'Basico';
        const label = this.agentAlive
            ? `Agente: ${modeLabel} - Conectado`
            : `Agente: ${modeLabel} - Sin respuesta`;
        const icon = this.agentAlive
            ? (agentMode === 'dcevm' ? 'zap' : 'warning')
            : 'debug-disconnect';

        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(icon);
        item.tooltip = `Ruta: ${agentPath}\nModo: ${modeLabel}\nConexion: ${this.agentAlive ? 'activa' : 'sin respuesta'}`;
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
            new ServerActionItem('Cambiar Agente', {
                command: 'mm43.importAgent', title: 'Cambiar Agente'
            }, 'cloud-download'),
            new ServerActionItem('Inyectar Agente en Servidor (asadmin)', {
                command: 'mm43.injectAgentOptions', title: 'Inyectar Opciones'
            }, 'plug'),
            new ServerActionItem('Abrir domain.xml (Config manual)', {
                command: 'mm43.openDomainXml', title: 'Abrir domain.xml'
            }, 'code'),
            new ServerActionItem('Eliminar Agente', {
                command: 'mm43.removeAgent', title: 'Eliminar Agente'
            }, 'trash'),
        ];
    }

    private getServerLabel(): string {
        switch (this.serverState) {
            case 'running': return 'Servidor: Activo';
            case 'starting': return 'Servidor: Iniciando';
            case 'stopping': return 'Servidor: Deteniendo';
            case 'stopped': return 'Servidor: Detenido';
            default: return 'Servidor: Desconocido';
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
