/**
 * MM43 - Motor de Aplanamiento Cronológico Semántico
 * VersionControlCommands.ts - Registro de comandos VS Code del módulo
 *
 * Comandos registrados:
 *   mm43.vc.startFeature      - Iniciar nueva feature lógica
 *   mm43.vc.commitWithVector  - Commit enriquecido con Vector de Versión
 *   mm43.vc.flattenActive     - Aplanar feature activa
 *   mm43.vc.flattenFeature    - Aplanar feature específica (argumento: featureId)
 *   mm43.vc.refresh           - Refrescar estado del motor
 *   mm43.vc.showTopology      - Abrir webview de topología DAG
 */

import * as vscode from 'vscode';
import { FlatteningEngine } from '../modules/versioncontrol/FlatteningEngine';
import { VersionControlProvider } from './VersionControlProvider';
import { VersionControlWebviewPanel } from './VersionControlWebviewPanel';
import { Logger } from '../modules/logger/Logger';

export function registerVersionControlCommands(
    context: vscode.ExtensionContext,
    engine: FlatteningEngine,
    provider: VersionControlProvider
): void {

    // ─────────────────────────────────────────────────────────────
    // mm43.vc.startFeature
    // ─────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('mm43.vc.startFeature', async () => {
            const featureId = await vscode.window.showInputBox({
                title: 'MM43 · Nueva Feature',
                prompt: 'ID de la feature (ej. FEAT-42, US-001)',
                placeHolder: 'FEAT-001',
                validateInput: (v) => {
                    if (!v || v.trim().length === 0) { return 'El ID no puede estar vacío'; }
                    if (/[^a-zA-Z0-9\-_]/.test(v)) { return 'Solo se permiten letras, números, guiones y guiones bajos'; }
                    return undefined;
                }
            });

            if (!featureId) { return; }

            const featureName = await vscode.window.showInputBox({
                title: 'MM43 · Nueva Feature',
                prompt: 'Nombre descriptivo (opcional)',
                placeHolder: 'Descripción breve de la tarea',
                value: featureId
            });

            if (featureName === undefined) { return; }

            try {
                await engine.startFeature(featureId.trim(), featureName.trim() || featureId.trim());
                vscode.window.showInformationMessage(
                    `✅ Feature '${featureId}' iniciada. refs/features/${featureId}/ creados.`
                );
                provider.refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Error al iniciar feature: ${(err as Error).message}`);
            }
        })
    );

    // ─────────────────────────────────────────────────────────────
    // mm43.vc.commitWithVector
    // ─────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('mm43.vc.commitWithVector', async (featureIdArg?: string) => {
            const state = engine.getState();

            const message = await vscode.window.showInputBox({
                title: 'MM43 · Commit con Vector de Versión',
                prompt: 'Mensaje del commit',
                placeHolder: 'feat: descripción del cambio',
                validateInput: (v) => {
                    if (!v || v.trim().length === 0) { return 'El mensaje no puede estar vacío'; }
                    if (v.trim().length < 5) { return 'El mensaje debe tener al menos 5 caracteres'; }
                    return undefined;
                }
            });

            if (!message) { return; }

            // Si hay features disponibles, preguntar a cuál asociar
            let featureId: string | undefined = featureIdArg ?? state.currentFeature?.id;

            if (!featureId && state.allFeatures.length > 0) {
                const pick = await vscode.window.showQuickPick(
                    state.allFeatures.map(f => ({ label: f.id, description: `${f.commits.length} commit(s)` })),
                    { title: 'Asociar a feature (opcional)', placeHolder: 'Selecciona una feature o cancela para omitir' }
                );
                featureId = pick?.label;
            }

            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'MM43 · Realizando commit...', cancellable: false },
                    async () => {
                        await engine.commitWithVector(message.trim(), featureId);
                    }
                );

                vscode.window.showInformationMessage(
                    `✅ Commit realizado con Vector de Versión MM43${featureId ? ` (Feature: ${featureId})` : ''}`
                );
                provider.refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Error en commit: ${(err as Error).message}`);
            }
        })
    );

    // ─────────────────────────────────────────────────────────────
    // mm43.vc.flattenActive
    // ─────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('mm43.vc.flattenActive', async () => {
            const state = engine.getState();

            if (!state.currentFeature) {
                vscode.window.showWarningMessage('No hay una feature activa. Inicia una con "Nueva Feature".');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `¿Aplanar feature '${state.currentFeature.id}' al tronco?\n` +
                `Esto ejecutará un rebase semántico con ${state.currentFeature.commits.length} commit(s).`,
                { modal: true },
                'Aplanar'
            );

            if (confirm !== 'Aplanar') { return; }

            await executeFlatten(engine, provider, state.currentFeature.id);
        })
    );

    // ─────────────────────────────────────────────────────────────
    // mm43.vc.flattenFeature (con argumento)
    // ─────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('mm43.vc.flattenFeature', async (featureId?: string) => {
            const id = featureId ?? await promptFeatureSelection(engine);
            if (!id) { return; }

            const confirm = await vscode.window.showWarningMessage(
                `¿Aplanar feature '${id}' al tronco?`,
                { modal: true },
                'Aplanar'
            );

            if (confirm !== 'Aplanar') { return; }

            await executeFlatten(engine, provider, id);
        })
    );

    // ─────────────────────────────────────────────────────────────
    // mm43.vc.refresh
    // ─────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('mm43.vc.refresh', async () => {
            await engine.refreshState();
            provider.refresh();
            Logger.info('VERSION_CONTROL', 'Estado actualizado manualmente');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('mm43.vc.sanitize', async () => {
            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'MM43 · Saneando topología...', cancellable: false },
                    async () => {
                        await engine.sanitizeFeatures();
                    }
                );
                vscode.window.showInformationMessage('✅ Topología saneada y sincronizada.');
                provider.refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Error al sanear: ${(err as Error).message}`);
            }
        })
    );

    // ─────────────────────────────────────────────────────────────
    // mm43.vc.showTopology
    // ─────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('mm43.vc.showTopology', () => {
            let state = engine.getState();
            VersionControlWebviewPanel.createOrShow(context, state);
            // Suscribir cambios de estado para refrescar el webview
            engine.onStateChanged(s => {
                VersionControlWebviewPanel.createOrShow(context, s);
            });
        })
    );
    // ─────────────────────────────────────────────────────────────
    // Nuevos comandos lógicos (Rediseño)
    // ─────────────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('mm43.vc.closeFeature', async (featureId?: string) => {
            const state = engine.getState();
            const id = featureId ?? state?.currentFeature?.id;
            if (!id) return;
            await engine.closeFeature(id);
            vscode.window.showInformationMessage(`✅ Feature '${id}' cerrada.`);
        }),

        vscode.commands.registerCommand('mm43.vc.openFeature', async (featureId?: string) => {
            const id = featureId ?? await promptFeatureSelection(engine);
            if (!id) return;
            await engine.openFeature(id);
            vscode.window.showInformationMessage(`✅ Feature '${id}' reabierta.`);
        }),

        vscode.commands.registerCommand('mm43.vc.deleteFeature', async (featureId?: string) => {
            const id = featureId ?? await promptFeatureSelection(engine);
            if (!id) return;

            const confirm = await vscode.window.showWarningMessage(
                `¿Eliminar feature '${id}'? Esta acción borrará sus referencias en Git.`,
                { modal: true },
                'Eliminar'
            );

            if (confirm !== 'Eliminar') return;

            await engine.deleteFeature(id);
            vscode.window.showInformationMessage(`✅ Feature '${id}' eliminada.`);
        }),

        vscode.commands.registerCommand('mm43.vc.assignCommit', async (args: { sha: string, featureId?: string }) => {
            let featureId = args?.featureId;
            if (!featureId) {
                featureId = await promptFeatureSelection(engine);
            }
            if (!featureId) return;

            try {
                await engine.assignCommitToFeature(args.sha, featureId);
                vscode.window.showInformationMessage(`✅ Commit ${args.sha.substring(0, 8)} asignado a '${featureId}'.`);
            } catch (err) {
                vscode.window.showErrorMessage(`Error al asignar commit: ${(err as Error).message}`);
            }
        }),

        vscode.commands.registerCommand('mm43.vc.unassignCommit', async (sha: string) => {
            try {
                await engine.unassignCommit(sha);
                vscode.window.showInformationMessage(`✅ Commit ${sha.substring(0, 8)} desvinculado.`);
            } catch (err) {
                vscode.window.showErrorMessage(`Error al desvincular: ${(err as Error).message}`);
            }
        }),

        vscode.commands.registerCommand('mm43.vc.syncUp', async () => {
            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'MM43 · Subiendo cambios...', cancellable: false },
                    async () => {
                        await engine.syncUp();
                    }
                );
                vscode.window.showInformationMessage('✅ Cambios subidos correctamente.');
            } catch (err) {
                vscode.window.showErrorMessage(`Error al subir: ${(err as Error).message}`);
            }
        }),

        vscode.commands.registerCommand('mm43.vc.syncDown', async () => {
            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'MM43 · Bajando cambios...', cancellable: false },
                    async () => {
                        await engine.syncDown();
                    }
                );
                vscode.window.showInformationMessage('✅ Cambios bajados correctamente.');
            } catch (err) {
                vscode.window.showErrorMessage(`Error al bajar: ${(err as Error).message}`);
            }
        }),

        vscode.commands.registerCommand('mm43.vc.fullSync', async () => {
            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'MM43 · Sincronización Total...', cancellable: false },
                    async () => {
                        await engine.fullSync();
                    }
                );
                vscode.window.showInformationMessage('✅ Sincronización Total completada (Cero Conflictos).');
            } catch (err) {
                vscode.window.showErrorMessage(`Error en sincronización total: ${(err as Error).message}`);
            }
        }),

        // ─────────────────────────────────────────────────────────────
        // Comandos de Archivos y Stash
        // ─────────────────────────────────────────────────────────────

        vscode.commands.registerCommand('mm43.vc.stageFile', async (file: string) => {
            await engine.stageFile(file);
        }),
        vscode.commands.registerCommand('mm43.vc.unstageFile', async (file: string) => {
            await engine.unstageFile(file);
        }),
        vscode.commands.registerCommand('mm43.vc.discardChanges', async (file: string) => {
            const confirm = await vscode.window.showWarningMessage(`¿Descartar cambios en ${file}?`, 'Descartar');
            if (confirm === 'Descartar') await engine.discardChanges(file);
        }),
        vscode.commands.registerCommand('mm43.vc.applyStash', async (index: number) => {
            await engine.applyStash(index);
        }),
        vscode.commands.registerCommand('mm43.vc.createStash', async () => {
            const message = await vscode.window.showInputBox({ prompt: 'Mensaje para el stash (opcional)' });
            if (message !== undefined) {
                await engine.createStash(message || 'Stash automático MM43');
            }
        })
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function executeFlatten(
    engine: FlatteningEngine,
    provider: VersionControlProvider,
    featureId: string
): Promise<void> {
    try {
        const result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `MM43 · Aplanando '${featureId}'...`,
                cancellable: false
            },
            async () => engine.flattenFeature(featureId)
        );

        if (result.success) {
            vscode.window.showInformationMessage(
                `✅ ${result.message}`,
                'OK'
            );
        } else {
            const detail = result.conflictsFound.length > 0
                ? `\n\nConflictos en: ${result.conflictsFound.map(c => c.filesAffected.join(', ')).join(' | ')}`
                : '';
            vscode.window.showErrorMessage(`⚠ ${result.message}${detail}`);
        }

        provider.refresh();
    } catch (err) {
        vscode.window.showErrorMessage(`Error crítico en aplanamiento: ${(err as Error).message}`);
    }
}

async function promptFeatureSelection(engine: FlatteningEngine): Promise<string | undefined> {
    const features = engine.getState().allFeatures;
    if (features.length === 0) {
        vscode.window.showWarningMessage('No hay features registradas.');
        return undefined;
    }

    const pick = await vscode.window.showQuickPick(
        features.map(f => ({
            label: f.id,
            description: `${f.commits.length} commit(s) · Head: ${f.headSha.substring(0, 8)}`
        })),
        { title: 'Seleccionar Feature a Aplanar' }
    );

    return pick?.label;
}
