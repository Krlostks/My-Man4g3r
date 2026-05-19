import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ProjectConfig } from '../../config/types';
import { ConfigManager } from '../../config/ConfigManager';
import { Logger } from '../logger/Logger';
import { HotReloadClient } from './HotReloadClient';
import { DcevmValidator } from './DcevmValidator';

export class AgenteHotReloadManager {

    constructor() { }

    async importAgent(): Promise<void> {
        Logger.debug('DEBUG', 'importAgent invocado');
        const uris = await vscode.window.showOpenDialog({
            title: 'MM43 — Selecciona el archivo del Agente HotSwap (.jar)',
            openLabel: 'Seleccionar Agente',
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'Java Archive': ['jar'] }
        });

        if (!uris || uris.length === 0) { 
            Logger.debug('DEBUG', 'Importación de agente cancelada por el usuario');
            return; 
        }
        const agentPath = uris[0].fsPath;

        if (!fs.existsSync(agentPath)) {
            Logger.error('HOTRELOAD', `El archivo seleccionado no existe: ${agentPath}`);
            vscode.window.showErrorMessage(`[MM43] El archivo seleccionado no existe: ${agentPath}`);
            return;
        }

        Logger.info('HOTRELOAD', `Agente seleccionado: ${agentPath}`);

        const { serverPath } = ConfigManager.getServerConfig();
        if (!serverPath) {
            Logger.error('HOTRELOAD', 'Intento de importar agente sin servidor configurado');
            vscode.window.showErrorMessage('[MM43] Configure un servidor primero antes de importar el agente.');
            return;
        }

        Logger.debug('DEBUG', 'Validando DCEVM...');
        const dcevmResult = DcevmValidator.checkDcevm();
        Logger.info('HOTRELOAD', `Java Home del servidor: ${dcevmResult.javaHome}`);
        Logger.info('HOTRELOAD', `Salida java -version: ${dcevmResult.versionOutput.trim()}`);

