import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../../config/ConfigManager';
import { ProjectConfig } from '../../config/types';
import { AgenteHotReloadManager } from '../hotreload/AgenteHotReloadManager';
import { Logger } from '../logger/Logger';

export class AssetWatcher {
    private isPaused: boolean = false;
    private saveListener?: vscode.Disposable;

    constructor() {
        // En el nuevo modelo, la instancia no hace nada hasta que se llame a startAll()
    }

    setPaused(paused: boolean): void {
        this.isPaused = paused;
        if (paused) {
            Logger.info('WATCHER', '⏸ Sincronización al guardar pausada.');
        } else {
            Logger.info('WATCHER', '▶ Sincronización al guardar reanudada.');
        }
    }

    startAll(): boolean {
        if (this.saveListener) {
            return true;
        }

        this.saveListener = vscode.workspace.onDidSaveTextDocument((document: vscode.TextDocument) => {
            if (this.isPaused) { return; }

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

        Logger.info('WATCHER', '▶ Watcher global activado: reaccionará a Ctrl+S en archivos del proyecto.');
        return true;
    }

    startForProject(project: ProjectConfig): void {
        // Por compatibilidad con comandos antiguos
        this.startAll();
    }

    stopForProject(projectName: string): void {
        // No-op en este nuevo paradigma
    }

    stopAll(): void {
        if (this.saveListener) {
            this.saveListener.dispose();
            this.saveListener = undefined;
            Logger.info('WATCHER', 'Watcher global de guardado (Ctrl+S) detenido.');
        }
    }

    get activeProjects(): string[] {
        // En el nuevo modelo, todos los proyectos configurados están "activos"
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
            vscode.window.setStatusBarMessage(`✅ Sync: ${path.basename(relativeFilename)}`, 3000);
        } catch (err) {
            Logger.error('WATCHER', `${project.name} | ERROR copiando ${relativeFilename}: ${err}`);
        }
    }

    dispose(): void {
        this.stopAll();
    }
}
