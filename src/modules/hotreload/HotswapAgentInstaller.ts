import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigManager } from '../../config/ConfigManager';
import { Logger } from '../logger/Logger';
import { ProcessRunner } from '../process/ProcessRunner';

/**
 * Gestiona la instalación y desinstalación de HotswapAgent en el dominio
 * Payara/GlassFish mediante `asadmin create-jvm-options` / `delete-jvm-options`.
 *
 * La operación es idempotente: instalar dos veces produce el mismo resultado.
 * El método generate las opciones JVM necesarias sin duplicados.
 *
 * Notas sobre escape de asadmin:
 *   - Los `:` en rutas deben escaparse como `\:` al pasarlos a asadmin.
 *   - Se usan `/` en las rutas (no `\`) para evitar conflictos con escape de shell.
 */
export class HotswapAgentInstaller {

    private static readonly AGENT_MARKER = 'hotswap-agent';
    private static readonly OLD_PORT_MARKER = 'mm43.agent.port';
    private static readonly ALT_JVM_MARKER = '-XXaltjvm=dcevm';

    /**
     * Instala HotswapAgent en el dominio:
     * 1. Valida que el jar y el asadmin existen.
     * 2. Lista y elimina opciones previas del agente/puerto viejo.
     * 3. Crea la nueva opción `-javaagent:...`.
     * 4. Genera/actualiza el archivo .properties base.
     * 5. Avisa que se requiere reiniciar el servidor.
     */
    static async install(agentJarPath?: string): Promise<boolean> {
        const jarPath = agentJarPath ?? ConfigManager.getHotswapAgentJar();
        if (!jarPath || !fs.existsSync(jarPath)) {
            vscode.window.showErrorMessage('[MM43] No se encontró el jar de HotswapAgent. Configure mm43.hotswap.agentJar.');
            return false;
        }

        const { serverPath, domain } = ConfigManager.getServerConfig();
        if (!serverPath) {
            vscode.window.showErrorMessage('[MM43] Configure la ruta del servidor (mm43.serverPath) antes de instalar el agente.');
            return false;
        }

        const asadmin = this.getAsadminPath(serverPath);
        if (!asadmin) {
            vscode.window.showErrorMessage('[MM43] No se encontró asadmin en el servidor configurado.');
            return false;
        }

        const domainArg = domain || 'domain1';

        // 1. Generar el .properties base
        const propsOk = await this.generatePropertiesFile();
        if (!propsOk) { return false; }

        const propsPath = ConfigManager.getHotswapPropertiesPath();
        if (!propsPath) {
            vscode.window.showErrorMessage('[MM43] No hay workspace abierto para generar hotswap-agent.properties.');
            return false;
        }

        // 2. Listar opciones actuales
        const currentOptions = await this.listJvmOptions(asadmin, domainArg);
        if (currentOptions === null) {
            vscode.window.showErrorMessage('[MM43] No se pudo ejecutar asadmin list-jvm-options. Revise la ruta del servidor.');
            return false;
        }

        // 3. Eliminar opciones previas del agente, puerto viejo y alt-jvm si existen
        await this.removeOldOptions(asadmin, domainArg, currentOptions);

        // 4. Construir la nueva opción -javaagent
        const jvmOption = this.buildJvmOption(jarPath, propsPath);

        // 5. Crear la nueva opción
        Logger.info('HOTRELOAD', `Instalando HotswapAgent: ${jvmOption}`);
        const createResult = await ProcessRunner.run(asadmin, [
            'create-jvm-options',
            `--target=server-config`,
            `${jvmOption}`,
        ], { timeout: 30000 });

        if (createResult.code !== 0) {
            const msg = `Error al crear la opción JVM: ${createResult.stderr || createResult.stdout}`;
            Logger.error('HOTRELOAD', msg);
            vscode.window.showErrorMessage(`[MM43] ${msg}`);
            return false;
        }

        // 6. Verificar que quedó instalada
        const optionsAfter = await this.listJvmOptions(asadmin, domainArg);
        const installed = optionsAfter?.some(o => o.includes(this.AGENT_MARKER)) ?? false;

        if (installed) {
            Logger.info('HOTRELOAD', 'HotswapAgent instalado correctamente en domain.xml');
            const restart = await vscode.window.showInformationMessage(
                '[MM43] HotswapAgent instalado. Se requiere reiniciar el servidor para aplicar los cambios.',
                'Reiniciar ahora', 'Más tarde'
            );
            return restart === 'Reiniciar ahora';
        } else {
            Logger.error('HOTRELOAD', 'La opción JVM no aparece en list-jvm-options tras crear.');
            vscode.window.showWarningMessage('[MM43] La instalación puede no haber funcionado. Verifique con asadmin list-jvm-options.');
            return false;
        }
    }

    /**
     * Desinstala HotswapAgent eliminando todas las opciones JVM que lo referencian.
     */
    static async uninstall(): Promise<boolean> {
        const { serverPath, domain } = ConfigManager.getServerConfig();
        if (!serverPath) {
            vscode.window.showErrorMessage('[MM43] Configure la ruta del servidor antes de desinstalar.');
            return false;
        }

        const asadmin = this.getAsadminPath(serverPath);
        if (!asadmin) {
            vscode.window.showErrorMessage('[MM43] No se encontró asadmin.');
            return false;
        }

        const domainArg = domain || 'domain1';
        const currentOptions = await this.listJvmOptions(asadmin, domainArg);
        if (currentOptions === null) { return false; }

        await this.removeOldOptions(asadmin, domainArg, currentOptions);
        Logger.info('HOTRELOAD', 'HotswapAgent desinstalado del dominio.');
        vscode.window.showInformationMessage('[MM43] HotswapAgent desinstalado. Reinicie el servidor para aplicar.');
        return true;
    }

