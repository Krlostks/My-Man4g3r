/**
 * ElCompletionProvider — Autocompletado inteligente para expresiones EL en XHTML.
 *
 * Contextos soportados:
 *  1. #{|        → sugiere todos los bean names del BeanRegistry
 *  2. #{bean.|   → sugiere métodos y fields del bean
 *  3. #{bean.prop.| → resuelve tipo anidado y sugiere sus miembros
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { BeanRegistry } from '../../AI/BeanRegistry';

// Regex para campos de instancia (copiada de BeanScanner para reusar)
const RE_FIELD = /^\s*(?:private|protected|public)\s+(?!static\s|final\s+static\s)([A-Za-z0-9_<>\[\],\s.]+?)\s+(\w+)\s*[=;]/gm;
const RE_METHOD = /^\s*public\s+(?!static\s+(?:void\s+main|class))(?:(\w[\w<>\[\],\s]*?)\s+)(\w+)\s*\(/gm;

export class ElCompletionProvider implements vscode.CompletionItemProvider {

    constructor(private registry: BeanRegistry) {}

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] | null {

        const line = document.lineAt(position.line).text;
        const col = position.character;
        const textBefore = line.substring(0, col);

        // Detectar si estamos dentro de una expresión EL: #{...
        // Buscar el último #{ sin } cerrando
        const elStart = textBefore.lastIndexOf('#{');
        if (elStart === -1) { return null; }

        const afterEl = textBefore.substring(elStart + 2);
        if (afterEl.includes('}')) { return null; } // ya cerrada

        // Caso 1: sin punto → sugerir bean names
        if (!afterEl.includes('.')) {
            return this.suggestBeans(afterEl);
        }

        // Caso 2+: con punto(s) → resolver cadena
        const parts = afterEl.split('.');
        const beanName = parts[0];
        const entry = this.registry.resolve(beanName);
        if (!entry) { return null; }

        // Si solo hay 1 punto → sugerir miembros directos del bean
        if (parts.length === 2) {
            return this.suggestMembers(entry.methods, entry.fields, entry.fieldTypes, parts[1]);
        }

        // Múltiples puntos → resolver tipo por cadena
        let currentFilePath = entry.filePath;
        for (let i = 1; i < parts.length - 1; i++) {
            const fieldName = parts[i];
            let fieldType: string | undefined;

            if (i === 1) {
                fieldType = entry.fieldTypes?.get(fieldName);
            } else {
                fieldType = this.findFieldType(currentFilePath, fieldName);
            }

            if (!fieldType) { return null; }

            const cleanType = fieldType.replace(/<.*>/, '').replace(/\[\]/, '').trim();
            const nextFile = this.registry.getClassFile(cleanType);
            if (!nextFile) { return null; }
            currentFilePath = nextFile;
        }

        // Leer el archivo final y extraer sus miembros
        const { methods, fields, fieldTypes } = this.extractMembersFromFile(currentFilePath);
        const prefix = parts[parts.length - 1];
        return this.suggestMembers(methods, fields, fieldTypes, prefix);
    }

    // ─── Sugerencias ────────────────────────────────────────────────────────

    private suggestBeans(prefix: string): vscode.CompletionItem[] {
        const names = this.registry.allBeanNames();
        return names
            .filter(n => n.startsWith(prefix))
            .map(name => {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
                const entry = this.registry.resolve(name);
                item.detail = entry ? `CDI Bean → ${entry.className}` : 'CDI Bean';
                item.sortText = `0_${name}`;
                return item;
            });
    }

    private suggestMembers(
        methods: Set<string>,
        fields: Set<string>,
        fieldTypes: Map<string, string>,
        prefix: string
    ): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];

        for (const field of fields) {
            if (prefix && !field.startsWith(prefix)) { continue; }
            const item = new vscode.CompletionItem(field, vscode.CompletionItemKind.Field);
            item.detail = fieldTypes.get(field) || 'field';
            item.sortText = `0_${field}`;
            items.push(item);
        }

        for (const method of methods) {
            if (prefix && !method.startsWith(prefix)) { continue; }
            const item = new vscode.CompletionItem(method, vscode.CompletionItemKind.Method);
            item.detail = 'method';
            item.sortText = `1_${method}`;
            items.push(item);
        }

        return items;
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    private findFieldType(filePath: string, fieldName: string): string | undefined {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const re = new RegExp(
                `^\\s*(?:private|protected|public)\\s+(?!static\\s|final\\s+static\\s)([A-Za-z0-9_<>\\[\\],\\s.]+?)\\s+${fieldName}\\s*[=;]`, 'm'
            );
            const match = re.exec(content);
            return match ? match[1].trim() : undefined;
        } catch { return undefined; }
    }

    private extractMembersFromFile(filePath: string): {
        methods: Set<string>; fields: Set<string>; fieldTypes: Map<string, string>;
    } {
        const methods = new Set<string>();
        const fields = new Set<string>();
        const fieldTypes = new Map<string, string>();

        try {
            const content = fs.readFileSync(filePath, 'utf-8');

            let m: RegExpExecArray | null;
            const reF = new RegExp(RE_FIELD.source, 'gm');
            while ((m = reF.exec(content)) !== null) {
                fields.add(m[2]);
                fieldTypes.set(m[2], m[1].trim());
            }

            const reM = new RegExp(RE_METHOD.source, 'gm');
            while ((m = reM.exec(content)) !== null) {
                methods.add(m[2]);
            }
        } catch { /* archivo no accesible */ }

        return { methods, fields, fieldTypes };
    }
}
