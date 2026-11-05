import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { JvmKind } from '../../config/types';
import { ConfigManager } from '../../config/ConfigManager';
import { Logger } from '../logger/Logger';

export interface JvmCapability {
    kind: JvmKind;
    javaHome: string;
    versionOutput: string;
    debugPort: number;
}

/**
 * Resuelve la capacidad de la JVM que usa el servidor Payara/GlassFish.
 * Detecta DCEVM leyendo AS_JAVA de asenv.bat y ejecutando `java -version`.
 * Publica el contexto `mm43.jvmKind` para condicionar vistas en VS Code.
 *
 * La caché se invalida cuando cambia el mtime de asenv.bat o la config
 * mm43.serverPath.
 */
export class JvmCapabilityResolver {

    private static _cached: JvmCapability | null = null;
    private static _cacheAsenvMtime: number = 0;
    private static _cacheServerPath: string = '';
    private static readonly _onDidChange = new vscode.EventEmitter<JvmCapability>();

    /** Evento que se emite cuando la capacidad detectada cambia. */
    static readonly onDidChange: vscode.Event<JvmCapability> = JvmCapabilityResolver._onDidChange.event;

    /**
     * Resuelve la capacidad de la JVM, usando caché si está vigente.
     * Si la caché es inválida (cambio de asenv.bat o serverPath), recalcula.
     */
    static resolve(): JvmCapability {
        const { serverPath } = ConfigManager.getServerConfig();
        const asenvPath = this.findAsenvPath(serverPath);

        // Invalidar caché si cambió serverPath o mtime de asenv.bat
        const currentMtime = asenvPath && fs.existsSync(asenvPath)
            ? fs.statSync(asenvPath).mtimeMs
            : 0;
        const serverPathChanged = serverPath !== this._cacheServerPath;
        const mtimeChanged = currentMtime !== this._cacheAsenvMtime;

        if (this._cached && !serverPathChanged && !mtimeChanged) {
            return this._cached;
        }

        const capability = this.detect(serverPath);
        const previous = this._cached;
        this._cached = capability;
        this._cacheAsenvMtime = currentMtime;
        this._cacheServerPath = serverPath;

        // Publicar contexto para vistas condicionales
        void vscode.commands.executeCommand('setContext', 'mm43.jvmKind', capability.kind);

        // Emitir evento de cambio si difiere
        if (!previous || previous.kind !== capability.kind || previous.javaHome !== capability.javaHome) {
            this._onDidChange.fire(capability);
        }

        return capability;
    }

    /** Invalida la caché para forzar recalculo en la próxima llamada a resolve(). */
    static invalidateCache(): void {
        this._cached = null;
        this._cacheAsenvMtime = 0;
        this._cacheServerPath = '';
    }

    // ─── Implementación interna ───────────────────────────────────────────────

    private static detect(serverPath: string): JvmCapability {
        const javaHome = this.getServerJavaHome(serverPath);
        const debugPort = this.getDebugPort(serverPath);

        if (!javaHome) {
            Logger.warn('HOTRELOAD', 'JvmCapabilityResolver: no se pudo determinar Java del servidor');
            return { kind: 'unknown', javaHome: '', versionOutput: '', debugPort };
        }

        const javaExe = process.platform === 'win32' ? 'java.exe' : 'java';
        const javaBin = path.join(javaHome, 'bin', javaExe);

        if (!fs.existsSync(javaBin)) {
            Logger.warn('HOTRELOAD', `JvmCapabilityResolver: ejecutable no encontrado: ${javaBin}`);
            return { kind: 'unknown', javaHome, versionOutput: '', debugPort };
        }

        const versionOutput = this.runJavaVersion(javaBin);
        const kind = this.detectKind(javaHome, versionOutput);

        Logger.info('HOTRELOAD', `JVM detectada: ${kind} (${javaHome})`);
        return { kind, javaHome, versionOutput, debugPort };
    }

