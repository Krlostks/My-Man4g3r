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
 * La detección se ejecuta UNA sola vez: al importar el agente o en el primer arranque.
 * No se ejecuta en cada arranque del servidor.
 */
export class DcevmValidator {

    /**
     * Localiza la variable AS_JAVA en asenv.bat del servidor para determinar
     * qué instalación de Java usa el servidor (independiente del JAVA_HOME global).
     */
    static getServerJavaHome(): string {
        const { serverPath } = ConfigManager.getServerConfig();
        if (!serverPath) { return ''; }

        // Buscar asenv.bat en las dos ubicaciones posibles
        const candidates = [
            path.join(serverPath, 'glassfish', 'config', 'asenv.bat'),
            path.join(serverPath, 'config', 'asenv.bat'),
        ];

        for (const asenvPath of candidates) {
            if (fs.existsSync(asenvPath)) {
                const content = fs.readFileSync(asenvPath, 'utf-8');
                // Extraer AS_JAVA=... del archivo
                const match = content.match(/^\s*set\s+AS_JAVA\s*=\s*(.+)\s*$/mi);
                if (match) {
                    const javaHome = match[1].trim();
                    Logger.info('HOTRELOAD', `AS_JAVA detectado en asenv.bat: ${javaHome}`);
                    return javaHome;
                }
            }
        }

        // Fallback: usar JAVA_HOME del entorno
        const envJava = process.env.JAVA_HOME || '';
        Logger.warn('HOTRELOAD', `No se encontró AS_JAVA en asenv.bat, usando JAVA_HOME: ${envJava}`);
        return envJava;
    }

    /**
     * Ejecuta `java -version` en la JVM del servidor y busca indicadores de DCEVM.
     * Retorna un resultado con la información completa.
     */
    static checkDcevm(): DcevmCheckResult {
        const javaHome = this.getServerJavaHome();
        if (!javaHome) {
            return { isDcevm: false, javaHome: '', versionOutput: 'No se pudo determinar la ruta de Java del servidor.' };
        }

        const javaBin = path.join(javaHome, 'bin', 'java.exe');
        if (!fs.existsSync(javaBin)) {
            return { isDcevm: false, javaHome, versionOutput: `Ejecutable java no encontrado en: ${javaBin}` };
        }

        try {
            // java -version escribe en STDERR → redirigimos con 2>&1
            const output = execSync(`"${javaBin}" -version 2>&1`, {
                encoding: 'utf-8',
                timeout: 10000,
            });

            const isDcevm = this.containsDcevmSignature(output);

            Logger.info('HOTRELOAD', `Verificación DCEVM — resultado: ${isDcevm ? 'DCEVM Detectado  ' : 'JVM Estándar ⚠️'}`);
            Logger.info('HOTRELOAD', `java -version output: ${output.trim()}`);
            return { isDcevm, javaHome, versionOutput: output };
        } catch (err: any) {
            // Fallback: si execSync lanza error, intentamos capturar stderr
            const stderr = err.stderr?.toString() || '';
            const stdout = err.stdout?.toString() || '';
            const combined = stderr + stdout;
            const isDcevm = this.containsDcevmSignature(combined);

            Logger.info('HOTRELOAD', `Verificación DCEVM (fallback) — resultado: ${isDcevm ? 'DCEVM Detectado  ' : 'JVM Estándar ⚠️'}`);
            Logger.info('HOTRELOAD', `java -version output (fallback): ${combined.trim()}`);
            return { isDcevm, javaHome, versionOutput: combined };
        }
    }

    /**
     * Busca firmas conocidas de DCEVM en la salida de java -version.
     */
    private static containsDcevmSignature(output: string): boolean {
        const lower = output.toLowerCase();
        return lower.includes('dcevm') ||
            lower.includes('dynamic code evolution') ||
            lower.includes('trava');
    }

    /**
     * Retorna la ruta del archivo asenv.bat para que el usuario lo pueda editar.
     */
    static getAsenvPath(): string | undefined {
        const { serverPath } = ConfigManager.getServerConfig();
        if (!serverPath) { return undefined; }

        const candidates = [
            path.join(serverPath, 'glassfish', 'config', 'asenv.bat'),
            path.join(serverPath, 'config', 'asenv.bat'),
        ];

        for (const p of candidates) {
            if (fs.existsSync(p)) { return p; }
        }
        return undefined;
    }
}
