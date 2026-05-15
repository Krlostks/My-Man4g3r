import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../../config/ConfigManager';
import { Logger } from '../logger/Logger';

export class CacheCleaner {

    private get domainPath(): string {
        const { serverPath, domain } = ConfigManager.getServerConfig();
        if (!serverPath || !domain) return '';

        let domainsDir = path.join(serverPath, 'glassfish', 'domains');
        if (!fs.existsSync(domainsDir)) {
            domainsDir = path.join(serverPath, 'domains');
        }
        return path.join(domainsDir, domain);
    }

    /** Borra el contenido de osgi-cache y generated */
    async clearAll(): Promise<void> {
        const domainPath = this.domainPath;
        if (!domainPath) {
            vscode.window.showErrorMessage('[MM43] No se puede limpiar cache: Servidor no configurado.');
            return;
        }
        const targets = [
            path.join(domainPath, 'osgi-cache'),
            path.join(domainPath, 'generated'),
        ];

        Logger.info('CACHE', 'Limpiando caches de Payara...');
        Logger.show();

        let cleaned = 0;
        let errors = 0;

        for (const dir of targets) {
            if (!fs.existsSync(dir)) {
                Logger.warn('CACHE', `Directorio no existe: ${dir}`);
                continue;
            }
            const result = this.deleteContents(dir);
            cleaned += result.deleted;
            errors += result.errors;
            Logger.info('CACHE',
                `${path.basename(dir)}: ${result.deleted} elementos eliminados` +
                (result.errors > 0 ? `, ${result.errors} errores` : '')
            );
        }

        const msg = `Listo: ${cleaned} elementos eliminados.` +
            (errors > 0 ? ` (${errors} errores menores ignorados)` : '');

        Logger.info('CACHE', msg);
        vscode.window.showInformationMessage(`[MM43] 🧹 ${msg}`);
    }

    /** Limpia solo el server.log */
    clearServerLog(): void {
        const logFile = path.join(this.domainPath, 'logs', 'server.log');

        try {
            if (!fs.existsSync(logFile)) {
                vscode.window.showWarningMessage(`[MM43] server.log no encontrado: ${logFile}`);
                return;
            }
            fs.writeFileSync(logFile, '', 'utf-8');
            Logger.info('CACHE', 'server.log limpiado.');
            vscode.window.showInformationMessage('[MM43] server.log limpiado exitosamente.');
        } catch (err) {
            vscode.window.showErrorMessage(`[MM43] Error al limpiar server.log: ${err}`);
        }
    }

    // ─── Privado ──────────────────────────────────────────────────────────────

    private deleteContents(dir: string): { deleted: number; errors: number } {
        let deleted = 0;
        let errors = 0;

        try {
            const entries = fs.readdirSync(dir);
            for (const entry of entries) {
                const fullPath = path.join(dir, entry);
                try {
                    fs.rmSync(fullPath, { recursive: true, force: true });
                    deleted++;
                } catch {
                    errors++;
                }
            }
        } catch {
            errors++;
        }

        return { deleted, errors };
    }
}
