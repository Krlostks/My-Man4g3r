import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigManager } from '../config/ConfigManager';
import { ProjectConfig } from '../config/types';

type ProjectItemKind = 'project' | 'action';

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
            this.tooltip = `Proyecto Maven: ${project.rootPath}${project.classpath ? '\n(Classpath Generado  )' : ''}`;
            this.iconPath = new vscode.ThemeIcon('package');
            this.contextValue = 'mm43Project';
        } else {
            this.command = command;
            this.iconPath = iconId ? new vscode.ThemeIcon(iconId) : undefined;
            this.contextValue = 'mm43ProjectAction';
        }
    }
}

export class ProjectsProvider implements vscode.TreeDataProvider<ProjectItem> {

    private _onDidChangeTreeData = new vscode.EventEmitter<ProjectItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor() {
        ConfigManager.onDidChange(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ProjectItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ProjectItem): ProjectItem[] {
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
                return [emptyItem as unknown as ProjectItem];
            }
            return projects.map(p => new ProjectItem(p));
        }

        const p = element.project;
        return [
            new ProjectItem(p, 'action', '▶ Run (Build + Deploy)', {
                command: 'mm43.runProject',
                title: 'Run',
                arguments: [p.name],
            }, 'play'),
            new ProjectItem(p, 'action', 'Build Exploded', {
                command: 'mm43.buildProject',
                title: 'Build Exploded',
                arguments: [p.name],
            }, 'tools'),
            new ProjectItem(p, 'action', 'Clean Install', {
                command: 'mm43.installProject',
                title: 'Clean Install',
                arguments: [p.name],
            }, 'package'),
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
            new ProjectItem(p, 'action', 'Eliminar proyecto', {
                command: 'mm43.removeProject',
                title: 'Eliminar Proyecto',
                arguments: [{ project: p }],
            }, 'trash'),
        ];
    }
}
