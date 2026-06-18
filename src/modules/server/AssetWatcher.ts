import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../../config/ConfigManager';
import { ProjectConfig } from '../../config/types';
import { AgenteHotReloadManager } from '../hotreload/AgenteHotReloadManager';
import { Logger } from '../logger/Logger';

export class AssetWatcher {
    private saveListener?: vscode.Disposable;

    constructor(private isServerRunning?: () => boolean) {
        // Registrar el listener de guardado global desde el inicio
        this.initSaveListener();
    }

    setPaused(paused: boolean): void {
        // No-op para mantener compatibilidad, el comportamiento real se rige por el estado del servidor
    }

    private initSaveListener(): void {
        if (this.saveListener) {
            return;
        }

        this.saveListener = vscode.workspace.onDidSaveTextDocument((document: vscode.TextDocument) => {
            // SOLO funciona si el servidor está en ejecución (running)
            if (this.isServerRunning && !this.isServerRunning()) {
                return;
            }

            const filename = document.fileName;

            // Ignorar archivos temporales, auto-guardados o irrelevantes
            if (filename.endsWith('.swp') || filename.endsWith('~') || path.basename(filename).startsWith('.')) {
                return;
            }

            const projects = ConfigManager.getProjects();

            // Buscar si el archivo pertenece a algún proyecto configurado
            const project = projects.find(p => filename.toLowerCase().startsWith(p.rootPath.toLowerCase()));

            if (!project) { return; }

            const webappSrc = path.join(project.rootPath, 'src', 'main', 'webapp');
            const webappSrcJava = path.join(project.rootPath, 'src', 'main', 'java');

            // Verificar si es un cambio webapp (xhtml, css, etc)
            if (filename.toLowerCase().startsWith(webappSrc.toLowerCase())) {
                const relativeFilename = path.relative(webappSrc, filename);
                this.syncFile(project, webappSrc, relativeFilename);
            }
            // Verificar si es un cambio en código Java (dentro del src/main/java)
            else if (filename.toLowerCase().startsWith(webappSrcJava.toLowerCase()) && filename.endsWith('.java')) {
                AgenteHotReloadManager.cambioEnCaliente(filename, project);
            }
        });

        Logger.info('WATCHER', '▶ Listener global de Ctrl+S activo y pendiente del servidor.');
    }

    startAll(): boolean {
        // No-op: Siempre está activo si el servidor está running
        this.initSaveListener();
        return true;
    }

    startForProject(project: ProjectConfig): void {
        // No-op por compatibilidad
    }

    stopForProject(projectName: string): void {
        // No-op por compatibilidad
    }

    stopAll(): void {
        // No-op: No detenemos el listener físico para que siga reaccionando al Ctrl+S independientemente de la UI
    }

    get activeProjects(): string[] {
        return ConfigManager.getProjects().map(p => p.name);
    }

    private syncFile(
        project: ProjectConfig,
        webappSrc: string,
        relativeFilename: string
    ): void {
        const srcFile = path.join(webappSrc, relativeFilename);
        const targetExploded = path.join(project.rootPath, 'target', project.warName);
        const destFile = path.join(targetExploded, relativeFilename);

        try {
            if (!fs.existsSync(srcFile)) { return; }

            const stats = fs.lstatSync(srcFile);
            if (!stats.isFile()) { return; }

            const destDir = path.dirname(destFile);
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }

            fs.copyFileSync(srcFile, destFile);

            const now = new Date();
            fs.utimesSync(destFile, now, now);

            Logger.info('WATCHER', `${project.name} | Sync (Guardado): ${relativeFilename} -> ${destFile}`);
            vscode.window.setStatusBarMessage(`  Sync: ${path.basename(relativeFilename)}`, 3000);
        } catch (err) {
            Logger.error('WATCHER', `${project.name} | ERROR copiando ${relativeFilename}: ${err}`);
        }
    }

    dispose(): void {
        if (this.saveListener) {
            this.saveListener.dispose();
            this.saveListener = undefined;
        }
    }
}
