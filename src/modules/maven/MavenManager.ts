import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectConfig } from '../../config/types';
import { MavenComand } from './MavenComand';
import { Logger } from '../logger/Logger';

export class MavenManager {

    async cleanCompile(project: ProjectConfig): Promise<boolean> {
        Logger.debug('DEBUG', `cleanCompile invocado para: ${project.name}`);
        const cmd = new MavenComand(
            `${project.name}-clean-compile`,
            `Clean & Compile: ${project.name}`,
            ['clean', 'compile'],
            { 'skipTests': 'true' },
            [],
            project.rootPath
        );

        const valid = await cmd.validate();
        if (!valid) {
            Logger.error('MAVEN', `Directorio de proyecto no existe: ${project.rootPath}`);
            vscode.window.showErrorMessage(
                `[MM43] El directorio del proyecto no existe: ${project.rootPath}`
            );
            return false;
        }

        Logger.section(`Clean & Compile: ${project.name}`);
        Logger.info('MAVEN', `🔨 Iniciando clean & compile para: ${project.name}`);

        Logger.debug('DEBUG', 'Ejecutando comando Maven clean compile...');
        const result = await cmd.execute();

        if (result.success) {
            Logger.info('MAVEN', `✅ clean & compile completado: ${project.name}`);
            vscode.window.showInformationMessage(
                `[MM43] ✅ '${project.name}' compilado correctamente.`
            );
        } else {
            Logger.error('MAVEN', `Error en clean & compile: ${result.error}`);
            vscode.window.showErrorMessage(
                `[MM43] ❌ Falló la compilación de '${project.name}'. Revisa el canal "mm43".`
            );
        }

        return result.success;
    }

    async cleanInstall(project: ProjectConfig, skipTests = true): Promise<boolean> {
        Logger.debug('DEBUG', `cleanInstall invocado para: ${project.name}`);
        const props: Record<string, string> = skipTests ? { 'skipTests': 'true' } : {};

        const cmd = new MavenComand(
            `${project.name}-clean-install`,
            `Clean & Install: ${project.name}`,
            ['clean', 'install', '-U', 'war:exploded'],
            props,
            [],
            project.rootPath
        );

        const valid = await cmd.validate();
        if (!valid) {
            Logger.error('MAVEN', `Directorio de proyecto no existe: ${project.rootPath}`);
            vscode.window.showErrorMessage(
                `[MM43] El directorio del proyecto no existe: ${project.rootPath}`
            );
            return false;
        }

        Logger.section(`Clean & Install: ${project.name}`);
        Logger.info('MAVEN', `📦 Iniciando clean & install para: ${project.name}`);

        Logger.debug('DEBUG', 'Ejecutando comando Maven clean install...');
        const result = await cmd.execute();

        if (result.success) {
            Logger.info('MAVEN', `✅ clean & install completado: ${project.name}`);
            vscode.window.showInformationMessage(
                `[MM43] ✅ '${project.name}' instalado correctamente.`
            );
        } else {
            Logger.error('MAVEN', `Error en clean & install: ${result.error}`);
            vscode.window.showErrorMessage(
                `[MM43] ❌ Falló el install de '${project.name}'. Revisa el canal "mm43".`
            );
        }

        return result.success;
    }

    async cleanPackage(project: ProjectConfig, skipTests = true): Promise<boolean> {
        Logger.debug('DEBUG', `cleanPackage invocado para: ${project.name}`);
        const props: Record<string, string> = skipTests ? { '-DoutputDirectory': 'rutaDestino' } : {};
        const cmd = new MavenComand(
            `${project.name}-clean-package`,
            `Clean & Package: ${project.name}`,
            ['clean', 'package',],
            props,
            [],
            project.rootPath
        );

        const valid = await cmd.validate();
        if (!valid) {
            Logger.error('MAVEN', `Directorio de proyecto no existe: ${project.rootPath}`);
            vscode.window.showErrorMessage(
                `[MM43] El directorio del proyecto no existe: ${project.rootPath}`
            );
            return false;
        }

        Logger.section(`Package WAR: ${project.name}`);
        Logger.info('MAVEN', `📦 Empaquetando WAR para: ${project.name}`);

        Logger.debug('DEBUG', 'Ejecutando comando Maven clean package...');
        const result = await cmd.execute();

        if (result.success) {
            Logger.info('MAVEN', `✅ clean & package completado: ${project.name}`);
        } else {
            Logger.error('MAVEN', `Error en clean & package: ${result.error}`);
            vscode.window.showErrorMessage(
                `[MM43] ❌ Falló el empaquetado de '${project.name}'. Revisa el canal "mm43".`
            );
        }
        return result.success;
    }

    async generarClasspath(project: ProjectConfig): Promise<string> {
        Logger.debug('DEBUG', `generarClasspath invocado para: ${project.name}`);
        const outputFileName = 'classpath.txt';
        const outputPath = path.join(project.rootPath, outputFileName);
        const rutaDeProyecto = project.rootPath;

        const cmd = new MavenComand(
            `${project.name}-generar-classpath`,
            `Generar Classpath: ${project.name}`,
            ['dependency:build-classpath'],
            { 'mdep.outputFile': outputFileName },
            [],
            rutaDeProyecto
        );

        const valid = await cmd.validate();
        if (!valid) {
            Logger.error('MAVEN', `Directorio inexistente: ${project.rootPath}`);
            throw new Error(`Directorio inexistente: ${project.rootPath}`);
        }

        Logger.info('MAVEN', `🔍 Obteniendo classpath para: ${project.name}`);
        Logger.debug('DEBUG', 'Ejecutando dependency:build-classpath...');
        const result = await cmd.execute();

        if (!result.success) {
            Logger.error('MAVEN', `Fallo al ejecutar Maven: ${result.error}`);
            throw new Error(`Fallo al ejecutar Maven: ${result.error}`);
        }

        if (!fs.existsSync(outputPath)) {
            Logger.error('MAVEN', `No se generó el archivo ${outputFileName}`);
            throw new Error(`No se generó el archivo ${outputFileName}`);
        }

        const classpath = fs.readFileSync(outputPath, 'utf8').trim();
        Logger.debug('DEBUG', `Classpath leído (${classpath.length} caracteres)`);

        try {
            fs.unlinkSync(outputPath);
        } catch (e) {
            Logger.warn('MAVEN', `No se pudo eliminar el archivo temporal: ${outputFileName}`);
        }
        return classpath;
    }
}