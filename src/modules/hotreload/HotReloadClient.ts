import * as net from 'net';
import { ConfigManager } from '../../config/ConfigManager';
import { Logger } from '../logger/Logger';


export class HotReloadClient {


    static async sendReload(className: string, classFilePath: string): Promise<boolean> {
        console.log("className es: " + className + " y filepath es:" + classFilePath);
        // Validacion de entrada: evitar romper el protocolo basado en '|'
        if (!className || !className.trim()) {

            Logger.error('HOTRELOAD', 'sendReload: className vacio');
            return false;
        }
        if (!classFilePath || !classFilePath.trim()) {
            Logger.error('HOTRELOAD', 'sendReload: classFilePath vacio');
            return false;
        }
        if (className.includes('|') || classFilePath.includes('|') ||
            className.includes('\n') || classFilePath.includes('\n')) {
            Logger.error('HOTRELOAD', `sendReload: caracteres invalidos en parametros (${className})`);
            return false;
        }

        const port = ConfigManager.getHotReloadPort();
        const message = `REDEFINE|${className}|${classFilePath}`;

        return new Promise((resolve) => {
            const socket = new net.Socket();
            let resolved = false;
            let responseData = '';

            socket.setTimeout(8000);

            socket.connect(port, '127.0.0.1', () => {
                Logger.info('HOTRELOAD', `⚡ Enviando recarga: ${className}`);
                socket.end(message + '\n');
            });

            socket.on('data', (data) => {
                responseData += data.toString();
            });

            socket.on('end', () => {
                if (resolved) { return; }
                resolved = true;

                const line = responseData.trim();
                if (line.startsWith('OK|')) {
                    Logger.info('HOTRELOAD', `  Agente confirmó redefinición: ${className}`);
                    resolve(true);
                } else if (line.startsWith('ERROR|')) {
                    const parts = line.split('|');
                    const errorMsg = parts.length >= 3 ? parts.slice(2).join('|') : 'Error desconocido';
                    Logger.error('HOTRELOAD', ` Agente rechazó ${className}: ${errorMsg}`);
                    resolve(false);
                } else if (line.length === 0) {
                    resolve(true);
                } else {
                    Logger.debug('DEBUG', `Respuesta no reconocida del agente: "${line}". Asumiendo éxito.`);
                    resolve(false);
                }
            });

            socket.on('close', () => {
                if (!resolved) {
                    resolved = true;
                    // Si no hubo data ni end, asumir éxito (fire-and-forget fallback)
                    if (responseData.length === 0) {
                        resolve(true);
                    }
                }
            });

            socket.on('error', (err) => {
                if (!resolved) {
                    resolved = true;
                    Logger.error('HOTRELOAD', `Error al conectar con el agente (puerto ${port}): ${err.message}`);
                    socket.destroy();
                    resolve(false);
                }
            });

            socket.on('timeout', () => {
                if (!resolved) {
                    resolved = true;
                    Logger.error('HOTRELOAD', `Timeout al conectar con el agente (puerto ${port})`);
                    socket.destroy();
                    resolve(false);
                }
            });
        });
    }

    /**
     * Verifica si el agente está activo intentando una conexión rápida al puerto.
     */
    static async isAgentAlive(): Promise<boolean> {
        const port = ConfigManager.getHotReloadPort();

        return new Promise((resolve) => {
            const socket = new net.Socket();
            let resolved = false;
            socket.setTimeout(2000);

            const finish = (alive: boolean) => {
                if (resolved) { return; }
                resolved = true;
                socket.destroy();
                resolve(alive);
            };

            socket.connect(port, '127.0.0.1', () => {
                finish(true);
            });

            socket.on('error', () => {
                finish(false);
            });

            socket.on('timeout', () => {
                finish(false);
            });
        });
    }
}
