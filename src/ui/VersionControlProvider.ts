
import * as vscode from 'vscode';
import { FlatteningEngine } from '../modules/versioncontrol/FlatteningEngine';
import { VersionControlState, Feature, ConflictInfo } from '../config/types';

type NodeKind =
    | 'branch-info'
    | 'feature-active'
    | 'feature-group'
    | 'feature-item'
    | 'conflict-group'
    | 'conflict-item'
    | 'action-group'
    | 'empty-hint';

export class VersionControlNode extends vscode.TreeItem {
    constructor(
        public readonly kind: NodeKind,
        label: string,
        collapsible: vscode.TreeItemCollapsibleState,
        public readonly data?: Feature | ConflictInfo | VersionControlState
    ) {
        super(label, collapsible);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export class VersionControlProvider implements vscode.TreeDataProvider<VersionControlNode> {

    private _onDidChangeTreeData = new vscode.EventEmitter<VersionControlNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private state: VersionControlState = {
        currentBranch: '...',
        currentFeature: undefined,
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

    constructor(private readonly engine: FlatteningEngine) {
        engine.onStateChanged(s => {
            this.state = s;
            this.refresh();
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: VersionControlNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: VersionControlNode): VersionControlNode[] {
        if (!element) {
            return this.getRootNodes();
        }

        switch (element.kind) {
            case 'feature-group': return this.getFeatureNodes();
            case 'conflict-group': return this.getConflictNodes();
            case 'action-group': return this.getActionNodes();
            default: return [];
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Nodos raíz
    // ─────────────────────────────────────────────────────────────

    private getRootNodes(): VersionControlNode[] {
        const nodes: VersionControlNode[] = [];

        // ── Información de Rama ──────────────────────────────────
        const branchNode = new VersionControlNode(
            'branch-info',
            `$(git-branch) ${this.state.currentBranch}`,
            vscode.TreeItemCollapsibleState.None,
            this.state
        );
        branchNode.description = this.state.trunkHead
            ? this.state.trunkHead.substring(0, 8)
            : '';
        branchNode.tooltip = `Rama: ${this.state.currentBranch}\nHEAD: ${this.state.trunkHead}`;
        branchNode.iconPath = new vscode.ThemeIcon('git-branch');
        nodes.push(branchNode);

        // ── Feature activa ───────────────────────────────────────
        if (this.state.currentFeature) {
            const f = this.state.currentFeature;
            const activeNode = new VersionControlNode(
                'feature-active',
                `$(zap) Feature activa: ${f.id}`,
                vscode.TreeItemCollapsibleState.None,
                f
            );
            activeNode.description = `${f.commits.length} commit(s)`;
            activeNode.tooltip = `ID: ${f.id}\nCommits: ${f.commits.length}\nHead: ${f.headSha.substring(0, 8)}`;
            activeNode.iconPath = new vscode.ThemeIcon('zap');
            activeNode.contextValue = 'activeFeature';
            nodes.push(activeNode);
        }

        // ── Acciones rápidas ─────────────────────────────────────
        const actionGroup = new VersionControlNode(
            'action-group',
            '$(terminal) Acciones',
            vscode.TreeItemCollapsibleState.Expanded
        );
        actionGroup.iconPath = new vscode.ThemeIcon('terminal');
        nodes.push(actionGroup);

        // ── Features registradas ─────────────────────────────────
        const featureCount = this.state.allFeatures.length;
        const featureGroup = new VersionControlNode(
            'feature-group',
            '$(list-unordered) Features',
            featureCount > 0
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed
        );
        featureGroup.description = `${featureCount} registrada(s)`;
        featureGroup.iconPath = new vscode.ThemeIcon('list-unordered');
        nodes.push(featureGroup);

        // ── Conflictos ───────────────────────────────────────────
        const conflictCount = this.state.pendingConflicts.length;
        const conflictGroup = new VersionControlNode(
            'conflict-group',
            '$(warning) Conflictos',
            conflictCount > 0
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed
        );
        conflictGroup.description = conflictCount > 0 ? `${conflictCount} detectado(s)` : 'Ninguno';
        conflictGroup.iconPath = new vscode.ThemeIcon(conflictCount > 0 ? 'warning' : 'check');
        nodes.push(conflictGroup);

        return nodes;
    }

    // ─────────────────────────────────────────────────────────────
    // Sub-nodos de Acciones
    // ─────────────────────────────────────────────────────────────

    private getActionNodes(): VersionControlNode[] {
        const actions: VersionControlNode[] = [];

        const makeAction = (
            label: string,
            icon: string,
            command: string,
            tooltip: string
        ): VersionControlNode => {
            const n = new VersionControlNode(
                'action-group',
                label,
                vscode.TreeItemCollapsibleState.None
            );
            n.iconPath = new vscode.ThemeIcon(icon);
            n.tooltip = tooltip;
            n.command = { command, title: label, arguments: [] };
            return n;
        };

        actions.push(makeAction(
            'Nueva Feature',
            'add',
            'mm43.vc.startFeature',
            'Registrar una nueva feature lógica y crear sus refs'
        ));

        actions.push(makeAction(
            'Commit con Vector',
            'git-commit',
            'mm43.vc.commitWithVector',
            'Realizar un commit enriquecido con Vector de Versión MM43'
        ));

        if (this.state.currentFeature) {
            actions.push(makeAction(
                'Aplanar Feature Activa',
                'git-merge',
                'mm43.vc.flattenActive',
                'Integrar la feature activa al tronco con aplanamiento semántico'
            ));
        }

        actions.push(makeAction(
            'Actualizar Estado',
            'refresh',
            'mm43.vc.refresh',
            'Recargar el estado del motor de aplanamiento'
        ));

        actions.push(makeAction(
            'Ver Topología DAG',
            'type-hierarchy',
            'mm43.vc.showTopology',
            'Abrir el panel de visualización del grafo DAG'
        ));

        return actions;
    }

    // ─────────────────────────────────────────────────────────────
    // Sub-nodos de Features
    // ─────────────────────────────────────────────────────────────

    private getFeatureNodes(): VersionControlNode[] {
        if (this.state.allFeatures.length === 0) {
            const hint = new VersionControlNode(
                'empty-hint',
                'Sin features registradas',
                vscode.TreeItemCollapsibleState.None
            );
            hint.iconPath = new vscode.ThemeIcon('info');
            hint.tooltip = 'Usa "Nueva Feature" para iniciar una tarea lógica';
            return [hint];
        }

        return this.state.allFeatures.map(f => {
            const isActive = this.state.currentFeature?.id === f.id;
            const node = new VersionControlNode(
                'feature-item',
                f.id,
                vscode.TreeItemCollapsibleState.None,
                f
            );
            node.description = `${f.commits.length} commit(s) · ${f.headSha.substring(0, 8)}`;
            node.tooltip = `Feature: ${f.id}\nHead: ${f.headSha}\nStart: ${f.startSha}\nCommits: ${f.commits.length}`;
            node.iconPath = new vscode.ThemeIcon(isActive ? 'zap' : 'circle-outline');
            node.contextValue = isActive ? 'activeFeatureItem' : 'featureItem';

            if (!isActive) {
                node.command = {
                    command: 'mm43.vc.flattenFeature',
                    title: 'Aplanar Feature',
                    arguments: [f.id]
                };
            }
            return node;
        });
    }

    // ─────────────────────────────────────────────────────────────
    // Sub-nodos de Conflictos
    // ─────────────────────────────────────────────────────────────

    private getConflictNodes(): VersionControlNode[] {
        if (this.state.pendingConflicts.length === 0) {
            const ok = new VersionControlNode(
                'empty-hint',
                'Sin conflictos semánticos',
                vscode.TreeItemCollapsibleState.None
            );
            ok.iconPath = new vscode.ThemeIcon('check');
            return [ok];
        }

        return this.state.pendingConflicts.map((c, i) => {
            const node = new VersionControlNode(
                'conflict-item',
                `Conflicto #${i + 1}`,
                vscode.TreeItemCollapsibleState.None,
                c
            );
            node.description = c.filesAffected.slice(0, 2).join(', ');
            node.tooltip = [
                `Commit A: ${c.commitA.substring(0, 8)}`,
                `Commit B: ${c.commitB.substring(0, 8)}`,
                `Archivos afectados: ${c.filesAffected.join(', ')}`,
                `Detectado: ${c.detectedAt}`
            ].join('\n');
            node.iconPath = new vscode.ThemeIcon('warning');
            node.contextValue = 'conflictItem';
            return node;
        });
    }
}
