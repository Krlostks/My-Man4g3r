import { JavaClassIndex } from '../java/JavaClassIndex';
import { extractRefs } from './ElParser';

export interface ScopeVar {
    name: string;
    type: string;
    sourceExpr?: string;
}

/**
 * Resuelve variables de alcance (scope) en archivos XHTML:
 *  - Etiquetas de iteración: <p:dataTable var="obj">, <ui:repeat var="item">, <c:forEach var="x">
 *  - Etiquetas de selección/colección: <f:selectItems var="tabulador">, <p:selectItems>, <p:autoComplete var="...">
 *  - Parámetros y variables de asignación: <ui:param name="..." value="...">, <c:set var="..." value="...">
 *  - Variables de índice: rowIndexVar="idx" (Integer)
 *
 * Infiere el tipo de la variable mediante:
 *  1. `value` o `items` de la propia etiqueta (ej. `List<Tabulador>` → `Tabulador`).
 *  2. `itemValue` y el componente de selección padre (ej. `<p:selectOneMenu value="#{obj.tabuladorSeleccionado}">`).
 *  3. Fallback a 'Object' para evitar falsos positivos de diagnóstico cuando el tipo no es estrictamente navegable.
 */
export class ScopeResolver {
    constructor(private readonly classIndex: JavaClassIndex) {}

    /**
     * Extrae las variables de ámbito activas en una posición o prefijo de texto.
     * @param textBefore Texto desde el inicio hasta el cursor o inicio de la referencia EL.
     * @param fullDocumentText Documento completo (opcional, permite inspeccionar etiquetas auto-cerradas o atributos posteriores).
     * @param offset Posición del cursor en el documento (opcional).
     */
    resolveScopeVariables(
        textBefore: string,
        fullDocumentText?: string,
        offset?: number
    ): Map<string, string> {
        const scopes = new Map<string, string>();
        const targetOffset = offset ?? textBefore.length;
        const fullDoc = fullDocumentText ?? textBefore;

        // 1. Resolver parámetros globales previos: <ui:param> y <c:set>
        this.resolveParamAndSetScopes(textBefore, scopes);

        // 2. Resolver etiquetas contenedoras abiertas que envuelven el cursor
        this.resolveAncestorTagScopes(fullDoc, targetOffset, scopes);

        // 3. Si el cursor se encuentra DENTRO de una etiqueta (abierta o auto-cerrada),
        //    resolver variables declaradas en la misma etiqueta (ej. f:selectItems var="tabulador")
        this.resolveCurrentTagScope(fullDoc, targetOffset, scopes);

        return scopes;
    }

    /**
     * Resuelve <ui:param name="..." value="..."/> y <c:set var="..." value="..."/> que aparecen antes del cursor.
     */
    private resolveParamAndSetScopes(textBefore: string, scopes: Map<string, string>): void {
        const paramRe = /<([\w.-]+):(param|set)\b([^>]*)\/?>/gi;
        let match: RegExpExecArray | null;
        while ((match = paramRe.exec(textBefore)) !== null) {
            const attrs = match[3];
            const nameMatch = /\b(?:name|var)\s*=\s*["']([^"']+)["']/i.exec(attrs);
            const valueMatch = /\bvalue\s*=\s*["']([^"']+)["']/i.exec(attrs);

            if (nameMatch) {
                const varName = nameMatch[1].trim();
                let varType = 'Object';
                if (valueMatch) {
                    const resolved = this.resolveExpressionType(valueMatch[1].trim(), scopes);
                    if (resolved) {
                        varType = resolved;
                    }
                }
                scopes.set(varName, varType);
            }
        }
    }

