import * as net from 'net';
import { ConfigManager } from '../../config/ConfigManager';
import { Logger } from '../logger/Logger';


export type HotReloadStatus =
    | 'SUCCESS'
    | 'INVALID_REQUEST'
    | 'CONNECTION_REFUSED'
    | 'TIMEOUT'
    | 'AGENT_UNAVAILABLE'
    | 'CLASS_REJECTED'
    | 'STRUCTURAL_UNSUPPORTED'
    | 'PROTOCOL_ERROR'
    | 'UNKNOWN_RESPONSE';

export interface HotReloadResult {
    success: boolean;
    status: HotReloadStatus;
    message: string;
    reloadType: 'method-body' | 'structural';
    requiresRedeploy: boolean;
}

export interface HotReloadCapabilities {
    reachable: boolean;
    supportsRedefinition: boolean;
    supportsStructuralChanges: boolean;
    supportsAuxiliaryClasses: boolean;
    rawResponse?: string;
    message: string;
}

interface AgentRequestResult {
    success: boolean;
    status: HotReloadStatus;
    message: string;
    response: string;
}

export class HotReloadClient {

    static async sendReload(className: string, classFilePath: string): Promise<boolean> {
        const result = await this.sendReloadResult(className, classFilePath);
        return result.success;
    }

    static async sendReloadResult(className: string, classFilePath: string): Promise<HotReloadResult> {
        if (!className?.trim() || !classFilePath?.trim()) {
            return { success: false, status: 'INVALID_REQUEST', message: 'Clase o archivo vacío.', reloadType: 'method-body', requiresRedeploy: false };
        }
        if ([className, classFilePath].some(value => /[|\r\n]/.test(value))) {
            return { success: false, status: 'INVALID_REQUEST', message: 'Parámetros inválidos para el protocolo.', reloadType: 'method-body', requiresRedeploy: false };
        }

        const request = await this.request(`REDEFINE|${className}|${classFilePath}`, 8000);
        if (request.success) {
            Logger.info('HOTRELOAD', `Agente confirmó redefinición: ${className}`);
        } else {
            Logger.error('HOTRELOAD', `Agente no pudo redefinir ${className}: ${request.message}`);
        }
        return {
            success: request.success,
            status: request.status,
            message: request.message,
            reloadType: 'method-body',
            requiresRedeploy: request.status === 'STRUCTURAL_UNSUPPORTED',
        };
    }

    /** Consulta PING y CAPABILITIES sin interpretar el cierre del socket como éxito. */
    static async getCapabilities(): Promise<HotReloadCapabilities> {
        const ping = await this.request('PING', 2000);
        if (!ping.success) {
            return {
                reachable: false,
                supportsRedefinition: false,
                supportsStructuralChanges: false,
                supportsAuxiliaryClasses: false,
                message: ping.message,
            };
        }

        const capabilities = await this.request('CAPABILITIES', 3000);
        if (!capabilities.success) {
            return {
                reachable: true,
                supportsRedefinition: true,
                supportsStructuralChanges: false,
                supportsAuxiliaryClasses: false,
                message: `Agente activo, pero no informó capacidades: ${capabilities.message}`,
            };
        }

        return this.parseCapabilities(capabilities.response);
    }

    static async isAgentAlive(): Promise<boolean> {
        const capabilities = await this.getCapabilities();
        return capabilities.reachable;
    }

    private static parseCapabilities(response: string): HotReloadCapabilities {
        const line = response.trim();
        const payload = line.includes('|') ? line.substring(line.indexOf('|') + 1) : line;
        const values = new Set(payload.split(/[|,;\s]+/).map(value => value.trim().toUpperCase()).filter(Boolean));
        const has = (...names: string[]) => names.some(name => values.has(name));

        return {
            reachable: true,
            supportsRedefinition: has('REDEFINE', 'BASIC', 'HOTSWAP') || line === 'OK',
            supportsStructuralChanges: has('STRUCTURAL', 'DCEVM'),
            supportsAuxiliaryClasses: has('AUXILIARY_CLASSES', 'AUXILIARY', 'CLASS_DEFINITION'),
            rawResponse: response,
            message: `Capacidades recibidas: ${line}`,
        };
    }

    private static request(command: string, timeoutMs: number): Promise<AgentRequestResult> {
        const port = ConfigManager.getHotReloadPort();
        return new Promise((resolve) => {
            const socket = new net.Socket();
            let settled = false;
            let responseData = '';

            const finish = (result: AgentRequestResult): void => {
                if (settled) { return; }
                settled = true;
                socket.destroy();
                resolve(result);
            };

            socket.setTimeout(timeoutMs);
            socket.connect(port, '127.0.0.1', () => socket.end(`${command}\n`));
            socket.on('data', data => { responseData += data.toString(); });
            socket.on('end', () => {
                const line = responseData.trim();
                if (!line) {
                    finish({ success: false, status: 'AGENT_UNAVAILABLE', message: 'El agente cerró la conexión sin responder.', response: '' });
                } else if (line === 'OK' || line.startsWith('OK|') || line.startsWith('PONG')) {
                    finish({ success: true, status: 'SUCCESS', message: line, response: line });
                } else if (/STRUCTURAL[_ -]?UNSUPPORTED|UNSUPPORTED_STRUCTURAL/i.test(line)) {
                    finish({ success: false, status: 'STRUCTURAL_UNSUPPORTED', message: line, response: line });
                } else if (line.startsWith('ERROR|')) {
                    finish({ success: false, status: 'CLASS_REJECTED', message: line.substring(6) || 'El agente rechazó la operación.', response: line });
                } else {
                    finish({ success: false, status: 'PROTOCOL_ERROR', message: `Respuesta no reconocida: ${line}`, response: line });
                }
            });
            socket.on('error', error => finish({ success: false, status: 'CONNECTION_REFUSED', message: error.message, response: responseData }));
            socket.on('timeout', () => finish({ success: false, status: 'TIMEOUT', message: `Timeout del agente en el puerto ${port}.`, response: responseData }));
            socket.on('close', () => {
                if (!settled && !responseData) {
                    finish({ success: false, status: 'AGENT_UNAVAILABLE', message: 'El agente no respondió.', response: '' });
                }
            });
        });
    }

}
