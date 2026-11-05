import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { HotswapPropertiesStore, ApplyScope } from './HotswapPropertiesStore';
import { ConfigManager } from '../../config/ConfigManager';
import { Logger } from '../logger/Logger';

/**
 * Servicio de alto nivel para gestionar la configuración del agente HotswapAgent.
 * Coordina el HotswapPropertiesStore con la UI y las acciones de redeploy/reinicio.
 *
 * Mantiene una instancia singleton por workspace.
 */
export class HotswapConfigService {

    private static _instance: HotswapConfigService | undefined;
    private _store: HotswapPropertiesStore | undefined;
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

    private constructor() { }

    static getInstance(): HotswapConfigService {
        if (!this._instance) {
            this._instance = new HotswapConfigService();
        }
        return this._instance;
    }

    /** Inicializa el store cargando el archivo .properties actual. */
    init(): void {
        const propsPath = ConfigManager.getHotswapPropertiesPath();
        if (!propsPath) {
            Logger.warn('HOTRELOAD', 'HotswapConfigService: no hay workspace abierto');
            return;
        }

        this._store = new HotswapPropertiesStore(propsPath);
        this._store.load();
        this._store.onDidChange(() => this._onDidChange.fire());
        Logger.debug('DEBUG', `HotswapConfigService: cargado ${propsPath}`);
    }

    /** Devuelve el store de propiedades. Lanza si no está inicializado. */
    get store(): HotswapPropertiesStore {
        if (!this._store) {
            throw new Error('HotswapConfigService: no inicializado. Llama init() primero.');
        }
        return this._store;
    }

    /** Devuelve true si hay propiedades pendientes del scope indicado. */
    hasPending(scope?: ApplyScope): boolean {
        const pending = this._store?.getPendingAll();
        if (!pending || pending.size === 0) { return false; }
        if (!scope) { return pending.size > 0; }
        return Array.from(pending.values()).some(s => s === scope);
    }

    /**
     * Edita una propiedad con un cuadro de entrada en VS Code.
     * Muestra el valor actual y el scope de aplicación.
     */
    async editProperty(key: string, currentValue: string, scope: ApplyScope): Promise<void> {
        if (!this._store) { return; }

        const scopeLabel = scope === 'restart' ? '(requiere reiniciar servidor)'
            : scope === 'redeploy' ? '(requiere redeploy de la app)'
            : '(efecto inmediato)';

        const newValue = await vscode.window.showInputBox({
            title: `Editar propiedad: ${key}`,
            value: currentValue,
            prompt: `Nuevo valor para '${key}' ${scopeLabel}`,
        });

        if (newValue === undefined) { return; } // Cancelado

        try {
            this._store.set(key, newValue, scope);
            Logger.info('HOTRELOAD', `Propiedad actualizada: ${key}=${newValue}`);
        } catch (err) {
            vscode.window.showErrorMessage(`[MM43] Error al guardar propiedad: ${err}`);
        }
    }

    /**
     * Activa o desactiva un plugin en disabledPlugins.
     */
    async togglePlugin(pluginName: string, disable: boolean): Promise<void> {
        if (!this._store) { return; }

        const current = this._store.get('disabledPlugins') ?? '';
        const plugins = current ? current.split(',').map(p => p.trim()).filter(Boolean) : [];

        if (disable && !plugins.includes(pluginName)) {
            plugins.push(pluginName);
        } else if (!disable) {
            const idx = plugins.indexOf(pluginName);
            if (idx >= 0) { plugins.splice(idx, 1); }
        }

        this._store.set('disabledPlugins', plugins.join(','), 'redeploy');
        Logger.info('HOTRELOAD', `Plugin ${disable ? 'deshabilitado' : 'habilitado'}: ${pluginName}`);
    }

    /** Marca todas las propiedades con scope 'redeploy' como aplicadas. */
    markRedeployApplied(): void {
        this._store?.markAllApplied('redeploy');
        this._onDidChange.fire();
    }

    /** Marca todas las propiedades con scope 'restart' como aplicadas. */
    markRestartApplied(): void {
        this._store?.markAllApplied('restart');
        this._onDidChange.fire();
    }

    /** Recarga el archivo .properties desde disco. */
    reload(): void {
        this._store?.load();
        this._onDidChange.fire();
    }

    /** Devuelve la ruta al archivo .properties, o undefined si no hay workspace. */
    getPropertiesPath(): string | undefined {
        return ConfigManager.getHotswapPropertiesPath();
    }

    /** Devuelve la ruta al log del agente, o undefined si no hay workspace. */
    getLogPath(): string | undefined {
        return ConfigManager.getHotswapLogPath();
    }
}

