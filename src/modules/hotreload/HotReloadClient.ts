import * as net from 'net';
import { ConfigManager } from '../../config/ConfigManager';
import { Logger } from '../logger/Logger';

/**
 * Cliente TCP para comunicarse con el HotReloadAgent.
 * 
 * Protocolo de envío:    NombreCompletoDeLaClase|RutaAbsolutaAlArchivoClass\n
 * Protocolo de respuesta: OK|NombreClase\n   o   ERROR|NombreClase|mensaje\n
 */
export class HotReloadClient {

    /**
     * Envía una petición de recarga al agente y espera la respuesta.
     * @param className Nombre completo de la clase (ej: com.miapp.controllers.MiControlador)
     * @param classFilePath Ruta absoluta al archivo .class compilado
     * @returns Promise que resuelve con true si la redefinición fue exitosa
     */
    static async sendReload(className: string, classFilePath: string): Promise<boolean> {
        const port = ConfigManager.getHotReloadPort();
        const message = `${className}|${classFilePath}`;

        return new Promise((resolve) => {
            const socket = new net.Socket();
            let resolved = false;
            let responseData = '';

            socket.setTimeout(8000);

            socket.connect(port, '127.0.0.1', () => {
                Logger.info('HOTRELOAD', `⚡ Enviando recarga: ${className}`);
                socket.write(message + '\n');
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
                    Logger.error('HOTRELOAD', `❌ Agente rechazó ${className}: ${errorMsg}`);
                    resolve(false);
                } else {
                    // Respuesta no reconocida — asumir éxito (compatibilidad con agente viejo)
                    Logger.debug('DEBUG', `Respuesta no reconocida del agente: "${line}". Asumiendo éxito.`);
                    resolve(true);
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
            socket.setTimeout(2000);

            socket.connect(port, '127.0.0.1', () => {
                socket.destroy();
                resolve(true);
            });

            socket.on('error', () => {
                resolve(false);
            });

            socket.on('timeout', () => {
                socket.destroy();
                resolve(false);
            });
        });
    }
}
