import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ConfigManager } from '../../config/ConfigManager';
import { ProjectConfig } from '../../config/types';
import { AgenteHotReloadManager } from '../hotreload/AgenteHotReloadManager';
import { Logger } from '../logger/Logger';

const DEBOUNCE_MS = 300;

export class AssetWatcher {
    private watchers: Map<string, fs.FSWatcher[]> = new Map();
    private pendingTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private lastHashes: Map<string, string> = new Map();
    private isPaused: boolean = false;

    setPaused(paused: boolean): void {
        this.isPaused = paused;
        if (paused) {
            Logger.info('WATCHER', '⏸ Sincronización estática pausada.');
        } else {
            Logger.info('WATCHER', '▶ Sincronización estática reanudada.');
        }
    }

    startAll(): boolean {
        const projects = ConfigManager.getProjects();
        if (projects.length === 0) {
            vscode.window.showWarningMessage('[MM43] No hay proyectos configurados para vigilar.');
            return false;
        }
        for (const project of projects) {
            this.startForProject(project);
        }
        return true;
    }

    startForProject(project: ProjectConfig): void {
        const webappSrc = path.join(project.rootPath, 'src', 'main', 'webapp');
        const webappSrcJava = path.join(project.rootPath, 'src', 'main', 'java');

        if (!fs.existsSync(webappSrc)) {
            Logger.warn('WATCHER', `${project.name}: directorio webapp no encontrado: ${webappSrc}`);
            return;
        }

        if (this.watchers.has(project.name)) {
            Logger.info('WATCHER', `${project.name}: ya está vigilado.`);
            return;
        }

        Logger.info('WATCHER', `${project.name}: vigilando ${webappSrc}`);
        const targetExploded = path.join(project.rootPath, 'target', project.warName);
        Logger.info('WATCHER', `${project.name}: destino   ${targetExploded}`);

        const webappWatcher = fs.watch(webappSrc, { recursive: true }, (event, filename) => {
            if (this.isPaused || !filename) { return; }
            if (filename.endsWith('.swp') || filename.endsWith('~') || filename.startsWith('.')) {
                return;
            }

            const fullPath = path.join(webappSrc, filename);
            if (this.isIdentical(fullPath)) { return; }

            this.debounce(`webapp:${project.name}:${filename}`, () => {
                this.syncFile(project, webappSrc, filename, event);
            });
        });

        const list = [webappWatcher];

        if (fs.existsSync(webappSrcJava)) {
            const javaWatcher = fs.watch(webappSrcJava, { recursive: true }, (event, filename) => {
                if (this.isPaused || !filename) { return; }
                if (filename.endsWith('.swp') || filename.endsWith('~') || filename.startsWith('.')) {
                    return;
                }
                this.debounce(`java:${project.name}:${filename}`, () => {
                    AgenteHotReloadManager.cambioEnCaliente(filename, project);
                });
            });
            list.push(javaWatcher);
        }
        this.watchers.set(project.name, list);
    }

    stopForProject(projectName: string): void {
        const list = this.watchers.get(projectName);
        if (list) {
            list.forEach(w => w.close());
            this.watchers.delete(projectName);
            Logger.info('WATCHER', `${projectName}: detenido.`);
        }
    }

    stopAll(): void {
        for (const [name] of this.watchers) {
            this.stopForProject(name);
        }
        for (const timer of this.pendingTimers.values()) {
            clearTimeout(timer);
        }
        this.pendingTimers.clear();
        Logger.info('WATCHER', 'Todos los watchers detenidos.');
    }

    get activeProjects(): string[] {
        return Array.from(this.watchers.keys());
    }

    private debounce(key: string, action: () => void): void {
        const existing = this.pendingTimers.get(key);
        if (existing) { clearTimeout(existing); }

        const timer = setTimeout(() => {
            this.pendingTimers.delete(key);
            action();
        }, 500);

        this.pendingTimers.set(key, timer);
    }

    private isIdentical(filePath: string): boolean {
        try {
            if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) { return false; }
            const content = fs.readFileSync(filePath);
            const hash = crypto.createHash('md5').update(content).digest('hex');
            const lastHash = this.lastHashes.get(filePath);
            if (lastHash === hash) { return true; }
            this.lastHashes.set(filePath, hash);
            return false;
        } catch (e) {
            return false;
        }
    }

    private syncFile(
        project: ProjectConfig,
        webappSrc: string,
        relativeFilename: string,
        event: string
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

            Logger.info('WATCHER', `${project.name} | Sync: ${relativeFilename} -> ${destFile}`);
        } catch (err) {
            Logger.error('WATCHER', `${project.name} | ERROR copiando ${relativeFilename}: ${err}`);
        }
    }

    dispose(): void {
        this.stopAll();
    }
}
