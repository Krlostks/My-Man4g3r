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

// Tiempos estimados (ms) — ajusta si tu servidor es más lento/rápido
const TIMEOUT_START_MS  = 15_000;
const TIMEOUT_STOP_MS   =  6_000;

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
        this.assetWatcher = watcher;
    }

    // ─────────────────────────────────────────────
    // BLOQUE 1: Helpers privados
    // ─────────────────────────────────────────────

    private setWatchersPaused(paused: boolean): void {
        this.assetWatcher?.setPaused(paused);
        AgenteHotReloadManager.setPaused(paused);
    }

    /** Ruta resuelta de asadmin (lanza si no configurado). */
    private get asadmin(): string {
        const { serverPath, domain } = ConfigManager.getServerConfig();
        if (!serverPath || !domain) {
            throw new Error('Servidor no configurado. Use "Configurar Servidor".');
        }
        const p = ServerValidator.getAsadminPath(serverPath);
        if (!p) {
            throw new Error(`asadmin no encontrado en: ${serverPath}`);
        }
        return p;
    }

    private get domain(): string {
        return ConfigManager.getServerConfig().domain;
    }

    private get domainPath(): string {
        const { serverPath, domain } = ConfigManager.getServerConfig();
        const candidates = [
            path.join(serverPath, 'glassfish', 'domains', domain),
            path.join(serverPath, 'domains', domain),
        ];
        return candidates.find(fs.existsSync) ?? candidates[0];
    }

    /** Reutiliza terminal existente o crea una nueva. */
    private getTerminal(name: string): vscode.Terminal {
        return vscode.window.terminals.find(t => t.name === name)
            ?? vscode.window.createTerminal({ name });
    }

    // ─────────────────────────────────────────────
    // BLOQUE 2: Ciclo de vida del servidor
    // ─────────────────────────────────────────────

    start(): void {
        const { serverPath, domain } = ConfigManager.getServerConfig();
        if (!serverPath || !domain) {
            vscode.window.showErrorMessage('[MM43] Servidor no configurado.');
            return;
        }

        const validation = ServerValidator.validate(serverPath);
        if (!validation.valid) {
            vscode.window.showErrorMessage(`[MM43] ${validation.error}`);
            return;
        }

        this.setWatchersPaused(true);
        this.onStateChange('starting');
        Logger.section('Iniciar Servidor');
        Logger.info('SERVER', `Iniciando dominio: ${this.domain}`);
        Logger.show();

        const term = this.getTerminal('MM43 — Server');
        term.show();
        term.sendText(`& "${this.asadmin}" start-domain --debug ${this.domain}`);
        this.serverTerminal = term;

        vscode.window.onDidCloseTerminal(t => {
            if (t === this.serverTerminal) {
                this.onStateChange('stopped');
                Logger.warn('SERVER', 'Terminal del servidor cerrada.');
            }
        });

        setTimeout(() => {
            this.onStateChange('running');
            this.setWatchersPaused(false);
            Logger.info('SERVER', '✅ Servidor iniciado.');
        }, TIMEOUT_START_MS);
    }

    stop(): void {
        this.setWatchersPaused(true);
        this.onStateChange('stopping');
        Logger.section('Detener Servidor');
        Logger.info('SERVER', `Deteniendo dominio: ${this.domain}`);
        Logger.show();

        const term = this.getTerminal('MM43 — Server Stop');
        term.show();
        term.sendText(`& "${this.asadmin}" stop-domain ${this.domain}`);

        setTimeout(() => {
            this.onStateChange('stopped');
            this.setWatchersPaused(false);
            Logger.info('SERVER', '✅ Servidor detenido.');
        }, TIMEOUT_STOP_MS);
    }

    /** Detención síncrona al desactivar la extensión. */
    stopSync(): void {
        const { serverPath, domain } = ConfigManager.getServerConfig();
        if (!serverPath || !domain) { return; }

        const asadminPath = ServerValidator.getAsadminPath(serverPath);
        if (!asadminPath) { return; }

        const { execSync } = require('child_process');
        try {
            execSync(`"${asadminPath}" stop-domain ${domain}`, {
                stdio: 'ignore',
                timeout: 10_000,
            });
        } catch (_) { /* ignorar en deactivate */ }
    }

    // ─────────────────────────────────────────────
    // BLOQUE 3: Despliegue
    // ─────────────────────────────────────────────

    /**
     * Deploy inteligente: usa `redeploy` si la app ya existe, `deploy` si no.
     * Llama a esto DESPUÉS de buildExploded().
     */
    async smartDeploy(project: ProjectConfig): Promise<void> {
        const targetExploded = path.join(project.rootPath, 'target', project.warName);

        if (!fs.existsSync(targetExploded)) {
            Logger.error('SERVER', `Exploded no encontrado: ${targetExploded}`);
            vscode.window.showErrorMessage(
                `[MM43] Carpeta exploded no existe en ${targetExploded}. Ejecuta Build primero.`
            );
            return;
        }

        const apps = await this.listApplications();
        const exists = apps.some(a => a.name === project.warName);

        Logger.section(`${exists ? 'Redeploy' : 'Deploy'}: ${project.name}`);
        Logger.info('SERVER', `${exists ? 'Redeployando' : 'Deployando'} ${project.warName} desde exploded...`);
        Logger.show();

        const term = this.getTerminal(`MM43 — Deploy ${project.name}`);
        term.show();

        if (exists) {
            term.sendText(`& "${this.asadmin}" redeploy --name ${project.warName} "${targetExploded}"`);
        } else {
            term.sendText(`& "${this.asadmin}" deploy --name ${project.warName} "${targetExploded}"`);
        }

        term.sendText(
            `Write-Host "[MM43] ${exists ? 'Redeploy' : 'Deploy'} de ${project.warName} enviado." -ForegroundColor Cyan`
        );
    }

    /**
     * Flujo RUN completo: buildExploded → smartDeploy.
     * Equivale al botón "Run" de IntelliJ/Eclipse con servidor GlassFish.
     * Llama externamente a MavenManager.buildExploded() antes de invocar esto,
     * o usa runProject() del Context que orquesta todo.
     */
    async deployAfterBuild(project: ProjectConfig): Promise<void> {
        await this.smartDeploy(project);
    }

    /**
     * Redeploy completo con limpieza de caches: stop → clean cache → build → start → deploy.
     * Uso: cuando hay cambios estructurales grandes o el servidor está en estado inconsistente.
     */
    fullRedeploy(project: ProjectConfig): void {
        this.setWatchersPaused(true);
        this.onStateChange('stopping');
        Logger.section(`Redeploy Completo: ${project.name}`);
        Logger.show();

        const targetExploded = path.join(project.rootPath, 'target', project.warName);
        const term = this.getTerminal(`MM43 — Redeploy ${project.name}`);
        term.show();

        // 1) Detener servidor
        term.sendText(`& "${this.asadmin}" stop-domain ${this.domain}`);
        // 2) Limpiar caches
        term.sendText(`Remove-Item -Recurse -Force "${this.domainPath}\\osgi-cache\\*" -ErrorAction SilentlyContinue`);
        term.sendText(`Remove-Item -Recurse -Force "${this.domainPath}\\generated\\*" -ErrorAction SilentlyContinue`);
        // 3) Build exploded
        term.sendText(`Set-Location "${project.rootPath}"`);
        term.sendText(`mvnd compile war:exploded -DskipTests`);
        // 4) Iniciar servidor
        term.sendText(`& "${this.asadmin}" start-domain --debug ${this.domain}`);
        // 5) Redeploy (la app ya existe si llegamos aquí desde fullRedeploy)
        term.sendText(`& "${this.asadmin}" redeploy --name ${project.warName} "${targetExploded}"`);
        term.sendText(`Write-Host "[MM43] ✅ Redeploy completo de ${project.warName} terminado." -ForegroundColor Cyan`);

        // Estado optimista tras tiempo estimado (start + build + redeploy)
        const estimatedMs = TIMEOUT_START_MS + 15_000;
        setTimeout(() => {
            this.onStateChange('running');
            this.setWatchersPaused(false);
            Logger.info('SERVER', '✅ Servidor listo tras redeploy completo.');
        }, estimatedMs);
    }

    // ─────────────────────────────────────────────
    // BLOQUE 4: Consultas y gestión de aplicaciones
    // ─────────────────────────────────────────────

    listApplications(): Promise<DeployedApp[]> {
        return new Promise((resolve) => {
            Logger.info('SERVER', 'Consultando aplicaciones desplegadas...');
            exec(`"${this.asadmin}" list-applications`, { timeout: 15_000 }, (error, stdout) => {
                if (error) {
                    Logger.error('SERVER', `list-applications error: ${error.message}`);
                    resolve([]);
                    return;
                }

                const apps: DeployedApp[] = [];
                for (const line of stdout.split('\n').map(l => l.trim()).filter(Boolean)) {
                    if (/^(Command|Nothing|No applications)/.test(line)) { continue; }
                    const match = line.match(/^(\S+)\s*<(.+)>$/);
                    if (match) {
                        apps.push({ name: match[1], type: match[2].trim() });
                    } else if (!line.includes(' ')) {
                        apps.push({ name: line, type: 'unknown' });
                    }
                }

                Logger.info('SERVER', `${apps.length} app(s) encontrada(s).`);
                resolve(apps);
            });
        });
    }

    undeploy(appName: string): Promise<boolean> {
        return new Promise((resolve) => {
            Logger.section(`Undeploy: ${appName}`);
            exec(`"${this.asadmin}" undeploy ${appName}`, { timeout: 30_000 }, (error) => {
                if (error) {
                    Logger.error('SERVER', `undeploy error: ${error.message}`);
                    resolve(false);
                    return;
                }
                Logger.info('SERVER', `✅ Undeploy de '${appName}' exitoso.`);
                resolve(true);
            });
        });
    }

    /**
     * Consulta el estado real del servidor ejecutando 'asadmin list-domains'.
     */
    async checkServerStatus(): Promise<ServerState> {
        return new Promise((resolve) => {
            Logger.info('SERVER', 'Consultando estado real del servidor...');
            const targetDomain = this.domain;
            exec(`"${this.asadmin}" list-domains`, { timeout: 10_000 }, (error, stdout) => {
                if (error) {
                    Logger.error('SERVER', `Error al consultar dominios: ${error.message}`);
                    this.onStateChange('stopped');
                    resolve('stopped');
                    return;
                }

                const lines = stdout.split('\n');
                let foundState: ServerState = 'stopped';
                for (const line of lines) {
                    const cleanLine = line.trim();
                    if (cleanLine.startsWith(targetDomain)) {
                        if (cleanLine.includes('running') && !cleanLine.includes('not running')) {
                            foundState = 'running';
                        } else {
                            foundState = 'stopped';
                        }
                        break;
                    }
                }

                Logger.info('SERVER', `Estado detectado para '${targetDomain}': ${foundState.toUpperCase()}`);
                this.onStateChange(foundState);
                resolve(foundState);
            });
        });
    }
}
