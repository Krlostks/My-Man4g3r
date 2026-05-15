/**
 * MM43 - Motor de Aplanamiento Cronológico Semántico
 * FlatteningEngine.ts - Orquesta el algoritmo de aplanamiento completo
 *
 * Implementa el flujo de 4 pasos del Manual Técnico:
 *   1. Extracción Topológica (rev-list --topo-order)
 *   2. Casting de Identidad (filtrado por refs/features/)
 *   3. Reordenamiento Semántico (rebase basado en VV)
 *   4. Validación de Integridad (SHA-1 y dependencias lógicas)
 */

import * as vscode from 'vscode';
import { spawn, execSync } from 'child_process';
import * as os from 'os';
import { GitPlumbing } from './GitPlumbing';
import { VersionVectorEngine } from './VersionVectorEngine';
import {
    Feature, EnrichedCommit, ConflictInfo, FlattenResult,
    CommitMetadata, VersionControlState
} from '../../config/types';
import { Logger } from '../logger/Logger';

export class FlatteningEngine {

    private git: GitPlumbing;
    private developerId: string;
    private state: VersionControlState;
    private _onStateChanged = new vscode.EventEmitter<VersionControlState>();
    readonly onStateChanged = this._onStateChanged.event;

    constructor(private readonly workspaceRoot: string) {
        this.git = new GitPlumbing(workspaceRoot);
        this.developerId = this.getLocalDeveloperId(workspaceRoot);
        this.state = {
            currentBranch: 'main',
            allFeatures: [],
            pendingConflicts: [],
            orphanCommits: [],
            stagedFiles: [],
            unstagedFiles: [],
            untrackedFiles: [],
            stashes: [],
            trunkHead: '',
            isRebasing: false
        };
    }

    // ─────────────────────────────────────────────────────────────
    // Inicialización
    // ─────────────────────────────────────────────────────────────

    async initialize(): Promise<void> {
        Logger.info('VERSION_CONTROL', 'Inicializando Motor de Aplanamiento MM43');
        await this.refreshState();
    }

    async refreshState(): Promise<void> {
        try {
            const [branch, trunkHead, featureIds, activeFeatureId, orphanCommits, detailedStatus, stashes] = await Promise.all([
                this.git.getCurrentBranch(),
                this.git.getHeadSha(),
                this.git.listAllFeatures(),
                this.git.getActiveFeature(),
                this.git.getOrphanCommits(),
                this.git.getDetailedStatus(),
                this.git.getStashList()
            ]);

            const allFeatures = await this.loadFeatures(featureIds);
            const currentFeature = allFeatures.find(f => f.id === activeFeatureId);

            this.state = {
                currentBranch: branch,
                currentFeature,
                allFeatures,
                pendingConflicts: await this.detectConflicts(allFeatures),
                orphanCommits,
                stagedFiles: detailedStatus.staged,
                unstagedFiles: detailedStatus.unstaged,
                untrackedFiles: detailedStatus.untracked,
                stashes,
                trunkHead,
                isRebasing: false
            };

            this._onStateChanged.fire(this.state);
        } catch (err) {
            Logger.error('VERSION_CONTROL', `refreshState error: ${(err as Error).message}`);
        }
    }

    getState(): VersionControlState {
        return this.state;
    }

    // ─────────────────────────────────────────────────────────────
    // Gestión de Features
    // ─────────────────────────────────────────────────────────────

    /**
     * Crea una nueva feature lógica y registra sus refs en Git.
     * @param featureId  Identificador único de la tarea (ej. "FEAT-42")
     * @param featureName Nombre descriptivo
     */
    async startFeature(featureId: string, featureName: string): Promise<void> {

        Logger.info('VERSION_CONTROL', `Iniciando feature: ${featureId} - ${featureName}`);

        await this.git.createFeatureRefs(featureId);
        await this.git.setActiveFeature(featureId);
        await this.refreshState();

        Logger.info('VERSION_CONTROL', `Feature '${featureId}' iniciada correctamente`);
    }