        if (dcevmResult.isDcevm) {
            Logger.debug('DEBUG', 'DCEVM detectado, activando modo completo');
            await ConfigManager.setAgentPath(agentPath);
            await ConfigManager.setAgentMode('dcevm');
            vscode.window.showInformationMessage(
                '✅ Agente importado con DCEVM detectado. Hot-Reload completo habilitado (cambios estructurales soportados).'
            );
            Logger.info('HOTRELOAD', '✅ Modo DCEVM activado — soporte estructural completo.');
        } else {
            Logger.debug('DEBUG', 'DCEVM NO detectado, solicitando elección al usuario');
            const choice = await vscode.window.showWarningMessage(
                '⚠️ La JVM del servidor NO es DCEVM. El Hot-Reload será limitado (solo cuerpos de métodos). ' +
                '¿Qué desea hacer?',
                { modal: true },
                'Continuar con HotSwap Básico',
                'Configurar DCEVM manualmente'
            );

            if (choice === 'Continuar con HotSwap Básico') {
                Logger.debug('DEBUG', 'Usuario eligió HotSwap Básico');
                await ConfigManager.setAgentPath(agentPath);
                await ConfigManager.setAgentMode('basic');
                vscode.window.showInformationMessage(
                    '⚡ Agente importado en modo básico. Cambios en firmas de métodos o campos requerirán Redeploy Completo.'
                );
                Logger.info('HOTRELOAD', '⚡ Modo básico activado — solo cambios en cuerpos de métodos.');
            } else if (choice === 'Configurar DCEVM manualmente') {
                Logger.debug('DEBUG', 'Usuario eligió Configurar DCEVM manualmente');
                await this.openDcevmConfigFiles();
            }
        }
    }

    async injectAgentOptions(): Promise<void> {
        Logger.debug('DEBUG', 'injectAgentOptions invocado');
        const agentPath = ConfigManager.getAgentPath();
        const { serverPath, domain } = ConfigManager.getServerConfig();

        if (!agentPath || !serverPath) {
            Logger.error('HOTRELOAD', 'Inyectar agente falló: agente o servidor no configurados');
            vscode.window.showErrorMessage('[MM43] El agente o el servidor no están configurados.');
            return;
        }

        const asadmin = path.join(serverPath, 'bin', 'asadmin.bat');
        const port = ConfigManager.getHotReloadPort();
        
        const jvmOpt = `-javaagent:${agentPath}`.replace(/:/g, '\\:');
        const portOpt = `-Dmm43.agent.port=${port}`;

        const terminal = vscode.window.terminals.find(t => t.name === 'MM43 — Agent Setup') || vscode.window.createTerminal('MM43 — Agent Setup');
        terminal.show();

        Logger.info('HOTRELOAD', `Enviando comandos de inyección a asadmin...`);
        Logger.debug('DEBUG', `Inyectando JVM options: ${jvmOpt} y ${portOpt}`);
        terminal.sendText(`& "${asadmin}" create-jvm-options --target server-config "${jvmOpt}"`);
        terminal.sendText(`& "${asadmin}" create-jvm-options --target server-config "${portOpt}"`);

        vscode.window.showInformationMessage('🚀 Comandos de inyección enviados. Revise la terminal para confirmar el éxito.');
    }

    async openDomainXml(): Promise<void> {
        Logger.debug('DEBUG', 'openDomainXml invocado');
        const { serverPath, domain } = ConfigManager.getServerConfig();
        if (!serverPath || !domain) { return; }

        const domainXmlPath = path.join(serverPath, 'glassfish', 'domains', domain, 'config', 'domain.xml');

        if (fs.existsSync(domainXmlPath)) {
            Logger.debug('DEBUG', `Abriendo domain.xml: ${domainXmlPath}`);
            const doc = await vscode.workspace.openTextDocument(domainXmlPath);
            await vscode.window.showTextDocument(doc);
            Logger.info('HOTRELOAD', `Abierto para edición manual: ${domainXmlPath}`);
        } else {
            Logger.error('HOTRELOAD', `No se encontró domain.xml en: ${domainXmlPath}`);
            vscode.window.showErrorMessage(`[MM43] No se encontró domain.xml en: ${domainXmlPath}`);
        }
    }

    async openDcevmConfigFiles(): Promise<void> {
        Logger.debug('DEBUG', 'openDcevmConfigFiles invocado');
        const disclaimer = await vscode.window.showWarningMessage(
            '⚠️ RESPONSABILIDAD DEL USUARIO\n\n' +
            'Va a modificar la configuración del servidor para apuntar a una JDK con DCEVM. ' +
            'Esto es una operación manual. Debe:\n' +
            '1. Descargar e instalar DCEVM/Trava OpenJDK.\n' +
            '2. Cambiar la variable AS_JAVA en asenv.bat a la ruta de la nueva JDK.\n' +
            '3. Reiniciar el servidor.\n\n' +
            'MM43 NO se hace responsable de errores derivados de esta modificación.',
            { modal: true },
            'Entendido, abrir archivos'
        );

        if (disclaimer !== 'Entendido, abrir archivos') { 
            Logger.debug('DEBUG', 'Usuario canceló apertura de archivos DCEVM');
            return; 
        }

        const asenvPath = DcevmValidator.getAsenvPath();
        if (asenvPath) {
            Logger.debug('DEBUG', `Abriendo asenv.bat: ${asenvPath}`);
            const doc = await vscode.workspace.openTextDocument(asenvPath);
            await vscode.window.showTextDocument(doc);
            Logger.info('HOTRELOAD', `Abierto para edición: ${asenvPath}`);
        } else {
            Logger.error('HOTRELOAD', 'No se pudo encontrar asenv.bat');
            vscode.window.showErrorMessage('[MM43] No se pudo encontrar el archivo asenv.bat del servidor.');
        }
    }

    async removeAgent(): Promise<void> {
        Logger.debug('DEBUG', 'removeAgent invocado');
        await ConfigManager.removeAgent();
        Logger.info('HOTRELOAD', 'Agente eliminado de la configuración.');
        vscode.window.showInformationMessage('✅ Agente de Hot-Reload eliminado.');
    }

    private static changeQueue: { filename: string, project: ProjectConfig }[] = [];
    private static processTimer: ReturnType<typeof setTimeout> | undefined;
    private static THRESHOLD = 50; 
    private static lastHashes: Map<string, string> = new Map();
    private static isPaused: boolean = false;

    static setPaused(paused: boolean): void {
        Logger.debug('DEBUG', `setPaused invocado (paused: ${paused})`);
        this.isPaused = paused;
        if (paused) {
            Logger.info('HOTRELOAD', '⏸ Watcher pausado temporalmente.');
        } else {
            Logger.info('HOTRELOAD', '▶ Watcher reanudado.');
        }
    }

    static async cambioEnCaliente(filename: string, project: ProjectConfig): Promise<void> {
        if (this.isPaused) { return; }

        if (!filename.endsWith('.java')) { return; }

        filename = filename.replace(/[\r\n]/g, '').trim();

        const javaAbsPath = path.isAbsolute(filename) ? filename : path.join(project.rootPath, 'src', 'main', 'java', filename);
        if (!fs.existsSync(javaAbsPath)) { return; }

        try {
            const content = fs.readFileSync(javaAbsPath);
            const hash = crypto.createHash('md5').update(content).digest('hex');
            const lastHash = this.lastHashes.get(javaAbsPath);

            if (lastHash === hash) {
                return;
            }
            this.lastHashes.set(javaAbsPath, hash);
            Logger.debug('DEBUG', `Cambio real detectado en: ${filename} (hash: ${hash})`);
        } catch (e) {
            Logger.error('HOTRELOAD', `Error calculando hash para ${filename}: ${e}`);
        }

        this.changeQueue.push({ filename, project });

        if (this.processTimer) { clearTimeout(this.processTimer); }

        this.processTimer = setTimeout(() => {
            this.procesarCola();
        }, 800); 
    }

    private static async procesarCola(): Promise<void> {
        const queue = [...this.changeQueue];
        this.changeQueue = [];

        if (queue.length === 0) { return; }

        Logger.debug('DEBUG', `procesarCola invocado con ${queue.length} cambios`);

        if (queue.length > this.THRESHOLD) {
            Logger.warn('HOTRELOAD', `⚠️ Detectados ${queue.length} cambios simultáneos. Saturación probable.`);
            const choice = await vscode.window.showWarningMessage(
                `[MM43] Se detectaron ${queue.length} cambios en archivos Java. ` +
                '¿Desea procesar todos uno por uno o realizar un Redeploy Completo?',
                'Procesar todo (Lento)', 'Redeploy Completo'
            );

            if (choice === 'Redeploy Completo') {
                Logger.debug('DEBUG', 'Usuario eligió Redeploy Completo tras saturación');
                vscode.commands.executeCommand('mm43.restartServer');
                return;
            } else if (!choice) {
                Logger.debug('DEBUG', 'Procesamiento de cola cancelado por el usuario');
                return; 
            }
        }

        const uniqueFiles = new Map<string, { filename: string, project: ProjectConfig }>();
        queue.forEach(q => uniqueFiles.set(`${q.project.name}:${q.filename}`, q));

        Logger.info('HOTRELOAD', `🔄 Procesando cola de recarga (${uniqueFiles.size} archivos únicos)...`);

        for (const [key, item] of uniqueFiles) {
            await this.ejecutarRecargaIndividual(item.filename, item.project);
        }
    }

    private static async ejecutarRecargaIndividual(filename: string, project: ProjectConfig): Promise<void> {
        Logger.debug('DEBUG', `ejecutarRecargaIndividual para: ${filename}`);
        const agentPath = ConfigManager.getAgentPath();
        const agentMode = ConfigManager.getAgentMode();

        if (!agentPath || agentMode === 'none') { 
            Logger.debug('DEBUG', 'HotSwap omitido: agente no configurado o modo none');
            return; 
        }

        const latestProjects = ConfigManager.getProjects();
        const latestProject = latestProjects.find(p => p.name === project.name) || project;

        const javaAbsPath = path.isAbsolute(filename) ? filename : path.join(latestProject.rootPath, 'src', 'main', 'java', filename);
        const compileSuccess = await this.compilarIncremental(javaAbsPath, latestProject);
        if (!compileSuccess) { 
            Logger.debug('DEBUG', `Compilación falló para ${filename}, abortando HotSwap`);
            return; 
        }

        let relativeToSrc = filename;
        if (path.isAbsolute(filename)) {
            const srcRoot = path.join(latestProject.rootPath, 'src', 'main', 'java');
            relativeToSrc = path.relative(srcRoot, filename);
        }

        const javaRelative = relativeToSrc.replace(/\\/g, '/');
        const className = javaRelative.replace(/\.java$/, '').replace(/\//g, '.');

        const classFile = path.join(
            latestProject.rootPath, 'target', latestProject.warName,
            'WEB-INF', 'classes',
            relativeToSrc.replace(/\.java$/, '.class')
        );

        if (!fs.existsSync(classFile)) { 
            Logger.debug('DEBUG', `Archivo .class no encontrado: ${classFile}`);
            return; 
        }

        Logger.debug('DEBUG', `Enviando ${className} al agente HotSwap...`);
        const success = await HotReloadClient.sendReload(className, classFile);

        if (success) {
            Logger.info('HOTRELOAD', `⚡ Clase recargada: ${className}`);
            vscode.window.setStatusBarMessage(`⚡ Hot-Reload: ${path.basename(filename, '.java')}`, 3000);
        } else {
            if (agentMode === 'basic') {
                Logger.warn('HOTRELOAD', `Error al recargar ${className}. Posible cambio estructural en modo básico.`);
            } else {
                Logger.error('HOTRELOAD', `Error al enviar ${className} al agente.`);
            }
        }
    }

    private static async compilarIncremental(javaFile: string, project: ProjectConfig): Promise<boolean> {
        Logger.debug('DEBUG', `compilarIncremental para: ${javaFile}`);
        const jdkPath = ConfigManager.getJdkPath();
        const classpath = project.classpath;

        if (!classpath) {
            Logger.error('HOTRELOAD', `No hay classpath para ${project.name}.`);
            return false;
        }

        const outputDir = path.join(project.rootPath, 'target', project.warName, 'WEB-INF', 'classes');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const allProjects = ConfigManager.getProjects();
        const localClassDirs = allProjects.map(p => 
            path.join(p.rootPath, 'target', p.warName, 'WEB-INF', 'classes').replace(/\\/g, '/')
        ).join(';');

        const tempDir = path.join(project.rootPath, 'target', 'mm43_temp');
        if (!fs.existsSync(tempDir)) { fs.mkdirSync(tempDir, { recursive: true }); }

        const argFile = path.join(tempDir, `javac_args_${Date.now()}.txt`);
        
        const fullClasspath = `${localClassDirs};${classpath.replace(/\\/g, '/')}`;
        const argContent = `-encoding UTF-8\n-cp "${fullClasspath}"\n-d "${outputDir.replace(/\\/g, '/')}"\n"${javaFile.replace(/\\/g, '/')}"`;

        fs.writeFileSync(argFile, argContent, 'utf8');

        const cleanJdk = jdkPath.replace(/^&\s*/, '').replace(/"/g, '');
        const { exec } = require('child_process');

        return new Promise((resolve) => {
            const cmd = `"${cleanJdk}" @"${argFile}"`;
            Logger.debug('DEBUG', `Ejecutando javac: ${cmd}`);

            const env = { ...process.env };
            if (env.PATH) {
                env.PATH = env.PATH.replace(/[\r\n]/g, '');
            }

            exec(cmd, { env }, (error: any, stdout: string, stderr: string) => {
                try { fs.unlinkSync(argFile); } catch (e) { }

                if (error) {
                    Logger.error('HOTRELOAD', `Error de compilación en ${path.basename(javaFile)}: ${stderr || stdout}`);
                    resolve(false);
                } else {
                    Logger.info('HOTRELOAD', `✅ Compilación de ${path.basename(javaFile)} exitosa.`);
                    resolve(true);
                }
            });
        });
    }
}
