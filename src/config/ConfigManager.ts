import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
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
        // 1. Obtener la ruta configurada en la extensión
        let configuredPath = vscode.workspace.getConfiguration(SECTION).get<string>('jdkPath', '').trim().replace(/[\r\n]/g, '');

        if (configuredPath) {
            if (fs.existsSync(configuredPath)) {
                try {
                    const stat = fs.statSync(configuredPath);
                    if (stat.isDirectory()) {
                        const javacPath = path.join(configuredPath, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
                        if (fs.existsSync(javacPath)) {
                            return javacPath;
                        }
                    } else {
                        return configuredPath;
                    }
                } catch (e) {
                    // Ignorar error al verificar stats y continuar
                }
            } else if (configuredPath.toLowerCase() === 'javac' || configuredPath.toLowerCase() === 'javac.exe') {
                const resolved = this.findJavacInPath();
                if (resolved) { return resolved; }
            }
        }

        // 2. Intentar obtener el JDK desde el AS_JAVA del servidor
        const { serverPath } = this.getServerConfig();
        if (serverPath) {
            const candidates = [
                path.join(serverPath, 'glassfish', 'config', 'asenv.bat'),
                path.join(serverPath, 'config', 'asenv.bat'),
            ];
            for (const asenvPath of candidates) {
                if (fs.existsSync(asenvPath)) {
                    try {
                        const content = fs.readFileSync(asenvPath, 'utf-8');
                        const match = content.match(/^\s*set\s+AS_JAVA\s*=\s*(.+)\s*$/mi);
                        if (match) {
                            const javaHome = match[1].trim().replace(/"/g, '');
                            const javacPath = path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
                            if (fs.existsSync(javacPath)) {
                                return javacPath;
                            }
                        }
                    } catch (e) {
                        // Ignorar errores leyendo asenv.bat
                    }
                }
            }
        }

        // 3. Intentar obtenerlo desde la variable de entorno JAVA_HOME
        const envJavaHome = process.env.JAVA_HOME;
        if (envJavaHome) {
            const javacPath = path.join(envJavaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
            if (fs.existsSync(javacPath)) {
                return javacPath;
            }
        }

        // 4. Intentar obtenerlo desde la configuración estándar de extensiones de Java en VS Code
        const javaHomeConfig = vscode.workspace.getConfiguration('java').get<string>('home') ||
            vscode.workspace.getConfiguration('java.jdt.ls.java').get<string>('home');
        if (javaHomeConfig) {
            const javacPath = path.join(javaHomeConfig, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
            if (fs.existsSync(javacPath)) {
                return javacPath;
            }
        }

        // 5. Buscar en la variable de entorno PATH del sistema
        const resolved = this.findJavacInPath();
        if (resolved) {
            return resolved;
        }

        // 6. Fallback final a 'javac'
        return 'javac';
    }

    private static findJavacInPath(): string | undefined {
        const pathEnv = process.env.PATH || '';
        const delimiter = process.platform === 'win32' ? ';' : ':';
        const pathDirs = pathEnv.split(delimiter);
        const exeName = process.platform === 'win32' ? 'javac.exe' : 'javac';
        for (const dir of pathDirs) {
            const fullPath = path.join(dir, exeName);
            try {
                if (fs.existsSync(fullPath)) {
                    return fullPath;
                }
            } catch (e) {
                // Ignorar directorios inaccesibles en el PATH
            }
        }
        return undefined;
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
