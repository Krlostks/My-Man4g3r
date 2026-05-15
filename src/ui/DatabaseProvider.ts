import * as vscode from 'vscode';
import { AsadminDatabaseManager } from '../modules/database/AsadminDatabaseManager';
import { PersistenceScanner } from '../modules/database/PersistenceScanner';
import { JdbcPool, JdbcResource, PersistenceUnit, PoolStatus } from '../modules/database/types';
import { Logger } from '../modules/logger/Logger';

/* ─── Nodos del arbol ────────────────────────────────────────────────── */

/** Nodo de seccion (Pools / Resources) */
class DatabaseSectionItem extends vscode.TreeItem {
    constructor(
        label: string,
        public readonly section: 'pools' | 'resources',
        count?: number
    ) {
        super(
            count !== undefined ? `${label} (${count})` : label,
            vscode.TreeItemCollapsibleState.Expanded
        );
        this.iconPath = new vscode.ThemeIcon(
            section === 'pools' ? 'server-process' : 'plug'
        );
        this.contextValue = `mm43Db${section.charAt(0).toUpperCase() + section.slice(1)}Section`;
    }
}

/** Nodo que representa un Connection Pool */
class PoolItem extends vscode.TreeItem {
    constructor(
        public readonly pool: JdbcPool
    ) {
        super(pool.name, vscode.TreeItemCollapsibleState.None);
        this.description = pool.datasourceClassname || undefined;
        this.iconPath = new vscode.ThemeIcon(PoolItem.iconForStatus(pool.status));
        this.contextValue = 'mm43DbPool';
        this.tooltip = `Pool: ${pool.name}\nEstado: ${pool.status}\nClase: ${pool.datasourceClassname || 'N/A'}`;
    }

    private static iconForStatus(status: PoolStatus): string {
        switch (status) {
            case 'active':   return 'pass-filled';
            case 'inactive': return 'circle-slash';
            case 'error':    return 'error';
            default:         return 'question';
        }
    }
}

/** Nodo que representa un JDBC Resource existente en el servidor */
class ResourceItem extends vscode.TreeItem {
    constructor(
        public readonly resource: JdbcResource
    ) {
        super(resource.jndiName, vscode.TreeItemCollapsibleState.None);
        this.description = resource.poolName ? `-> ${resource.poolName}` : undefined;
        this.contextValue = 'mm43DbResource';
        this.iconPath = new vscode.ThemeIcon('link');
        this.tooltip = `Recurso JDBC: ${resource.jndiName}\nPool: ${resource.poolName || 'N/A'}`;
    }
}

/**
 * Nodo que representa un recurso requerido por persistence.xml
 * que NO existe como recurso global en el servidor.
 */
class MissingResourceItem extends vscode.TreeItem {
    constructor(
        public readonly unit: PersistenceUnit
    ) {
        const label = unit.globalJndiName;
        super(label, vscode.TreeItemCollapsibleState.None);

        this.contextValue = 'mm43DbResourceMissing';
        this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));

        if (unit.scope === 'app-scoped') {
            this.description = `${unit.projectName} (migrar de java:app/)`;
            this.tooltip =
                `RECURSO FALTANTE (requiere migracion)\n` +
                `Proyecto: ${unit.projectName}\n` +
                `PU: ${unit.unitName}\n\n` +
                `JNDI original: ${unit.jtaDataSource}\n` +
                `JNDI global:   ${unit.globalJndiName}\n\n` +
                `El persistence.xml usa el prefijo java:app/ que define\n` +
                `un recurso de ambito de aplicacion (via glassfish-resources.xml).\n\n` +
                `Para gestionarlo desde MM43:\n` +
                `1. Haga clic en (+) para crear el pool y recurso global\n` +
                `2. Cambie el persistence.xml para usar: ${unit.globalJndiName}\n` +
                `3. Elimine glassfish-resources.xml si ya no lo necesita`;
        } else {
            this.description = unit.projectName;
            this.tooltip =
                `RECURSO FALTANTE\n` +
                `Proyecto: ${unit.projectName}\n` +
                `PU: ${unit.unitName}\n` +
                `JNDI: ${unit.globalJndiName}\n\n` +
                `Requerido por el codigo pero no existe en el servidor.\n` +
                `Haga clic en (+) para crear el pool y recurso.`;
        }
    }
}

