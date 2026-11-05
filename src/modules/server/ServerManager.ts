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
import { MavenToolResolver } from '../maven/MavenToolResolver';
import { ProcessRunner } from '../process/ProcessRunner';

export interface DeployedApp {
    name: string;
    type: string;
}

type StateChangeCallback = (state: ServerState) => void;

// Tiempos estimados (ms) — ajusta si tu servidor es más lento/rápido
const TIMEOUT_START_MS = 300_000;
const TIMEOUT_STOP_MS = 6_000;
const POLL_INTERVAL_MS = 1_500;

export class ServerManager {
    private serverTerminal: vscode.Terminal | undefined;
    private terminalCloseListener?: vscode.Disposable;
    private onStateChange: StateChangeCallback;
    private assetWatcher: AssetWatcher | undefined;
    private currentState: ServerState = 'stopped';
    private pollingTimers: ReturnType<typeof setTimeout>[] = [];


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

        public setWatchersPaused(paused: boolean): void {
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


    private clearPollingTimers(): void {
            for (const timer of this.pollingTimers) {
                clearTimeout(timer);
            }
            this.pollingTimers = [];
        }

        public async waitUntilState(expectedState: ServerState, maxWaitMs = TIMEOUT_START_MS, label: string = expectedState): Promise<boolean> {
        const state = await this.waitForState(expectedState, maxWaitMs, label);
        return state === expectedState;
    }

    private waitForState(
            expectedState: ServerState,
            maxWaitMs: number,
            label: string
        ): Promise<ServerState> {
            return new Promise((resolve) => {
                const startTime = Date.now();
                let attempt = 0;
    
                const poll = async () => {
                    attempt++;
                    const elapsed = Date.now() - startTime;
    
                    if (elapsed >= maxWaitMs) {
                        Logger.warn('SERVER', 
                            `Timeout de ${label} tras ${maxWaitMs}ms (${attempt} intentos). Estado final: ${this.currentState}`
                        );
                        resolve(this.currentState);
                        return;
                    }
    
                    const state = await this.checkServerStatus();
                    Logger.debug('DEBUG', 
                        `[${label}] Intento ${attempt}: estado=${state} (${elapsed}ms / ${maxWaitMs}ms)`
                    );
    
                    if (state === expectedState) {
                        Logger.info('SERVER', 
                            `Servidor ${label} exitosamente en ${elapsed}ms (${attempt} intentos).`
                        );
                        resolve(state);
                        return;
                    }
    
                    // Programar siguiente verificación
                    const timer = setTimeout(poll, POLL_INTERVAL_MS);
                    this.pollingTimers.push(timer);
                };
    
                // Primera verificación inmediata
                poll();
            });
        }

    // ─────────────────────────────────────────────
    // BLOQUE 2: Ciclo de vida del servidor
    // ─────────────────────────────────────────────

                start(options: { resumeWatchers?: boolean } = {}): void {
        const resumeWatchers = options.resumeWatchers ?? true;
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

        this.clearPollingTimers();
        this.setWatchersPaused(true);
        this.onStateChange('starting');
        Logger.section('Iniciar Servidor');
        Logger.info('SERVER', `Iniciando dominio: ${this.domain}`);
        Logger.show();

        const term = this.getTerminal('MM43 — Server');
        term.show();
        term.sendText(`& "${this.asadmin}" start-domain --debug ${this.domain}`);
        this.serverTerminal = term;

                this.terminalCloseListener?.dispose();
        this.terminalCloseListener = vscode.window.onDidCloseTerminal(t => {
            if (t === this.serverTerminal) {
                this.clearPollingTimers();
                this.onStateChange('stopped');
                Logger.warn('SERVER', 'Terminal del servidor cerrada.');
            }
        });

        // ── POLLING REAL en lugar de setTimeout fijo ──
                this.waitForState('running', TIMEOUT_START_MS, 'iniciando').then((finalState) => {
            this.onStateChange(finalState);
            if (resumeWatchers) {
                this.setWatchersPaused(finalState !== 'running');
            }
            if (finalState === 'running') {
                Logger.info('SERVER', '  Servidor iniciado correctamente.');
            } else {
                Logger.error('SERVER', `  Fallo al iniciar servidor. Estado: ${finalState}`);
            }
        });
    }

    /** Detención síncrona al desactivar la extensión. */
    stop(): void {
        this.clearPollingTimers();
        this.setWatchersPaused(true);
        this.onStateChange('stopping');
        Logger.section('Detener Servidor');
        Logger.info('SERVER', `Deteniendo dominio: ${this.domain}`);
        Logger.show();
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
        

        // ── POLLING REAL en lugar de setTimeout fijo ──
        this.waitForState('stopped', TIMEOUT_STOP_MS, 'deteniendo').then((finalState) => {
            this.onStateChange(finalState);
            this.setWatchersPaused(finalState !== 'stopped');
            if (finalState === 'stopped') {
                Logger.info('SERVER', '  Servidor detenido correctamente.');
            } else {
                Logger.error('SERVER', `  Fallo al detener servidor. Estado: ${finalState}`);
            }
        });
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
     * Ejecuta un redeploy verificable para hot reload.
     * A diferencia de smartDeploy(), espera cada etapa y devuelve solo cuando
     * el servidor y el deployment terminaron realmente.
     */
    async redeployAndWait(project: ProjectConfig, build: () => Promise<boolean>): Promise<boolean> {
        this.setWatchersPaused(true);
        try {
            if (this.getServerState() !== 'stopped') {
                this.stop();
                if (!await this.waitUntilState('stopped', TIMEOUT_STOP_MS, 'deteniendo para redeploy')) {
                    throw new Error('El servidor no llegó al estado detenido.');
                }
            }

            if (!await build()) {
                throw new Error('La compilación del proyecto falló.');
            }

                        this.start({ resumeWatchers: false });
            if (!await this.waitUntilState('running', TIMEOUT_START_MS, 'iniciando tras redeploy')) {
                throw new Error('El servidor no llegó al estado running.');
            }

            const targetExploded = path.join(project.rootPath, 'target', project.warName);
            if (!fs.existsSync(targetExploded)) {
                throw new Error(`Exploded no encontrado: ${targetExploded}`);
            }

                        const applicationQuery = await this.queryApplications();
            if (!applicationQuery.success) {
                throw new Error('No se pudo determinar si la aplicación ya está desplegada.');
            }
            const action = applicationQuery.apps.some(app => app.name === project.warName) ? 'redeploy' : 'deploy';
            const result = await ProcessRunner.run(this.asadmin, [action, '--name', project.warName, targetExploded], {
                timeout: 180_000,
                onStdout: data => Logger.raw(data),
                onStderr: data => Logger.raw(data),
            });
            if (result.code !== 0) {
                throw new Error(result.stderr || result.stdout || `asadmin ${action} terminó con código ${result.code}`);
            }

            Logger.info('SERVER', `${action} completado para ${project.warName}.`);
            return true;
        } catch (error) {
            Logger.error('SERVER', `Redeploy verificable falló: ${String(error)}`);
            return false;
                } finally {
            // Solo se reanudan los watchers si el servidor quedó realmente disponible.
            this.setWatchersPaused(this.getServerState() !== 'running');
        }
    }

    /**
     * Redeploy rápido para Hot Reload.
     * Mantiene el servidor encendido y solo ejecuta deploy/redeploy sobre el
     * exploded WAR ya compilado. Si falla, el servicio puede usar el flujo
     * completo como fallback.
     */
    async fastRedeployAndWait(project: ProjectConfig): Promise<boolean> {
        this.setWatchersPaused(true);
        try {
            if (this.getServerState() !== 'running') {
                this.start({ resumeWatchers: false });
                if (!await this.waitUntilState('running', TIMEOUT_START_MS, 'iniciando para redeploy rápido')) {
                    throw new Error('El servidor no llegó al estado running.');
                }
            }

            const targetExploded = path.join(project.rootPath, 'target', project.warName);
            if (!fs.existsSync(targetExploded)) {
                throw new Error(`Exploded no encontrado: ${targetExploded}`);
            }

            const applicationQuery = await this.queryApplications();
            if (!applicationQuery.success) {
                throw new Error('No se pudo determinar el estado de la aplicación.');
            }

            const action = applicationQuery.apps.some(app => app.name === project.warName)
                ? 'redeploy'
                : 'deploy';
            const result = await ProcessRunner.run(this.asadmin, [action, '--name', project.warName, targetExploded], {
                timeout: 180_000,
                onStdout: data => Logger.raw(data),
                onStderr: data => Logger.raw(data),
            });

            if (result.code !== 0) {
                throw new Error(result.stderr || result.stdout || `asadmin ${action} terminó con código ${result.code}`);
            }

            Logger.info('SERVER', `${action} rápido completado para ${project.warName}.`);
            return true;
        } catch (error) {
            Logger.error('SERVER', `Redeploy rápido falló: ${String(error)}`);
            return false;
        } finally {
            this.setWatchersPaused(this.getServerState() !== 'running');
        }
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
        const maven = MavenToolResolver.resolve(project.rootPath);
        const mavenCommand = [maven.command, ...maven.argsPrefix, 'compile', 'war:exploded', '-DskipTests']
            .map(arg => `"${arg.replace(/"/g, '\\"')}"`)
            .join(' ');
        term.sendText(mavenCommand);
        // 4) Iniciar servidor
        term.sendText(`& "${this.asadmin}" start-domain --debug ${this.domain}`);
        // 5) Redeploy (la app ya existe si llegamos aquí desde fullRedeploy)
        term.sendText(`& "${this.asadmin}" redeploy --name ${project.warName} "${targetExploded}"`);
        term.sendText(`Write-Host "[MM43]   Redeploy completo de ${project.warName} terminado." -ForegroundColor Cyan`);

        // Estado optimista tras tiempo estimado (start + build + redeploy)
        const estimatedMs = TIMEOUT_START_MS + 15_000;
        setTimeout(() => {
            this.onStateChange('running');
            this.setWatchersPaused(false);
            Logger.info('SERVER', '  Servidor listo tras redeploy completo.');
        }, estimatedMs);
    }

    // ─────────────────────────────────────────────
    // BLOQUE 4: Consultas y gestión de aplicaciones
    // ─────────────────────────────────────────────

            async listApplications(): Promise<DeployedApp[]> {
        const result = await this.queryApplications();

        if (!result.success) {
            throw new Error('No se pudieron consultar las aplicaciones desplegadas.');
        }

        return result.apps;
    }

    private queryApplications(): Promise<{ success: boolean; apps: DeployedApp[] }> {
        return new Promise((resolve) => {
            Logger.info('SERVER', 'Consultando aplicaciones desplegadas...');
            const command = `"${this.asadmin}" list-applications`;

            exec(command, { timeout: 15_000 }, (error, stdout, stderr) => {
                Logger.debug('SERVER', `Comando ejecutado: ${command}`);
                Logger.debug('SERVER', `stdout: ${stdout}`);
                Logger.debug('SERVER', `stderr: ${stderr}`);
                if (error) {
                    Logger.error(
                        'SERVER',
                        `list-applications error: ${error.message}. stderr: ${stderr || '(vacío)'}`
                    );
                    resolve({ success: false, apps: [] });
                    return;
                }

                const apps: DeployedApp[] = [];
                for (const line of stdout.split('\n').map(l => l.trim()).filter(Boolean)) {
                                        if (/^(Command|Nothing|No applications)/i.test(line)) {
                        continue;
                    }
                    const match = line.match(/^(\S+)\s*<(.+)>$/);
                    if (match) {
                        apps.push({ name: match[1], type: match[2].trim() });
                    } else if (!line.includes(' ')) {
                        apps.push({ name: line, type: 'unknown' });
                    }
                }

                Logger.info('SERVER', `${apps.length} app(s) encontrada(s).`);
                resolve({ success: true, apps });
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
                Logger.info('SERVER', `  Undeploy de '${appName}' exitoso.`);
                resolve(true);
            });
        });
    }

    /**
     * Consulta el estado real del servidor ejecutando 'asadmin list-domains'.
     */

    async verifacionRapidaDeServidor(): Promise<boolean> {



        return true;
    }
    async checkServerStatus(): Promise<ServerState> {
        return new Promise((resolve) => {
            Logger.info('SERVER', 'Consultando estado real del servidor...');
            const targetDomain = this.domain;
            exec(`"${this.asadmin}" list-domains`, { timeout: 10_000 }, (error, stdout) => {
                if (error) {
                                    Logger.error('SERVER', `Error al consultar dominios: ${error.message}`);
                                                        this.onStateChange('unknown');
                                                        resolve('unknown');
                                                        return;
                                                    }

                                                    const lines = stdout.split('\n');
                                                    let foundState: ServerState = 'unknown';
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
