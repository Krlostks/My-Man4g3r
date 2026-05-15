import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { ConfigManager } from '../../config/ConfigManager';
import { ProjectConfig, ServerState } from '../../config/types';
import { Logger } from '../logger/Logger';
import { ServerValidator } from './ServerValidator';

import { AgenteHotReloadManager } from '../hotreload/AgenteHotReloadManager';
import { AssetWatcher } from './AssetWatcher';

export interface DeployedApp {
    name: string;
    type: string;
}

type StateChangeCallback = (state: ServerState) => void;

export class ServerManager {
    private serverTerminal: vscode.Terminal | undefined;
    private onStateChange: StateChangeCallback;
    private assetWatcher: AssetWatcher | undefined;
    private currentState: ServerState = 'stopped';

    constructor(onStateChange: StateChangeCallback) {
        this.onStateChange = (state) => {
            this.currentState = state;
            onStateChange(state);
        };
    }

    getServerState(): ServerState {
        return this.currentState;
    }

    setAssetWatcher(watcher: AssetWatcher): void {
        Logger.debug('DEBUG', 'setAssetWatcher invocado');
        this.assetWatcher = watcher;
    }

    private setWatchersPaused(paused: boolean): void {
        Logger.debug('DEBUG', `setWatchersPaused invocado (paused: ${paused})`);
        if (this.assetWatcher) {
            this.assetWatcher.setPaused(paused);
        }
        AgenteHotReloadManager.setPaused(paused);
    }

    private get asadmin(): string {
        const { serverPath, domain } = ConfigManager.getServerConfig();
        if (!serverPath || !domain) {
            throw new Error('El servidor no está configurado. Use el botón "Configurar Servidor".');
        }
        const asadminPath = ServerValidator.getAsadminPath(serverPath);
        if (!asadminPath) {
            throw new Error(`No se pudo encontrar asadmin en la ruta: ${serverPath}`);
        }
        return asadminPath;
    }

    private get domainPath(): string {
        const { serverPath, domain } = ConfigManager.getServerConfig();
        let domainsDir = path.join(serverPath, 'glassfish', 'domains');
        if (!fs.existsSync(domainsDir)) {
            domainsDir = path.join(serverPath, 'domains');
        }
        return path.join(domainsDir, domain);
    }

    private get domain(): string {
        return ConfigManager.getServerConfig().domain;
    }

    private getTerminal(name: string): vscode.Terminal {
        Logger.debug('DEBUG', `getTerminal invocado para: ${name}`);
        const existing = vscode.window.terminals.find(t => t.name === name);
        if (existing) { return existing; }
        return vscode.window.createTerminal({ name });
    }

    start(): void {
        Logger.debug('DEBUG', 'start invocado');
        const { serverPath, domain } = ConfigManager.getServerConfig();
        if (!serverPath || !domain) {
            vscode.window.showErrorMessage('[MM43] Servidor no configurado. Use el botón "Configurar Servidor".');
            return;
        }

        const validation = ServerValidator.validate(serverPath);
        if (!validation.valid) {
            vscode.window.showErrorMessage(`[MM43] Error de configuración: ${validation.error}`);
            return;
        }

        this.setWatchersPaused(true);
        this.onStateChange('starting');
        Logger.info('SERVER', `Iniciando Servidor (dominio: ${this.domain})...`);
        Logger.show();

        const term = this.getTerminal('MM43 — Server');
        term.show();

        const cmd = `& "${this.asadmin}" start-domain --debug ${this.domain}`;
        Logger.debug('DEBUG', `Enviando comando de arranque: ${cmd}`);
        term.sendText(cmd);

        this.serverTerminal = term;
        vscode.window.onDidCloseTerminal(t => {
            if (t === this.serverTerminal) {
                Logger.debug('DEBUG', 'Terminal de servidor cerrada detectada');
                this.onStateChange('stopped');
                Logger.warn('SERVER', 'Terminal del servidor cerrada.');
            }
        });

        setTimeout(() => {
            Logger.debug('DEBUG', 'Cambiando estado a running (timeout 12s)');
            this.onStateChange('running');
            this.setWatchersPaused(false);
            Logger.info('SERVER', 'Servidor iniciado.');
        }, 12000);
    }

