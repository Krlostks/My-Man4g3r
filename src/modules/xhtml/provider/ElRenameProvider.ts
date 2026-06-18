/**
 * ElRenameProvider — Renombrado sincronizado de miembros Java ↔ XHTML.
 *
 * Al renombrar un bean, método o campo en una expresión EL,
 * busca y reemplaza todas las ocurrencias en todos los archivos XHTML del workspace.
 */

import * as vscode from 'vscode';
import { BeanRegistry } from '../../AI/BeanRegistry';
import { XhtmlExpressionParser } from '../../AI/XhtmlExpressionParser';

const RE_EL_GLOBAL = /\#\{([a-zA-Z_][\w]*?)\.([a-zA-Z_][\w.]*?)(?=[(\s,}])/g;

export class ElRenameProvider implements vscode.RenameProvider {

    constructor(private registry: BeanRegistry) {}

    prepareRename(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.Range | null {
        const expr = XhtmlExpressionParser.parse(document, position);
        if (!expr) { return null; }

        const line = document.lineAt(position.line).text;
        const col = position.character;

        // Localizar el rango exacto de la palabra bajo el cursor dentro de la EL
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_]\w*/);
        if (!wordRange) { return null; }

        return wordRange;
    }

    async provideRenameEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        newName: string,
        _token: vscode.CancellationToken
    ): Promise<vscode.WorkspaceEdit | null> {

        const expr = XhtmlExpressionParser.parse(document, position);
        if (!expr) { return null; }

        const oldName = expr.cursorOnBean
            ? expr.beanName
            : (expr.clickedPart || expr.memberName);

        if (oldName === newName) { return null; }

        const edit = new vscode.WorkspaceEdit();

        // Buscar en todos los archivos XHTML del workspace
        const xhtmlFiles = await vscode.workspace.findFiles('**/*.xhtml', '**/node_modules/**');

        for (const uri of xhtmlFiles) {
            const doc = await vscode.workspace.openTextDocument(uri);
            const text = doc.getText();

            const re = new RegExp(RE_EL_GLOBAL.source, 'g');
            let match: RegExpExecArray | null;

            while ((match = re.exec(text)) !== null) {
                const beanName = match[1];
                const memberChain = match[2];
                const exprStart = match.index + 2; // skip #{

                if (expr.cursorOnBean) {
                    // Renombrando el bean
                    if (beanName === oldName) {
                        const start = doc.positionAt(exprStart);
                        const end = doc.positionAt(exprStart + oldName.length);
                        edit.replace(uri, new vscode.Range(start, end), newName);
                    }
                } else {
                    // Renombrando un miembro — solo si es del mismo bean
                    if (beanName !== expr.beanName) { continue; }

                    const parts = memberChain.split('.');
                    let offset = exprStart + beanName.length + 1; // +1 por el punto

                    for (const part of parts) {
                        if (part === oldName) {
                            const start = doc.positionAt(offset);
                            const end = doc.positionAt(offset + oldName.length);
                            edit.replace(uri, new vscode.Range(start, end), newName);
                        }
                        offset += part.length + 1; // +1 por el punto
                    }
                }
            }
        }

        return edit.size > 0 ? edit : null;
    }
}
