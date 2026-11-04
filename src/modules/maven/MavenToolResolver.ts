import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../../config/ConfigManager';

export type MavenTool = 'auto' | 'mvn' | 'mvnd' | 'wrapper' | 'custom';

export interface MavenExecutable {
    command: string;
    argsPrefix: string[];
    source: MavenTool | 'path';
}

export class MavenToolResolver {
    static resolve(workingDir?: string): MavenExecutable {
        const configured = ConfigManager.getMavenTool();
        const root = workingDir ?? process.cwd();

        if (configured === 'custom') {
            const customPath = this.cleanPath(ConfigManager.getMavenPath());
            if (!customPath) {
                throw new Error('Configure mm43.mavenPath cuando mm43.mavenTool es custom.');
            }
            const resolvedPath = path.isAbsolute(customPath)
                ? customPath
                : path.resolve(root, customPath);
            if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
                throw new Error(`No existe el ejecutable Maven configurado: ${customPath}`);
            }
            return { command: resolvedPath, argsPrefix: [], source: 'custom' };
        }

        const mvnd = process.platform === 'win32' ? 'mvnd.cmd' : 'mvnd';
        const mvn = process.platform === 'win32' ? 'mvn.cmd' : 'mvn';

        if (configured === 'mvnd') {
            return this.requirePathTool(mvnd, 'mvnd');
        }
        if (configured === 'mvn') {
            return this.requirePathTool(mvn, 'mvn');
        }
        if (configured === 'wrapper') {
            const wrapper = this.findWrapper(root);
            if (!wrapper) {
                throw new Error(`No se encontró Maven Wrapper en ${root}.`);
            }
            return wrapper;
        }

        // auto: preferir una herramienta instalada y usar el wrapper como fallback.
        if (this.isOnPath(mvnd)) {
            return { command: mvnd, argsPrefix: [], source: 'mvnd' };
        }
        if (this.isOnPath(mvn)) {
            return { command: mvn, argsPrefix: [], source: 'mvn' };
        }
        const wrapper = this.findWrapper(root);
        if (wrapper) {
            return wrapper;
        }

        throw new Error(
            'No se encontró Maven. Instale mvn/mvnd, agregue Maven al PATH o configure mm43.mavenPath.'
        );
    }

    private static requirePathTool(command: string, label: 'mvn' | 'mvnd'): MavenExecutable {
        if (!this.isOnPath(command)) {
            throw new Error(`La herramienta ${label} no está disponible en PATH.`);
        }
        return { command, argsPrefix: [], source: label };
    }

    private static isOnPath(command: string): boolean {
        const pathEnv = process.env.PATH ?? '';
        const delimiter = process.platform === 'win32' ? ';' : ':';
        const executable = process.platform === 'win32' ? command : command.replace(/\.cmd$/, '');

        return pathEnv.split(delimiter).some(rawDir => {
            const dir = this.cleanPath(rawDir);
            if (!dir) { return false; }
            return fs.existsSync(path.join(dir, executable));
        });
    }

    private static findWrapper(root: string): MavenExecutable | undefined {
        const wrapperName = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
        const wrapperPath = path.resolve(root, wrapperName);
        if (!fs.existsSync(wrapperPath)) {
            return undefined;
        }

        if (process.platform !== 'win32') {
            try {
                if (!fs.statSync(wrapperPath).isFile()) { return undefined; }
            } catch {
                return undefined;
            }
        }

        return { command: wrapperPath, argsPrefix: [], source: 'wrapper' };
    }

    private static cleanPath(value: string): string {
        return value.trim().replace(/^['"]|['"]$/g, '');
    }
}
