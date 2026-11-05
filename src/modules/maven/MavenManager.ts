import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectConfig, ServerState, SyncResult } from '../../config/types';
import * as crypto from 'crypto';
import { MavenComand } from './MavenComand';
import { Logger } from '../logger/Logger';
import { ServerManager } from '../server/ServerManager';

export class MavenManager {
    constructor(private serverManager: ServerManager) { }

    // ─────────────────────────────────────────────
    // BLOQUE 1: Ciclo de vida principal
    // ─────────────────────────────────────────────

    /**
     * Compila + genera carpeta exploded en target/<warName>.
     * Uso: flujo Run (paso previo a deploy/redeploy).
     */
    async buildExploded(project: ProjectConfig, skipTests = true): Promise<boolean> {
        Logger.debug('DEBUG', `buildExploded: ${project.name}`);
        const props: Record<string, string> = skipTests ? { 'skipTests': 'true' } : {};
        Logger.info('SERVER', 'Se consultará el estado del servidor');
        const serverState = await this.getServerStateForBuild();
        const canClean = serverState === 'stopped';

        if (!canClean) {
            this.warnCleanSkipped(`Build Exploded: ${project.name}`, serverState);
        }

        return this._runCmd(new MavenComand(
            `${project.name}-build-exploded`,
            `Build Exploded: ${project.name}`,
            canClean ? ['clean', 'compile', 'war:exploded'] : ['compile', 'war:exploded'],
            props,
            [],
            project.rootPath
        ), `Build Exploded: ${project.name}`);
    }

    /**
     * clean + install en repo local + exploded.
     * Uso: primera vez o al cambiar dependencias entre módulos.
     */
    async cleanInstall(project: ProjectConfig, skipTests = true): Promise<boolean> {
            Logger.debug('DEBUG', `cleanInstall: ${project.name}`);
            const serverState = await this.getServerStateForBuild();
            if (serverState !== 'stopped') {
                this.warnCleanBlocked(`Clean Install: ${project.name}`, serverState);
                return false;
            }

            const props: Record<string, string> = skipTests ? { 'skipTests': 'true' } : {};
            return this._runCmd(new MavenComand(
                `${project.name}-clean-install`,
                `Clean Install: ${project.name}`,
                ['clean', 'install', 'war:exploded'],
                props,
                [],
                project.rootPath
            ), `Clean Install: ${project.name}`);
        }

    /**
     * Compilación incremental para los flujos de hot reload.
     * No limpia ni instala dependencias.
     */
    async compileIncremental(project: ProjectConfig, skipTests = true): Promise<boolean> {
        Logger.debug('DEBUG', `compileIncremental: ${project.name}`);
        const props: Record<string, string> = skipTests ? { skipTests: 'true' } : {};

        return this._runCmd(new MavenComand(
            `${project.name}-compile-incremental`,
            `Compile Incremental: ${project.name}`,
            ['compile'],
            props,
            [],
            project.rootPath
        ), `Compile Incremental: ${project.name}`);
    }

    /**
     * Compila y sincroniza las clases en el WAR exploded sin ejecutar
     * nuevamente el empaquetado completo.
     */
        async buildExplodedIncremental(project: ProjectConfig, skipTests = true): Promise<boolean> {

        const result = await this.buildExplodedIncrementalDetailed(project, skipTests);
        return result.ok;
    }

    async buildExplodedIncrementalDetailed(
        project: ProjectConfig,
        skipTests = true
    ): Promise<{ ok: boolean; sync?: SyncResult }> {
        const compiled = await this.compileIncremental(project, skipTests);
        if (!compiled) {
            return { ok: false };
        }

        const sync = await this.syncExplodedClasses(project);
        return sync ? { ok: true, sync } : { ok: false };
    }

