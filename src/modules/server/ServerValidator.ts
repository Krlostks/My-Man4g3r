import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../logger/Logger';

export class ServerValidator {
    /**
     * Valida si un directorio tiene la estructura de un servidor GlassFish/Payara.
     */
    static validate(serverPath: string): { valid: boolean; error?: string } {
        try {
            if (!fs.existsSync(serverPath)) {
                return { valid: false, error: 'La ruta especificada no existe.' };
            }

            const stats = fs.statSync(serverPath);
            if (!stats.isDirectory()) {
                return { valid: false, error: 'La ruta no es un directorio.' };
            }

            // Rutas críticas para validar un servidor compatible con GlassFish
            const criticalFiles = [
                path.join(serverPath, 'glassfish', 'bin', 'asadmin.bat'),
                path.join(serverPath, 'glassfish', 'domains')
            ];

            // Alternativa para instalaciones más compactas o diferentes versiones
            const alternativeFiles = [
                path.join(serverPath, 'bin', 'asadmin.bat'),
                path.join(serverPath, 'domains')
            ];

            const hasCritical = criticalFiles.every(f => fs.existsSync(f));
            const hasAlternative = alternativeFiles.every(f => fs.existsSync(f));

            if (!hasCritical && !hasAlternative) {
                Logger.error('SERVER', `Validación fallida en: ${serverPath}`);
                return { 
                    valid: false, 
                    error: 'La estructura del directorio no corresponde a un servidor GlassFish/Payara válido (falta asadmin o carpeta de dominios).' 
                };
            }

            Logger.info('SERVER', `Servidor validado correctamente en: ${serverPath}`);
            return { valid: true };
        } catch (err) {
            return { valid: false, error: `Error al validar el directorio: ${(err as Error).message}` };
        }
    }

    /**
     * Intenta encontrar la ruta exacta de asadmin en el servidor.
     */
    static getAsadminPath(serverPath: string): string | undefined {
        const candidates = [
            path.join(serverPath, 'glassfish', 'bin', 'asadmin.bat'),
            path.join(serverPath, 'bin', 'asadmin.bat'),
            path.join(serverPath, 'glassfish', 'bin', 'asadmin'),
            path.join(serverPath, 'bin', 'asadmin')
        ];

        for (const p of candidates) {
            if (fs.existsSync(p)) {
                return p;
            }
        }
        return undefined;
    }
}
