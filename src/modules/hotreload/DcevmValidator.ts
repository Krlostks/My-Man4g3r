import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ConfigManager } from '../../config/ConfigManager';
import { Logger } from '../logger/Logger';

export type DcevmCheckResult = {
    isDcevm: boolean;
    javaHome: string;
    versionOutput: string;
};

/**
 * Valida si la JVM que utiliza el servidor es DCEVM (Dynamic Code Evolution VM).
 *
 * La deteccion se ejecuta UNA sola vez: al importar el agente o en el primer arranque.
 * No se ejecuta en cada arranque del servidor.
 */
export class DcevmValidator {

    /**
     * Localiza la variable AS_JAVA en asenv.bat del servidor para determinar
     * que instalacion de Java usa el servidor (independiente del JAVA_HOME global).
     */
    static getServerJavaHome(): string {
        const { serverPath } = ConfigManager.getServerConfig();
        if (!serverPath) { return ''; }

        // Buscar asenv.bat (Windows) y asenv.conf (Linux/Unix) en ubicaciones posibles
        const candidates = [
            path.join(serverPath, 'glassfish', 'config', 'asenv.bat'),
            path.join(serverPath, 'config', 'asenv.bat'),
            path.join(serverPath, 'glassfish', 'config', 'asenv.conf'),
            path.join(serverPath, 'config', 'asenv.conf'),
        ];

        for (const asenvPath of candidates) {
            if (fs.existsSync(asenvPath)) {
                const content = fs.readFileSync(asenvPath, 'utf-8');
                // Soportar formato Windows (set AS_JAVA=...) y Linux (AS_JAVA=...)
                const match = content.match(/^\s*(?:set\s+)?AS_JAVA\s*=\s*(.+)\s*$/mi);
                if (match) {
                    // Remover comillas envolventes si existen
                    const javaHome = match[1].trim().replace(/^["']|["']$/g, '');
                    Logger.info('HOTRELOAD', `AS_JAVA detectado en ${path.basename(asenvPath)}: ${javaHome}`);
                    return javaHome;
                }
            }
        }

        // Fallback: usar JAVA_HOME del entorno
        const envJava = process.env.JAVA_HOME || '';
        Logger.warn('HOTRELOAD', `No se encontró AS_JAVA, usando JAVA_HOME: ${envJava}`);
        return envJava;
    }

    /**
     * Ejecuta `java -version` en la JVM del servidor y busca indicadores de DCEVM.
     * Retorna un resultado con la informacion completa.
     */
    static checkDcevm(): DcevmCheckResult {
        const javaHome = this.getServerJavaHome();
        if (!javaHome) {
            return { isDcevm: false, javaHome: '', versionOutput: 'No se pudo determinar la ruta de Java del servidor.' };
        }

        // Seleccionar ejecutable segun plataforma
        const javaExe = process.platform === 'win32' ? 'java.exe' : 'java';
        const javaBin = path.join(javaHome, 'bin', javaExe);

        if (!fs.existsSync(javaBin)) {
            return { isDcevm: false, javaHome, versionOutput: `Ejecutable java no encontrado en: ${javaBin}` };
        }

        // Ejecutar java -version manejando diferencias entre plataformas
        const output = this.ejecutarJavaVersion(javaBin);
        const isDcevm = this.containsDcevmSignature(output);

        Logger.info('HOTRELOAD', `Verificacion DCEVM - resultado: ${isDcevm ? 'DCEVM Detectado  ' : 'JVM Estandar ⚠️'}`);
        Logger.info('HOTRELOAD', `java -version output: ${output.trim()}`);
        return { isDcevm, javaHome, versionOutput: output };
    }

    /**
     * Ejecuta `java -version` manejando las diferencias entre plataformas Windows/Linux/Mac.
     * En Windows, java -version puede escribir en stderr o stdout dependiendo de la version.
     */
    private static ejecutarJavaVersion(javaBin: string): string {
        // Intentar multiples metodos de ejecucion
        const metodos = [
            // Metodo 1: execSync con redireccion estandar (funciona en la mayoria)
            () => {
                try {
                    const result = execSync(`"${javaBin}" -version 2>&1`, {
                        encoding: 'utf-8',
                        timeout: 10000,
                        windowsHide: true,
                    });
                    if (result && result.trim()) {
                        Logger.debug('DEBUG', `java -version OK (metodo 2>&1)`);
                        return result.trim();
                    }
                } catch (err: any) {
                    Logger.debug('DEBUG', `Metodo 2>&1 fallo: ${err.message}`);
                }
                return null;
            },
            // Metodo 2: execSync sin redireccion (algunas versiones de Windows)
            () => {
                try {
                    const result = execSync(`"${javaBin}" -version`, {
                        encoding: 'utf-8',
                        timeout: 10000,
                        windowsHide: true,
                    });
                    if (result && result.trim()) {
                        Logger.debug('DEBUG', `java -version OK (sin redireccion)`);
                        return result.trim();
                    }
                } catch (err: any) {
                    Logger.debug('DEBUG', `Metodo sin redireccion fallo: ${err.message}`);
                }
                return null;
            },
            // Metodo 3: capturar streams directamente
            () => {
                try {
                    execSync(`"${javaBin}" -version`, {
                        encoding: 'utf-8',
                        timeout: 10000,
                        windowsHide: true,
                        stdio: ['ignore', 'pipe', 'pipe'],
                    });
                } catch (err: any) {
                    // Cuando execSync falla, los datos pueden estar en stdout/stderr
                    const data = err.stdout?.toString() || err.stderr?.toString() || '';
                    if (data.trim()) {
                        Logger.debug('DEBUG', `Capturado tras error: ${data.trim().substring(0, 100)}`);
                        return data.trim();
                    }
                }
                return null;
            },
        ];

        for (const metodo of metodos) {
            const resultado = metodo();
            if (resultado) {
                return resultado;
            }
        }

        // Fallback final: redireccion a archivo temporal (100% sincrono)
        return this.ejecutarJavaVersionConArchivoTemporal(javaBin);
    }

    /**
     * Fallback robusto: ejecuta java -version redirigiendo la salida a un archivo
     * temporal mediante el shell, y lo lee SINCRONAMENTE.
     *
     * A diferencia de spawn (que es asincrono), execSync con redireccion de shell
     * garantiza que el archivo ya este escrito cuando lo leemos.
     */
    private static ejecutarJavaVersionConArchivoTemporal(javaBin: string): string {
        const tempDir = process.env.TEMP || process.env.TMPDIR || '/tmp';
        const tempFile = path.join(tempDir, `mm43_javaversion_${process.pid}_${Date.now()}.txt`);

        // En Windows java -version va a stderr; en Unix lo unificamos a stdout
        const cmd = process.platform === 'win32'
            ? `"${javaBin}" -version 2>"${tempFile}"`
            : `"${javaBin}" -version >"${tempFile}" 2>&1`;

        try {
            execSync(cmd, {
                encoding: 'utf-8',
                timeout: 10000,
                windowsHide: true,
            });
        } catch (err: any) {
            // Aunque execSync falle, el archivo puede contener la salida util
            Logger.debug('DEBUG', `Comando con archivo temporal lanzo error (puede ser normal): ${err.message}`);
        }

        try {
            if (fs.existsSync(tempFile)) {
                const content = fs.readFileSync(tempFile, 'utf8').trim();
                fs.unlinkSync(tempFile);
                Logger.debug('DEBUG', `java -version OK (archivo temporal): ${content.substring(0, 100)}`);
                return content;
            }
        } catch (readErr) {
            Logger.debug('DEBUG', `Error leyendo archivo temporal: ${readErr}`);
        } finally {
            // Garantizar limpieza
            try {
                if (fs.existsSync(tempFile)) { fs.unlinkSync(tempFile); }
            } catch (e) { /* ignorar */ }
        }

        Logger.warn('HOTRELOAD', 'Todos los metodos de java -version fallaron');
        return '';
    }

    /**
     * Busca firmas conocidas de DCEVM en la salida de java -version.
     */
    private static containsDcevmSignature(output: string): boolean {
        const lower = output.toLowerCase();
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

    /**
     * Retorna la ruta del archivo asenv (bat o conf) para que el usuario lo pueda editar.
     */
    static getAsenvPath(): string | undefined {
        const { serverPath } = ConfigManager.getServerConfig();
        if (!serverPath) { return undefined; }

        const candidates = [
            path.join(serverPath, 'glassfish', 'config', 'asenv.bat'),
            path.join(serverPath, 'config', 'asenv.bat'),
            path.join(serverPath, 'glassfish', 'config', 'asenv.conf'),
            path.join(serverPath, 'config', 'asenv.conf'),
        ];

        for (const p of candidates) {
            if (fs.existsSync(p)) { return p; }
        }
        return undefined;
    }
}