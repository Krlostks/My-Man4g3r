import { JavaClassIndex } from '../java/JavaClassIndex';
import { extractRefs } from './ElParser';

export interface ScopeVar {
    name: string;
    type: string;
    sourceExpr?: string;
}

/**
 * Resuelve variables de alcance (scope) definidas en etiquetas XHTML que envuelven la posición actual:
 *  - p:dataTable var="item" value="#{bean.lista}"
 *  - ui:repeat var="item" value="#{bean.lista}"
 *  - c:forEach var="item" items="#{bean.lista}"
 *  - ui:param name="paramName" value="#{bean.prop}"
 */
export class ScopeResolver {
    constructor(private readonly classIndex: JavaClassIndex) {}

    /**
     * Extrae las variables de scope activas en `textBeforeCursor`.
     * Devuelve un mapa: nombreVariable → tipoJava (ej. "item" → "Usuario").
     */
    resolveScopeVariables(textBeforeCursor: string): Map<string, string> {
        const scopes = new Map<string, string>();

        // 1. Detectar tags de iteración abiertos: <prefix:(dataTable|repeat|forEach|dataGrid|dataList) ...>
        // Regex para capturar tags con var y value/items
        const tagRe = /<([\w.-]+):(dataTable|repeat|forEach|dataGrid|dataList)\b([^>]*)(?:\/?>|$)/gi;
        let match: RegExpExecArray | null;

        while ((match = tagRe.exec(textBeforeCursor)) !== null) {
            const fullTag = match[0];
            const isSelfClosing = fullTag.trim().endsWith('/>');
            const tagIndex = match.index;
            const tagName = `${match[1]}:${match[2]}`;

            // Si es un tag normal (no auto-cerrado), comprobar si ya se cerró antes del cursor
            if (!isSelfClosing) {
                const closeTag = `</${tagName}>`;
                const closeIndex = textBeforeCursor.indexOf(closeTag, tagIndex + fullTag.length);
                if (closeIndex !== -1) {
                    // El tag ya se cerró antes del cursor
                    continue;
                }
            } else {
                // Auto-cerrado: no proporciona scope para hijos
                continue;
            }

            const attrs = match[3];
            const varMatch = /\bvar\s*=\s*["']([^"']+)["']/i.exec(attrs);
            const valueMatch = /\b(?:value|items)\s*=\s*["']([^"']+)["']/i.exec(attrs);

            if (varMatch && valueMatch) {
                const varName = varMatch[1].trim();
                const valueExpr = valueMatch[1].trim();
                const resolvedType = this.resolveExpressionType(valueExpr, scopes);
                if (resolvedType) {
                    scopes.set(varName, resolvedType);
                }
            }
        }

        // 2. Detectar <ui:param name="..." value="..."/>
        const paramRe = /<([\w.-]+):param\b([^>]*)\/?>/gi;
        while ((match = paramRe.exec(textBeforeCursor)) !== null) {
            const attrs = match[2];
            const nameMatch = /\bname\s*=\s*["']([^"']+)["']/i.exec(attrs);
            const valueMatch = /\bvalue\s*=\s*["']([^"']+)["']/i.exec(attrs);

            if (nameMatch && valueMatch) {
                const paramName = nameMatch[1].trim();
                const valueExpr = valueMatch[1].trim();
                const resolvedType = this.resolveExpressionType(valueExpr, scopes);
                if (resolvedType) {
                    scopes.set(paramName, resolvedType);
                }
            }
        }

        return scopes;
    }

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
            return this.classIndex.unwrapGenericType(resolved.targetType);
        }

        return undefined;
    }
}

