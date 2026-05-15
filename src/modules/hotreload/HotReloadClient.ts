import * as net from 'net';
import { ConfigManager } from '../../config/ConfigManager';
import { Logger } from '../logger/Logger';

/**
 * Cliente TCP para comunicarse con el HotReloadAgent que escucha en el puerto 9999.
 * Protocolo: `NombreCompletoDeLaClase|RutaAbsolutaAlArchivoClass\n`
 */
export class HotReloadClient {

    /**
     * Envía una petición de recarga al agente.
     * @param className Nombre completo de la clase (ej: com.miapp.controllers.MiControlador)
     * @param classFilePath Ruta absoluta al archivo .class compilado
     * @returns Promise que resuelve con true si el envío fue exitoso
     */
    static async sendReload(className: string, classFilePath: string): Promise<boolean> {
        const port = ConfigManager.getHotReloadPort();
        const message = `${className}|${classFilePath}`;

        return new Promise((resolve) => {
            const socket = new net.Socket();
            let resolved = false;

            socket.setTimeout(5000);

            socket.connect(port, '127.0.0.1', () => {
                Logger.info('HOTRELOAD', `⚡ Enviando recarga: ${className}`);
                socket.write(message + '\n');
                socket.end();
            });

            socket.on('close', () => {
                if (!resolved) {
                    resolved = true;
                    resolve(true);
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
