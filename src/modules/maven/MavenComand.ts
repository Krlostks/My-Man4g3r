import * as vscode from 'vscode';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import { CommandResult, ICommand } from "../../config/types";
import { Logger } from '../logger/Logger';

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

        // Definimos la ejecución en el shell
        const execution = new vscode.ShellExecution('mvnd', args, {
            cwd: this.workingDir ?? (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)
        });

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
        if (this.workingDir && !fs.existsSync(this.workingDir)) {
            return false;
        }
        return true;
    }

    /**
     * Ejecuta el comando Maven usando child_process.
     * Envía los logs en tiempo real al Logger centralizado.
     */
    async execute(): Promise<CommandResult> {
        const argsString = this.buildArgs().join(' ');
        const fullCommand = `mvnd ${argsString}`;

        const options: childProcess.ExecOptions = {
            cwd: this.workingDir ?? (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)
        };

        Logger.info('MAVEN', `Ejecutando: ${fullCommand}`);
        Logger.show();

        return new Promise((resolve) => {
            const child = childProcess.exec(fullCommand, options, (error: childProcess.ExecException | null, stdout: string | Buffer, stderr: string | Buffer) => {
                if (error) {
                    resolve({
                        success: false,
                        salida: stdout.toString(),
                        error: (stderr ? stderr.toString() : error.message)
                    });
                } else {
                    resolve({
                        success: true,
                        salida: stdout.toString()
                    });
                }
            });

            // Enviar logs en tiempo real al Logger centralizado
            child.stdout?.on('data', (data: Buffer | string) => {
                Logger.raw(data.toString());
            });
            child.stderr?.on('data', (data: Buffer | string) => {
                Logger.raw(data.toString());
            });
        });
    }
}