    stop(): void {
        Logger.debug('DEBUG', 'stop invocado');
        this.setWatchersPaused(true);
        this.onStateChange('stopping');
        Logger.info('SERVER', 'Deteniendo Servidor...');
        Logger.show();

        const term = this.getTerminal('MM43 — Server Stop');
        term.show();
        const cmd = `& "${this.asadmin}" stop-domain ${this.domain}`;
        Logger.debug('DEBUG', `Enviando comando de detención: ${cmd}`);
        term.sendText(cmd);

        setTimeout(() => {
            Logger.debug('DEBUG', 'Cambiando estado a stopped (timeout 5s)');
            this.onStateChange('stopped');
            this.setWatchersPaused(false);
            Logger.info('SERVER', 'Servidor detenido.');
        }, 5000);
    }

    stopSync(): void {
        Logger.debug('DEBUG', 'stopSync invocado (deactivate)');
        const { serverPath, domain } = ConfigManager.getServerConfig();
        if (!serverPath || !domain) { return; }

        const asadminPath = path.join(serverPath, 'bin', 'asadmin.bat');
        if (!fs.existsSync(asadminPath)) { return; }

        const { execSync } = require('child_process');
        try {
            console.log(`[MM43] Deteniendo servidor ${domain} antes de cerrar...`);
            Logger.debug('DEBUG', 'Ejecutando stop-domain síncrono...');
            execSync(`"${asadminPath}" stop-domain ${domain}`, {
                stdio: 'ignore',
                timeout: 10000
            });
        } catch (e) {
            Logger.debug('DEBUG', `Error o timeout en stopSync: ${String(e)}`);
        }
    }

    async deployProject(project: ProjectConfig): Promise<void> {
        Logger.debug('DEBUG', `deployProject invocado para: ${project.name}`);
        const targetExploded = path.join(project.rootPath, 'target', project.warName);

        if (!fs.existsSync(targetExploded)) {
            Logger.error('SERVER', `Directorio exploded no encontrado: ${targetExploded}`);
            vscode.window.showErrorMessage(`[MM43] No se encontró el directorio exploded en: ${targetExploded}. Ejecute un Build primero.`);
            return;
        }

        Logger.section(`Deploy Exploded: ${project.name}`);
        Logger.info('SERVER', `Desplegando ${project.name} desde ${targetExploded}...`);
        Logger.show();

        const cmd = `& "${this.asadmin}" deploy --force --name ${project.warName} "${targetExploded}"`;
        Logger.debug('DEBUG', `Comando de deploy: ${cmd}`);

        const term = this.getTerminal(`MM43 — Deploy ${project.name}`);
        term.show();
        term.sendText(cmd);
        term.sendText(`Write-Host "[MM43] Despliegue de ${project.warName} enviado al servidor." -ForegroundColor Cyan`);
    }

    sync(projectName: string): void {
        Logger.debug('DEBUG', `sync invocado para: ${projectName}`);
        const projects = ConfigManager.getProjects();
        const project = projects.find(p => p.name === projectName);
        if (!project) {
            Logger.error('SERVER', `Proyecto ${projectName} no encontrado para sync`);
            vscode.window.showErrorMessage(`[MM43] Proyecto '${projectName}' no encontrado.`);
            return;
        }

        const targetExploded = path.join(project.rootPath, 'target', project.warName);
        const srcWebapp = path.join(project.rootPath, 'src', 'main', 'webapp');

        if (!fs.existsSync(srcWebapp)) {
            Logger.warn('SERVER', `No existe la carpeta webapp en ${srcWebapp}`);
            return;
        }

        Logger.info('SERVER', `Sincronizando estáticos: ${projectName} (src → target)`);
        Logger.show();

        const term = this.getTerminal(`MM43 — Sync ${projectName}`);
        term.show();
        const cmd = `xcopy "${srcWebapp}\\*" "${targetExploded}\\" /S /E /Y /I /Q`;
        Logger.debug('DEBUG', `Comando de sync (xcopy): ${cmd}`);
        term.sendText(cmd);
        term.sendText(`Write-Host "[MM43] Sync estático de ${projectName} completado." -ForegroundColor Green`);
    }

