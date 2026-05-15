/**
 * MM43 - Motor de Aplanamiento Cronológico Semántico
 * GitPlumbing.ts - Abstracción de comandos de bajo nivel de Git (plumbing)
 *
 * Encapsula: git rev-list, git update-ref, git symbolic-ref, git commit-tree
 * y demás comandos de fontanería necesarios para manipular la topología del grafo.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { EnrichedCommit, CommitMetadata, Feature } from '../../config/types';
import { VersionVectorEngine } from './VersionVectorEngine';
import { Logger } from '../logger/Logger';

export class GitPlumbing {

    constructor(private readonly workspaceRoot: string) { }

    // ─────────────────────────────────────────────────────────────
    // Utilidad interna: ejecutar comando git
    // ─────────────────────────────────────────────────────────────

    private exec(args: string[], trim = true): Promise<string> {
        return new Promise((resolve, reject) => {
            // Forzar a git a no escapar caracteres no-ASCII en nombres de archivos
            const proc = spawn('git', ['-c', 'core.quotepath=false', ...args], {
                cwd: this.workspaceRoot,
                env: {
                    ...process.env,
                    LC_ALL: 'en_US.UTF-8',
                    LANG: 'en_US.UTF-8'
                }
            });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
            proc.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));

            proc.on('close', (code) => {
                if (code === 0) {
                    resolve(trim ? stdout.trim() : stdout);
                } else {
                    reject(new Error(`git ${args[0]} failed (${code}): ${stderr.trim()}`));
                }
            });

            proc.on('error', (err) => reject(err));
        });
    }

    // ─────────────────────────────────────────────────────────────
    // Información básica
    // ─────────────────────────────────────────────────────────────

    async getCurrentBranch(): Promise<string> {
        try {
            return await this.exec(['rev-parse', '--abbrev-ref', 'HEAD']);
        } catch {
            return 'HEAD detached';
        }
    }

    async getHeadSha(): Promise<string> {
        return this.exec(['rev-parse', 'HEAD']);
    }

    async getShortSha(sha: string): Promise<string> {
        return this.exec(['rev-parse', '--short', sha]);
    }

    /** Verifica si el workspace raíz es un repositorio git válido */
    async isGitRepo(): Promise<boolean> {
        try {
            await this.exec(['rev-parse', '--git-dir']);
            return true;
        } catch {
            return false;
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Topología: rev-list (DAG)
    // ─────────────────────────────────────────────────────────────

    /**
     * Obtiene la lista de commits en orden topológico (DAG).
     * Usa --topo-order para respetar la causalidad sin importar timestamps.
     */
    async getTopoOrderedCommits(from?: string, to: string = 'HEAD'): Promise<EnrichedCommit[]> {
        const range = from ? `${from}..${to}` : to;
        const format = '%H|%h|%s|%an|%ae|%ci';

        try {
            const raw = await this.exec([
                'rev-list',
                '--topo-order',
                `--format=${format}`,
                range
            ]);

            // rev-list --format intercala líneas "commit SHA" con el formato
            // Filtramos líneas que comiencen con un SHA-1 de 40 caracteres seguido de |
            const lines = raw.split('\n').filter(l => /^[a-f0-9]{40}\|/.test(l));

            // Obtenemos los commits que ya están en el servidor para marcarlos
            const branch = await this.getCurrentBranch();
            let remoteCommits = new Set<string>();
            try {
                const remoteRaw = await this.exec(['rev-list', `origin/${branch}`]);
                remoteCommits = new Set(remoteRaw.split('\n').filter(Boolean));
            } catch {
                // Si no hay remoto o rama remota, ignoramos
            }

            const commits: EnrichedCommit[] = [];
            for (const line of lines) {
                const [sha, shortSha, message, author, authorEmail, date] = line.split('|');
                const fullMessage = await this.getCommitBody(sha);
                let metadata = VersionVectorEngine.deserialize(fullMessage);
                
                // Si no hay metadatos en el mensaje, buscamos en git notes
                if (!metadata) {
                    const note = await this.getCommitNote(sha);
                    if (note) {
                        metadata = VersionVectorEngine.deserialize(note);
                    }
                }

                const isOnServer = remoteCommits.has(sha);

                commits.push({ sha, shortSha, message, author, authorEmail, date, metadata, isOnServer });
            }
            return commits;
        } catch (err) {
            Logger.error('GIT', `getTopoOrderedCommits failed: ${(err as Error).message}`);
            return [];
        }
    }

    /** Obtiene el mensaje completo (subject + body) de un commit */
    async getCommitBody(sha: string): Promise<string> {
        return this.exec(['log', '-1', '--format=%B', sha]);
    }

    /** Obtiene archivos modificados por un commit */
    async getCommitFiles(sha: string): Promise<string[]> {
        const raw = await this.exec(['diff-tree', '--no-commit-id', '-r', '--name-only', sha]);
        return raw.split('\n').filter(Boolean);
    }

    // ─────────────────────────────────────────────────────────────
    // Gestión de refs/features/ (Namespace de topología)
    // ─────────────────────────────────────────────────────────────

    /**
     * Crea los punteros de inicio y head para una nueva feature.
     * refs/features/[ID]/start → commit base actual (HEAD)
     * refs/features/[ID]/head  → commit base actual (HEAD)
     */
    async createFeatureRefs(featureId: string): Promise<void> {
        const headSha = await this.getHeadSha();
        await this.exec(['update-ref', `refs/features/${featureId}/start`, headSha]);
        await this.exec(['update-ref', `refs/features/${featureId}/head`, headSha]);
        await this.setFeatureStatus(featureId, 'open');
        Logger.info('GIT', `Feature refs created for '${featureId}' at ${headSha.substring(0, 8)}`);
    }

    /** Establece el estado de una feature (open/closed) usando un ref simbólico falso o archivo */
    async setFeatureStatus(featureId: string, status: 'open' | 'closed'): Promise<void> {
        // Almacenamos el status en un archivo de configuración dentro de .git/mm43_features/
        try {
            const gitDir = await this.exec(['rev-parse', '--git-dir']);
            const statusDir = path.resolve(this.workspaceRoot, gitDir, 'mm43_features');
            if (!fs.existsSync(statusDir)) {
                fs.mkdirSync(statusDir, { recursive: true });
            }
            fs.writeFileSync(path.join(statusDir, `${featureId}.status`), status);
        } catch (err) {
            Logger.error('GIT', `Error al escribir status de feature: ${(err as Error).message}`);
        }
    }

    /** Obtiene el estado de una feature */
    async getFeatureStatus(featureId: string): Promise<'open' | 'closed' | undefined> {
        try {
            const gitDir = await this.exec(['rev-parse', '--git-dir']);
            const statusFile = path.resolve(this.workspaceRoot, gitDir, 'mm43_features', `${featureId}.status`);
            if (fs.existsSync(statusFile)) {
                return fs.readFileSync(statusFile, 'utf8').trim() as 'open' | 'closed';
            }
            return undefined;
        } catch {
            return undefined;
        }
    }

    /** Actualiza el puntero head de la feature al commit actual */
    async advanceFeatureHead(featureId: string, newSha?: string): Promise<void> {
        const sha = newSha ?? await this.getHeadSha();
        await this.exec(['update-ref', `refs/features/${featureId}/head`, sha]);
        Logger.info('GIT', `Feature '${featureId}' head advanced to ${sha.substring(0, 8)}`);
    }

    /** Resuelve una referencia de feature a su SHA */
    async resolveFeatureRef(featureId: string, pointer: 'start' | 'head'): Promise<string | undefined> {
        try {
            return await this.exec(['rev-parse', `refs/features/${featureId}/${pointer}`]);
        } catch {
            return undefined;
        }
    }

    /** Lista todas las features registradas en refs/features/ */
    async listAllFeatures(): Promise<string[]> {
        try {
            const raw = await this.exec(['for-each-ref', '--format=%(refname)', 'refs/features/']);
            const refs = raw.split('\n').filter(Boolean);
            // Extraer IDs únicos de refs/features/[ID]/start y refs/features/[ID]/head
            const ids = new Set<string>();
            for (const ref of refs) {
                const match = ref.match(/refs\/features\/([^/]+)\//);
                if (match) { ids.add(match[1]); }
            }
            return Array.from(ids);
        } catch {
            return [];
        }
    }

    /** Elimina los refs de una feature (tras integración exitosa) */
    async deleteFeatureRefs(featureId: string): Promise<void> {
        try {
            await this.exec(['update-ref', '-d', `refs/features/${featureId}/start`]);
            await this.exec(['update-ref', '-d', `refs/features/${featureId}/head`]);
            
            // Clean up status file
            const gitDir = await this.exec(['rev-parse', '--git-dir']);
            const statusFile = path.resolve(this.workspaceRoot, gitDir, 'mm43_features', `${featureId}.status`);
            if (fs.existsSync(statusFile)) {
                fs.unlinkSync(statusFile);
            }
            
            Logger.info('GIT', `Feature refs deleted for '${featureId}'`);
        } catch (err) {
            Logger.warn('GIT', `Could not delete refs for '${featureId}': ${(err as Error).message}`);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Notas de Git (Mapeo retrospectivo)
    // ─────────────────────────────────────────────────────────────

    /**
     * Añade o actualiza una nota de Git en un commit con metadatos MM43
     */
    async addCommitNote(sha: string, metadata: CommitMetadata): Promise<void> {
        const trailer = VersionVectorEngine.serialize(metadata);
        await this.exec(['notes', 'add', '-f', '-m', trailer, sha]);
        Logger.info('GIT', `Note added to commit ${sha.substring(0, 8)} for feature ${metadata.featureId}`);
    }

    /** Obtiene metadatos de un commit desde git notes */
    async getCommitNote(sha: string): Promise<string | undefined> {
        try {
            return await this.exec(['notes', 'show', sha]);
        } catch {
            return undefined;
        }
    }

    /** Elimina los metadatos de un commit en git notes */
    async removeCommitNote(sha: string): Promise<void> {
        try {
            await this.exec(['notes', 'remove', sha]);
        } catch {
            // Ignorar si no había nota
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Commits Locales Huérfanos
    // ─────────────────────────────────────────────────────────────

    /**
     * Retorna los commits locales (origin/current..HEAD) que no están asignados a ninguna feature
     */
    async getOrphanCommits(): Promise<EnrichedCommit[]> {
        const branch = await this.getCurrentBranch();
        try {
            // Revisamos si existe un upstream configurado
            await this.exec(['rev-parse', '--verify', `origin/${branch}`]);
        } catch {
            // Si no hay upstream, consideramos todos los commits desde el inicio del proyecto?
            // Por seguridad, mejor devolvemos una lista vacía o usamos una heurística distinta si es el primer push.
            // Para este rediseño, asumiremos que se necesita un upstream (o compararemos con otro remoto por defecto).
            return []; 
        }

        const commits = await this.getTopoOrderedCommits(`origin/${branch}`, 'HEAD');
        const orphans: EnrichedCommit[] = [];

        for (const c of commits) {
            // Buscar metadatos en el cuerpo del commit o en notas
            let metadata = c.metadata;
            if (!metadata) {
                const note = await this.getCommitNote(c.sha);
                if (note) {
                    metadata = VersionVectorEngine.deserialize(note);
                }
            }

            if (!metadata || !metadata.featureId) {
                orphans.push(c);
            }
        }
        return orphans;
    }

    // ─────────────────────────────────────────────────────────────
    // Sincronización (Push/Pull lineal)
    // ─────────────────────────────────────────────────────────────

    /**
     * Hace fetch y rebase del remoto para mantener el historial lineal
     */
    async syncDown(): Promise<void> {
        Logger.info('GIT', 'Iniciando pull con rebase...');
        await this.exec(['pull', '--rebase']);
        Logger.info('GIT', 'Sincronización bajada completada.');
    }

    /**
     * Sube los commits locales al servidor.
     */
    async syncUp(): Promise<void> {
        Logger.info('GIT', 'Iniciando push...');
        // Verificamos si hay commits huérfanos antes de subir
        const orphans = await this.getOrphanCommits();
        if (orphans.length > 0) {
            throw new Error(`Hay ${orphans.length} commit(s) local(es) no asignado(s) a una feature. Asígnalos antes de subir.`);
        }
        await this.exec(['push']);
        Logger.info('GIT', 'Subida completada.');
    }

    // ─────────────────────────────────────────────────────────────
    // Operaciones de aplanamiento (rebase automatizado)
    // ─────────────────────────────────────────────────────────────

    /**
     * Ejecuta un rebase interactivo automático para mover los commits
     * de la feature al frente del tronco (HEAD).
     *
     * Equivale a: git rebase --onto <trunkHead> <featureStart> HEAD
     */
    async rebaseFeatureOntoTrunk(featureId: string, trunkHead: string): Promise<void> {
        const startSha = await this.resolveFeatureRef(featureId, 'start');
        if (!startSha) {
            throw new Error(`No se encontró refs/features/${featureId}/start`);
        }

        Logger.info('GIT', `Rebasing feature '${featureId}' onto trunk ${trunkHead.substring(0, 8)}`);
        await this.exec(['rebase', '--onto', trunkHead, startSha, 'HEAD']);
    }

    /**
     * Crea un commit enriquecido con metadatos MM43 (Vector de Versión).
     * Usa git commit-tree para construir el nodo sin afectar el staging area.
     *
     * Retorna el SHA del nuevo commit.
     */
    async createEnrichedCommit(
        treeSha: string,
        parentSha: string,
        message: string,
        metadata: CommitMetadata
    ): Promise<string> {
        const trailer = VersionVectorEngine.serialize(metadata);
        const fullMessage = `${message}\n\n${trailer}`;

        // Usamos una variable de entorno temporal para pasar el mensaje
        const sha = await this.execWithEnv(
            ['commit-tree', treeSha, '-p', parentSha, '-m', fullMessage],
            {}
        );
        return sha;
    }

    private execWithEnv(args: string[], env: Record<string, string>): Promise<string> {
        return new Promise((resolve, reject) => {
            const proc = spawn('git', ['-c', 'core.quotepath=false', ...args], {
                cwd: this.workspaceRoot,
                env: {
                    ...process.env,
                    ...env,
                    LC_ALL: 'en_US.UTF-8',
                    LANG: 'en_US.UTF-8'
                }
            });

            let stdout = '';
            let stderr = '';
            proc.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
            proc.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));

            proc.on('close', (code) => {
                if (code === 0) { resolve(stdout.trim()); }
                else { reject(new Error(`git commit-tree failed: ${stderr.trim()}`)); }
            });
            proc.on('error', reject);
        });
    }

    /** Obtiene el tree SHA del HEAD actual (para commit-tree) */
    async getHeadTree(): Promise<string> {
        return this.exec(['rev-parse', 'HEAD^{tree}']);
    }

    // ─────────────────────────────────────────────────────────────
    // symbolic-ref: contexto de tarea activa
    // ─────────────────────────────────────────────────────────────

    /** Almacena el featureId activo en un symbolic-ref especial o archivo fallback */
    async setActiveFeature(featureId: string): Promise<void> {
        try {
            await this.exec([
                'symbolic-ref',
                'MM43_ACTIVE_FEATURE',
                `refs/features/${featureId}/head`
            ]);
        } catch {
            Logger.warn('GIT', 'symbolic-ref no disponible, usando archivo de estado en .git/');
            try {
                const gitDir = await this.exec(['rev-parse', '--git-dir']);
                const stateFile = path.resolve(this.workspaceRoot, gitDir, 'MM43_ACTIVE_FEATURE');
                fs.writeFileSync(stateFile, `refs/features/${featureId}/head`);
            } catch (err) {
                Logger.error('GIT', `Error al escribir fallback de feature activa: ${(err as Error).message}`);
            }
        }
    }

    /** Obtiene el featureId activo, si existe */
    async getActiveFeature(): Promise<string | undefined> {
        let ref: string;
        try {
            ref = await this.exec(['symbolic-ref', 'MM43_ACTIVE_FEATURE']);
        } catch {
            try {
                const gitDir = await this.exec(['rev-parse', '--git-dir']);
                const stateFile = path.resolve(this.workspaceRoot, gitDir, 'MM43_ACTIVE_FEATURE');
                if (fs.existsSync(stateFile)) {
                    ref = fs.readFileSync(stateFile, 'utf8').trim();
                } else {
                    return undefined;
                }
            } catch {
                return undefined;
            }
        }
        const match = ref.match(/refs\/features\/([^/]+)\//);
        return match ? match[1] : undefined;
    }

    // ─────────────────────────────────────────────────────────────
    // Estado limpio del workspace
    // ─────────────────────────────────────────────────────────────

    async hasUncommittedChanges(): Promise<boolean> {
        const status = await this.exec(['status', '--porcelain']);
        return status.length > 0;
    }

    async getStatus(): Promise<string> {
        return this.exec(['status', '--short'], false);
    }

    async getStagedFiles(): Promise<string[]> {
        const raw = await this.exec(['diff', '--cached', '--name-only']);
        return raw.split('\n').filter(Boolean);
    }

    // ─────────────────────────────────────────────────────────────
    // Gestión Detallada de Archivos y Stashes
    // ─────────────────────────────────────────────────────────────

    async getDetailedStatus(): Promise<{ staged: import('../../config/types').GitFileStatus[], unstaged: import('../../config/types').GitFileStatus[], untracked: import('../../config/types').GitFileStatus[] }> {
        const raw = await this.exec(['status', '--porcelain'], false);
        const lines = raw.split('\n').filter(Boolean);
        
        const staged: import('../../config/types').GitFileStatus[] = [];
        const unstaged: import('../../config/types').GitFileStatus[] = [];
        const untracked: import('../../config/types').GitFileStatus[] = [];

        for (const line of lines) {
            const indexStatus = line[0];
            const workTreeStatus = line[1];
            const file = line.substring(3).trim();

            if (indexStatus === '?' && workTreeStatus === '?') {
                untracked.push({ path: file, status: '??' });
                continue;
            }

            if (indexStatus !== ' ' && indexStatus !== '?') {
                staged.push({ path: file, status: indexStatus });
            }

            if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
                unstaged.push({ path: file, status: workTreeStatus });
            }
        }

        return { staged, unstaged, untracked };
    }

    async getStashList(): Promise<import('../../config/types').GitStash[]> {
        try {
            const raw = await this.exec(['stash', 'list']);
            const lines = raw.split('\n').filter(Boolean);
            return lines.map(line => {
                const match = line.match(/^stash@\{(\d+)\}: (.*)$/);
                if (match) {
                    return { index: parseInt(match[1]), message: match[2] };
                }
                return { index: 0, message: line };
            }).filter(s => s.message);
        } catch {
            return [];
        }
    }

    async stageFile(file: string): Promise<void> {
        await this.exec(['add', file]);
    }

    async unstageFile(file: string): Promise<void> {
        await this.exec(['reset', 'HEAD', '--', file]);
    }

    async discardChanges(file: string): Promise<void> {
        await this.exec(['checkout', '--', file]);
        // Si es untracked, checkout falla, deberíamos usar clean
        // Para simplificar, si falla intentamos clean
        try {
            const status = await this.getDetailedStatus();
            if (status.untracked.find(u => u.path === file)) {
                await this.exec(['clean', '-fd', file]);
            }
        } catch {}
    }

    async applyStash(index: number): Promise<void> {
        await this.exec(['stash', 'apply', `stash@{${index}}`]);
    }

    async createStash(message: string): Promise<void> {
        await this.exec(['stash', 'save', message]);
    }

    async stageAll(): Promise<void> {
        await this.exec(['add', '.']);
    }

    async commitGeneric(message: string, metadata?: CommitMetadata): Promise<string> {
        let fullMessage = message;
        if (metadata) {
            const trailer = VersionVectorEngine.serialize(metadata);
            fullMessage += `\n\n${trailer}`;
        }
        await this.exec(['commit', '-m', fullMessage]);
        return this.getHeadSha();
    }

    async commitExists(sha: string): Promise<boolean> {
        try {
            await this.exec(['rev-parse', '--verify', sha]);
            return true;
        } catch {
            return false;
        }
    }
}
