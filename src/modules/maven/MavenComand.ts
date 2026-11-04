import * as vscode from 'vscode';
import * as fs from 'fs';
import { CommandResult, ICommand } from "../../config/types";
import { Logger } from '../logger/Logger';
import { ProcessRunner } from '../process/ProcessRunner';
import { MavenToolResolver } from './MavenToolResolver';

export class MavenComand implements ICommand {
    constructor(
        public id: string,
        public name: string,
        public phases: string[],
        public properties: Record<string, string> = {},
        public profiles: string[] = [],
        public workingDir?: string
    ) { }

    private buildArgs(): string[] {
        const args: string[] = [...this.phases];

        // Forzar encoding UTF-8 en todos los comandos Maven
        args.push('-Dfile.encoding=UTF-8');

        for (const [key, value] of Object.entries(this.properties)) {
            args.push(`-D${key}=${value}`);
        }

        // Añadir perfiles (-Pprofile1,profile2)
        if (this.profiles && this.profiles.length > 0) {
            args.push(`-P${this.profiles.join(',')}`);
        }

        return args;
    }

    /**
     * Crea un objeto Task de VS Code para que el comando sea rastreable en la UI.
     */
    toTask(): vscode.Task {
        const args = this.buildArgs();
        const executable = MavenToolResolver.resolve(this.workingDir);
        const execution = new vscode.ProcessExecution(
            executable.command,
            [...executable.argsPrefix, ...args],
            { cwd: this.workingDir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath }
        );

        // Instanciamos el Task
        const task = new vscode.Task(
            { type: 'maven', id: this.id },
            vscode.TaskScope.Workspace,
            this.name,
            'maven', // Fuente de la tarea para VS Code
            execution
        );

        // Configuración de visualización en la terminal
        task.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Dedicated,
            showReuseMessage: false,
            clear: true
        };

        return task;
    }

    /**
     * Valida si el directorio de trabajo existe antes de ejecutar.
     */
    async validate(): Promise<boolean> {
        if (this.workingDir && (!fs.existsSync(this.workingDir) || !fs.statSync(this.workingDir).isDirectory())) {
            return false;
        }
        return true;
    }

    /**
     * Ejecuta el comando Maven usando child_process.
     * Envía los logs en tiempo real al Logger centralizado.
     */
    async execute(): Promise<CommandResult> {
        try {
            const executable = MavenToolResolver.resolve(this.workingDir);
            const args = [...executable.argsPrefix, ...this.buildArgs()];
            const displayCommand = [executable.command, ...args].join(' ');
            const cwd = this.workingDir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

            Logger.info('MAVEN', `Usando ${executable.source}: ${displayCommand}`);
            Logger.show();

            const result = await ProcessRunner.run(executable.command, args, {
                cwd,
                timeout: 180000,
                onStdout: data => Logger.raw(data),
                onStderr: data => Logger.raw(data),
            });

            if (result.code === 0) {
                return { success: true, salida: result.stdout };
            }

            const reason = result.timedOut
                ? 'Maven excedió el tiempo máximo de ejecución.'
                : result.cancelled
                    ? 'La ejecución de Maven fue cancelada.'
                    : result.stderr || `Maven terminó con código ${result.code}`;
            Logger.error('MAVEN', reason);
            return { success: false, salida: result.stdout, error: reason };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            Logger.error('MAVEN', message);
            return { success: false, salida: '', error: message };
        }
    }
}