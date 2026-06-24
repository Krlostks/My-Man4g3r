import * as vscode from 'vscode';
import { ConfigManager } from './config/ConfigManager';
import { ProjectConfig } from './config/types';
import { StatusBarManager } from './ui/StatusBarManager';
import { ProjectsProvider } from './ui/ProjectsProvider';
import { ServerProvider } from './ui/ServerProvider';
import { DatabaseProvider } from './ui/DatabaseProvider';
import { ServerManager } from './modules/server/ServerManager';
import { LogTailer } from './modules/server/LogTailer';
import { AssetWatcher } from './modules/server/AssetWatcher';
import { CacheCleaner } from './modules/server/CacheCleaner';
import { MavenManager } from './modules/maven/MavenManager';
import { AgenteHotReloadManager } from './modules/hotreload/AgenteHotReloadManager';
import { AsadminDatabaseManager } from './modules/database/AsadminDatabaseManager';
import { DatabaseProvisioner } from './modules/database/DatabaseProvisioner';
import { Logger } from './modules/logger/Logger';
import { LogWebviewProvider } from './modules/logger/LogWebviewProvider';
import { FlatteningEngine } from './modules/versioncontrol/FlatteningEngine';
import { VersionControlProvider } from './ui/VersionControlProvider';
import { VersionControlWebviewPanel } from './ui/VersionControlWebviewPanel';
import { registerVersionControlCommands } from './ui/VersionControlCommands';
import { ServerValidator } from './modules/server/ServerValidator';
import { BeanRegistry } from './modules/AI/BeanRegistry';
import { BeanScanner } from './modules/AI/BeanScanner';
import { BeanDefinitionProvider } from './modules/AI/BeanDefinitionProvider';
import { NamespacerRegistry } from "./modules/xhtml/registry/NamespaceRegistry";
import { XhtmlHoverProvider } from "./modules/xhtml/provider/XhtmlHoverProvider";
import { XhtmlCompletionProvider } from "./modules/xhtml/provider/XhtmlCompletionProvider";
import { ElCompletionProvider } from "./modules/xhtml/provider/ElCompletionProvider";
import { ElHoverProvider } from "./modules/xhtml/provider/ElHoverProvider";
import { ElDiagnosticProvider } from "./modules/xhtml/provider/ElDiagnosticProvider";
import { ElRenameProvider } from "./modules/xhtml/provider/ElRenameProvider";

let globalServerManager: ServerManager | undefined;

