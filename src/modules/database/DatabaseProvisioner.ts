import * as vscode from 'vscode';
import { Logger } from '../logger/Logger';
import { AsadminDatabaseManager } from './AsadminDatabaseManager';
import { PersistenceScanner } from './PersistenceScanner';
import {
    DatabaseDriver,
    DRIVER_PROFILES,
    PoolConfig,
    PersistenceUnit,
} from './types';

/**
 * Asistente de aprovisionamiento interactivo para crear Pools y Recursos JDBC.
 *
 * Implementa el flujo de "Stops" para el usuario:
 *   1. Deteccion de recursos faltantes
 *   2. Seleccion de driver (QuickPick)
 *   3. Credenciales (InputBox)
 *   4. Almacenamiento seguro (SecretStorage)
 *   5. Ejecucion de comandos asadmin
 */
export class DatabaseProvisioner {

    constructor(private readonly secretStorage: vscode.SecretStorage) {}

    /**
     * Flujo principal: detecta brechas entre persistence.xml y el servidor,
     * y guia al usuario para crear los recursos faltantes.
     */
    async provisionMissing(onComplete?: () => void): Promise<void> {
        Logger.section('Aprovisionamiento de Recursos JDBC');

        // Paso 0: Escanear persistence.xml de todos los proyectos
        const units = PersistenceScanner.scanAll();
        if (units.length === 0) {
            vscode.window.showInformationMessage(
                '[MM43] No se encontraron unidades de persistencia en los proyectos configurados.'
            );
            return;
        }

        // Paso 1: Obtener recursos existentes en el servidor
        const existingResources = await AsadminDatabaseManager.listResources();
        const existingNames = new Set(existingResources.map(r => r.jndiName));

        // Paso 2: Detectar brechas (comparar con el JNDI global normalizado)
        const missing = units.filter(u => !existingNames.has(u.globalJndiName));

        if (missing.length === 0) {
            vscode.window.showInformationMessage(
                '[MM43] Todos los recursos JDBC requeridos ya existen en el servidor.'
            );
            onComplete?.();
            return;
        }

        Logger.info('DATABASE', `${missing.length} recurso(s) JDBC faltante(s) detectado(s).`);

        // Paso 3: Ofrecer crear cada recurso faltante
        for (const unit of missing) {
            const crear = await vscode.window.showWarningMessage(
                `El recurso '${unit.globalJndiName}' (proyecto: ${unit.projectName}) no existe en el servidor.`,
                { modal: false },
                'Crear ahora',
                'Omitir'
            );

            if (crear === 'Crear ahora') {
                await this.runProvisioningWizard(unit);
            }
        }

        onComplete?.();
    }