    fullRedeploy(projectName: string): void {
        Logger.debug('DEBUG', `fullRedeploy invocado para: ${projectName}`);
        const projects = ConfigManager.getProjects();
        const project = projects.find(p => p.name === projectName);
        if (!project) return;

        this.setWatchersPaused(true);
        this.onStateChange('stopping');
        Logger.section(`Redeploy completo: ${projectName}`);

        const term = this.getTerminal(`MM43 — Redeploy ${projectName}`);
        term.show();

        Logger.debug('DEBUG', 'Enviando ráfaga de comandos para full redeploy...');
        term.sendText(`& "${this.asadmin}" stop-domain ${this.domain}`);
        term.sendText(`Remove-Item -Recurse -Force "${this.domainPath}\\osgi-cache\\*" -ErrorAction SilentlyContinue`);
        term.sendText(`Remove-Item -Recurse -Force "${this.domainPath}\\generated\\*" -ErrorAction SilentlyContinue`);
        const targetExploded = path.join(project.rootPath, 'target', project.warName);
        term.sendText(`Set-Location "${project.rootPath}"`);
        term.sendText(`mvnd clean install -DskipTests war:exploded`);
        term.sendText(`& "${this.asadmin}" start-domain --debug ${this.domain}`);
        term.sendText(`& "${this.asadmin}" redeploy --name ${project.warName} "${targetExploded}"`);
        term.sendText(`Write-Host "[MM43] Redeploy de ${projectName} terminado." -ForegroundColor Cyan`);

        setTimeout(() => {
            Logger.debug('DEBUG', 'Cambiando estado a running tras fullRedeploy (timeout 25s)');
            this.onStateChange('running');
            this.setWatchersPaused(false);
        }, 25000);
    }

    listApplications(): Promise<DeployedApp[]> {
        Logger.debug('DEBUG', 'listApplications invocado');
        return new Promise((resolve) => {
            const cmd = `"${this.asadmin}" list-applications`;
            Logger.info('SERVER', `Consultando aplicaciones desplegadas...`);

            Logger.debug('DEBUG', `Ejecutando exec: ${cmd}`);
            exec(cmd, { timeout: 15000 }, (error, stdout, stderr) => {
                if (error) {
                    Logger.error('SERVER', `Error al listar aplicaciones: ${error.message}`);
                    resolve([]);
                    return;
                }

                const apps: DeployedApp[] = [];
                const lines = stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0);

                for (const line of lines) {
                    if (line.startsWith('Command') || line.startsWith('Nothing') || line.startsWith('No applications')) {
                        continue;
                    }

                    const match = line.match(/^(\S+)\s*<(.+)>$/);
                    if (match) {
                        apps.push({ name: match[1], type: match[2].trim() });
                    } else if (!line.includes(' ') && line.length > 0) {
                        apps.push({ name: line, type: 'unknown' });
                    }
                }

                Logger.debug('DEBUG', `Parseadas ${apps.length} aplicaciones`);
                Logger.info('SERVER', `${apps.length} aplicación(es) encontrada(s).`);
                resolve(apps);
            });
        });
    }

    undeploy(appName: string): Promise<boolean> {
        Logger.debug('DEBUG', `undeploy invocado para: ${appName}`);
        return new Promise((resolve) => {
            const cmd = `"${this.asadmin}" undeploy ${appName}`;
            Logger.section(`Undeploy: ${appName}`);
            Logger.debug('DEBUG', `Ejecutando exec: ${cmd}`);
            exec(cmd, { timeout: 30000 }, (error, stdout, stderr) => {
                if (error) {
                    Logger.error('SERVER', `Error al ejecutar undeploy: ${error.message}`);
                    resolve(false);
                    return;
                }
                Logger.info('SERVER', `✅ Undeploy de '${appName}' exitoso.`);
                resolve(true);
            });
        });
    }
}
