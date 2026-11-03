import * as vscode from 'vscode';
import { NamespaceRegistry } from '../registry/NamespaceRegistry';
import { analyze } from '../parsing/TagContext';

/**
 * Proveedor de autocompletado para etiquetas y atributos de JSF / Jakarta / PrimeFaces / OmniFaces.
 * Si el cursor está dentro de una expresión EL (#{...}), delega en los proveedores EL.
 */
export class FacesCompletionProvider implements vscode.CompletionItemProvider {
    constructor(private readonly registry: NamespaceRegistry) {}

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] | null {
        const textBefore = document.getText(
            new vscode.Range(new vscode.Position(0, 0), position)
        );

        const ctx = analyze(textBefore);

        // Si estamos dentro de EL (#{...}) o en un valor de atributo sin contexto de etiqueta, no interferir
        if (ctx.kind === 'none' || ctx.kind === 'el' || ctx.kind === 'attrValue') {
            return null;
        }

        if (ctx.kind === 'tagName') {
            return this.suggestComponents(document, ctx.prefix, ctx.partial);
        }

        if (ctx.kind === 'attrName') {
            return this.suggestAttributes(document, ctx.prefix, ctx.component, ctx.used);
        }

        return null;
    }

    private suggestComponents(
        document: vscode.TextDocument,
        prefix: string,
        partial: string
    ): vscode.CompletionItem[] | null {
        const ns = this.registry.resolve(document, prefix);
        if (!ns) {
            return null;
        }

        const components = this.registry.components(ns);
        const results: vscode.CompletionItem[] = [];
        const lowerPartial = partial.toLowerCase();

        for (const comp of components.values()) {
            if (partial && !comp.name.toLowerCase().startsWith(lowerPartial)) {
                continue;
            }

            const item = new vscode.CompletionItem(comp.name, vscode.CompletionItemKind.Class);
            item.detail = `${ns.label}: <${prefix}:${comp.name}>`;
            item.insertText = comp.name;

            if (comp.description) {
                const md = new vscode.MarkdownString();
                md.appendMarkdown(`### \`<${prefix}:${comp.name}>\`\n\n`);
                md.appendMarkdown(comp.description);
                item.documentation = md;
            }

            results.push(item);
        }

        return results.length > 0 ? results : null;
    }

    private suggestAttributes(
        document: vscode.TextDocument,
        prefix: string,
        componentName: string,
        used: Set<string>
    ): vscode.CompletionItem[] | null {
        const ns = this.registry.resolve(document, prefix);
        if (!ns) {
            return null;
        }

        const comp = this.registry.components(ns).get(componentName);
        if (!comp || !comp.attributes) {
            return null;
        }

        const results: vscode.CompletionItem[] = [];

        for (const attr of comp.attributes) {
            if (used.has(attr.name)) {
                continue;
            }

            const item = new vscode.CompletionItem(attr.name, vscode.CompletionItemKind.Property);
            item.detail = `${attr.required ? '(Requerido) ' : ''}${attr.type || ''}`.trim();
            item.insertText = new vscode.SnippetString(`${attr.name}="$1"`);

            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**${attr.name}**\n\n`);
            if (attr.description) {
                md.appendMarkdown(`${attr.description}\n\n`);
            }
            if (attr.type) {
                md.appendMarkdown(`**Tipo:** \`${attr.type}\`\n\n`);
            }
            if (attr.required) {
                md.appendMarkdown(`**Requerido:** \`true\`\n`);
            }
            item.documentation = md;

            // Priorizar atributos requeridos en la lista
            item.sortText = attr.required ? `0_${attr.name}` : `1_${attr.name}`;

            results.push(item);
        }

        return results.length > 0 ? results : null;
    }
}

