import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigManager } from '../config/ConfigManager';
import { ProjectConfig } from '../config/types';

type ProjectItemKind = 'project' | 'action';
type ProjectGroupId = 'quick' | 'advanced';

export class ProjectItem extends vscode.TreeItem {
    constructor(
        public readonly project: ProjectConfig,
        public readonly kind: ProjectItemKind = 'project',
        label?: string,
        command?: vscode.Command,
        iconId?: string
    ) {
        super(
            label ?? project.name,
            kind === 'project'
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );

        if (kind === 'project') {
            this.description = path.basename(project.rootPath);
            this.tooltip = `Proyecto Maven: ${project.rootPath}${project.classpath ? '\n(Classpath generado)' : ''}`;
            this.iconPath = new vscode.ThemeIcon('package');
            this.contextValue = 'mm43Project';
        } else {
            this.command = command;
            this.iconPath = iconId ? new vscode.ThemeIcon(iconId) : undefined;
            this.contextValue = 'mm43ProjectAction';
        }
    }
}

/** Nodo agrupador dentro de un proyecto: separa flujo diario de opciones avanzadas de Maven */
export class ProjectGroupItem extends vscode.TreeItem {
    constructor(
        public readonly project: ProjectConfig,
        public readonly groupId: ProjectGroupId
    ) {
        const label = groupId === 'quick' ? 'Acciones Rapidas' : 'Maven Avanzado';
        super(
            label,
            groupId === 'quick'
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed
        );
        this.iconPath = new vscode.ThemeIcon(groupId === 'quick' ? 'rocket' : 'tools');
        this.contextValue = 'mm43ProjectGroup';
    }
}

export class ProjectsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {

    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor() {
        ConfigManager.onDidChange(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
        if (!element) {
            const projects = ConfigManager.getProjects();
            if (projects.length === 0) {
                const emptyItem = new vscode.TreeItem(
                    'No hay proyectos configurados',
                    vscode.TreeItemCollapsibleState.None
                );
                emptyItem.iconPath = new vscode.ThemeIcon('info');
                emptyItem.command = {
                    command: 'mm43.addProject',
                    title: 'Agregar primer proyecto',
                };
                return [emptyItem];
            }
            return projects.map(p => new ProjectItem(p));
        }

        // Nivel proyecto: dos grupos + accion destructiva aparte
        if (element instanceof ProjectItem && element.kind === 'project') {
            const p = element.project;
            return [
                new ProjectGroupItem(p, 'quick'),
                new ProjectGroupItem(p, 'advanced'),
                new ProjectItem(p, 'action', 'Eliminar proyecto', {
                    command: 'mm43.removeProject',
                    title: 'Eliminar Proyecto',
                    arguments: [{ project: p }],
                }, 'trash'),
            ];
        }

        // Contenido de cada grupo
        if (element instanceof ProjectGroupItem) {
            const p = element.project;

            if (element.groupId === 'quick') {
                return [
                    new ProjectItem(p, 'action', 'Run (Build + Deploy)', {
                        command: 'mm43.runProject',
                        title: 'Run',
                        arguments: [p.name],
                    }, 'play'),
                    new ProjectItem(p, 'action', 'Clean Install', {
                        command: 'mm43.installProject',
                        title: 'Clean Install',
                        arguments: [p.name],
                    }, 'package'),
                ];
            }

            // advanced
            return [
                new ProjectItem(p, 'action', 'Build Exploded', {
                    command: 'mm43.buildProject',
                    title: 'Build Exploded',
                    arguments: [p.name],
                }, 'tools'),
                new ProjectItem(p, 'action', 'Actualizar Dependencias (-U)', {
                    command: 'mm43.updateDependencies',
                    title: 'Actualizar Dependencias',
                    arguments: [p.name],
                }, 'cloud-download'),
                new ProjectItem(p, 'action', 'Exportar WAR', {
                    command: 'mm43.exportWar',
                    title: 'Exportar WAR',
                    arguments: [p.name],
                }, 'export'),
                new ProjectItem(p, 'action', 'Generar Classpath', {
                    command: 'mm43.generateClasspath',
                    title: 'Generar Classpath',
                    arguments: [{ project: p }],
                }, 'library'),
            ];
        }

        return [];
    }
}