export async function activate(context: vscode.ExtensionContext) {

    Logger.init(context);
    Logger.debug('DEBUG', 'Iniciando activación de MM43...');
    vscode.window.showInformationMessage('MM43: Extension Activada y Lista  ');

    const logWebview = new LogWebviewProvider(context.extensionUri);
    Logger.setWebview(logWebview);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(LogWebviewProvider.viewType, logWebview)
    );

    const statusBar = new StatusBarManager();
    const projectsProvider = new ProjectsProvider();
    const serverProvider = new ServerProvider();
    context.subscriptions.push(statusBar);

    globalServerManager = new ServerManager((state) => {
        statusBar.setServerState(state);
        serverProvider.setServerState(state);
        Logger.debug('DEBUG', `Estado del servidor cambiado a: ${state}`);

        if (state !== 'running') {
            Logger.debug('DEBUG', 'Servidor no está running, deteniendo watchers automáticamente');
            statusBar.setWatcherState('stopped');
            serverProvider.setWatcherState('stopped');
            assetWatcher.stopAll();
        }
    });

    const serverManager = globalServerManager;

    const logTailer = new LogTailer();
    const assetWatcher = new AssetWatcher(() => serverManager.getServerState() === 'running');
    serverManager.setAssetWatcher(assetWatcher);
    const cacheCleaner = new CacheCleaner();
    const mavenManager = new MavenManager(globalServerManager);
    const agente = new AgenteHotReloadManager();

    const databaseProvider = new DatabaseProvider();
    const databaseProvisioner = new DatabaseProvisioner(context.secrets);

    context.subscriptions.push(
        { dispose: () => logTailer.dispose() },
        { dispose: () => assetWatcher.dispose() }
    );

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('mm43.projectsView', projectsProvider),
        vscode.window.registerTreeDataProvider('mm43.serverView', serverProvider),
        vscode.window.registerTreeDataProvider('mm43.databaseView', databaseProvider)
    );

    serverProvider.setListAppsFn(() => serverManager.listApplications());

    context.subscriptions.push(
        vscode.commands.registerCommand('mm43.refreshProjects', () => {
            Logger.debug('DEBUG', 'Comando mm43.refreshProjects ejecutado');
            projectsProvider.refresh();
        }),

        vscode.commands.registerCommand('mm43.addProject', async () => {
            Logger.debug('DEBUG', 'Comando mm43.addProject ejecutado');
            const project = await promptNewProject();
            if (project) {
                Logger.debug('DEBUG', `Agregando proyecto: ${project.name}`);
                await ConfigManager.addProject(project);
                projectsProvider.refresh();
                vscode.window.showInformationMessage(`[MM43] Proyecto '${project.name}' agregado.`);
            }
        }),

        vscode.commands.registerCommand('mm43.removeProject', async (nameOrItem: string | { project: ProjectConfig }) => {
            const name = typeof nameOrItem === 'string' ? nameOrItem : nameOrItem?.project?.name;
            Logger.debug('DEBUG', `Comando mm43.removeProject ejecutado para: ${name}`);
            if (!name) { return; }
            const confirm = await vscode.window.showWarningMessage(
                `¿Eliminar el proyecto '${name}' del catálogo?`,
                { modal: true }, 'Eliminar'
            );
            if (confirm === 'Eliminar') {
                Logger.debug('DEBUG', `Confirmada eliminación de proyecto: ${name}`);
                await ConfigManager.removeProject(name);
                projectsProvider.refresh();
            }
        }),

        vscode.commands.registerCommand('mm43.buildProject', async (nameOrItem: string | { project: ProjectConfig }) => {
            Logger.debug('DEBUG', 'Comando mm43.buildProject ejecutado');
            const projects = ConfigManager.getProjects();
            if (projects.length === 0) {
                vscode.window.showWarningMessage('[MM43] No hay proyectos configurados.');
                return;
            }

            let project: ProjectConfig | undefined;
            if (typeof nameOrItem === 'string') {
                project = projects.find(p => p.name === nameOrItem);
            } else if (nameOrItem?.project) {
                project = nameOrItem.project;
            }

            if (!project) {
                const selected = await vscode.window.showQuickPick(
                    projects.map(p => ({ label: p.name, description: p.rootPath, project: p })),
                    { placeHolder: 'Selecciona el proyecto a compilar' }
                );
                if (!selected) { return; }
                project = selected.project;
            }

            Logger.debug('DEBUG', `Iniciando build para: ${project.name}`);
            Logger.show();
            await mavenManager.buildExploded(project);
        }),

        vscode.commands.registerCommand('mm43.installProject', async (nameOrItem: string | { project: ProjectConfig }) => {
            Logger.debug('DEBUG', 'Comando mm43.installProject ejecutado');
            const proyectos = ConfigManager.getProjects();
            if (proyectos.length === 0) {
                vscode.window.showWarningMessage('[MM43] No hay proyectos configurados.');
                return;
            }
            let proyecto: ProjectConfig | undefined;
            if (typeof nameOrItem === 'string') {
                proyecto = proyectos.find(p => p.name === nameOrItem);
            } else if (nameOrItem?.project) {
                proyecto = nameOrItem.project;
            }

            if (!proyecto) {
                const selected = await vscode.window.showQuickPick(
                    proyectos.map(p => ({ label: p.name, description: p.rootPath, project: p })),
                    { placeHolder: 'Selecciona el proyecto a instalar' }
                );
                if (!selected) { return; }
                proyecto = selected.project;
            }

            Logger.debug('DEBUG', `Iniciando install para: ${proyecto.name}`);
            Logger.show();
            await mavenManager.cleanInstall(proyecto);
        }),

        vscode.commands.registerCommand('mm43.exportWar', async (nameOrItem: string | { project: ProjectConfig }) => {
            Logger.debug('DEBUG', 'Comando mm43.exportWar ejecutado');
            const proyectos = ConfigManager.getProjects();
            if (proyectos.length === 0) {
                vscode.window.showWarningMessage('[MM43] No hay proyectos configurados.');
                return;
            }
            let proyecto: ProjectConfig | undefined;
            if (typeof nameOrItem === 'string') {
                proyecto = proyectos.find(p => p.name === nameOrItem);
            } else if (nameOrItem?.project) {
                proyecto = nameOrItem.project;
            }

            if (!proyecto) {
                const selected = await vscode.window.showQuickPick(
                    proyectos.map(p => ({ label: p.name, description: p.rootPath, project: p })),
                    { placeHolder: 'Selecciona el proyecto a exportar' }
                );
                if (!selected) { return; }
                proyecto = selected.project;
            }

            const targetUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`${proyecto.warName}.war`),
                filters: { 'WAR Files': ['war'] },
                title: 'Exportar WAR'
            });

            if (!targetUri) {
                return;
            }

            Logger.debug('DEBUG', `Exportando WAR de ${proyecto.name} a ${targetUri.fsPath}`);
            Logger.show();
            const success = await mavenManager.cleanPackage(proyecto);

            if (success) {
                try {
                    const sourceWarPath = vscode.Uri.file(`${proyecto.rootPath}/target/${proyecto.warName}.war`);
                    await vscode.workspace.fs.copy(sourceWarPath, targetUri, { overwrite: true });
                    vscode.window.showInformationMessage(`[MM43]   WAR exportado exitosamente a ${targetUri.fsPath}`);
                } catch (error) {
                    Logger.error('GENERAL', `Error al exportar WAR: ${String(error)}`);
                    vscode.window.showErrorMessage(`[MM43] ❌ Error al copiar el archivo WAR: ${String(error)}`);
                }
            }
        }),

        vscode.commands.registerCommand('mm43.detectarBajoCursor', () => {
            Logger.debug('DEBUG', 'Comando mm43.detectarBajoCursor ejecutado');
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            const position = editor.selection.active;
            const document = editor.document;
            const wordRange = document.getWordRangeAtPosition(position);
            if (wordRange) {
                const word = document.getText(wordRange);
                Logger.info('GENERAL', `Palabra bajo cursor: ${word}`);
                vscode.window.showInformationMessage(`MM43: Palabra bajo el cursor: ${word}`);
            } else {
                vscode.window.showInformationMessage('MM43: No hay palabra bajo el cursor');
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('mm43.startWatcher', (name?: string) => {
            Logger.debug('DEBUG', `Comando mm43.startWatcher ejecutado${name ? ` para ${name}` : ''}`);

            if (serverManager.getServerState() !== 'running') {
                vscode.window.showErrorMessage('[MM43] El Watcher solo puede encenderse si el servidor está en ejecución.');
                return;
            }

            statusBar.setWatcherState('running');
            serverProvider.setWatcherState('running');
            if (name) {
                const projects = ConfigManager.getProjects();
                const project = projects.find(p => p.name === name);
                if (project) { assetWatcher.startForProject(project); }
            } else {
                assetWatcher.startAll();
            }
            vscode.window.showInformationMessage(
                `[MM43] Asset Watcher iniciado${name ? ` para '${name}'` : ''}. Hot-reload Java en Fase 3.`
            );
        }),

        vscode.commands.registerCommand('mm43.stopWatcher', () => {
            Logger.debug('DEBUG', 'Comando mm43.stopWatcher ejecutado');

            if (serverManager.getServerState() !== 'running') {
                vscode.window.showErrorMessage('[MM43] El Watcher solo puede apagarse si el servidor está en ejecución.');
                return;
            }

            statusBar.setWatcherState('stopped');
            serverProvider.setWatcherState('stopped');
            assetWatcher.stopAll();
            vscode.window.showInformationMessage('[MM43] Watcher detenido.');
        }),

        vscode.commands.registerCommand('mm43.checkServerStatus', async () => {
            Logger.debug('DEBUG', 'Comando mm43.checkServerStatus ejecutado');
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "[MM43] Consultando estado del servidor...",
                cancellable: false
            }, async () => {
                const status = await serverManager.checkServerStatus();
                const statusStr = status === 'running' ? 'ACTIVO 🟢' : 'DETENIDO 🔴';
                vscode.window.showInformationMessage(`[MM43] El servidor está: ${statusStr}`);
                if (status === 'running') {
                    await serverProvider.refreshDeployedApps();
                }
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('mm43.startServer', () => {
            Logger.debug('DEBUG', 'Comando mm43.startServer ejecutado');
            serverManager.start();
        }),

        vscode.commands.registerCommand('mm43.stopServer', () => {
            Logger.debug('DEBUG', 'Comando mm43.stopServer ejecutado');
            serverManager.stop();
        }),

        vscode.commands.registerCommand('mm43.restartServer', async () => {
            Logger.debug('DEBUG', 'Comando mm43.restartServer ejecutado');
            const projects = ConfigManager.getProjects();
            if (projects.length === 0) {
                vscode.window.showWarningMessage('[MM43] No hay proyectos configurados.');
                return;
            }
            let project = projects[0];
            if (projects.length > 1) {
                const selected = await vscode.window.showQuickPick(
                    projects.map(p => ({ label: p.name, description: p.rootPath, project: p })),
                    { placeHolder: 'Selecciona el proyecto para redeploy completo' }
                );
                if (!selected) { return; }
                project = selected.project;
            }
            Logger.debug('DEBUG', `Reiniciando servidor con redeploy para: ${project.name}`);
            serverManager.fullRedeploy(project);
        }),

        vscode.commands.registerCommand('mm43.showServerLogs', () => {
            Logger.debug('DEBUG', 'Comando mm43.showServerLogs ejecutado');
            if (logTailer.isActive) {
                Logger.show();
            } else {
                logTailer.start();
            }
        }),

        vscode.commands.registerCommand('mm43.clearServerCache', async () => {
            Logger.debug('DEBUG', 'Comando mm43.clearServerCache ejecutado');
            const confirm = await vscode.window.showWarningMessage(
                '¿Limpiar las caches de Payara? (osgi-cache y generated)',
                { modal: true }, 'Limpiar'
            );
            if (confirm === 'Limpiar') {
                Logger.debug('DEBUG', 'Iniciando limpieza de cache...');
                await cacheCleaner.clearAll();
            }
        }),

        vscode.commands.registerCommand('mm43.clearServerLogs', async () => {
            Logger.debug('DEBUG', 'Comando mm43.clearServerLogs ejecutado');
            const confirm = await vscode.window.showWarningMessage(
                '¿Limpiar el server.log?',
                { modal: true }, 'Limpiar'
            );
            if (confirm === 'Limpiar') {
                Logger.debug('DEBUG', 'Limpiando server.log...');
                cacheCleaner.clearServerLog();
            }
        }),

        vscode.commands.registerCommand('mm43.addServer', async () => {
            Logger.debug('DEBUG', 'Comando mm43.addServer ejecutado');
            const uris = await vscode.window.showOpenDialog({
                title: 'MM43 — Selecciona el directorio raíz del servidor (GlassFish/Payara)',
                openLabel: 'Seleccionar Servidor',
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false
            });

            if (!uris || uris.length === 0) return;
            const serverPath = uris[0].fsPath;

            Logger.debug('DEBUG', `Validando ruta del servidor: ${serverPath}`);
            const validation = ServerValidator.validate(serverPath);
            if (!validation.valid) {
                Logger.error('SERVER', `Ruta de servidor inválida: ${validation.error}`);
                vscode.window.showErrorMessage(`[MM43] Directorio inválido: ${validation.error}`);
                return;
            }

            const domain = await vscode.window.showInputBox({
                title: 'MM43 — Nombre del Dominio',
                prompt: 'Ingrese el nombre del dominio a administrar',
                value: 'domain1'
            }) || 'domain1';

            Logger.debug('DEBUG', `Actualizando configuración de servidor. Path: ${serverPath}, Domain: ${domain}`);
            const config = vscode.workspace.getConfiguration('mm43');
            await config.update('serverPath', serverPath, vscode.ConfigurationTarget.Workspace);
            await config.update('serverDomain', domain, vscode.ConfigurationTarget.Workspace);

            vscode.window.showInformationMessage(`  Servidor configurado correctamente en: ${serverPath}`);
            serverProvider.refresh();
        }),

        vscode.commands.registerCommand('mm43.removeServer', async () => {
            Logger.debug('DEBUG', 'Comando mm43.removeServer ejecutado');
            const confirm = await vscode.window.showWarningMessage(
                '¿Eliminar la configuración del servidor?',
                { modal: true }, 'Eliminar'
            );
            if (confirm === 'Eliminar') {
                Logger.debug('DEBUG', 'Eliminando configuración de servidor...');
                const config = vscode.workspace.getConfiguration('mm43');
                await config.update('serverPath', undefined, vscode.ConfigurationTarget.Workspace);
                await config.update('serverDomain', undefined, vscode.ConfigurationTarget.Workspace);
                vscode.window.showInformationMessage('  Configuración de servidor eliminada.');
                serverProvider.refresh();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('mm43.undeployApp', async (item?: any) => {
            Logger.debug('DEBUG', 'Comando mm43.undeployApp ejecutado');
            let appName: string | undefined;

            if (item?.app?.name) {
                appName = item.app.name;
            } else {
                const apps = await serverManager.listApplications();
                if (apps.length === 0) {
                    vscode.window.showInformationMessage('[MM43] No hay aplicaciones desplegadas en el servidor.');
                    return;
                }
                const selected = await vscode.window.showQuickPick(
                    apps.map(a => ({ label: a.name, description: `<${a.type}>`, app: a })),
                    { placeHolder: 'Selecciona la aplicación a desplegar (undeploy)' }
                );
                if (!selected) { return; }
                appName = selected.app.name;
            }

            if (!appName) { return; }

            const confirm = await vscode.window.showWarningMessage(
                `¿Hacer undeploy de '${appName}'?`,
                { modal: true }, 'Undeploy'
            );
            if (confirm !== 'Undeploy') { return; }

            Logger.debug('DEBUG', `Iniciando undeploy de: ${appName}`);
            const success = await serverManager.undeploy(appName);
            if (success) {
                await serverProvider.refreshDeployedApps();
            }
        }),

        vscode.commands.registerCommand('mm43.refreshDeployedApps', async () => {
            Logger.debug('DEBUG', 'Comando mm43.refreshDeployedApps ejecutado');
            await serverProvider.refreshDeployedApps();
        }),

        vscode.commands.registerCommand('mm43.deployExploded', async () => {
            Logger.debug('DEBUG', 'Comando mm43.deployExploded ejecutado');
            const projects = ConfigManager.getProjects();
            if (projects.length === 0) {
                vscode.window.showWarningMessage('[MM43] No hay proyectos configurados.');
                return;
            }

            const selected = await vscode.window.showQuickPick(
                projects.map(p => ({ label: p.name, description: p.rootPath, project: p })),
                { placeHolder: 'Selecciona el proyecto a desplegar en modo Exploded' }
            );

            if (selected) {
                Logger.debug('DEBUG', `Iniciando deploy exploded para: ${selected.project.name}`);
                await serverManager.smartDeploy(selected.project);
                setTimeout(() => serverProvider.refreshDeployedApps(), 5000);
            }
        })
    );

    // ─────────────────────────────────────────────
    // Comandos nuevos: Run, Update Dependencies, Compilar Java
    // ─────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('mm43.runProject', async (nameOrItem: string | { project: ProjectConfig }) => {
            Logger.debug('DEBUG', 'Comando mm43.runProject ejecutado');
            const projects = ConfigManager.getProjects();
            if (projects.length === 0) {
                vscode.window.showWarningMessage('[MM43] No hay proyectos configurados.');
                return;
            }

            let project: ProjectConfig | undefined;
            if (typeof nameOrItem === 'string') {
                project = projects.find(p => p.name === nameOrItem);
            } else if (nameOrItem?.project) {
                project = nameOrItem.project;
            }

            if (!project) {
                const selected = await vscode.window.showQuickPick(
                    projects.map(p => ({ label: p.name, description: p.rootPath, project: p })),
                    { placeHolder: 'Selecciona el proyecto a ejecutar (Run)' }
                );
                if (!selected) { return; }
                project = selected.project;
            }

            Logger.section(`Run: ${project.name}`);
            Logger.info('GENERAL', `▶ Ejecutando flujo Run para: ${project.name}`);
            Logger.show();

            // Paso 1: Build Exploded
            const buildOk = await mavenManager.buildExploded(project);
            if (!buildOk) {
                Logger.error('GENERAL', `❌ Build falló. Abortando Run para ${project.name}.`);
                return;
            }

            // Paso 2: Smart Deploy (deploy o redeploy según estado del servidor)
            await serverManager.deployAfterBuild(project);
            setTimeout(() => serverProvider.refreshDeployedApps(), 5000);
        }),

        vscode.commands.registerCommand('mm43.updateDependencies', async (nameOrItem: string | { project: ProjectConfig }) => {
            Logger.debug('DEBUG', 'Comando mm43.updateDependencies ejecutado');
            const projects = ConfigManager.getProjects();
            if (projects.length === 0) {
                vscode.window.showWarningMessage('[MM43] No hay proyectos configurados.');
                return;
            }

            let project: ProjectConfig | undefined;
            if (typeof nameOrItem === 'string') {
                project = projects.find(p => p.name === nameOrItem);
            } else if (nameOrItem?.project) {
                project = nameOrItem.project;
            }

            if (!project) {
                const selected = await vscode.window.showQuickPick(
                    projects.map(p => ({ label: p.name, description: p.rootPath, project: p })),
                    { placeHolder: 'Selecciona el proyecto para actualizar dependencias' }
                );
                if (!selected) { return; }
                project = selected.project;
            }

            Logger.debug('DEBUG', `Actualizando dependencias para: ${project.name}`);
            Logger.show();
            await mavenManager.updateDependencies(project);
        }),

        vscode.commands.registerCommand('mm43.compilarJava', async () => {
            Logger.debug('DEBUG', 'Comando mm43.compilarJava ejecutado');
            const editor = vscode.window.activeTextEditor;
            if (!editor || !editor.document.fileName.endsWith('.java')) {
                vscode.window.showWarningMessage('[MM43] Abre un archivo .java para compilar.');
                return;
            }

            const filePath = editor.document.fileName;
            const projects = ConfigManager.getProjects();
            const project = projects.find(p => filePath.startsWith(p.rootPath));

            if (!project) {
                vscode.window.showErrorMessage('[MM43] El archivo no pertenece a ningún proyecto configurado.');
                return;
            }

            if (!project.classpath) {
                vscode.window.showWarningMessage('[MM43] Genera el classpath primero (mm43.generateClasspath).');
                return;
            }

            // Derivar la ruta relativa desde src/main/java
            const srcRoot = require('path').join(project.rootPath, 'src', 'main', 'java');
            const relativePath = require('path').relative(srcRoot, filePath);

            Logger.info('HOTRELOAD', `Compilación individual: ${relativePath}`);
            await AgenteHotReloadManager.cambioEnCaliente(relativePath, project);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('mm43.importAgent', async () => {
            Logger.debug('DEBUG', 'Comando mm43.importAgent ejecutado');
            await agente.importAgent();
            serverProvider.refresh();
        }),

        vscode.commands.registerCommand('mm43.removeAgent', async () => {
            Logger.debug('DEBUG', 'Comando mm43.removeAgent ejecutado');
            const confirm = await vscode.window.showWarningMessage(
                '¿Eliminar el agente de Hot-Reload?',
                { modal: true }, 'Eliminar'
            );
            if (confirm === 'Eliminar') {
                Logger.debug('DEBUG', 'Eliminando agente...');
                await agente.removeAgent();
                serverProvider.refresh();
            }
        }),

        vscode.commands.registerCommand('mm43.injectAgentOptions', async () => {
            Logger.debug('DEBUG', 'Comando mm43.injectAgentOptions ejecutado');
            await agente.injectAgentOptions();
        }),

        vscode.commands.registerCommand('mm43.openDomainXml', async () => {
            Logger.debug('DEBUG', 'Comando mm43.openDomainXml ejecutado');
            await agente.openDomainXml();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('mm43.generateClasspath', async (item?: any) => {
            Logger.debug('DEBUG', 'Comando mm43.generateClasspath ejecutado');
            const projects = ConfigManager.getProjects();
            if (projects.length === 0) {
                vscode.window.showWarningMessage('[MM43] No hay proyectos configurados.');
                return;
            }

            let project = item?.project;
            if (!project) {
                const selected = await vscode.window.showQuickPick(
                    projects.map(p => ({ label: p.name, project: p })),
                    { placeHolder: 'Selecciona proyecto para generar classpath' }
                );
                if (!selected) { return; }
                project = selected.project;
            }

            try {
                Logger.debug('DEBUG', `Generando classpath para: ${project.name}`);
                const classpath = await mavenManager.generarClasspath(project);
                await ConfigManager.updateProjectClasspath(project.name, classpath);
                vscode.window.showInformationMessage(`[MM43]   Classpath generado y guardado para '${project.name}'`);
            } catch (err) {
                Logger.error('MAVEN', `Error al generar classpath: ${String(err)}`);
                vscode.window.showErrorMessage(`[MM43] ❌ Error al generar classpath: ${String(err)}`);
            }
        }),

        vscode.commands.registerCommand('mm43.hotReload', async () => {
            Logger.debug('DEBUG', 'Comando mm43.hotReload ejecutado');
            const projects = ConfigManager.getProjects();
            if (projects.length > 0 && projects[0].classpath) {
                Logger.debug('DEBUG', 'Iniciando HotSwap...');
            } else {
                vscode.window.showWarningMessage('[MM43] Por favor, genera el classpath primero.');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('mm43.db.refresh', async () => {
            Logger.debug('DEBUG', 'Comando mm43.db.refresh ejecutado');
            await databaseProvider.reload();
        }),

        vscode.commands.registerCommand('mm43.db.provisionMissing', async () => {
            Logger.debug('DEBUG', 'Comando mm43.db.provisionMissing ejecutado');
            Logger.show();
            await databaseProvisioner.provisionMissing(() => databaseProvider.reload());
        }),

        vscode.commands.registerCommand('mm43.db.pingPool', async (item?: any) => {
            Logger.debug('DEBUG', 'Comando mm43.db.pingPool ejecutado');
            let poolName: string | undefined;

            if (item?.pool?.name) {
                poolName = item.pool.name;
            } else {
                const pools = await AsadminDatabaseManager.listPools();
                if (pools.length === 0) {
                    vscode.window.showInformationMessage('[MM43] No hay pools registrados.');
                    return;
                }
                const selected = await vscode.window.showQuickPick(
                    pools.map(p => p.name),
                    { placeHolder: 'Selecciona el pool a verificar' }
                );
                if (!selected) { return; }
                poolName = selected;
            }

            if (!poolName) { return; }

            Logger.debug('DEBUG', `Ping a pool: ${poolName}`);
            Logger.show();
            const status = await AsadminDatabaseManager.pingPool(poolName);
            databaseProvider.updatePoolStatus(poolName, status);

            if (status === 'active') {
                vscode.window.showInformationMessage(`[MM43] Ping a '${poolName}': Conexion exitosa.`);
            } else {
                vscode.window.showWarningMessage(`[MM43] Ping a '${poolName}': La conexion fallo.`);
            }
        }),

        vscode.commands.registerCommand('mm43.db.editPool', async (item?: any) => {
            Logger.debug('DEBUG', 'Comando mm43.db.editPool ejecutado');
            let poolName: string | undefined;

            if (item?.pool?.name) {
                poolName = item.pool.name;
            } else {
                const pools = await AsadminDatabaseManager.listPools();
                if (pools.length === 0) {
                    vscode.window.showInformationMessage('[MM43] No hay pools registrados.');
                    return;
                }
                const selected = await vscode.window.showQuickPick(
                    pools.map(p => p.name),
                    { placeHolder: 'Selecciona el pool a editar' }
                );
                if (!selected) { return; }
                poolName = selected;
            }

            if (!poolName) { return; }

            Logger.debug('DEBUG', `Obteniendo detalles del pool: ${poolName}`);
            const props = await AsadminDatabaseManager.getPoolDetails(poolName);
            const content = JSON.stringify(props, null, 2);

            const doc = await vscode.workspace.openTextDocument({
                content,
                language: 'json',
            });
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage(
                `[MM43] Propiedades del pool '${poolName}'. Para aplicar cambios use los comandos de asadmin set.`
            );
        }),

        vscode.commands.registerCommand('mm43.db.deletePool', async (item?: any) => {
            Logger.debug('DEBUG', 'Comando mm43.db.deletePool ejecutado');
            let poolName: string | undefined;

            if (item?.pool?.name) {
                poolName = item.pool.name;
            } else {
                const pools = await AsadminDatabaseManager.listPools();
                if (pools.length === 0) {
                    vscode.window.showInformationMessage('[MM43] No hay pools registrados.');
                    return;
                }
                const selected = await vscode.window.showQuickPick(
                    pools.map(p => p.name),
                    { placeHolder: 'Selecciona el pool a eliminar' }
                );
                if (!selected) { return; }
                poolName = selected;
            }

            if (!poolName) { return; }

            const confirm = await vscode.window.showWarningMessage(
                `Eliminar el pool '${poolName}' y todos sus recursos asociados?`,
                { modal: true }, 'Eliminar'
            );
            if (confirm !== 'Eliminar') { return; }

            Logger.debug('DEBUG', `Eliminando pool: ${poolName}`);
            Logger.show();
            const success = await AsadminDatabaseManager.deletePool(poolName);
            if (success) {
                vscode.window.showInformationMessage(`[MM43] Pool '${poolName}' eliminado.`);
                await databaseProvider.reload();
            }
        }),

        vscode.commands.registerCommand('mm43.db.editResource', async (item?: any) => {
            Logger.debug('DEBUG', 'Comando mm43.db.editResource ejecutado');
            let jndiName: string | undefined;

            if (item?.resource?.jndiName) {
                jndiName = item.resource.jndiName;
            } else {
                const resources = await AsadminDatabaseManager.listResources();
                if (resources.length === 0) {
                    vscode.window.showInformationMessage('[MM43] No hay recursos JDBC.');
                    return;
                }
                const selected = await vscode.window.showQuickPick(
                    resources.map(r => r.jndiName),
                    { placeHolder: 'Selecciona el recurso a editar' }
                );
                if (!selected) { return; }
                jndiName = selected;
            }

            if (!jndiName) { return; }

            const pools = await AsadminDatabaseManager.listPools();
            if (pools.length === 0) {
                vscode.window.showWarningMessage('[MM43] No hay pools disponibles para asignar.');
                return;
            }

            const currentPool = await AsadminDatabaseManager.getResourcePoolName(jndiName);

            const selected = await vscode.window.showQuickPick(
                pools.map(p => ({
                    label: p.name,
                    description: p.name === currentPool ? '(actual)' : '',
                })),
                { placeHolder: `Selecciona el pool para '${jndiName}' (actual: ${currentPool})` }
            );

            if (!selected || selected.label === currentPool) { return; }

            Logger.debug('DEBUG', `Reasignando recurso ${jndiName} al pool: ${selected.label}`);
            Logger.show();
            const success = await AsadminDatabaseManager.setResourcePool(jndiName, selected.label);
            if (success) {
                vscode.window.showInformationMessage(
                    `[MM43] Recurso '${jndiName}' reasignado a pool '${selected.label}'.`
                );
                await databaseProvider.reload();
            }
        }),

        vscode.commands.registerCommand('mm43.db.deleteResource', async (item?: any) => {
            Logger.debug('DEBUG', 'Comando mm43.db.deleteResource ejecutado');
            let jndiName: string | undefined;

            if (item?.resource?.jndiName) {
                jndiName = item.resource.jndiName;
            } else {
                const resources = await AsadminDatabaseManager.listResources();
                if (resources.length === 0) {
                    vscode.window.showInformationMessage('[MM43] No hay recursos JDBC.');
                    return;
                }
                const selected = await vscode.window.showQuickPick(
                    resources.map(r => r.jndiName),
                    { placeHolder: 'Selecciona el recurso a eliminar' }
                );
                if (!selected) { return; }
                jndiName = selected;
            }

            if (!jndiName) { return; }

            const confirm = await vscode.window.showWarningMessage(
                `Eliminar el recurso JDBC '${jndiName}'?`,
                { modal: true }, 'Eliminar'
            );
            if (confirm !== 'Eliminar') { return; }

            Logger.debug('DEBUG', `Eliminando recurso: ${jndiName}`);
            Logger.show();
            const success = await AsadminDatabaseManager.deleteResource(jndiName);
            if (success) {
                vscode.window.showInformationMessage(`[MM43] Recurso '${jndiName}' eliminado.`);
                await databaseProvider.reload();
            }
        })
    );

    // assetWatcher.startAll(); se eliminó la llamada redundante aquí

    const beanRegistry = await setupBeanIndex(context);
    setupFacesIntellisense(context, beanRegistry);

    const vcWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (vcWorkspaceRoot) {
        Logger.debug('DEBUG', `Inicializando Control de Versión en: ${vcWorkspaceRoot}`);
        setupVersionControl(context, vcWorkspaceRoot).catch(err => {
            Logger.error('VERSION_CONTROL', `Error al inicializar: ${String(err)}`);
        });
    } else {
        Logger.warn('VERSION_CONTROL', 'No hay workspace abierto. Control de versión deshabilitado.');
    }

    async function promptNewProject(): Promise<ProjectConfig | undefined> {
        const name = await vscode.window.showInputBox({
            title: 'MM43 — Nuevo Proyecto Maven (1/4)',
            prompt: 'Nombre corto del proyecto (ej. Admin, Nomina)',
            validateInput: v => v?.trim() ? undefined : 'El nombre no puede estar vacío'
        });
        if (!name) { return undefined; }

        const rootUris = await vscode.window.showOpenDialog({
            title: 'MM43 — Selecciona la carpeta raíz del proyecto Maven (2/4)',
            openLabel: 'Seleccionar carpeta raíz',
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false
        });
        if (!rootUris || rootUris.length === 0) { return undefined; }
        const rootPath = rootUris[0].fsPath;

        const warName = await vscode.window.showInputBox({
            title: 'MM43 — Nuevo Proyecto Maven (3/4)',
            prompt: 'Nombre del artefacto WAR (sin extensión, ej. sigafAdministrador)',
            validateInput: v => v?.trim() ? undefined : 'El nombre WAR no puede estar vacío'
        });
        if (!warName) { return undefined; }

        return {
            name: name.trim(),
            rootPath: rootPath.trim(),
            warName: warName.trim()
        };
    }
    if (serverManager.getServerState() === 'running' && assetWatcher.startAll()) {
        statusBar.setWatcherState('running');
        serverProvider.setWatcherState('running');
        Logger.info('WATCHER', 'Watchers inicializados correctamente');
    } else {
        statusBar.setWatcherState('stopped');
        serverProvider.setWatcherState('stopped');
        if (serverManager.getServerState() === 'running') {
            Logger.warn('WATCHER', 'No se pudieron inicializar los watchers');
        }
    }
    Logger.debug('DEBUG', 'Activación de MM43 completada.');
}

function setupFacesIntellisense(contexto: vscode.ExtensionContext, beanRegistry: BeanRegistry): void {
    const pathDeContexto = contexto.extensionPath;
    
    const registry = new NamespacerRegistry(pathDeContexto);
    const proveedorDeAutocompletado = new XhtmlCompletionProvider(registry);
    const proveedorDeHover = new XhtmlHoverProvider(registry);

    // Proveedores EL (integración con módulo AI)
    const elCompletion = new ElCompletionProvider(beanRegistry);
    const elHover = new ElHoverProvider(beanRegistry);
    //const elDiagnostics = new ElDiagnosticProvider(beanRegistry);
    const elRename = new ElRenameProvider(beanRegistry);

    // registros
    const xhtmlSelector: vscode.DocumentSelector = [
        { language: 'html', pattern: '**/*.xhtml' }
    ]

    contexto.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(xhtmlSelector, proveedorDeAutocompletado, ':'),
        vscode.languages.registerCompletionItemProvider(xhtmlSelector, elCompletion, '#', '.'),
        vscode.languages.registerHoverProvider(xhtmlSelector, elHover),
        vscode.languages.registerHoverProvider(xhtmlSelector, proveedorDeHover),
        vscode.languages.registerRenameProvider(xhtmlSelector, elRename),
        //elDiagnostics
    )

    //comando para limpiar cache
    contexto.subscriptions.push(
        vscode.commands.registerCommand('mm43.xhtml.clearCache', () => {
            registry.limpiarCache();
            Logger.info('XHTML', 'Caché limpiada');
        })
    )
    Logger.info('XHTML', 'Faces Intellisense + EL Integration cargado.');
    
}

export async function setupVersionControl(
    context: vscode.ExtensionContext,
    workspaceRoot: string
): Promise<void> {
    Logger.info('VERSION_CONTROL', `Inicializando módulo en: ${workspaceRoot}`);

    const engine = new FlatteningEngine(workspaceRoot);

    await engine.initialize();

    const vcProvider = new VersionControlProvider(engine);

    const treeView = vscode.window.createTreeView('mm43VersionControl', {
        treeDataProvider: vcProvider,
        showCollapseAll: false
    });

    registerVersionControlCommands(context, engine, vcProvider);

    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceRoot, '.git/refs/**')
    );
    watcher.onDidChange(() => engine.refreshState());
    watcher.onDidCreate(() => engine.refreshState());
    watcher.onDidDelete(() => engine.refreshState());

    context.subscriptions.push(
        treeView,
        watcher,
        { dispose: () => engine.dispose() }
    );

    Logger.info('VERSION_CONTROL', '  Módulo de Control de Versión MM43 activo');
}

async function setupBeanIndex(context: vscode.ExtensionContext): Promise<BeanRegistry> {
    const projects = ConfigManager.getProjects();

    const registry = new BeanRegistry();
    const scanner = new BeanScanner(registry);

    scanner.scanAll(projects).catch(err =>
        Logger.error('AI', `Error en scan inicial: ${String(err)}`)
    );

    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(
            [{ language: 'xml' }, { pattern: '**/*.xhtml' }],
            new BeanDefinitionProvider(registry)
        )
    );

    for (const project of projects) {
        const javaGlob = new vscode.RelativePattern(
            project.rootPath,
            'src/main/java/**/*.java'
        );
        const watcher = vscode.workspace.createFileSystemWatcher(javaGlob);

        watcher.onDidChange(uri => scanner.scanFile(uri.fsPath));
        watcher.onDidCreate(uri => scanner.scanFile(uri.fsPath));
        watcher.onDidDelete(uri => registry.invalidate(uri.fsPath));

        context.subscriptions.push(watcher);
    }

    context.subscriptions.push(
        ConfigManager.onDidChange(() => {
            const updated = ConfigManager.getProjects();
            scanner.scanAll(updated).catch(err =>
                Logger.error('AI', `Re-scan tras cambio de config: ${String(err)}`)
            );
        })
    );

    Logger.info('AI', `Bean Index inicializado. ${registry.size} beans cargados.`);
    return registry;
}

export function deactivate() {
    Logger.debug('DEBUG', 'Desactivando extensión MM43...');
    // if (globalServerManager) {
    //      globalServerManager.stop();
    // }
}  