    /**
     * Asistente paso a paso para un recurso JDBC individual.
     */
    async runProvisioningWizard(unit: PersistenceUnit): Promise<boolean> {
        Logger.section(`Asistente: ${unit.jtaDataSource}`);

        // ── STOP 1: Seleccion de Driver ─────────────────────────────────
        const driverItems = Object.entries(DRIVER_PROFILES).map(([key, profile]) => ({
            label: `$(${profile.iconId}) ${profile.label}`,
            description: profile.datasourceClassname,
            driverKey: key as DatabaseDriver,
        }));

        const selectedDriver = await vscode.window.showQuickPick(driverItems, {
            title: `MM43 - Seleccionar Motor de Base de Datos (1/4)`,
            placeHolder: 'Selecciona el motor para este recurso',
        });

        if (!selectedDriver) { return false; }
        const driver = selectedDriver.driverKey;
        const profile = DRIVER_PROFILES[driver];

        // ── STOP 2: Nombre del Pool ──────────────────────────────────────
        // Sugerir un nombre basado en el JNDI
        const suggestedPool = this.suggestPoolName(unit.jtaDataSource);

        const poolName = await vscode.window.showInputBox({
            title: 'MM43 - Nombre del Connection Pool (2/4)',
            prompt: 'Nombre identificador para el pool de conexiones',
            value: suggestedPool,
            validateInput: v => v?.trim() ? undefined : 'El nombre no puede estar vacio',
        });

        if (!poolName) { return false; }

        // Verificar si el pool ya existe
        const existingPools = await AsadminDatabaseManager.listPools();
        const poolExists = existingPools.some(p => p.name === poolName);

        if (poolExists) {
            const reusar = await vscode.window.showInformationMessage(
                `El pool '${poolName}' ya existe. Desea usarlo para el recurso '${unit.globalJndiName}'?`,
                'Usar existente', 'Cancelar'
            );

            if (reusar === 'Usar existente') {
                // Solo crear el resource apuntando al pool existente
                const resourceOk = await AsadminDatabaseManager.createResource(
                    unit.globalJndiName, poolName
                );
                if (resourceOk) { this.showMigrationHint(unit); }
                return resourceOk;
            }
            return false;
        }

        // ── STOP 3: Host y Puerto ────────────────────────────────────────
        const hostInput = await vscode.window.showInputBox({
            title: `MM43 - Conexion ${profile.label} (3/4)`,
            prompt: 'Host del servidor de base de datos',
            value: 'localhost',
            validateInput: v => v?.trim() ? undefined : 'El host no puede estar vacio',
        });
        if (!hostInput) { return false; }

        const portInput = await vscode.window.showInputBox({
            title: `MM43 - Conexion ${profile.label} (3/4)`,
            prompt: 'Puerto del servidor de base de datos',
            value: String(profile.defaultPort),
            validateInput: v => {
                const n = parseInt(v, 10);
                return (n > 0 && n <= 65535) ? undefined : 'Puerto invalido (1-65535)';
            },
        });
        if (!portInput) { return false; }

        const dbName = await vscode.window.showInputBox({
            title: `MM43 - Conexion ${profile.label} (3/4)`,
            prompt: 'Nombre de la base de datos',
            validateInput: v => v?.trim() ? undefined : 'El nombre de la BD no puede estar vacio',
        });
        if (!dbName) { return false; }

        // ── STOP 4: Credenciales (almacenadas en SecretStorage) ──────────
        const user = await vscode.window.showInputBox({
            title: 'MM43 - Credenciales (4/4)',
            prompt: 'Usuario de la base de datos',
            validateInput: v => v?.trim() ? undefined : 'El usuario no puede estar vacio',
        });
        if (!user) { return false; }

        const password = await vscode.window.showInputBox({
            title: 'MM43 - Credenciales (4/4)',
            prompt: 'Contrasena de la base de datos',
            password: true,
            validateInput: v => v?.trim() ? undefined : 'La contrasena no puede estar vacia',
        });
        if (!password) { return false; }

        // Guardar credenciales de forma segura
        await this.secretStorage.store(`mm43.db.${poolName}.user`, user);
        await this.secretStorage.store(`mm43.db.${poolName}.password`, password);

        // ── Ejecucion ────────────────────────────────────────────────────
        const poolConfig: PoolConfig = {
            poolName,
            driver,
            host: hostInput,
            port: parseInt(portInput, 10),
            databaseName: dbName,
            user,
            password,
        };

        // Crear el pool
        const poolOk = await AsadminDatabaseManager.createPool(poolConfig);
        if (!poolOk) {
            vscode.window.showErrorMessage(`[MM43] Error al crear el pool '${poolName}'.`);
            return false;
        }

        // Crear el recurso JDBC global apuntando al pool
        const resourceOk = await AsadminDatabaseManager.createResource(
            unit.globalJndiName, poolName
        );
        if (!resourceOk) {
            vscode.window.showErrorMessage(
                `[MM43] Pool creado pero error al crear recurso '${unit.globalJndiName}'.`
            );
            return false;
        }

        vscode.window.showInformationMessage(
            `[MM43] Recurso '${unit.globalJndiName}' -> Pool '${poolName}' creado exitosamente.`
        );

        // Ping de verificacion
        const status = await AsadminDatabaseManager.pingPool(poolName);
        if (status === 'active') {
            Logger.info('DATABASE', `Ping a '${poolName}': Conexion verificada.`);
        } else {
            Logger.warn('DATABASE', `Ping a '${poolName}': La conexion no pudo verificarse. Revise las credenciales.`);
        }

        // Avisar si persistence.xml necesita actualizarse
        this.showMigrationHint(unit);

        return true;
    }

    /**
     * Sugiere un nombre de pool basado en el JNDI.
     * Ej: "java:app/jdbc/egobsaden" -> "EgobsadenPool"
     */
    private suggestPoolName(jndiName: string): string {
        const parts = jndiName.split('/');
        const baseName = parts[parts.length - 1] || 'Default';
        const capitalized = baseName.charAt(0).toUpperCase() + baseName.slice(1);
        return `${capitalized}Pool`;
    }

    /**
     * Si el JNDI original usa java:app/, muestra un aviso al usuario
     * indicando que debe actualizar su persistence.xml para usar el nombre global.
     */
    private showMigrationHint(unit: PersistenceUnit): void {
        if (unit.scope === 'app-scoped') {
            vscode.window.showWarningMessage(
                `[MM43] El recurso se creo como '${unit.globalJndiName}' (global). ` +
                `Actualice su persistence.xml: cambie '${unit.jtaDataSource}' por '${unit.globalJndiName}'. ` +
                `Tambien puede eliminar glassfish-resources.xml si ya no lo necesita.`,
                'Entendido'
            );
            Logger.warn('DATABASE',
                `MIGRACION REQUERIDA en ${unit.projectName}:\n` +
                `  persistence.xml: cambiar '${unit.jtaDataSource}' -> '${unit.globalJndiName}'\n` +
                `  Eliminar: src/main/webapp/WEB-INF/glassfish-resources.xml (si existe)`
            );
        }
    }
}
