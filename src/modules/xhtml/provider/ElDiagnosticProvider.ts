/**
 * ElDiagnosticProvider — Valida expresiones EL en archivos XHTML en tiempo real.
 *
 * Emite warnings cuando:
 *  - Un bean referenciado en #{beanName...} no existe en BeanRegistry
 *  - Un miembro (método/campo) no existe en el bean registrado
 */

import * as vscode from 'vscode';
import { BeanRegistry } from '../../AI/BeanRegistry';

const RE_EL_GLOBAL = /\#\{([a-zA-Z_][\w]*?)\.([a-zA-Z_][\w.]*?)(?=[(\s,}])/g;

export class ElDiagnosticProvider implements vscode.Disposable {

    private diagnostics: vscode.DiagnosticCollection;
    private disposables: vscode.Disposable[] = [];

    constructor(private registry: BeanRegistry) {
        this.diagnostics = vscode.languages.createDiagnosticCollection('mm43-el');

        // Validar al guardar
        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument(doc => {
                if (this.isXhtml(doc)) { this.validate(doc); }
            })
        );

        // Validar al abrir
        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument(doc => {
                if (this.isXhtml(doc)) { this.validate(doc); }
            })
        );

        // Limpiar al cerrar
        this.disposables.push(
            vscode.workspace.onDidCloseTextDocument(doc => {
                this.diagnostics.delete(doc.uri);
            })
        );

        // Validar documentos ya abiertos
        vscode.workspace.textDocuments.forEach(doc => {
            if (this.isXhtml(doc)) { this.validate(doc); }
        });
    }

    validate(document: vscode.TextDocument): void {
        const diags: vscode.Diagnostic[] = [];
        const text = document.getText();

        const re = new RegExp(RE_EL_GLOBAL.source, 'g');
        let match: RegExpExecArray | null;

        while ((match = re.exec(text)) !== null) {
            const beanName = match[1];
            const memberChain = match[2];
            const exprOffset = match.index + 2; // skip #{

            const entry = this.registry.resolve(beanName);

            if (!entry) {
                // Bean no encontrado
                const startPos = document.positionAt(exprOffset);
                const endPos = document.positionAt(exprOffset + beanName.length);
                diags.push(new vscode.Diagnostic(
                    new vscode.Range(startPos, endPos),
                    `Bean '${beanName}' no encontrado en el índice CDI.`,
                    vscode.DiagnosticSeverity.Warning
                ));
                continue;
            }

            // Verificar primer miembro
            const firstMember = memberChain.split('.')[0];
            if (!entry.methods.has(firstMember) && !entry.fields.has(firstMember)) {
                const memberOffset = exprOffset + beanName.length + 1; // +1 por el punto
                const startPos = document.positionAt(memberOffset);
                const endPos = document.positionAt(memberOffset + firstMember.length);
                diags.push(new vscode.Diagnostic(
                    new vscode.Range(startPos, endPos),
                    `Miembro '${firstMember}' no encontrado en bean '${beanName}' (${entry.className}).`,
                    vscode.DiagnosticSeverity.Warning
                ));
            }
        }

        this.diagnostics.set(document.uri, diags);
    }

    private isXhtml(doc: vscode.TextDocument): boolean {
        return doc.fileName.endsWith('.xhtml');
    }

    dispose(): void {
        this.diagnostics.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
