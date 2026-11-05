import * as fs from 'fs';
import * as vscode from 'vscode';
import { ReloadOutcome, ReloadStatus } from '../../config/types';
import { Logger } from '../logger/Logger';

/**
 * Tipos de eventos parseados del log de HotswapAgent.
 */
type LogEntryType =
    | 'accepted'           // HotswapperPlugin DEBUG: "Class X will be reloaded from URL Y"
    | 'skipped'            // HotswapperPlugin TRACE: "Class X not loaded yet"
    | 'reload-start'       // PluginManager RELOAD: "Reloading classes [..] (autoHotswap)"
    | 'reload-ok'          // PluginManager DEBUG: "... reloaded classes [..] (autoHotswap)"
    | 'reload-fail'        // PluginManager DEBUG: "... Fail to reload classes [..] (autoHotswap), msg is ..."
    | 'watch-error'        // WatchEventCommand ERROR: "InvocationTargetException in method 'watchReload' ..."
    | 'other';

interface ParsedLogEntry {
    type: LogEntryType;
    timestamp: string;
    level: string;
    logger: string;
    message: string;
    classes: string[];       // Nombres de clase extraídos
    errorMsg?: string;       // Para reload-fail o watch-error
    isStaleLoader?: boolean; // Para watch-error: si es "This web container has not yet been started"
}

/**
 * Observa el archivo hotswap-agent.log mediante polling de tamaño/offset.
 * Parsea las entradas según el formato:
 *   `HOTSWAP AGENT: HH:mm:ss.SSS LEVEL (logger) - message`
 *
 * Soporta:
 * - Entradas multilínea (stack traces).
 * - Truncado del archivo (nuevo arranque → resetea offset).
 * - Ráfagas de cientos de clases sin bloquear el hilo (procesamiento por lotes).
 *
 * API principal:
 * - `waitForOutcome(classNames, sinceMs)`: espera el resultado para las clases indicadas.
 * - `onOutcome`: evento que se emite por cada ReloadOutcome.
 * - `history(limit)`: últimas N entradas de resultado.
 * - `staleLoaderCount()`: cuántos errores stale-loader hay en el historial reciente.
 */
export class HotswapLogObserver {