        /**
     * Sincroniza target/classes con WEB-INF/classes de forma incremental.
     * Retorna null si el origen no está disponible o si ocurre un error.
     */
    async syncExplodedClasses(project: ProjectConfig): Promise<SyncResult | null> {
        const source = path.join(project.rootPath, 'target', 'classes');
        const destination = path.join(
            project.rootPath, 'target', project.warName, 'WEB-INF', 'classes'
        );

        try {
            if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
                Logger.error('MAVEN', `No existe el directorio de clases compiladas: ${source}`);
                return null;
            }

            const result = this.syncDirectory(source, destination);
            Logger.info(
                'MAVEN',
                `Clases sincronizadas: ${result.changed.length} modificadas, ${result.removed.length} eliminadas`
            );
            return result;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            Logger.error('MAVEN', `No se pudieron sincronizar las clases: ${message}`);
            return null;
        }
    }

    private _syncTempCounter = 0;

    private syncDirectory(source: string, destination: string): SyncResult {
        const result: SyncResult = { changed: [], removed: [] };
        this.syncDirectoryContents(source, destination, destination, result);
        result.changed.sort((a, b) => a.className.localeCompare(b.className));
        result.removed.sort((a, b) => a.localeCompare(b));
        return result;
    }

    private syncDirectoryContents(
        source: string,
        destination: string,
        destinationRoot: string,
        result: SyncResult
    ): void {
        if (fs.existsSync(destination) && !fs.lstatSync(destination).isDirectory()) {
            this.collectRemovedClasses(destination, destinationRoot, result.removed);
            fs.rmSync(destination, { force: true });
        }
        fs.mkdirSync(destination, { recursive: true });

        const sourceEntries = new Set(fs.readdirSync(source));
        for (const entry of sourceEntries) {
            const sourcePath = path.join(source, entry);
            const destinationPath = path.join(destination, entry);
            const sourceStat = fs.lstatSync(sourcePath);

            if (sourceStat.isDirectory()) {
                this.syncDirectoryContents(sourcePath, destinationPath, destinationRoot, result);
            } else if (sourceStat.isFile()) {
                if (fs.existsSync(destinationPath) && fs.lstatSync(destinationPath).isDirectory()) {
                    this.collectRemovedClasses(destinationPath, destinationRoot, result.removed);
                    fs.rmSync(destinationPath, { recursive: true, force: true });
                }
                this.syncFileIfChanged(sourcePath, destinationPath, destinationRoot, result);
            }
        }

        for (const entry of fs.readdirSync(destination)) {
            if (!sourceEntries.has(entry)) {
                const stalePath = path.join(destination, entry);
                this.collectRemovedClasses(stalePath, destinationRoot, result.removed);
                fs.rmSync(stalePath, { recursive: true, force: true });
            }
        }
    }

    private syncFileIfChanged(
        sourcePath: string,
        destinationPath: string,
        destinationRoot: string,
        result: SyncResult
    ): void {
        const sourceBytes = fs.readFileSync(sourcePath);
        let changed = !fs.existsSync(destinationPath);

        if (!changed) {
            const destinationStat = fs.statSync(destinationPath);
            changed = destinationStat.size !== sourceBytes.length;
            if (!changed) {
                const destinationBytes = fs.readFileSync(destinationPath);
                changed = this.sha256(sourceBytes) !== this.sha256(destinationBytes);
            }
        }

        if (!changed) {
            return;
        }

        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        const tempPath = `${destinationPath}.mm43tmp-${process.pid}-${Date.now()}-${++this._syncTempCounter}`;

        try {
            fs.writeFileSync(tempPath, sourceBytes);
            fs.renameSync(tempPath, destinationPath);
        } catch (error) {
            try {
                if (fs.existsSync(tempPath)) {
                    fs.rmSync(tempPath, { force: true });
                }
            } catch { /* conservar el error original */ }
            throw error;
        }

        if (destinationPath.toLowerCase().endsWith('.class')) {
            const relativePath = path.relative(destinationRoot, destinationPath);
            const normalizedPath = relativePath.split(path.sep).join('/');
            result.changed.push({
                className: normalizedPath.replace(/\.class$/i, '').replace(/\//g, '.'),
                classFile: destinationPath,
                hash: this.sha256(sourceBytes),
            });
        }
    }

    private collectRemovedClasses(targetPath: string, destinationRoot: string, removed: string[]): void {
        if (!fs.existsSync(targetPath)) {
            return;
        }

        const stat = fs.lstatSync(targetPath);
        if (stat.isDirectory()) {
            for (const entry of fs.readdirSync(targetPath)) {
                this.collectRemovedClasses(path.join(targetPath, entry), destinationRoot, removed);
            }
        } else if (stat.isFile() && targetPath.toLowerCase().endsWith('.class')) {
            removed.push(path.relative(destinationRoot, targetPath).split(path.sep).join('/'));
        }
    }

    private sha256(contents: Buffer): string {
        return crypto.createHash('sha256').update(contents).digest('hex');
    }

    /**
     * clean + compile (sin exploded, sin install).
     * Uso: verificación rápida de errores de compilación.
     */
    async cleanCompile(project: ProjectConfig): Promise<boolean> {
            Logger.debug('DEBUG', `cleanCompile: ${project.name}`);
            const serverState = await this.getServerStateForBuild();
            const canClean = serverState === 'stopped';

            if (!canClean) {
                this.warnCleanSkipped(`Clean Compile: ${project.name}`, serverState);
            }

            return this._runCmd(new MavenComand(
                `${project.name}-clean-compile`,
                `Clean Compile: ${project.name}`,
                canClean ? ['clean', 'compile'] : ['compile'],
                { 'skipTests': 'true' },
                [],
                project.rootPath
            ), `Clean Compile: ${project.name}`);
        }

    /**
     * clean + package → WAR empaquetado en target/.
     * Uso: exportación / despliegue en producción.
     */
    async cleanPackage(project: ProjectConfig, skipTests = true): Promise<boolean> {
            Logger.debug('DEBUG', `cleanPackage: ${project.name}`);
            const serverState = await this.getServerStateForBuild();
            if (serverState !== 'stopped') {
                this.warnCleanBlocked(`Package WAR: ${project.name}`, serverState);
                return false;
            }

            const props: Record<string, string> = skipTests ? { 'skipTests': 'true' } : {};
            return this._runCmd(new MavenComand(
                `${project.name}-clean-package`,
                `Package WAR: ${project.name}`,
                ['clean', 'package'],
                props,
                [],
                project.rootPath
            ), `Package WAR: ${project.name}`);
        }

    // ─────────────────────────────────────────────
    // BLOQUE 2: Gestión de dependencias
    // ─────────────────────────────────────────────

    /**
     * Fuerza descarga de dependencias actualizadas (-U).
     * Uso: botón "Actualizar Dependencias".
     */
    async updateDependencies(project: ProjectConfig): Promise<boolean> {
        Logger.debug('DEBUG', `updateDependencies: ${project.name}`);

        // -U es flag de Maven (no property -D), se pasa como fase extra
        return this._runCmd(new MavenComand(
            `${project.name}-update-deps`,
            `Actualizar Dependencias: ${project.name}`,
            ['dependency:resolve', '-U'],
            {},
            [],
            project.rootPath
        ), `Actualizar Dependencias: ${project.name}`);
    }

    /**
     * Genera classpath completo y lo retorna como string.
     * Uso: hot-reload (javac incremental necesita classpath exacto).
     */
    async generarClasspath(project: ProjectConfig): Promise<string> {
        Logger.debug('DEBUG', `generarClasspath: ${project.name}`);
        const outputFileName = 'classpath.txt';
        const outputPath = path.join(project.rootPath, outputFileName);

        const cmd = new MavenComand(
            `${project.name}-classpath`,
            `Classpath: ${project.name}`,
            ['dependency:build-classpath'],
            { 'mdep.outputFile': outputFileName },
            [],
            project.rootPath
        );

        const valid = await cmd.validate();
        if (!valid) {
            const msg = `Directorio inexistente: ${project.rootPath}`;
            Logger.error('MAVEN', msg);
            throw new Error(msg);
        }

        Logger.section(`Classpath: ${project.name}`);
        Logger.info('MAVEN', `Generando classpath para: ${project.name}`);
        const result = await cmd.execute();

        if (!result.success) {
            const msg = `Maven falló al generar classpath: ${result.error}`;
            Logger.error('MAVEN', msg);
            throw new Error(msg);
        }

        if (!fs.existsSync(outputPath)) {
            const msg = `No se generó ${outputFileName}`;
            Logger.error('MAVEN', msg);
            throw new Error(msg);
        }

        const classpath = fs.readFileSync(outputPath, 'utf8').trim();
        Logger.debug('DEBUG', `Classpath leído (${classpath.length} chars)`);
        try { fs.unlinkSync(outputPath); } catch (_) { /* no crítico */ }
        return classpath;
    }

    // ─────────────────────────────────────────────
    // BLOQUE 3: Helper interno
    // ─────────────────────────────────────────────

    private async getServerStateForBuild(): Promise<ServerState> {
        try {
            return await this.serverManager.checkServerStatus();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            Logger.warn('MAVEN', `No se pudo verificar el estado del servidor; se prohíbe clean por seguridad: ${message}`);
            return 'unknown';
        }
    }

    private warnCleanSkipped(operation: string, state: ServerState): void {
        const message = `${operation}: servidor ${state}; se omite clean.`;
        Logger.warn('MAVEN', message);
        void vscode.window.showWarningMessage(`[MM43] ${message}`);
    }

    private warnCleanBlocked(operation: string, state: ServerState): void {
        const message = `${operation} cancelado: clean solo se permite con el servidor detenido (estado: ${state}). Detén el servidor y vuelve a intentarlo.`;
        Logger.warn('MAVEN', message);
        void vscode.window.showWarningMessage(`[MM43] ${message}`);
    }

    private async _runCmd(cmd: MavenComand, label: string): Promise<boolean> {
        const valid = await cmd.validate();
        if (!valid) {
            const msg = `Directorio no existe: ${(cmd as any).workingDir}`;
            Logger.error('MAVEN', msg);
            vscode.window.showErrorMessage(`[MM43] ${msg}`);
            return false;
        }

        Logger.section(label);
        Logger.info('MAVEN', `Iniciando: ${label}`);
        const result = await cmd.execute();

        if (result.success) {
            Logger.info('MAVEN', `  ${label}`);
            vscode.window.showInformationMessage(`[MM43]   ${label} OK.`);
        } else {
            Logger.error('MAVEN', `❌ ${label} — ${result.error}`);
            vscode.window.showErrorMessage(`[MM43] ❌ ${label} falló. Revisa el canal "mm43".`);
        }

        return result.success;
    }
}

