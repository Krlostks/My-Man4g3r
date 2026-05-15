import { exec } from 'child_process';
import { ConfigManager } from '../../config/ConfigManager';
import { ServerValidator } from '../server/ServerValidator';
import { Logger } from '../logger/Logger';
import {
    JdbcPool,
    JdbcResource,
    PoolConfig,
    PoolStatus,
    DRIVER_PROFILES,
} from './types';

/**
 * Capa de comunicacion con el servidor GlassFish/Payara a traves de asadmin
 * para la gestion de Connection Pools y JDBC Resources.
 *
 * Todos los metodos son asincronos y manejan errores internamente
 * para no romper el flujo de la extension.
 */
export class AsadminDatabaseManager {

    /* ─── Utilidades internas ────────────────────────────────────────── */

    private static getAsadminPath(): string {
        const { serverPath } = ConfigManager.getServerConfig();
        if (!serverPath) {
            throw new Error('El servidor no esta configurado.');
        }
        const asadminPath = ServerValidator.getAsadminPath(serverPath);
        if (!asadminPath) {
            throw new Error(`No se encontro asadmin en: ${serverPath}`);
        }
        return asadminPath;
    }

    /** Ejecuta un comando asadmin y devuelve stdout */
    private static run(args: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const asadmin = AsadminDatabaseManager.getAsadminPath();
            const cmd = `"${asadmin}" ${args}`;
            Logger.info('DATABASE', `> asadmin ${args}`);

            exec(cmd, { timeout: 20000 }, (error, stdout, stderr) => {
                if (error) {
                    Logger.error('DATABASE', `Error ejecutando asadmin: ${error.message}`);
                    reject(error);
                    return;
                }
                resolve(stdout);
            });
        });
    }

    /* ─── Lectura (Queries) ──────────────────────────────────────────── */

    /**
     * Lista todos los JDBC Connection Pools registrados en el servidor.
     */
    static async listPools(): Promise<JdbcPool[]> {
        try {
            const stdout = await AsadminDatabaseManager.run('list-jdbc-connection-pools');
            const pools: JdbcPool[] = [];
            const lines = stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            for (const line of lines) {
                // Ignorar lineas de resumen de asadmin
                if (line.startsWith('Command') || line.startsWith('Nothing') || line.startsWith('No ')) {
                    continue;
                }
                pools.push({
                    name: line,
                    datasourceClassname: '',
                    status: 'unknown',
                    properties: {},
                });
            }

            Logger.info('DATABASE', `${pools.length} pool(s) encontrado(s).`);
            return pools;
        } catch {
            return [];
        }
    }

    /**
     * Lista todos los JDBC Resources registrados en el servidor.
     */
    static async listResources(): Promise<JdbcResource[]> {
        try {
            const stdout = await AsadminDatabaseManager.run('list-jdbc-resources');
            const resources: JdbcResource[] = [];
            const lines = stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            for (const line of lines) {
                if (line.startsWith('Command') || line.startsWith('Nothing') || line.startsWith('No ')) {
                    continue;
                }
                resources.push({
                    jndiName: line,
                    poolName: '',
                    enabled: true,
                });
            }

            Logger.info('DATABASE', `${resources.length} recurso(s) JDBC encontrado(s).`);
            return resources;
        } catch {
            return [];
        }
    }

    /**
     * Obtiene las propiedades detalladas de un pool especifico.
     * Ejecuta: asadmin get resources.jdbc-connection-pool.<poolName>.*
     */
    static async getPoolDetails(poolName: string): Promise<Record<string, string>> {
        try {
            const stdout = await AsadminDatabaseManager.run(
                `get "resources.jdbc-connection-pool.${poolName}.*"`
            );
            const props: Record<string, string> = {};
            const lines = stdout.split('\n').map(l => l.trim()).filter(l => l.includes('='));

            for (const line of lines) {
                const eqIndex = line.indexOf('=');
                if (eqIndex > 0) {
                    const key = line.substring(0, eqIndex).trim();
                    const value = line.substring(eqIndex + 1).trim();
                    // Extraer solo el nombre corto de la propiedad
                    const shortKey = key.split('.').pop() || key;
                    props[shortKey] = value;
                }
            }

            return props;
        } catch {
            return {};
        }
    }

    /**
     * Obtiene el pool al que apunta un recurso JDBC.
     * Ejecuta: asadmin get resources.jdbc-resource.<jndiName>.pool-name
     */
    static async getResourcePoolName(jndiName: string): Promise<string> {
        try {
            const stdout = await AsadminDatabaseManager.run(
                `get "resources.jdbc-resource.${jndiName}.pool-name"`
            );
            const lines = stdout.split('\n').map(l => l.trim()).filter(l => l.includes('='));
            for (const line of lines) {
                const eqIndex = line.indexOf('=');
                if (eqIndex > 0) {
                    return line.substring(eqIndex + 1).trim();
                }
            }
            return '';
        } catch {
            return '';
        }
    }

    /* ─── Acciones (Mutaciones) ──────────────────────────────────────── */

    /**
     * Hace ping a un Connection Pool para verificar su estado.
     * Retorna true si la conexion fue exitosa.
     */
    static async pingPool(poolName: string): Promise<PoolStatus> {
        try {
            const stdout = await AsadminDatabaseManager.run(`ping-connection-pool "${poolName}"`);
            const success = stdout.toLowerCase().includes('succeeded') ||
                            stdout.toLowerCase().includes('command ping-connection-pool executed successfully');
            const status: PoolStatus = success ? 'active' : 'error';
            Logger.info('DATABASE', `Ping a '${poolName}': ${success ? 'OK' : 'FALLIDO'}`);
            return status;
        } catch {
            Logger.error('DATABASE', `Ping a '${poolName}': ERROR`);
            return 'error';
        }
    }

    /**
     * Crea un JDBC Connection Pool en el servidor.
     */
    static async createPool(config: PoolConfig): Promise<boolean> {
        const profile = DRIVER_PROFILES[config.driver];

        // Construir las propiedades segun el motor
        const props = AsadminDatabaseManager.buildPoolProperties(config);

        const args = [
            'create-jdbc-connection-pool',
            `--datasourceclassname="${profile.datasourceClassname}"`,
            `--restype="${profile.resType}"`,
            `--property="${props}"`,
            `"${config.poolName}"`,
        ].join(' ');

        try {
            Logger.section(`Creando Pool: ${config.poolName}`);
            await AsadminDatabaseManager.run(args);
            Logger.info('DATABASE', `Pool '${config.poolName}' creado exitosamente.`);
            return true;
        } catch (err) {
            Logger.error('DATABASE', `Error al crear pool '${config.poolName}': ${String(err)}`);
            return false;
        }
    }

    /**
     * Crea un JDBC Resource apuntando a un pool existente.
     */
    static async createResource(jndiName: string, poolName: string): Promise<boolean> {
        const args = `create-jdbc-resource --connectionpoolid="${poolName}" "${jndiName}"`;

        try {
            Logger.section(`Creando Recurso JDBC: ${jndiName}`);
            await AsadminDatabaseManager.run(args);
            Logger.info('DATABASE', `Recurso '${jndiName}' creado (pool: ${poolName}).`);
            return true;
        } catch (err) {
            Logger.error('DATABASE', `Error al crear recurso '${jndiName}': ${String(err)}`);
            return false;
        }
    }

    /**
     * Elimina un Connection Pool del servidor.
     * IMPORTANTE: Requiere que no haya recursos apuntando a el.
     */
    static async deletePool(poolName: string): Promise<boolean> {
        try {
            await AsadminDatabaseManager.run(`delete-jdbc-connection-pool --cascade=true "${poolName}"`);
            Logger.info('DATABASE', `Pool '${poolName}' eliminado.`);
            return true;
        } catch (err) {
            Logger.error('DATABASE', `Error al eliminar pool '${poolName}': ${String(err)}`);
            return false;
        }
    }

    /**
     * Elimina un JDBC Resource del servidor.
     */
    static async deleteResource(jndiName: string): Promise<boolean> {
        try {
            await AsadminDatabaseManager.run(`delete-jdbc-resource "${jndiName}"`);
            Logger.info('DATABASE', `Recurso '${jndiName}' eliminado.`);
            return true;
        } catch (err) {
            Logger.error('DATABASE', `Error al eliminar recurso '${jndiName}': ${String(err)}`);
            return false;
        }
    }

    /**
     * Actualiza una propiedad de un pool existente.
     * Ejecuta: asadmin set resources.jdbc-connection-pool.<pool>.<prop>=<value>
     */
    static async setPoolProperty(poolName: string, property: string, value: string): Promise<boolean> {
        try {
            await AsadminDatabaseManager.run(
                `set "resources.jdbc-connection-pool.${poolName}.${property}=${value}"`
            );
            Logger.info('DATABASE', `Pool '${poolName}': ${property} = ${value}`);
            return true;
        } catch (err) {
            Logger.error('DATABASE', `Error al actualizar '${poolName}.${property}': ${String(err)}`);
            return false;
        }
    }

    /**
     * Cambia el pool al que apunta un recurso JDBC.
     */
    static async setResourcePool(jndiName: string, newPoolName: string): Promise<boolean> {
        try {
            await AsadminDatabaseManager.run(
                `set "resources.jdbc-resource.${jndiName}.pool-name=${newPoolName}"`
            );
            Logger.info('DATABASE', `Recurso '${jndiName}' reasignado a pool '${newPoolName}'.`);
            return true;
        } catch (err) {
            Logger.error('DATABASE', `Error al reasignar recurso '${jndiName}': ${String(err)}`);
            return false;
        }
    }

    /* ─── Generacion de propiedades por motor ────────────────────────── */

    /**
     * Construye la cadena de propiedades para create-jdbc-connection-pool
     * segun el driver seleccionado.
     */
    private static buildPoolProperties(config: PoolConfig): string {
        const parts: string[] = [];

        switch (config.driver) {
            case 'sqlserver':
                parts.push(`serverName=${config.host}`);
                parts.push(`portNumber=${config.port}`);
                parts.push(`databaseName=${config.databaseName}`);
                parts.push(`user=${config.user}`);
                parts.push(`password=${config.password}`);
                parts.push(`selectMethod=cursor`);
                break;
            case 'mysql':
                parts.push(`serverName=${config.host}`);
                parts.push(`port=${config.port}`);
                parts.push(`databaseName=${config.databaseName}`);
                parts.push(`user=${config.user}`);
                parts.push(`password=${config.password}`);
                parts.push(`useSSL=false`);
                break;
            case 'oracle':
                parts.push(`serverName=${config.host}`);
                parts.push(`portNumber=${config.port}`);
                parts.push(`databaseName=${config.databaseName}`);
                parts.push(`user=${config.user}`);
                parts.push(`password=${config.password}`);
                parts.push(`driverType=thin`);
                break;
            case 'postgresql':
                parts.push(`serverName=${config.host}`);
                parts.push(`portNumber=${config.port}`);
                parts.push(`databaseName=${config.databaseName}`);
                parts.push(`user=${config.user}`);
                parts.push(`password=${config.password}`);
                break;
        }

        // Agregar propiedades adicionales si las hay
        if (config.additionalProperties) {
            for (const [key, value] of Object.entries(config.additionalProperties)) {
                parts.push(`${key}=${value}`);
            }
        }

        // El formato de asadmin usa ':' como separador de propiedades
        return parts.join(':');
    }
}
