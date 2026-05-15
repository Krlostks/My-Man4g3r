/**
 * XhtmlExpressionParser — Extrae la expresión EL bajo el cursor en un XHTML.
 *
 * Ejemplos de expresiones JSF/EL que maneja:
 *   #{clienteBean.guardar}
 *   #{clienteBean.nombre}
 *   action="#{pedidoBean.procesar}"
 *   value="#{usuarioBean.correo}"
 *
 * Devuelve el beanName y el memberName (método o field) bajo el cursor,
 * o undefined si el cursor no está sobre una expresión EL válida.
 */

import * as vscode from 'vscode';

export interface ElExpression {
    /** Nombre del bean (parte antes del punto): "clienteBean" */
    beanName: string;
    /** Nombre del miembro (parte después del punto): "guardar" */
    memberName: string;
    /** ¿El cursor está sobre el beanName (true) o el memberName (false)? */
    cursorOnBean: boolean;
}

export class XhtmlExpressionParser {

    /**
     * Analiza la línea bajo el cursor y devuelve la expresión EL si existe.
     * Soporta el patrón #{bean.member} con cualquier contenido alrededor.
     */
    static parse(
        document: vscode.TextDocument,
        position: vscode.Position
    ): ElExpression | undefined {

        const line = document.lineAt(position.line).text;
        const col = position.character;

        // Buscar TODAS las expresiones EL en la línea
        // Patrón: #{ ... } con al menos un punto
        const RE_EL = /\#\{([a-zA-Z_][\w]*?)\.([a-zA-Z_][\w]*?)(?:[(\s,}])/g;

        let match: RegExpExecArray | null;
        while ((match = RE_EL.exec(line)) !== null) {
            const exprStart = match.index;           // posición del '#'
            const exprEnd   = RE_EL.lastIndex;       // posición tras el último char capturado

            // ¿El cursor está dentro de esta expresión?
            if (col < exprStart || col > exprEnd) { continue; }

            const beanName   = match[1];
            const memberName = match[2];

            // ¿El cursor está sobre el beanName o el memberName?
            const beanStart   = exprStart + 2;               // +2 por "#{"
            const beanEnd     = beanStart + beanName.length;
            const memberStart = beanEnd + 1;                  // +1 por "."
            const memberEnd   = memberStart + memberName.length;

            const cursorOnBean = col >= beanStart && col <= beanEnd;
            const cursorOnMember = col >= memberStart && col <= memberEnd;

            if (!cursorOnBean && !cursorOnMember) { continue; }

            return { beanName, memberName, cursorOnBean };
        }

        return undefined;
    }
}