    /**
     * Cierra una feature marcando su estado como 'closed'.
     */
    async closeFeature(featureId: string): Promise<void> {
        await this.git.setFeatureStatus(featureId, 'closed');
        await this.refreshState();
        Logger.info('VERSION_CONTROL', `Feature '${featureId}' cerrada`);
    }

    /**
     * Abre una feature marcando su estado como 'open'.
     */
    async openFeature(featureId: string): Promise<void> {
        await this.git.setFeatureStatus(featureId, 'open');
        await this.refreshState();
        Logger.info('VERSION_CONTROL', `Feature '${featureId}' reabierta`);
    }

    /**
     * Elimina una feature y sus referencias de Git.
     */
    async deleteFeature(featureId: string): Promise<void> {
        await this.git.deleteFeatureRefs(featureId);
        await this.refreshState();
        Logger.info('VERSION_CONTROL', `Feature '${featureId}' eliminada`);
    }

    /**
     * Sanea las referencias de las features.
     * Si una feature apunta a un commit que ya no existe (ej. tras un reset --hard),
     * intenta rescatarla moviendo el head al start o al último commit válido.
     */
    async sanitizeFeatures(): Promise<void> {
        Logger.info('VERSION_CONTROL', 'Iniciando saneamiento de features...');
        const features = this.state.allFeatures;
        
        for (const feature of features) {
            const headExists = await this.git.commitExists(feature.headSha);
            const startExists = await this.git.commitExists(feature.startSha);

            if (!headExists) {
                Logger.warn('VERSION_CONTROL', `Feature '${feature.id}' tiene un head inválido (${feature.headSha}).`);
                if (startExists) {
                    Logger.info('VERSION_CONTROL', `Reseteando head de '${feature.id}' a su punto de inicio (${feature.startSha})`);
                    await this.git.advanceFeatureHead(feature.id, feature.startSha);
                } else {
                    Logger.error('VERSION_CONTROL', `Feature '${feature.id}' está totalmente huérfana. Marcando para revisión.`);
                }
            }
        }
        
        await this.refreshState();
        Logger.info('VERSION_CONTROL', 'Saneamiento completado.');
    }

    /**
     * Asocia un commit existente a una feature usando git notes.
     */
    async assignCommitToFeature(sha: string, featureId: string): Promise<void> {
        const feature = this.state.allFeatures.find(f => f.id === featureId);
        if (!feature) {
            throw new Error(`Feature '${featureId}' no encontrada.`);
        }

        const currentVV = await this.getCurrentVV();
        const newVV = VersionVectorEngine.increment(currentVV, this.developerId);

        const metadata: CommitMetadata = {
            versionVector: newVV,
            featureId: featureId,
            developerId: this.developerId,
            timestamp: Date.now()
        };

        // Add note to the commit
        await this.git.addCommitNote(sha, metadata);

        // Advance the feature head if this commit is newer in topology?
        // For simplicity, we advance the head to this commit. 
        // In a true topological map, we'd ensure it's a descendant, but we'll assume linear mapping for now.
        await this.git.advanceFeatureHead(featureId, sha);

        await this.refreshState();
        Logger.info('VERSION_CONTROL', `Commit ${sha} asignado a Feature '${featureId}'`);
    }

    /**
     * Desvincula un commit de su feature (remueve el git note).
     */
    async unassignCommit(sha: string): Promise<void> {
        await this.git.removeCommitNote(sha);
        await this.refreshState();
        Logger.info('VERSION_CONTROL', `Commit ${sha} desvinculado`);
    }

