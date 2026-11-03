/**
 * BeanDefinitionProvider — vscode.DefinitionProvider para expresiones EL en XHTML.
 *
 * Responde a "Go to Definition" (F12) cuando el cursor está sobre:
 *   #{clienteBean.guardar}
 *
 * Busca en BeanRegistry / JavaClassIndex → resuelve filePath → localiza la línea del método/field
 * dentro del .java y devuelve un vscode.Location.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { BeanRegistry } from './BeanRegistry';
import { JavaClassIndex } from '../IntellisenseSupport/java/JavaClassIndex';
import { findElRegions, extractRefs } from '../IntellisenseSupport/parsing/ElParser';
import { ScopeResolver } from '../IntellisenseSupport/parsing/ScopeResolver';
import { Logger } from '../logger/Logger';

export class BeanDefinitionProvider implements vscode.DefinitionProvider {
    private readonly classIndex: JavaClassIndex;
    private readonly scopeResolver: ScopeResolver;

    constructor(private registry: BeanRegistry, classIndex?: JavaClassIndex) {
        this.classIndex = classIndex || new JavaClassIndex(registry);
        this.scopeResolver = new ScopeResolver(this.classIndex);
    }

    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.Definition | undefined {
        const fullText = document.getText();
        const offset = document.offsetAt(position);

        const regions = findElRegions(fullText);
        const region = regions.find((r) => offset >= r.bodyStart && offset <= r.bodyEnd);
        if (!region) {
            return undefined;
        }

        const refs = extractRefs(fullText, region.bodyStart, region.bodyEnd);
        let targetRef: (typeof refs)[0] | undefined;
        let targetSegIdx = -1;

        for (const ref of refs) {
            const idx = ref.segments.findIndex((s) => offset >= s.start && offset <= s.end);
            if (idx !== -1) {
                targetRef = ref;
                targetSegIdx = idx;
                break;
            }
        }

        if (!targetRef || targetSegIdx === -1) {
            return undefined;
        }

        const targetSeg = targetRef.segments[targetSegIdx];
        const textBefore = fullText.substring(0, targetSeg.start);
        const scopeVars = this.scopeResolver.resolveScopeVariables(textBefore, fullText, targetSeg.start);

        // Si es el primer segmento (raíz)
        if (targetSegIdx === 0) {
            // Variable de scope: si se declaró en este archivo, ubicar la declaración var="..."
            if (scopeVars.has(targetSeg.name)) {
                const varDeclMatch = new RegExp(`\\bvar\\s*=\\s*["']${targetSeg.name}["']`).exec(fullText);
                if (varDeclMatch) {
                    return new vscode.Location(
                        document.uri,
                        document.positionAt(varDeclMatch.index)
                    );
                }
            }

            // Bean CDI: ir al archivo .java del bean
            const entry = this.registry.resolve(targetSeg.name);
            if (entry) {
                return new vscode.Location(
                    vscode.Uri.file(entry.filePath),
                    new vscode.Position(0, 0)
                );
            }

            Logger.warn('AI', `Bean no encontrado en índice: '${targetSeg.name}'`);
            return undefined;
        }

        // Segmento encadenado (método o propiedad)
        const chain = targetRef.segments.slice(0, targetSegIdx + 1).map((s) => s.name);
        const resolved = this.classIndex.resolveChain(chain[0], chain, scopeVars);
        if (!resolved) {
            Logger.warn('AI', `No se pudo resolver la cadena: '${chain.join('.')}'`);
            return undefined;
        }

        const declaringClass = resolved.declaringClass;
        if (!declaringClass) {
            return undefined;
        }

        const targetFile = this.registry.getClassFile(declaringClass);
        if (!targetFile || !fs.existsSync(targetFile)) {
            Logger.warn('AI', `Archivo no encontrado para la clase: '${declaringClass}'`);
            return undefined;
        }

        const targetMemberName = targetSeg.name;
        const line = this.findMemberLine(targetFile, targetMemberName);

        return new vscode.Location(
            vscode.Uri.file(targetFile),
            new vscode.Position(line, 0)
        );
    }

    /**
     * Busca la línea donde se declara el método o field por nombre en el archivo .java.
     */
    private findMemberLine(filePath: string, memberName: string): number {
        try {
            const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
            const capName = memberName.charAt(0).toUpperCase() + memberName.slice(1);
            const getter1 = `get${capName}`;
            const getter2 = `is${capName}`;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                // Campo directo o getter
                if (
                    new RegExp(`\\b${memberName}\\b`).test(line) ||
                    new RegExp(`\\b${getter1}\\b`).test(line) ||
                    new RegExp(`\\b${getter2}\\b`).test(line)
                ) {
                    return i;
                }
            }
        } catch {
            // Fallback a inicio de archivo
        }
        return 0;
    }
}
