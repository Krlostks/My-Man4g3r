import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectConfig, SyncResult, ChangedClass } from '../../config/types';
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
        const result = this.serverManager.getServerState();
        if (result === 'stopped') {

            return this._runCmd(new MavenComand(
                `${project.name}-build-exploded`,
                `Build Exploded: ${project.name}`,
                ['clean', 'compile', 'war:exploded'],
                props,
                [],
                project.rootPath
            ), `Build Exploded: ${project.name}`);
        } else {
            return this._runCmd(new MavenComand(
                `${project.name}-build-exploded`,
                `Build Exploded: ${project.name}`,
                ['compile', 'war:exploded'],
                props,
                [],
                project.rootPath
            ), `Build Exploded: ${project.name}`);
        }
    }

    /**
     * clean + install en repo local + exploded.
     * Uso: primera vez o al cambiar dependencias entre módulos.
     */
    async cleanInstall(project: ProjectConfig, skipTests = true): Promise<boolean> {
        Logger.debug('DEBUG', `cleanInstall: ${project.name}`);
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
        const compiled = await this.compileIncremental(project, skipTests);
        return compiled && this.syncExplodedClasses(project);
    }

    /**
     * Copia target/classes al directorio WEB-INF/classes del WAR exploded.
     * También elimina clases obsoletas para evitar que el servidor cargue
     * bytecode eliminado del proyecto.
     */
    async syncExplodedClasses(project: ProjectConfig): Promise<boolean> {
        const source = path.join(project.rootPath, 'target', 'classes');
        const destination = path.join(
            project.rootPath, 'target', project.warName, 'WEB-INF', 'classes'
        );

        try {
            if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
                Logger.error('MAVEN', `No existe el directorio de clases compiladas: ${source}`);
                return false;
            }

            this.syncDirectory(source, destination);
            Logger.info('MAVEN', `Clases sincronizadas: ${source} -> ${destination}`);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            Logger.error('MAVEN', `No se pudieron sincronizar las clases: ${message}`);
            return false;
        }
    }

    private syncDirectory(source: string, destination: string): void {
        if (fs.existsSync(destination) && !fs.lstatSync(destination).isDirectory()) {
            fs.rmSync(destination, { force: true });
        }
        fs.mkdirSync(destination, { recursive: true });
        const sourceEntries = new Set(fs.readdirSync(source));

        for (const entry of sourceEntries) {
            const sourcePath = path.join(source, entry);
            const destinationPath = path.join(destination, entry);
            const sourceStat = fs.lstatSync(sourcePath);

            if (sourceStat.isDirectory()) {
                this.syncDirectory(sourcePath, destinationPath);
            } else if (sourceStat.isFile()) {
                if (fs.existsSync(destinationPath) && fs.lstatSync(destinationPath).isDirectory()) {
                    fs.rmSync(destinationPath, { recursive: true, force: true });
                }
                fs.copyFileSync(sourcePath, destinationPath);
            }
        }

        for (const entry of fs.readdirSync(destination)) {
            if (!sourceEntries.has(entry)) {
                fs.rmSync(path.join(destination, entry), { recursive: true, force: true });
            }
        }
    }

    /**
     * clean + compile (sin exploded, sin install).
     * Uso: verificación rápida de errores de compilación.
     */
    async cleanCompile(project: ProjectConfig): Promise<boolean> {
        Logger.debug('DEBUG', `cleanCompile: ${project.name}`);

        return this._runCmd(new MavenComand(
            `${project.name}-clean-compile`,
            `Clean Compile: ${project.name}`,
            ['clean', 'compile'],
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
