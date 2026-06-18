import * as vscode from "vscode"
import { NamespacerRegistry } from "../registry/NamespaceRegistry";
export class XhtmlHoverProvider implements vscode.HoverProvider {

    private registry: NamespacerRegistry;
    constructor(registry: NamespacerRegistry) {
        this.registry = registry;
    }

    provideHover(documento: vscode.TextDocument, posicion: vscode.Position): vscode.Hover | null {
        this.registry.detectarNamespacers(documento, posicion);
        const palabraEnRango = documento.getWordRangeAtPosition(posicion, /[\w:]+/)
        if (!palabraEnRango) {
            return null;
        }
        const palabra = documento.getText(palabraEnRango)

        // por si el cursor esta en algo como p:datatable

        if (palabra.includes(':')) {
            const [prefijo, componente] = palabra.split(':')
            return this.proveedorHoverComponente(prefijo, componente, posicion)
        }

        //por si el cursor esta en algo como value="" (dentro de un componente)
        const lineaActual = documento.lineAt(posicion.line).text
        const attrMatch = lineaActual.match(/([a-zA-Z_][\w:]*)=["'][^"']*$/);
        if (attrMatch) {
            const attrNombre = attrMatch[1];
            return this.proveedorHoverAtributos(documento, posicion, attrNombre);
        }

        return null;
    }

    private proveedorHoverComponente(prefijo: string, componente: string, position: vscode.Position): vscode.Hover | null {
        const alias = `<${prefijo}:`
        const ns = this.registry.obtenerNameSpace(alias);
        if (!ns) {
            return null;
        }
        const definiciones = this.registry.obtenerDefiniciones(ns);

        const def = definiciones.find(d => 
            d.componente.nombre === componente
        )
        if (!def) {
            return null;
        }

        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${def.componente.nombre}**\n\n`)
        if (def.componente.descripcion) {
            markdown.appendMarkdown(`${def.componente.descripcion}\n\n`)
        } else {
            markdown.appendMarkdown(`Sin descripción`)
        }
        return new vscode.Hover(markdown, new vscode.Range(new vscode.Position(0, 0), position));
    }
    private proveedorHoverAtributos(documento: vscode.TextDocument, posicion: vscode.Position, atributoNombre: string): vscode.Hover | null {
        //Primero ubicaremos el componente actual
        const rango = new vscode.Range(new vscode.Position(0, 0), posicion);
        const palabraCompleta = documento.getText(rango);

        const ultimaEtiquetaAbierta = palabraCompleta.lastIndexOf('<');
        if (ultimaEtiquetaAbierta === -1) {
            return null;
        }

        const textoTag = palabraCompleta.substring(ultimaEtiquetaAbierta)
        const textoCoincidente = textoTag.match(/<([a-zA-Z_][\w]*):([a-zA-Z_][\w]*)/)

        if (!textoCoincidente) {
            return null;
        }

        const prefijo = textoCoincidente[1];
        const componenteNombre = textoCoincidente[2];
        const alias = `<${prefijo}:`;
        const ns = this.registry.obtenerNameSpace(alias);
        if (!ns) {
            return null;
        }
        const definiciones = this.registry.obtenerDefiniciones(ns);
        const defComponente = definiciones.find(d => d.componente.nombre === componenteNombre);
        if (!defComponente) {
            return null;
        }
        const attrDef = defComponente.componente.atributos.find(a => a.name === atributoNombre);
        if (!attrDef) {
            return null;
        }
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${attrDef.name } **\n\n`)
        markdown.appendMarkdown(attrDef.description || 'Sin descripción');
        markdown.appendMarkdown(`\n\n**requerido:** ${attrDef.required}\n`);
        markdown.appendMarkdown(`\n\n**tipo:** ${attrDef.type}\n`);
        return new vscode.Hover(markdown, new vscode.Range(new vscode.Position(0, 0), posicion));
    }       
}