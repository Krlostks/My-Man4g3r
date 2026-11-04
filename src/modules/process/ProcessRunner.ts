import { spawn, ChildProcess } from 'child_process';

export interface ProcessResult {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    cancelled: boolean;
}

export interface ProcessOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    signal?: AbortSignal;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
}

/** Ejecuta procesos con ejecutable y argumentos separados. */
export class ProcessRunner {
    static run(executable: string, args: string[] = [], options: ProcessOptions = {}): Promise<ProcessResult> {
        return new Promise((resolve) => {
            const child: ChildProcess = spawn(executable, args, {
                cwd: options.cwd,
                env: options.env ?? process.env,
                windowsHide: true,
                // Windows ejecuta mvn.cmd/mvnd.cmd mediante cmd.exe. Los
                // argumentos siguen viajando separados; no se construye una
                // cadena con cd, && ni interpolación del usuario.
                shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable),
            });

            let stdout = '';
            let stderr = '';
            let settled = false;
            let timedOut = false;
            let cancelled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let abortHandler: (() => void) | undefined;

            const finish = (result: ProcessResult) => {
                if (settled) { return; }
                settled = true;
                if (timer) { clearTimeout(timer); }
                if (abortHandler && options.signal) {
                    options.signal.removeEventListener('abort', abortHandler);
                }
                resolve(result);
            };

            const stop = (reason: 'timeout' | 'cancel') => {
                if (settled) { return; }
                timedOut = reason === 'timeout';
                cancelled = reason === 'cancel';
                child.kill();
            };

            child.stdout?.on('data', (data: Buffer | string) => {
                const value = data.toString();
                stdout += value;
                options.onStdout?.(value);
            });
            child.stderr?.on('data', (data: Buffer | string) => {
                const value = data.toString();
                stderr += value;
                options.onStderr?.(value);
            });
            child.on('error', (error: Error) => {
                stderr += error.message;
                finish({ code: null, signal: null, stdout, stderr, timedOut, cancelled });
            });
            child.on('close', (code, signal) => {
                finish({ code, signal, stdout, stderr, timedOut, cancelled });
            });

            if (options.timeout && options.timeout > 0) {
                timer = setTimeout(() => stop('timeout'), options.timeout);
            }

            if (options.signal) {
                abortHandler = () => stop('cancel');
                if (options.signal.aborted) {
                    abortHandler();
                } else {
                    options.signal.addEventListener('abort', abortHandler, { once: true });
                }
            }
        });
    }
}
