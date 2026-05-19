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

        // Si el cursor está sobre el nombre del bean → ir a la clase principal
        if (expr.cursorOnBean) {
            return new vscode.Location(
                vscode.Uri.file(entry.filePath),
                new vscode.Position(0, 0)
            );
        }

        // Determinar qué parte fue clickeada
        const clickedPart = expr.clickedPart || expr.memberName;
        let currentFilePath = entry.filePath;

        // Si es una propiedad anidada (ej. view.variable)
        if (expr.memberName.includes('.')) {
            const parts = expr.memberName.split('.');
            const partIndex = parts.indexOf(clickedPart);

            // Navegar archivo por archivo resolviendo el tipo de cada parte hasta llegar a la seleccionada
            for (let i = 0; i < partIndex; i++) {
                const part = parts[i];
                let fieldType: string | undefined;

                if (i === 0) {
                    fieldType = entry.fieldTypes?.get(part);
                } else {
                    fieldType = this.findFieldType(currentFilePath, part);
                }

                if (!fieldType) {
                    Logger.warn('AI', `No se pudo resolver el tipo de '${part}' en ${currentFilePath}`);
                    return undefined;
                }

                // Limpiar tipos genéricos (ej. List<Usuario> -> Usuario)
                const cleanType = fieldType.replace(/<.*>/, '').replace(/\[\]/, '').trim();
                const nextFile = this.registry.getClassFile(cleanType);

                if (!nextFile) {
                    Logger.warn('AI', `Clase no encontrada en el registro global: '${cleanType}'`);
                    return undefined;
                }
                currentFilePath = nextFile;
            }
        }

        // Buscar la línea donde se declara la parte clickeada en el archivo final resuelto
        const targetLine = this.findMemberLine(currentFilePath, clickedPart);
        return new vscode.Location(
            vscode.Uri.file(currentFilePath),
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

    /**
     * Busca la declaración de un field en un archivo .java y devuelve su tipo.
     */
    private findFieldType(filePath: string, fieldName: string): string | undefined {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const RE_FIELD = new RegExp(`^\\s*(?:private|protected|public)\\s+(?!static\\s|final\\s+static\\s)([A-Za-z0-9_<>\\[\\],\\s.]+?)\\s+${fieldName}\\s*[=;]`, 'm');
            const match = RE_FIELD.exec(content);
            if (match) {
                return match[1].trim();
            }
        } catch (err) {
            Logger.error('AI', `Error leyendo ${filePath}: ${String(err)}`);
        }
        return undefined;
    }
}