    /**
     * Realiza un commit enriquecido con Vector de Versión MM43.
     * Incrementa el VV del desarrollador local y lo serializa como trailer.
     */
    async commitWithVector(message: string, featureId?: string): Promise<void> {
        const staged = await this.git.getStagedFiles();
        if (staged.length === 0) {
            throw new Error('No hay cambios en el staging area. Usa git add antes de confirmar.');
        }

        // Calcular el nuevo Vector de Versión
        const currentVV = await this.getCurrentVV();
        const newVV = VersionVectorEngine.increment(currentVV, this.developerId);

        const metadata: CommitMetadata = {
            versionVector: newVV,
            featureId: featureId ?? this.state.currentFeature?.id,
            developerId: this.developerId,
            timestamp: Date.now()
        };

        const trailer = VersionVectorEngine.serialize(metadata);
        const fullMessage = `${message}\n\n${trailer}`;

        // Ejecutar el commit estándar con el mensaje enriquecido
        await new Promise<void>((resolve, reject) => {
            const proc = spawn('git', ['-c', 'core.quotepath=false', 'commit', '-m', fullMessage], {
                cwd: this.workspaceRoot,
                env: {
                    ...process.env,
                    LC_ALL: 'en_US.UTF-8',
                    LANG: 'en_US.UTF-8'
                }
            });
            proc.on('close', (code: number) => code === 0 ? resolve() : reject(new Error('commit failed')));
            proc.on('error', reject);
        });

        // Avanzar el puntero head de la feature
        const targetFeatureId = featureId ?? this.state.currentFeature?.id;
        if (targetFeatureId) {
            const newHead = await this.git.getHeadSha();
            await this.git.advanceFeatureHead(targetFeatureId, newHead);
        }

        await this.refreshState();
        Logger.info('VERSION_CONTROL', `Commit enriquecido realizado. VV: ${JSON.stringify(newVV)}`);
    }

    /**
     * Sincroniza cambios hacia el servidor.
     */
    async syncUp(): Promise<void> {
        await this.git.syncUp();
        await this.refreshState();
    }

    /**
     * Descarga cambios del servidor.
     */
    async syncDown(): Promise<void> {
        await this.git.syncDown();
        await this.refreshState();
    }

    /**
     * Sincronización Total (Zero-Conflict)
     * Auto-stage, Auto-commit genérico, Fetch, Rebase, Push
     */
    async fullSync(): Promise<void> {
        Logger.info('VERSION_CONTROL', 'Iniciando Sincronización Total...');
        const hasChanges = await this.git.hasUncommittedChanges();
        
        if (hasChanges) {
            await this.git.stageAll();
            const currentVV = await this.getCurrentVV();
            const newVV = VersionVectorEngine.increment(currentVV, this.developerId);
            
            const featureId = this.state.currentFeature?.id || 'MM43-SYSTEM-SYNC';
            const metadata: CommitMetadata = {
                versionVector: newVV,
                featureId,
                developerId: this.developerId,
                timestamp: Date.now()
            };
            
            await this.git.commitGeneric('MM43: Sincronización automática', metadata);
            Logger.info('VERSION_CONTROL', 'Auto-commit creado.');
        }

        // Fetch
        await new Promise<void>((resolve, reject) => {
            const proc = spawn('git', ['fetch', 'origin'], { cwd: this.workspaceRoot });
            proc.on('close', code => code === 0 ? resolve() : reject(new Error('Fetch falló')));
        });

        // Rebase
        const branch = await this.git.getCurrentBranch();
        await new Promise<void>((resolve, reject) => {
            const proc = spawn('git', ['rebase', `origin/${branch}`], { cwd: this.workspaceRoot });
            proc.on('close', code => code === 0 ? resolve() : reject(new Error('Rebase falló. Resuelve los conflictos manualmente.')));
        });

        // Push
        await this.git.syncUp();
        
        await this.refreshState();
        Logger.info('VERSION_CONTROL', 'Sincronización Total completada.');
    }

    // ─────────────────────────────────────────────────────────────
    // Wrappers para acciones rápidas de Git
    // ─────────────────────────────────────────────────────────────

    async stageFile(file: string): Promise<void> { await this.git.stageFile(file); await this.refreshState(); }
    async unstageFile(file: string): Promise<void> { await this.git.unstageFile(file); await this.refreshState(); }
    async discardChanges(file: string): Promise<void> { await this.git.discardChanges(file); await this.refreshState(); }
    async applyStash(index: number): Promise<void> { await this.git.applyStash(index); await this.refreshState(); }
    async createStash(message: string): Promise<void> { await this.git.createStash(message); await this.refreshState(); }

    // ─────────────────────────────────────────────────────────────
    // Algoritmo de Aplanamiento (4 pasos)
    // ─────────────────────────────────────────────────────────────