    /**
     * Genera o actualiza el archivo `.mm43/hotswap-agent.properties` base.
     * Crea el directorio .mm43/ si no existe.
     * No sobreescribe propiedades existentes si el archivo ya contiene contenido.
     */
    static async generatePropertiesFile(): Promise<boolean> {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!ws) {
            Logger.warn('HOTRELOAD', 'No hay workspace abierto para crear .mm43/');
            return false;
        }

        const mm43Dir = path.join(ws, '.mm43');
        const propsPath = path.join(mm43Dir, 'hotswap-agent.properties');
        const logPath = path.join(mm43Dir, 'hotswap-agent.log').replace(/\\/g, '/');

        // Crear directorio si no existe
        if (!fs.existsSync(mm43Dir)) {
            fs.mkdirSync(mm43Dir, { recursive: true });
            Logger.info('HOTRELOAD', `Directorio creado: ${mm43Dir}`);
        }

        // Sugerir agregar .mm43/ al .gitignore
        this.suggestGitignore(ws);

        // No sobreescribir si ya existe (preserva personalizaciones del usuario)
        if (fs.existsSync(propsPath)) {
            Logger.debug('DEBUG', `hotswap-agent.properties ya existe: ${propsPath}`);
            return true;
        }

        // Generar contenido base
        const logPathForward = logPath.replace(/\\/g, '/');
        const content = [
            '# MM43 — hotswap-agent.properties',
            '# Generado automáticamente. Puedes editar las propiedades, pero no el LOGFILE.',
            `LOGFILE=${logPathForward}`,
            'LOGFILE.append=true',
            'LOG_TO_CONSOLE=false',
            'LOGGER=info',
            '# Subir niveles para ver resultados de recarga por clase:',
            'LOGGER.org.hotswap.agent.config.PluginManager=debug',
            'LOGGER.org.hotswap.agent.plugin.hotswapper=trace',
            '# Plugins deshabilitados (separados por coma, vacío = todos habilitados):',
            'disabledPlugins=',
        ].join('\n');

        fs.writeFileSync(propsPath, content, 'utf8');
        Logger.info('HOTRELOAD', `hotswap-agent.properties creado: ${propsPath}`);
        return true;
    }

    // ─── Helpers internos ─────────────────────────────────────────────────────

    /**
     * Construye la opción `-javaagent` lista para pasarse a asadmin.
     * Escapa `:` → `\:` para asadmin, usa `/` en rutas.
     */
    static buildJvmOption(jarPath: string, propsPath: string): string {
        const jarFwd = jarPath.replace(/\\/g, '/').replace(/:/g, '\\:');
        const propsFwd = propsPath.replace(/\\/g, '/').replace(/:/g, '\\:');
        return `-javaagent\\:${jarFwd}=autoHotswap=true,propertiesFilePath=${propsFwd}`;
    }

    private static async listJvmOptions(asadmin: string, domain: string): Promise<string[] | null> {
        try {
            const result = await ProcessRunner.run(asadmin, ['list-jvm-options'], { timeout: 20000 });
            if (result.code !== 0 && !result.stdout) { return null; }
            return result.stdout.split('\n').map(l => l.trim()).filter(Boolean);
        } catch (err) {
            Logger.error('HOTRELOAD', `list-jvm-options falló: ${err}`);
            return null;
        }
    }

    private static async removeOldOptions(asadmin: string, domain: string, options: string[]): Promise<void> {
        const toRemove = options.filter(opt =>
            opt.includes(this.AGENT_MARKER) ||
            opt.includes(this.OLD_PORT_MARKER) ||
            opt.includes(this.ALT_JVM_MARKER)
        );

        for (const opt of toRemove) {
            Logger.info('HOTRELOAD', `Eliminando opción JVM antigua: ${opt}`);
            try {
                await ProcessRunner.run(asadmin, [
                    'delete-jvm-options',
                    `--target=server-config`,
                    opt,
                ], { timeout: 20000 });
            } catch (err) {
                Logger.warn('HOTRELOAD', `No se pudo eliminar opción: ${opt} — ${err}`);
            }
        }
    }

    private static getAsadminPath(serverPath: string): string | undefined {
        const candidates = [
            path.join(serverPath, 'bin', 'asadmin.bat'),
            path.join(serverPath, 'bin', 'asadmin'),
        ];
        return candidates.find(p => fs.existsSync(p));
    }

    /**
     * Sugiere agregar `.mm43/` al `.gitignore` del workspace (si no está ya).
     */
    private static suggestGitignore(wsRoot: string): void {
        const gitignorePath = path.join(wsRoot, '.gitignore');
        if (!fs.existsSync(gitignorePath)) { return; }
        const content = fs.readFileSync(gitignorePath, 'utf8');
        if (content.includes('.mm43/') || content.includes('.mm43')) { return; }
        // No modificar automáticamente el .gitignore; solo sugerir
        vscode.window.showInformationMessage(
            '[MM43] Recuerda agregar `.mm43/` a tu .gitignore (contiene logs y configuración local).',
            'Abrir .gitignore'
        ).then(choice => {
            if (choice === 'Abrir .gitignore') {
                vscode.workspace.openTextDocument(gitignorePath)
                    .then(doc => vscode.window.showTextDocument(doc));
            }
        });
    }
}

