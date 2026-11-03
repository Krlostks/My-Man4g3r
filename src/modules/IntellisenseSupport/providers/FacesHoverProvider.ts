import * as vscode from 'vscode';
import { NamespaceRegistry } from '../registry/NamespaceRegistry';
import { enclosingTag } from '../parsing/TagContext';
import { openElIndex } from '../parsing/ElParser';

/**
 * Proveedor de Hover para componentes y atributos JSF / Jakarta / PrimeFaces / OmniFaces.
 * Si el cursor está sobre una expresión EL (#{...}), delega en el proveedor EL.
 */
export class FacesHoverProvider implements vscode.HoverProvider {
    constructor(private readonly registry: NamespaceRegistry) {}

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.Hover | null {
        const textBefore = document.getText(
            new vscode.Range(new vscode.Position(0, 0), position)
        );

        // Si el cursor cae dentro de #{...}, dejar que el hover de EL actúe
        if (openElIndex(textBefore) >= 0) {
            return null;
        }

        const wordRange = document.getWordRangeAtPosition(position, /[\w:.-]+/);
        if (!wordRange) {
            return null;
        }

        const word = document.getText(wordRange);

        // Caso 1: hover sobre etiqueta "prefix:componente"
        if (word.includes(':')) {
            const [prefix, componentName] = word.split(':');
            return this.hoverComponent(document, prefix, componentName, wordRange);
        }

        // Caso 2: hover sobre atributo dentro de una etiqueta
        const enc = enclosingTag(textBefore);
        if (enc) {
            return this.hoverAttribute(document, enc.prefix, enc.component, word, wordRange);
        }

        return null;
    }

    private hoverComponent(
        document: vscode.TextDocument,
        prefix: string,
        componentName: string,
        range: vscode.Range
    ): vscode.Hover | null {
        const ns = this.registry.resolve(document, prefix);
        if (!ns) {
            return null;
        }

        const comp = this.registry.components(ns).get(componentName);
        if (!comp) {
            return null;
        }

        const md = new vscode.MarkdownString();
        md.appendMarkdown(`### \`<${prefix}:${comp.name}>\`\n\n`);
        md.appendMarkdown(`*${ns.label} Component*\n\n`);

        if (comp.description) {
            md.appendMarkdown(`${comp.description}\n\n`);
        } else {
            md.appendMarkdown(`*Sin descripción disponible.*\n\n`);
        }

        if (comp.attributes && comp.attributes.length > 0) {
            md.appendMarkdown(`**Atributos disponibles:** ${comp.attributes.length}\n`);
        }

        return new vscode.Hover(md, range);
    }

    private hoverAttribute(
        document: vscode.TextDocument,
        prefix: string,
        componentName: string,
        attributeName: string,
        range: vscode.Range
    ): vscode.Hover | null {
        const ns = this.registry.resolve(document, prefix);
        if (!ns) {
            return null;
        }

        const comp = this.registry.components(ns).get(componentName);
        if (!comp || !comp.attributes) {
            return null;
        }

        const attr = comp.attributes.find((a) => a.name === attributeName);
        if (!attr) {
            return null;
        }

        const md = new vscode.MarkdownString();
        md.appendMarkdown(`### \`${attr.name}\`\n\n`);
        md.appendMarkdown(`*Atributo de \`<${prefix}:${componentName}>\` (${ns.label})*\n\n`);

        if (attr.description) {
            md.appendMarkdown(`${attr.description}\n\n`);
        } else {
            md.appendMarkdown(`*Sin descripción disponible.*\n\n`);
        }

        if (attr.type) {
            md.appendMarkdown(`**Tipo:** \`${attr.type}\`\n\n`);
        }
        if (attr.required) {
            md.appendMarkdown(`**Requerido:** \`true\`\n`);
        }

        return new vscode.Hover(md, range);
    }
}

