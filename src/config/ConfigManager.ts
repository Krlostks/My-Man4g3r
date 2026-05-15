import * as vscode from 'vscode';
import { ProjectConfig, ServerConfig } from './types';

const SECTION = 'mm43';

export class ConfigManager {

    static getProjects(): ProjectConfig[] {
        const config = vscode.workspace.getConfiguration(SECTION);
        return config.get<ProjectConfig[]>('projects', []);
    }

    static async saveProjects(projects: ProjectConfig[]): Promise<void> {
        const config = vscode.workspace.getConfiguration(SECTION);
        await config.update('projects', projects, vscode.ConfigurationTarget.Workspace);
    }

    static async addProject(project: ProjectConfig): Promise<void> {
        const projects = this.getProjects();
        const idx = projects.findIndex(p => p.name === project.name);
        if (idx >= 0) {
            projects[idx] = project;
        } else {
            projects.push(project);
        }
        await this.saveProjects(projects);
    }

    static async removeProject(name: string): Promise<void> {
        const projects = this.getProjects().filter(p => p.name !== name);
        await this.saveProjects(projects);
    }

    static getServerConfig(): ServerConfig {
        const config = vscode.workspace.getConfiguration(SECTION);
        return {
            serverPath: config.get<string>('serverPath', ''),
            serverType: config.get<string>('serverType', 'glassfish'),
            domain: config.get<string>('serverDomain', ''),
        };
    }

    static getJdkPath(): string {
        const path = vscode.workspace.getConfiguration(SECTION).get<string>(
            'jdkPath',
            'C:\\Java\\jdk1.8.0_181\\bin\\javac.exe'
        );
        return path.trim().replace(/[\r\n]/g, '');
    }

    static getHotReloadPort(): number {
        return vscode.workspace.getConfiguration(SECTION).get<number>('hotReloadPort', 9999);
    }

    static getAgentPath(): string {
        return vscode.workspace.getConfiguration(SECTION).get<string>('agentPath', '');
    }

    static getAgentMode(): string {
        return vscode.workspace.getConfiguration(SECTION).get<string>('agentMode', 'none');
    }

    static async setAgentPath(agentPath: string): Promise<void> {
        const config = vscode.workspace.getConfiguration(SECTION);
        await config.update('agentPath', agentPath, vscode.ConfigurationTarget.Workspace);
    }

    static async setAgentMode(mode: string): Promise<void> {
        const config = vscode.workspace.getConfiguration(SECTION);
        await config.update('agentMode', mode, vscode.ConfigurationTarget.Workspace);
    }

    static async removeAgent(): Promise<void> {
        const config = vscode.workspace.getConfiguration(SECTION);
        await config.update('agentPath', undefined, vscode.ConfigurationTarget.Workspace);
        await config.update('agentMode', undefined, vscode.ConfigurationTarget.Workspace);
    }

    static onDidChange(callback: () => void): vscode.Disposable {
        return vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(SECTION)) {
                callback();
            }
        });
    }

    static async updateProjectClasspath(projectName: string, classpath: string): Promise<void> {
        const projects = this.getProjects();
        const idx = projects.findIndex(p => p.name === projectName);
        if (idx >= 0) {
            projects[idx].classpath = classpath;
            await this.saveProjects(projects);
        }
    }
}