    /**
     * Escanea etiquetas ancestrales en fullDoc que abren antes de targetOffset y cierran DESPUÉS de targetOffset.
     */
    private resolveAncestorTagScopes(fullDoc: string, targetOffset: number, scopes: Map<string, string>): void {
        // Captura apertura de tags: <prefix:tag ...>
        const openTagRe = /<([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)\b([^>]*?)(\/?>)/g;
        let match: RegExpExecArray | null;

        while ((match = openTagRe.exec(fullDoc)) !== null) {
            const tagStart = match.index;
            if (tagStart >= targetOffset) {
                break;
            }

            const prefix = match[1];
            const comp = match[2];
            const attrs = match[3];
            const isSelfClosing = match[4].startsWith('/>');
            const tagEnd = tagStart + match[0].length;

            if (isSelfClosing) {
                // Las etiquetas auto-cerradas no pueden ser ancestros de elementos posteriores a su cierre
                continue;
            }

            const fullTagName = `${prefix}:${comp}`;
            const closingTag = `</${fullTagName}>`;
            const closeIndex = this.findMatchingClosingTag(fullDoc, fullTagName, tagEnd);

            // Si cierra después del cursor (o no se ha cerrado aún en el documento), envuelve la posición
            if (closeIndex === -1 || closeIndex > targetOffset) {
                // 1. var="..."
                const varMatch = /\bvar\s*=\s*["']([^"']+)["']/i.exec(attrs);
                if (varMatch) {
                    const varName = varMatch[1].trim();
                    const valMatch = /\b(?:value|items)\s*=\s*["']([^"']+)["']/i.exec(attrs);
                    let inferredType = 'Object';
                    if (valMatch) {
                        const resolved = this.resolveExpressionType(valMatch[1].trim(), scopes);
                        if (resolved) {
                            inferredType = resolved;
                        }
                    }
                    scopes.set(varName, inferredType);
                }

                // 2. rowIndexVar="..." (p:dataTable)
                const rowVarMatch = /\browIndexVar\s*=\s*["']([^"']+)["']/i.exec(attrs);
                if (rowVarMatch) {
                    scopes.set(rowVarMatch[1].trim(), 'Integer');
                }
            }
        }
    }

    /**
     * Si targetOffset cae dentro de la declaración de una etiqueta (entre `<` y `>` / `/>`),
     * resuelve las variables que esa misma etiqueta declara (ej. f:selectItems var="tabulador").
     */
    private resolveCurrentTagScope(fullDoc: string, targetOffset: number, scopes: Map<string, string>): void {
        const tagInfo = this.findEnclosingTagAtOffset(fullDoc, targetOffset);
        if (!tagInfo) {
            return;
        }

        const tagText = tagInfo.text;
        const varMatch = /\bvar\s*=\s*["']([^"']+)["']/i.exec(tagText);
        if (!varMatch) {
            return;
        }

        const varName = varMatch[1].trim();
        let varType: string | undefined;

        // 1. Intentar resolver el tipo desde value="..." o items="..." de la etiqueta actual
        const valMatch = /\b(?:value|items)\s*=\s*["']([^"']+)["']/i.exec(tagText);
        if (valMatch) {
            varType = this.resolveExpressionType(valMatch[1].trim(), scopes);
        }

        // 2. Si no se resolvió (o si es un componente como f:selectItems dentro de un menú de selección):
        //    Buscar si la etiqueta contenedora padre (ej. p:selectOneMenu) define value="#{...}"
        if (!varType || varType === 'Object') {
            const parentValue = this.findParentSelectionValue(fullDoc, tagInfo.start, scopes);
            if (parentValue) {
                varType = parentValue;
            }
        }

        scopes.set(varName, varType || 'Object');
    }

    /**
     * Busca la etiqueta contenedora de selección (p:selectOneMenu, h:selectOneMenu, p:selectCheckboxMenu, etc.)
     * anterior a tagStart y obtiene el tipo de su atributo value="#{...}".
     */
    private findParentSelectionValue(fullDoc: string, tagStart: number, scopes: Map<string, string>): string | undefined {
        const textBefore = fullDoc.substring(0, tagStart);
        const menuRe = /<([\w.-]+):(selectOneMenu|selectCheckboxMenu|selectManyMenu|selectOneRadio|selectOneListbox)\b([^>]*?)>/gi;
        let lastMatch: RegExpExecArray | null = null;
        let m: RegExpExecArray | null;

        while ((m = menuRe.exec(textBefore)) !== null) {
            const closeTag = `</${m[1]}:${m[2]}>`;
            const closeIdx = fullDoc.indexOf(closeTag, m.index);
            if (closeIdx === -1 || closeIdx > tagStart) {
                lastMatch = m;
            }
        }

        if (lastMatch) {
            const attrs = lastMatch[3];
            const valMatch = /\bvalue\s*=\s*["']([^"']+)["']/i.exec(attrs);
            if (valMatch) {
                const expr = valMatch[1].trim();
                const resolved = this.resolveExpressionType(expr, scopes);
                if (resolved) {
                    return resolved;
                }
            }
        }

        return undefined;
    }

    /**
     * Localiza la etiqueta que envuelve el offset actual si el cursor se encuentra dentro de sus delimitadores `<` y `>`.
     */
    private findEnclosingTagAtOffset(fullDoc: string, offset: number): { text: string; start: number; end: number } | undefined {
        let tagStart = -1;
        let inQuote: string | null = null;

        for (let i = offset; i >= 0; i--) {
            const c = fullDoc[i];
            if (c === '>' && !inQuote && i < offset) {
                // Ya se cerró un tag antes del offset
                break;
            }
            if (c === '<' && !inQuote) {
                tagStart = i;
                break;
            }
        }

        if (tagStart === -1) {
            return undefined;
        }

        // Buscar el final del tag a partir de tagStart
        inQuote = null;
        let tagEnd = -1;
        for (let i = tagStart; i < fullDoc.length; i++) {
            const c = fullDoc[i];
            if (inQuote) {
                if (c === inQuote) {
                    inQuote = null;
                }
            } else if (c === '"' || c === "'") {
                inQuote = c;
            } else if (c === '>') {
                tagEnd = i;
                break;
            }
        }

        if (tagEnd !== -1 && offset <= tagEnd) {
            return {
                text: fullDoc.substring(tagStart, tagEnd + 1),
                start: tagStart,
                end: tagEnd
            };
        }

        return undefined;
    }

    /**
     * Busca la etiqueta de cierre correspondiente respetando anidación del mismo tag.
     */
    private findMatchingClosingTag(fullDoc: string, fullTagName: string, searchFrom: number): number {
        const openStr = `<${fullTagName}`;
        const closeStr = `</${fullTagName}>`;
        let depth = 1;
        let pos = searchFrom;

        while (pos < fullDoc.length) {
            const nextOpen = fullDoc.indexOf(openStr, pos);
            const nextClose = fullDoc.indexOf(closeStr, pos);

            if (nextClose === -1) {
                return -1;
            }

            if (nextOpen !== -1 && nextOpen < nextClose) {
                // Verificar si no es auto-cerrado
                const gt = fullDoc.indexOf('>', nextOpen);
                if (gt !== -1 && fullDoc.substring(nextOpen, gt + 1).endsWith('/>')) {
                    pos = gt + 1;
                    continue;
                }
                depth++;
                pos = nextOpen + openStr.length;
            } else {
                depth--;
                if (depth === 0) {
                    return nextClose;
                }
                pos = nextClose + closeStr.length;
            }
        }

        return -1;
    }

    /**
     * Evalúa una expresión EL (ej. "#{infraccionesController.view.listTabuladores}")
     * y devuelve el tipo desenvuelto (ej. "Tabulador").
     */
    private resolveExpressionType(expr: string, existingScopes: Map<string, string>): string | undefined {
        const elStart = expr.indexOf('#{');
        if (elStart === -1) {
            return undefined;
        }
        const elEnd = expr.indexOf('}', elStart);
        if (elEnd === -1) {
            return undefined;
        }

        const body = expr.substring(elStart + 2, elEnd);
        const refs = extractRefs(body, 0, body.length);
        if (refs.length === 0 || refs[0].segments.length === 0) {
            return undefined;
        }

        const segNames = refs[0].segments.map((s) => s.name);
        const resolved = this.classIndex.resolveChain(segNames[0], segNames, existingScopes);
        if (resolved && resolved.targetType) {
            const rawType = resolved.targetType;
            const unwrapped = this.classIndex.unwrapGenericType(rawType);
            return this.classIndex.cleanType(unwrapped);
        }

        return undefined;
    }
}
