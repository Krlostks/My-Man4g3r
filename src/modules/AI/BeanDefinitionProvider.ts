/**
 * BeanDefinitionProvider — vscode.DefinitionProvider para expresiones EL en XHTML.
 *
 * Responde a "Go to Definition" (F12) cuando el cursor está sobre:
 *   #{clienteBean.guardar}
 *
 * Busca en BeanRegistry → resuelve filePath → localiza la línea del método/field
 * dentro del .java y devuelve un vscode.Location.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { BeanRegistry } from './BeanRegistry';
import { XhtmlExpressionParser } from './XhtmlExpressionParser';
import { Logger } from '../logger/Logger';

export class BeanDefinitionProvider implements vscode.DefinitionProvider {

    constructor(private registry: BeanRegistry) {}

    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.Definition | undefined {

        const expr = XhtmlExpressionParser.parse(document, position);
        if (!expr) { return undefined; }

        const entry = this.registry.resolve(expr.beanName);
        if (!entry) {
            Logger.warn('AI', `Bean no encontrado en índice: '${expr.beanName}'`);
            return undefined;
        }

        // Si el cursor está sobre el nombre del bean → ir a la clase
        if (expr.cursorOnBean) {
            return new vscode.Location(
                vscode.Uri.file(entry.filePath),
                new vscode.Position(0, 0)
            );
        }

        // Si el cursor está sobre el miembro → buscar la línea del método/field
        const targetLine = this.findMemberLine(entry.filePath, expr.memberName);
        return new vscode.Location(
            vscode.Uri.file(entry.filePath),
            new vscode.Position(targetLine, 0)
        );
    }

    // ─── Privado ─────────────────────────────────────────────────────────────

    /**
     * Busca la línea donde se declara el método o field por nombre.
     * Estrategia simple: primera línea que contenga el nombre como identificador.
     * Devuelve 0 si no lo encuentra (abre el archivo al inicio).
     */
    private findMemberLine(filePath: string, memberName: string): number {
        try {
            const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
            // Busca declaración de método o field que contenga el nombre
            // Patrón: el nombre aparece como palabra completa seguido de '(' o espacio/;/=
            const re = new RegExp(`\\b${memberName}\\s*[\\(;=]`);
            for (let i = 0; i < lines.length; i++) {
                if (re.test(lines[i])) {
                    return i;
                }
            }
        } catch (err) {
            Logger.error('AI', `Error leyendo ${filePath}: ${String(err)}`);
        }
        return 0;
    }
}