    // ─── Formato del log ──────────────────────────────────────────────────────
    private static readonly HEADER_RE = /^HOTSWAP AGENT: (\d{2}:\d{2}:\d{2}\.\d{3}) (ERROR|RELOAD|WARNING|INFO|DEBUG|TRACE) \(([^)]+)\) - (.*)$/;
    private static readonly ACCEPT_RE  = /Class (\S+) will be reloaded from URL/;
    private static readonly SKIP_RE    = /Class (\S+) not loaded yet/;
    private static readonly RSTART_RE  = /Reloading classes \[(.+?)\] \(autoHotswap\)/;
    private static readonly ROK_RE     = /\.\.\. reloaded classes \[(.+?)\] \(autoHotswap\)/;
    private static readonly RFAIL_RE   = /\.\.\. Fail to reload classes \[(.+?)\] \(autoHotswap\), msg is (.*)/;
    private static readonly WERR_RE    = /InvocationTargetException in method 'watchReload' class '(\S+)' classLoader '([^']+)'/;
    private static readonly STALE_MSG  = 'this web container has not yet been started';

    // ─── Estado interno ───────────────────────────────────────────────────────
    private _filePath: string;
    private _offset: number = 0;
    private _pollInterval: NodeJS.Timeout | undefined;
    private _pendingText: string = '';  // buffer para entrada multilínea en curso
    private _currentEntry: { header: string; lines: string[] } | null = null;

    // Historial de outcomes (más reciente al final)
    private _history: ReloadOutcome[] = [];
    private readonly HISTORY_LIMIT = 100;

    // Contadores de stale-loader recientes (ventana de 60 s)
    private _staleTimestamps: number[] = [];

    // Eventos
    private readonly _onOutcome = new vscode.EventEmitter<ReloadOutcome>();
    readonly onOutcome: vscode.Event<ReloadOutcome> = this._onOutcome.event;

    // Acumulador de entradas parseadas desde el último waitForOutcome
    private _pendingEntries: ParsedLogEntry[] = [];

    constructor(filePath: string) {
        this._filePath = filePath;
    }

    /** Inicia el polling del log (por defecto cada 500 ms). */
    start(pollMs = 500): void {
        if (this._pollInterval) { return; }
        this._pollInterval = setInterval(() => { void this._poll(); }, pollMs);
        Logger.debug('DEBUG', `HotswapLogObserver: iniciado (${this._filePath})`);
    }

    /** Detiene el polling. */
    stop(): void {
        if (this._pollInterval) {
            clearInterval(this._pollInterval);
            this._pollInterval = undefined;
        }
    }

    /**
     * Espera el resultado de recarga para las clases indicadas.
     *
     * @param classNames  Nombres canónicos a esperar (ej. 'a.b.Foo$1').
     * @param sinceMs     Timestamp desde el que se empiezan a considerar entradas.
     * @param settleMs    Silencio tras el último evento antes de resolver (default 1500 ms).
     * @param timeoutMs   Tiempo máximo de espera (default 15000 ms).
     */
    waitForOutcome(
        classNames: string[],
        sinceMs: number,
        settleMs = 1500,
        timeoutMs = 15000
    ): Promise<ReloadOutcome[]> {
        return new Promise<ReloadOutcome[]>(resolve => {
            const targetSet = new Set(classNames);
            const collected: ParsedLogEntry[] = [];
            let settleTimer: NodeJS.Timeout | undefined;
            let totalTimer: NodeJS.Timeout | undefined;
            let disposed = false;

            const finish = () => {
                if (disposed) { return; }
                disposed = true;
                if (settleTimer) { clearTimeout(settleTimer); }
                if (totalTimer) { clearTimeout(totalTimer); }
                unsub.dispose();
                const outcomes = this.resolveOutcomes(classNames, collected, Date.now() - sinceMs);
                for (const o of outcomes) {
                    this._emitOutcome(o);
                }
                resolve(outcomes);
            };

            const resetSettle = () => {
                if (settleTimer) { clearTimeout(settleTimer); }
                settleTimer = setTimeout(finish, settleMs);
            };

            // Escuchar nuevas entradas parseadas
            const unsub = this.onOutcome(outcome => {
                if (disposed) { return; }
                if (targetSet.has(outcome.className)) {
                    resetSettle();
                }
            });

            // También escuchar las entradas en _pendingEntries
            const checkPending = () => {
                const relevant = this._pendingEntries.filter(e =>
                    e.classes.some(c => targetSet.has(c))
                );
                if (relevant.length > 0) {
                    collected.push(...relevant);
                    this._pendingEntries = this._pendingEntries.filter(e =>
                        !e.classes.some(c => targetSet.has(c))
                    );
                    resetSettle();
                }
            };

            // Verificar periódicamente las entradas acumuladas
            const checkInterval = setInterval(checkPending, 200);

            totalTimer = setTimeout(() => {
                clearInterval(checkInterval);
                finish();
            }, timeoutMs);

            // Verificar inmediatamente
            checkPending();
            resetSettle(); // Iniciar settle timer
        });
    }

    /** Devuelve las últimas N entradas del historial de outcomes. */
    history(limit = 50): ReloadOutcome[] {
        return this._history.slice(-limit);
    }

    /** Cuenta los errores stale-loader en los últimos 60 segundos. */
    staleLoaderCount(): number {
        const cutoff = Date.now() - 60_000;
        this._staleTimestamps = this._staleTimestamps.filter(t => t > cutoff);
        return this._staleTimestamps.length;
    }

    // ─── Polling y parseo ─────────────────────────────────────────────────────

    private async _poll(): Promise<void> {
        if (!fs.existsSync(this._filePath)) { return; }

        try {
            const stat = fs.statSync(this._filePath);
            const fileSize = stat.size;

            // Detectar truncado (nuevo arranque del agente)
            if (fileSize < this._offset) {
                Logger.debug('DEBUG', 'HotswapLogObserver: log truncado, reiniciando offset');
                this._offset = 0;
                this._pendingText = '';
                this._currentEntry = null;
            }

            if (fileSize <= this._offset) { return; }

            const fd = fs.openSync(this._filePath, 'r');
            const bufSize = Math.min(fileSize - this._offset, 65536); // leer en bloques de 64 KB
            const buf = Buffer.alloc(bufSize);
            const bytesRead = fs.readSync(fd, buf, 0, bufSize, this._offset);
            fs.closeSync(fd);

            if (bytesRead === 0) { return; }

            this._offset += bytesRead;
            const text = buf.subarray(0, bytesRead).toString('utf8');
            this._pendingText += text;

            // Procesar líneas completas
            const lines = this._pendingText.split(/\r?\n/);
            // La última línea puede estar incompleta
            this._pendingText = lines.pop() ?? '';

            // Procesar en lotes para no bloquear el event loop
            for (let i = 0; i < lines.length; i++) {
                this._processLine(lines[i]);
            }
        } catch (err) {
            Logger.debug('DEBUG', `HotswapLogObserver: error en poll: ${err}`);
        }
    }

    private _processLine(line: string): void {
        const headerMatch = HotswapLogObserver.HEADER_RE.exec(line);

        if (headerMatch) {
            // Nueva entrada: procesar la anterior si existe
            if (this._currentEntry) {
                const parsed = this._parseEntry(this._currentEntry.header, this._currentEntry.lines);
                if (parsed && parsed.type !== 'other') {
                    this._pendingEntries.push(parsed);
                }
            }
            this._currentEntry = { header: line, lines: [] };
        } else if (this._currentEntry) {
            // Continuación (stack trace u otras líneas)
            this._currentEntry.lines.push(line);
        }
    }

    private _parseEntry(headerLine: string, continuationLines: string[]): ParsedLogEntry | null {
        const m = HotswapLogObserver.HEADER_RE.exec(headerLine);
        if (!m) { return null; }

        const [, timestamp, level, logger, message] = m;
        const loggerLower = logger.toLowerCase();
        const messageLower = message.toLowerCase();
        const isHotswapper = loggerLower.includes('hotswapper') || loggerLower.includes('hotswapperplugin');
        const isPluginMgr  = loggerLower.includes('pluginmanager');
        const isWatchErr   = loggerLower.includes('watcheventcommand');

        let type: LogEntryType = 'other';
        let classes: string[] = [];
        let errorMsg: string | undefined;
        let isStaleLoader = false;

        if (isHotswapper && level === 'DEBUG') {
            const am = HotswapLogObserver.ACCEPT_RE.exec(message);
            if (am) { type = 'accepted'; classes = [am[1]]; }
        } else if (isHotswapper && level === 'TRACE') {
            const sm = HotswapLogObserver.SKIP_RE.exec(message);
            if (sm) { type = 'skipped'; classes = [sm[1]]; }
        } else if (isPluginMgr && level === 'RELOAD') {
            const rm = HotswapLogObserver.RSTART_RE.exec(message);
            if (rm) { type = 'reload-start'; classes = this._parseClassList(rm[1]); }
        } else if (isPluginMgr && level === 'DEBUG') {
            const okm = HotswapLogObserver.ROK_RE.exec(message);
            if (okm) { type = 'reload-ok'; classes = this._parseClassList(okm[1]); }
            const failm = HotswapLogObserver.RFAIL_RE.exec(message);
            if (failm) {
                type = 'reload-fail';
                classes = this._parseClassList(failm[1]);
                errorMsg = failm[2];
            }
        } else if (isWatchErr && level === 'ERROR') {
            const wm = HotswapLogObserver.WERR_RE.exec(message);
            if (wm) {
                type = 'watch-error';
                classes = [wm[1]];
                // Buscar Caused by en las líneas de continuación
                const causedBy = continuationLines.find(l => l.includes('Caused by:'));
                if (causedBy) {
                    isStaleLoader = causedBy.toLowerCase().includes(HotswapLogObserver.STALE_MSG);
                    errorMsg = causedBy.replace(/.*Caused by:\s*/i, '').trim();
                }
            }
        }

        return { type, timestamp, level, logger, message, classes, errorMsg, isStaleLoader };
    }

    private _parseClassList(raw: string): string[] {
        return raw.split(',').map(s => s.trim()).filter(Boolean);
    }

    // ─── Resolución de outcomes por clase ─────────────────────────────────────

    /**
     * Resuelve el outcome para cada clase según las reglas del plan:
     * 1. reload-ok → reloaded
     * 2. reload-fail o watch-error no-stale sin reload-ok → failed
     * 3. Solo watch-error stale sin reload-ok → stale-loader
     * 4. Solo skipped → skipped-not-loaded
     * 5. Solo reload-start sin ok/fail → timeout (si timeoutMs agotado)
     * 6. Nada → timeout
     */
    private resolveOutcomes(
        classNames: string[],
        entries: ParsedLogEntry[],
        elapsedMs: number
    ): ReloadOutcome[] {
        return classNames.map(className => {
            const relevant = entries.filter(e => e.classes.includes(className));
            return this.resolveForClass(className, relevant, elapsedMs);
        });
    }

    private resolveForClass(className: string, entries: ParsedLogEntry[], elapsedMs: number): ReloadOutcome {
        const hasReloadOk    = entries.some(e => e.type === 'reload-ok');
        const hasReloadFail  = entries.some(e => e.type === 'reload-fail');
        const hasWatchNonStale = entries.some(e => e.type === 'watch-error' && !e.isStaleLoader);
        const hasStaleOnly   = entries.some(e => e.type === 'watch-error' && e.isStaleLoader) &&
                               !hasReloadOk && !hasReloadFail && !hasWatchNonStale;
        const hasSkipped     = entries.some(e => e.type === 'skipped');
        const hasReloadStart = entries.some(e => e.type === 'reload-start');

        let status: ReloadStatus;
        let message: string | undefined;

        if (hasReloadOk) {
            status = 'reloaded';
        } else if (hasReloadFail || hasWatchNonStale) {
            status = 'failed';
            message = entries.find(e => e.type === 'reload-fail' || (e.type === 'watch-error' && !e.isStaleLoader))?.errorMsg;
        } else if (hasStaleOnly) {
            status = 'stale-loader';
            this._staleTimestamps.push(Date.now());
        } else if (hasSkipped) {
            status = 'skipped-not-loaded';
        } else {
            status = 'timeout';
        }

        return { className, status, ms: elapsedMs, message };
    }

    private _emitOutcome(outcome: ReloadOutcome): void {
        this._history.push(outcome);
        if (this._history.length > this.HISTORY_LIMIT) {
            this._history.shift();
        }
        this._onOutcome.fire(outcome);
    }
}

