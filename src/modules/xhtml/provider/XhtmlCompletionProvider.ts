import * as vscode from 'vscode';
import { NamespacerRegistry } from "../registry/NamespaceRegistry";

export class XhtmlCompletionProvider implements vscode.CompletionItemProvider {

    private registry: NamespacerRegistry;

    constructor(registry: NamespacerRegistry) {
        this.registry = registry;
    }

    provideCompletionItems(
        documento: vscode.TextDocument,
        posicionCursor: vscode.Position
    ): vscode.CompletionItem[] | null {

        const lineaActual = documento.lineAt(posicionCursor.line).text;
        const columnaCursor = posicionCursor.character;
        const textoHastaCursor = lineaActual.substring(0, columnaCursor);

        // Caso 1: cursor en "<prefix:" o "<prefix:nombre" → sugerir componentes
        const esEtiqueta = this.estaEnEtiqueta(textoHastaCursor);

        // Caso 2: cursor dentro de un tag "<prefix:componente ...atributo|"
        // — detectar si hay un tag con prefijo: abierto sin cerrar en la línea o antes
        const esAtributo = !esEtiqueta && this.estaEnTagConPrefijo(documento, posicionCursor);

        // Si ninguno de los dos contextos aplica → devolver null y no hacer nada más
        if (!esEtiqueta && !esAtributo) {
            return null;
        }

        // Solo detectar namespaces cuando realmente vamos a usarlos
        this.registry.detectarNamespacers(documento, posicionCursor);

        const rango = new vscode.Range(new vscode.Position(0, 0), posicionCursor);
        const textoAntesDelCursor = documento.getText(rango);

        if (esEtiqueta) {
            const items = this.proveedorCompletadoComponentes(textoAntesDelCursor);
            return items.length > 0 ? items : null;
        }

        // esAtributo
        const infoComponente = this.obtenerComponenteActual(documento, posicionCursor);
        if (infoComponente) {
            const items = this.sugeridorDeAtributos(infoComponente);
            return items.length > 0 ? items : null;
        }

        return null;
    }

    /**
     * Detecta si el cursor está justo después de "<prefix:" o "<prefix:nombre"
     * Ejemplo: "<p:" o "<p:commandBu"
     */
    private estaEnEtiqueta(textoHastaCursor: string): boolean {
        return /<([a-zA-Z_][\w]*):([a-zA-Z_][\w]*)?$/.test(textoHastaCursor);
    }

    /**
     * Detecta si el cursor está dentro de un tag con prefijo namespace abierto.
     * Busca hacia atrás el último '<' y verifica que sea "<prefix:componente"
     * sin que haya un '>' cerrando antes del cursor.
     * Solo aplica si el prefijo tiene un namespace registrado.
     */
    private estaEnTagConPrefijo(documento: vscode.TextDocument, posicion: vscode.Position): boolean {
        const rango = new vscode.Range(new vscode.Position(0, 0), posicion);
        const texto = documento.getText(rango);

        const ultimoTagAbierto = texto.lastIndexOf('<');
        if (ultimoTagAbierto === -1) { return false; }

        const fragmento = texto.substring(ultimoTagAbierto);

        // Si hay '>' o '</' después del '<', ya no estamos dentro del tag
        if (fragmento.includes('>') || fragmento.includes('</')) { return false; }

        // Verificar que el tag tenga formato "prefix:componente"
        return /<([a-zA-Z_][\w]*):([a-zA-Z_][\w]*)/.test(fragmento);
    }

    private proveedorCompletadoComponentes(texto: string): vscode.CompletionItem[] {
        const resultado: vscode.CompletionItem[] = [];

        const tagCoincidente = texto.match(/<([a-zA-Z_][\w]*):([a-zA-Z_][\w]*)?$/);
        if (!tagCoincidente) { return resultado; }

        const prefijo = tagCoincidente[1];
        const textoBuscado = tagCoincidente[2] || '';
        const alias = `<${prefijo}:`;

        const ns = this.registry.obtenerNameSpace(alias);
        if (!ns) { return resultado; }

        const definiciones = this.registry.obtenerDefiniciones(ns);
        const definicionesFiltradas = textoBuscado
            ? definiciones.filter(def => def.componente.nombre.startsWith(textoBuscado))
            : definiciones;

        for (const def of definicionesFiltradas) {
            const item = new vscode.CompletionItem(def.componente.nombre, vscode.CompletionItemKind.Class);
            item.documentation = new vscode.MarkdownString(def.componente.descripcion);
            item.insertText = def.componente.nombre;
            item.detail = `PrimeFaces: ${def.componente.nombre}`;
            resultado.push(item);
        }
        return resultado;
    }

    private obtenerComponenteActual(documento: vscode.TextDocument, posicion: vscode.Position) {
        const range = new vscode.Range(new vscode.Position(0, 0), posicion);
        const textoDetectado = documento.getText(range);

        const ultimoTagAbierto = textoDetectado.lastIndexOf('<');
        if (ultimoTagAbierto === -1) { return null; }

        const tag = textoDetectado.substring(ultimoTagAbierto);
        if (tag.includes('>') || tag.includes('</')) { return null; }

        const tagCoincidente = tag.match(/<([a-zA-Z_][\w]*):([a-zA-Z_][\w]*)/);
        if (!tagCoincidente) { return null; }

        const prefijo = tagCoincidente[1];
        const componente = tagCoincidente[2];

        const attrsRegex = /([a-zA-Z_][\w]*)=("[^"]*"|'[^']*')/g;
        const atributosUsados: string[] = [];
        let attrMatch;
        while ((attrMatch = attrsRegex.exec(tag)) !== null) {
            atributosUsados.push(attrMatch[1]);
        }

        return { prefijo, componente, atributosUsados };
    }

    private sugeridorDeAtributos(info: { prefijo: string, componente: string, atributosUsados: string[] }): vscode.CompletionItem[] {
        const resultado: vscode.CompletionItem[] = [];
        const alias = `<${info.prefijo}:`;
        const ns = this.registry.obtenerNameSpace(alias);
        if (!ns) { return resultado; }

        const definiciones = this.registry.obtenerDefiniciones(ns);
        const definicionComponente = definiciones.find(def => def.componente.nombre === info.componente);
        if (!definicionComponente) { return resultado; }

        for (const attr of definicionComponente.componente.atributos) {
            if (info.atributosUsados.includes(attr.name)) { continue; }
            const item = new vscode.CompletionItem(attr.name, vscode.CompletionItemKind.Property);
            item.documentation = new vscode.MarkdownString(attr.description);
            item.insertText = new vscode.SnippetString(`${attr.name}="$1"`);
            item.detail = `${attr.required ? '(required) ' : ''}${attr.type}`;
            resultado.push(item);
        }
        return resultado;
    }
}
