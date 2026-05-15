import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../../config/ConfigManager';
import { Logger } from '../logger/Logger';

export class LogTailer {
    private fileSize = 0;
    private active = false;

    private get logPath(): string {
        const { serverPath, domain } = ConfigManager.getServerConfig();
        if (!serverPath || !domain) return '';
        return path.join(serverPath, 'glassfish', 'domains', domain, 'logs', 'server.log');
    }

    start(): void {
        if (this.active) { return; }

        const logFile = this.logPath;

        if (!fs.existsSync(logFile)) {
            Logger.error('SERVER', `server.log no encontrado: ${logFile}`);
            Logger.show();
            return;
        }

        this.fileSize = fs.statSync(logFile).size;
        this.active = true;

        Logger.section(`Siguiendo logs: ${logFile}`);
        Logger.show();

        this.showTail(logFile, 100);

        fs.watchFile(logFile, { interval: 500 }, (curr, prev) => {
            if (curr.mtime !== prev.mtime) {
                this.readNewContent(logFile);
            }
        });
    }

    stop(): void {
        const logFile = this.logPath;
        if (logFile) {
            fs.unwatchFile(logFile);
        }
        this.active = false;
        Logger.info('SERVER', 'Seguimiento de logs detenido.');
    }

    clear(): void {
        const logFile = this.logPath;
        try {
            fs.writeFileSync(logFile, '', 'utf-8');
            this.fileSize = 0;
            Logger.info('SERVER', 'server.log limpiado.');
            vscode.window.showInformationMessage('[MM43] server.log limpiado exitosamente.');
        } catch (err) {
            vscode.window.showErrorMessage(`[MM43] Error limpiando server.log: ${err}`);
        }
    }

    get isActive(): boolean { return this.active; }

    private readNewContent(logFile: string): void {
        try {
            const stat = fs.statSync(logFile);
            const newSize = stat.size;

            if (newSize < this.fileSize) {
                this.fileSize = 0;
            }

            if (newSize > this.fileSize) {
                const stream = fs.createReadStream(logFile, {
                    start: this.fileSize,
                    end: newSize - 1,
                    encoding: 'utf-8'
                });
                stream.on('data', (chunk: any) => {
                    const content = chunk.toString();
                    Logger.raw(content);
                });
                this.fileSize = newSize;
            }
        } catch {
        }
    }

    private showTail(logFile: string, lines: number): void {
        try {
            const content = fs.readFileSync(logFile, 'utf-8');
            const allLines = content.split('\n');
            const tail = allLines.slice(-lines).filter(l => l.trim().length > 0);
            Logger.raw(tail.join('\n') + '\n');
        } catch {
        }
    }

    dispose(): void {
        this.stop();
    }
}