    /**
     * Lee AS_JAVA del asenv.bat/conf del servidor.
     * Soporta Payara 5, GlassFish 4 y variantes Linux.
     */
    static getServerJavaHome(serverPath?: string): string {
        const sp = serverPath ?? ConfigManager.getServerConfig().serverPath;
        if (!sp) {
            const envJava = process.env.JAVA_HOME || '';
            Logger.warn('HOTRELOAD', `No hay serverPath configurado; usando JAVA_HOME: ${envJava}`);
            return envJava;
        }

        const asenvPath = this.findAsenvPath(sp);
        if (asenvPath && fs.existsSync(asenvPath)) {
            const content = fs.readFileSync(asenvPath, 'utf-8');
            // Soportar Windows (set AS_JAVA=...) y Linux (AS_JAVA=...)
            const match = content.match(/^\s*(?:set\s+)?AS_JAVA\s*=\s*(.+)\s*$/mi);
            if (match) {
                const javaHome = match[1].trim().replace(/^["']|["']$/g, '');
                Logger.info('HOTRELOAD', `AS_JAVA detectado en ${path.basename(asenvPath)}: ${javaHome}`);
                return javaHome;
            }
        }

        const envJava = process.env.JAVA_HOME || '';
        Logger.warn('HOTRELOAD', `No se encontró AS_JAVA; usando JAVA_HOME: ${envJava}`);
        return envJava;
    }

    private static findAsenvPath(serverPath: string): string | undefined {
        if (!serverPath) { return undefined; }
        const candidates = [
            path.join(serverPath, 'glassfish', 'config', 'asenv.bat'),
            path.join(serverPath, 'config', 'asenv.bat'),
            path.join(serverPath, 'glassfish', 'config', 'asenv.conf'),
            path.join(serverPath, 'config', 'asenv.conf'),
        ];
        return candidates.find(p => fs.existsSync(p));
    }

    /**
     * Lee el puerto de debug del domain.xml (default 9009).
     * Busca debug-options con `-agentlib:jdwp` o `-Xrunjdwp`.
     */
    private static getDebugPort(serverPath: string): number {
        const DEFAULT_PORT = 9009;
        if (!serverPath) { return DEFAULT_PORT; }

        const { domain } = ConfigManager.getServerConfig();
        const domainXml = path.join(serverPath, 'glassfish', 'domains', domain || 'domain1', 'config', 'domain.xml');

        if (!fs.existsSync(domainXml)) { return DEFAULT_PORT; }

        try {
            const content = fs.readFileSync(domainXml, 'utf-8');
            // Buscar address= en debug-options
            const match = content.match(/address=(\d+)/);
            if (match) { return parseInt(match[1], 10); }
        } catch {
            // Ignorar
        }
        return DEFAULT_PORT;
    }

    /**
     * Detecta el tipo de JVM a partir del javaHome y la salida de java -version.
     * Prioridad: dcevm-alt (carpeta dcevm dentro del JDK) > dcevm (firma en versión) > standard.
     */
    private static detectKind(javaHome: string, versionOutput: string): JvmKind {
        // Detectar dcevm-alt: existe una carpeta 'dcevm' dentro del JDK
        const dcevmAltDir = path.join(javaHome, 'jre', 'lib', 'dcevm');
        const dcevmAltDir2 = path.join(javaHome, 'lib', 'dcevm');
        if (fs.existsSync(dcevmAltDir) || fs.existsSync(dcevmAltDir2)) {
            const lower = versionOutput.toLowerCase();
            if (!this.hasDcevmSignature(lower)) {
                // Tiene la carpeta pero no arranca con DCEVM por defecto
                return 'dcevm-alt';
            }
        }

        // Detectar dcevm por firma en java -version
        if (this.hasDcevmSignature(versionOutput.toLowerCase())) {
            return 'dcevm';
        }

        if (!versionOutput) { return 'unknown'; }
        return 'standard';
    }

    private static hasDcevmSignature(lower: string): boolean {
        const signatures = [
            'dcevm',
            'dynamic code evolution',
            'trava',
            'zulu jdk 8 dcevm',
            'jdk-8+dcevm',
            'openjdk (dcevm)',
            'java se 8 (dcevm)',
        ];
        return signatures.some(sig => lower.includes(sig));
    }

    private static runJavaVersion(javaBin: string): string {
        const methods = [
            () => {
                try {
                    return execSync(`"${javaBin}" -version 2>&1`, {
                        encoding: 'utf-8', timeout: 10000, windowsHide: true,
                    }).trim();
                } catch (err: any) {
                    const data = err.stdout?.toString() || err.stderr?.toString() || '';
                    return data.trim() || null;
                }
            },
            () => {
                try {
                    return execSync(`"${javaBin}" -version`, {
                        encoding: 'utf-8', timeout: 10000, windowsHide: true,
                        stdio: ['ignore', 'pipe', 'pipe'],
                    }).trim();
                } catch (err: any) {
                    const data = err.stdout?.toString() || err.stderr?.toString() || '';
                    return data.trim() || null;
                }
            },
        ];

        for (const m of methods) {
            const r = m();
            if (r) { return r; }
        }

        // Fallback: archivo temporal
        return this.runJavaVersionViaFile(javaBin);
    }

    private static runJavaVersionViaFile(javaBin: string): string {
        const tmpDir = process.env.TEMP || process.env.TMPDIR || '/tmp';
        const tmpFile = path.join(tmpDir, `mm43_jv_${process.pid}_${Date.now()}.txt`);
        const cmd = process.platform === 'win32'
            ? `"${javaBin}" -version 2>"${tmpFile}"`
            : `"${javaBin}" -version >"${tmpFile}" 2>&1`;
        try {
            execSync(cmd, { encoding: 'utf-8', timeout: 10000, windowsHide: true });
        } catch { /* versión va a stderr; el archivo puede tener contenido */ }
        try {
            if (fs.existsSync(tmpFile)) {
                const result = fs.readFileSync(tmpFile, 'utf8').trim();
                fs.unlinkSync(tmpFile);
                return result;
            }
        } catch { /* ignorar */ }
        return '';
    }
}