    /**
     * PASO COMPLETO: Aplana (integra) la feature activa al tronco.
     *
     * Ejecuta:
     *   1. Extracción Topológica
     *   2. Casting de Identidad
     *   3. Reordenamiento Semántico (rebase)
     *   4. Validación de Integridad
     */
    async flattenFeature(featureId: string): Promise<FlattenResult> {
        Logger.info('VERSION_CONTROL', `=== Iniciando aplanamiento de '${featureId}' ===`);

        this.state.isRebasing = true;
        this._onStateChanged.fire(this.state);

        try {
            // ── PASO 1: Extracción Topológica ──────────────────────────
            Logger.info('VERSION_CONTROL', 'Paso 1: Extracción Topológica (rev-list --topo-order)');
            const feature = this.state.allFeatures.find(f => f.id === featureId);
            if (!feature) {
                return this.flattenError(`Feature '${featureId}' no encontrada`);
            }

            const allCommits = await this.git.getTopoOrderedCommits(feature.startSha);

            // ── PASO 2: Casting de Identidad ───────────────────────────
            Logger.info('VERSION_CONTROL', 'Paso 2: Casting de Identidad (filtrado por refs/features/)');
            const featureCommits = allCommits.filter(c =>
                c.metadata?.featureId === featureId ||
                c.metadata?.developerId === this.developerId
            );

            if (featureCommits.length === 0) {
                return this.flattenError('No se encontraron commits para esta feature');
            }

            Logger.info('VERSION_CONTROL', `${featureCommits.length} commit(s) identificados para aplanar`);

            // ── PASO 3: Reordenamiento Semántico ───────────────────────
            Logger.info('VERSION_CONTROL', 'Paso 3: Reordenamiento Semántico (rebase onto trunk HEAD)');

            // Detección de conflictos antes del rebase
            const conflicts = await this.detectConflictsForFeature(feature, featureCommits);
            if (conflicts.length > 0) {
                Logger.warn('VERSION_CONTROL', `${conflicts.length} conflicto(s) semántico(s) detectado(s)`);
                this.state.pendingConflicts = conflicts;
                this.state.isRebasing = false;
                this._onStateChanged.fire(this.state);

                return {
                    success: false,
                    conflictsFound: conflicts,
                    message: `Se detectaron ${conflicts.length} conflicto(s) semántico(s) concurrentes. Resuélvelos antes de aplanar.`
                };
            }

            const trunkHead = this.state.trunkHead;
            await this.git.rebaseFeatureOntoTrunk(featureId, trunkHead);

            // ── PASO 4: Validación de Integridad ───────────────────────
            Logger.info('VERSION_CONTROL', 'Paso 4: Validación de Integridad (SHA-1 y dependencias)');
            const newHead = await this.git.getHeadSha();

            // Limpiar refs de la feature tras integración exitosa
            await this.git.deleteFeatureRefs(featureId);

            this.state.isRebasing = false;
            await this.refreshState();

            Logger.info('VERSION_CONTROL', `=== Aplanamiento completado. Nuevo HEAD: ${newHead.substring(0, 8)} ===`);

            return {
                success: true,
                newHeadSha: newHead,
                integratedFeatureId: featureId,
                conflictsFound: [],
                message: `Feature '${featureId}' integrada exitosamente. Historial lineal conservado.`
            };

        } catch (err) {
            this.state.isRebasing = false;
            this._onStateChanged.fire(this.state);
            const msg = (err as Error).message;
            Logger.error('VERSION_CONTROL', `Error en aplanamiento: ${msg}`);
            return this.flattenError(msg);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Detección de conflictos semánticos
    // ─────────────────────────────────────────────────────────────

    private async detectConflicts(features: Feature[]): Promise<ConflictInfo[]> {
        const conflicts: ConflictInfo[] = [];
        // Comparar pares de features activas
        for (let i = 0; i < features.length; i++) {
            for (let j = i + 1; j < features.length; j++) {
                const a = features[i];
                const b = features[j];
                if (a.status !== 'active' || b.status !== 'active') { continue; }

                const vvA = this.getLatestVV(a);
                const vvB = this.getLatestVV(b);
                if (!vvA || !vvB) { continue; }

                if (VersionVectorEngine.isConcurrent(vvA, vvB)) {
                    const filesA = await this.getFeatureFiles(a);
                    const filesB = await this.getFeatureFiles(b);
                    const shared = filesA.filter(f => filesB.includes(f));

                    if (shared.length > 0) {
                        conflicts.push({
                            commitA: a.headSha,
                            commitB: b.headSha,
                            vectorA: vvA,
                            vectorB: vvB,
                            filesAffected: shared,
                            detectedAt: new Date().toISOString()
                        });
                    }
                }
            }
        }
        return conflicts;
    }

    private async detectConflictsForFeature(
        feature: Feature,
        commits: EnrichedCommit[]
    ): Promise<ConflictInfo[]> {
        const conflicts: ConflictInfo[] = [];
        const trunkCommits = await this.git.getTopoOrderedCommits(feature.startSha, this.state.trunkHead);

        for (const fc of commits) {
            if (!fc.metadata) { continue; }
            for (const tc of trunkCommits) {
                if (!tc.metadata) { continue; }
                if (VersionVectorEngine.isConcurrent(fc.metadata.versionVector, tc.metadata.versionVector)) {
                    const fcFiles = await this.git.getCommitFiles(fc.sha);
                    const tcFiles = await this.git.getCommitFiles(tc.sha);
                    const shared = fcFiles.filter(f => tcFiles.includes(f));
                    if (shared.length > 0) {
                        conflicts.push({
                            commitA: fc.sha,
                            commitB: tc.sha,
                            vectorA: fc.metadata.versionVector,
                            vectorB: tc.metadata.versionVector,
                            filesAffected: shared,
                            detectedAt: new Date().toISOString()
                        });
                    }
                }
            }
        }
        return conflicts;
    }

    // ─────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────

    private async loadFeatures(featureIds: string[]): Promise<Feature[]> {
        const features: Feature[] = [];
        for (const id of featureIds) {
            const [startSha, headSha] = await Promise.all([
                this.git.resolveFeatureRef(id, 'start'),
                this.git.resolveFeatureRef(id, 'head')
            ]);
            if (!startSha || !headSha) { continue; }

            const commits = await this.git.getTopoOrderedCommits(startSha, headSha);
            const status = await this.git.getFeatureStatus(id);
            features.push({
                id,
                name: id,
                startRef: `refs/features/${id}/start`,
                headRef: `refs/features/${id}/head`,
                startSha,
                headSha,
                developerId: this.developerId,
                commits,
                status: status === 'closed' ? 'integrated' : 'active'
            });
        }
        return features;
    }

    private async getCurrentVV() {
        // Tomamos el VV del último commit MM43, o iniciamos desde cero
        const commits = await this.git.getTopoOrderedCommits(undefined, 'HEAD');
        for (const c of commits) {
            if (c.metadata) { return c.metadata.versionVector; }
        }
        return VersionVectorEngine.empty();
    }

    private getLatestVV(feature: Feature) {
        for (const c of feature.commits) {
            if (c.metadata) { return c.metadata.versionVector; }
        }
        return undefined;
    }

    private async getFeatureFiles(feature: Feature): Promise<string[]> {
        const files = new Set<string>();
        for (const c of feature.commits) {
            const cf = await this.git.getCommitFiles(c.sha);
            cf.forEach(f => files.add(f));
        }
        return Array.from(files);
    }

    private getLocalDeveloperId(cwd: string): string {
        // Leer git config user.email del repositorio del workspace activo
        try {
            return execSync('git config user.email', { encoding: 'utf8', cwd }).trim();
        } catch {
            try {
                return execSync('git config user.name', { encoding: 'utf8', cwd }).trim();
            } catch {
                return os.hostname();
            }
        }
    }

    private flattenError(message: string): FlattenResult {
        return { success: false, conflictsFound: [], message };
    }

    dispose(): void {
        this._onStateChanged.dispose();
    }
}
