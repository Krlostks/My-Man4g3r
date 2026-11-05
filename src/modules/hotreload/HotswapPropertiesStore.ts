import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from '../logger/Logger';

/**
 * Estado de pendiente de una propiedad que requiere acción para aplicarse.
 */
export type ApplyScope = 'restart' | 'redeploy' | 'live';

export interface PropertyEntry {
    key: string;
    value: string;
    comment?: string;
    pendingApply?: ApplyScope;
}

/**
 * Lee y escribe el archivo hotswap-agent.properties preservando:
 * - Comentarios (líneas que empiezan con #)
 * - Orden original de las propiedades
 * - Líneas en blanco de separación
 *
 * Mantiene un estado de "pendiente de aplicar" por propiedad.
 * Propiedades obligatorias (LOGFILE, LOGFILE.append, niveles de logger) no
 * pueden borrarse desde la UI.
 *
 * Validaciones:
 *   - Los valores de propiedades 'arg' no pueden contener ',' ni '='.
 *   - No se pueden tener includedClassLoaderPatterns y excludedClassLoaderPatterns
 *     simultáneamente.
 */
export class HotswapPropertiesStore {

    private static readonly MANDATORY_KEYS = new Set([
        'LOGFILE',
        'LOGFILE.append',
        'LOG_TO_CONSOLE',
        'LOGGER',
        'LOGGER.org.hotswap.agent.config.PluginManager',
        'LOGGER.org.hotswap.agent.plugin.hotswapper',
    ]);

    private static readonly EXCLUSIVE_PATTERNS = [
        'includedClassLoaderPatterns',
        'excludedClassLoaderPatterns',
    ];

    private readonly _filePath: string;
    private _lines: string[] = [];          // Todas las líneas del archivo (con comentarios)
    private _props: Map<string, string> = new Map();   // key → valor actual
    private _pending: Map<string, ApplyScope> = new Map(); // key → scope pendiente

    private readonly _onDidChange = new vscode.EventEmitter<HotswapPropertiesStore>();
    readonly onDidChange: vscode.Event<HotswapPropertiesStore> = this._onDidChange.event;

    constructor(filePath: string) {
        this._filePath = filePath;
    }

    /** Carga el archivo desde disco. No lanza si no existe. */
    load(): void {
        if (!fs.existsSync(this._filePath)) {
            this._lines = [];
            this._props.clear();
            return;
        }
        const raw = fs.readFileSync(this._filePath, 'utf8');
        this._lines = raw.split(/\r?\n/);
        this._props.clear();

        for (const line of this._lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) { continue; }
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx < 0) { continue; }
            const key = trimmed.substring(0, eqIdx).trim();
            const value = trimmed.substring(eqIdx + 1).trim();
            this._props.set(key, value);
        }
    }

    /** Devuelve el valor de una propiedad, o undefined si no existe. */
    get(key: string): string | undefined {
        return this._props.get(key);
    }

    /** Devuelve todas las propiedades como mapa. */
    getAll(): Map<string, string> {
        return new Map(this._props);
    }

    /**
     * Establece el valor de una propiedad.
     * Marca como pendiente con el scope indicado (default 'redeploy').
     * Valida restricciones de contenido y exclusión mutua.
     */
    set(key: string, value: string, pendingApply: ApplyScope = 'redeploy'): void {
        this.validateValue(key, value);

        this._props.set(key, value);
        this._pending.set(key, pendingApply);

        // Actualizar la línea en el array de líneas (preservar comentarios)
        this.updateLine(key, value);
        this.write();
        this._onDidChange.fire(this);
    }

    /**
     * Elimina una propiedad si no es obligatoria.
     * @throws Error si la propiedad es obligatoria.
     */
    delete(key: string): void {
        if (HotswapPropertiesStore.MANDATORY_KEYS.has(key)) {
            throw new Error(`La propiedad '${key}' es obligatoria y no puede eliminarse.`);
        }
        if (!this._props.has(key)) { return; }
        this._props.delete(key);
        this._pending.delete(key);
        this.removeLine(key);
        this.write();
        this._onDidChange.fire(this);
    }

    /** Devuelve el scope pendiente de una propiedad, si lo hay. */
    getPending(key: string): ApplyScope | undefined {
        return this._pending.get(key);
    }

    /** Devuelve todas las propiedades con pendiente de aplicar. */
    getPendingAll(): Map<string, ApplyScope> {
        return new Map(this._pending);
    }

    /** Marca una propiedad como aplicada (elimina de pendientes). */
    markApplied(key: string): void {
        this._pending.delete(key);
    }

    /** Marca todas las propiedades con el scope indicado como aplicadas. */
    markAllApplied(scope: ApplyScope): void {
        for (const [key, s] of this._pending) {
            if (s === scope) { this._pending.delete(key); }
        }
    }

    // ─── Escritura atómica ────────────────────────────────────────────────────

    private write(): void {
        const content = this._lines.join('\n');
        const tmpPath = this._filePath + '.mm43tmp';
        try {
            fs.writeFileSync(tmpPath, content, 'utf8');
            fs.renameSync(tmpPath, this._filePath);
        } catch (err) {
            try { if (fs.existsSync(tmpPath)) { fs.unlinkSync(tmpPath); } } catch { /* ignorar */ }
            throw err;
        }
        Logger.debug('DEBUG', `HotswapPropertiesStore: escrito ${this._filePath}`);
    }

    // ─── Manipulación de líneas preservando comentarios ───────────────────────

    private updateLine(key: string, value: string): void {
        const idx = this.findLineIndex(key);
        const newLine = `${key}=${value}`;
        if (idx >= 0) {
            this._lines[idx] = newLine;
        } else {
            // Agregar al final si no existe
            this._lines.push(newLine);
        }
    }

    private removeLine(key: string): void {
        const idx = this.findLineIndex(key);
        if (idx >= 0) {
            this._lines.splice(idx, 1);
        }
    }

    private findLineIndex(key: string): number {
        for (let i = 0; i < this._lines.length; i++) {
            const trimmed = this._lines[i].trim();
            if (trimmed.startsWith('#') || !trimmed) { continue; }
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx < 0) { continue; }
            if (trimmed.substring(0, eqIdx).trim() === key) { return i; }
        }
        return -1;
    }

    // ─── Validaciones ─────────────────────────────────────────────────────────

    private validateValue(key: string, value: string): void {
        // Validar exclusión mutua
        if (HotswapPropertiesStore.EXCLUSIVE_PATTERNS.includes(key) && value) {
            const other = HotswapPropertiesStore.EXCLUSIVE_PATTERNS.find(k => k !== key);
            if (other && this._props.get(other)) {
                throw new Error(
                    `No se pueden usar '${key}' y '${other}' simultáneamente.`
                );
            }
        }

        // Las rutas en propiedades file no deben contener barras invertidas
        if (key === 'LOGFILE' || key === 'extraClasspath' || key === 'watchResources') {
            if (value.includes('\\')) {
                throw new Error(`La ruta de '${key}' debe usar '/' en lugar de '\\'`);
            }
        }
    }
}