/** Nodo informativo */
class EmptyStateItem extends vscode.TreeItem {
    constructor(message: string, commandId?: string) {
        super(message, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('info');
        if (commandId) {
            this.command = { command: commandId, title: message };
        }
    }
}

/* ─── Provider ───────────────────────────────────────────────────────── */

/**
 * TreeDataProvider para la vista "Bases de Datos" en el sidebar de MM43.
 *
 * Estructura:
 *   [Pools]
 *     - PoolName (icono segun ping)
 *   [Resources]
 *     - jdbc/nombre      (existente, icono link)
 *     - jdbc/faltante     (faltante, icono warning + info de migracion)
 */
export class DatabaseProvider implements vscode.TreeDataProvider<vscode.TreeItem> {

    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private pools: JdbcPool[] = [];
    private resources: JdbcResource[] = [];
    private requiredUnits: PersistenceUnit[] = [];
    private poolStatuses: Map<string, PoolStatus> = new Map();
    private loaded = false;

    refresh(): void {
        this.loaded = false;
        this._onDidChangeTreeData.fire();
    }

    /** Fuerza la recarga de datos desde el servidor */
    async reload(): Promise<void> {
        Logger.info('DATABASE', 'Recargando datos de Pools y Resources...');

        // Leer persistence.xml de los proyectos
        this.requiredUnits = PersistenceScanner.scanAll();

        // Consultar el servidor
        this.pools = await AsadminDatabaseManager.listPools();
        this.resources = await AsadminDatabaseManager.listResources();

        // Enriquecer recursos con el poolName
        for (const res of this.resources) {
            res.poolName = await AsadminDatabaseManager.getResourcePoolName(res.jndiName);
        }

        this.loaded = true;
        this._onDidChangeTreeData.fire();
    }

    /** Actualiza el estado de un pool tras un ping */
    updatePoolStatus(poolName: string, status: PoolStatus): void {
        this.poolStatuses.set(poolName, status);
        const pool = this.pools.find(p => p.name === poolName);
        if (pool) {
            pool.status = status;
        }
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        // Carga lazy al expandir por primera vez
        if (!this.loaded) {
            try {
                await this.reload();
            } catch {
                return [new EmptyStateItem('Error al conectar con el servidor')];
            }
        }

        // ── Raiz: mostrar secciones ──────────────────────────────────────
        if (!element) {
            return [
                new DatabaseSectionItem('Pools', 'pools', this.pools.length),
                new DatabaseSectionItem('Resources', 'resources', this.resources.length),
            ];
        }

        // ── Hijos de la seccion "Pools" ─────────────────────────────────
        if (element instanceof DatabaseSectionItem && element.section === 'pools') {
            if (this.pools.length === 0) {
                return [new EmptyStateItem('No hay pools registrados')];
            }
            return this.pools.map(p => {
                const cached = this.poolStatuses.get(p.name);
                if (cached) { p.status = cached; }
                return new PoolItem(p);
            });
        }

        // ── Hijos de la seccion "Resources" ─────────────────────────────
        if (element instanceof DatabaseSectionItem && element.section === 'resources') {
            const items: vscode.TreeItem[] = [];

            // Recursos existentes en el servidor (globales)
            for (const res of this.resources) {
                items.push(new ResourceItem(res));
            }

            // Recursos requeridos por persistence.xml pero que NO existen globalmente.
            // Se compara usando globalJndiName (el nombre normalizado sin java:app/).
            const existingNames = new Set(this.resources.map(r => r.jndiName));
            for (const unit of this.requiredUnits) {
                if (!existingNames.has(unit.globalJndiName)) {
                    items.push(new MissingResourceItem(unit));
                }
            }

            if (items.length === 0) {
                return [new EmptyStateItem('No hay recursos JDBC')];
            }

            return items;
        }

        return [];
    }
}
