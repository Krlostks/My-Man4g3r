/**
 * ElHoverProvider — Muestra información de Beans Java al hacer hover
 * sobre expresiones EL (#{bean.member}) en archivos XHTML.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { BeanRegistry } from '../../AI/BeanRegistry';
import { XhtmlExpressionParser } from '../../AI/XhtmlExpressionParser';

export class ElHoverProvider implements vscode.HoverProvider {

    constructor(private registry: BeanRegistry) {}

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.Hover | null {

        const expr = XhtmlExpressionParser.parse(document, position);
        if (!expr) { return null; }

        const entry = this.registry.resolve(expr.beanName);
        if (!entry) { return null; }

        const md = new vscode.MarkdownString();
        md.isTrusted = true;

        if (expr.cursorOnBean) {
            md.appendMarkdown(`**CDI Bean** \`@Named\`\n\n`);
            md.appendMarkdown(`| | |\n|---|---|\n`);
            md.appendMarkdown(`| **Nombre EL** | \`${entry.beanName}\` |\n`);
            md.appendMarkdown(`| **Clase** | \`${entry.className}\` |\n`);
            md.appendMarkdown(`| **Campos** | ${entry.fields.size} |\n`);
            md.appendMarkdown(`| **Métodos** | ${entry.methods.size} |\n`);
            return new vscode.Hover(md);
        }

        // Hover sobre miembro
        const memberName = expr.clickedPart || expr.memberName;
        const isMethod = entry.methods.has(memberName);
        const isField = entry.fields.has(memberName);

        if (!isMethod && !isField) {
            // Intentar resolver en tipo anidado
            if (expr.memberName.includes('.')) {
                return this.hoverNestedMember(entry, expr, md);
            }
            return null;
        }

        if (isField) {
            const type = entry.fieldTypes?.get(memberName) || 'unknown';
            md.appendMarkdown(`**Campo** de \`${entry.className}\`\n\n`);
            md.appendMarkdown(`\`\`\`java\n${type} ${memberName}\n\`\`\`\n`);
        } else {
            const sig = this.findMethodSignature(entry.filePath, memberName);
            md.appendMarkdown(`**Método** de \`${entry.className}\`\n\n`);
            md.appendMarkdown(`\`\`\`java\n${sig || `public ? ${memberName}(...)`}\n\`\`\`\n`);
        }

        return new vscode.Hover(md);
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    private hoverNestedMember(
        entry: { filePath: string; className: string; fieldTypes?: Map<string, string> },
        expr: { memberName: string; clickedPart?: string },
        md: vscode.MarkdownString
    ): vscode.Hover | null {
        const parts = expr.memberName.split('.');
        const target = expr.clickedPart || parts[parts.length - 1];
        let currentFile = entry.filePath;

        const targetIdx = parts.indexOf(target);
        for (let i = 0; i < targetIdx; i++) {
            const ft = i === 0
                ? entry.fieldTypes?.get(parts[i])
                : this.readFieldType(currentFile, parts[i]);
            if (!ft) { return null; }
            const clean = ft.replace(/<.*>/, '').replace(/\[\]/, '').trim();
            const next = this.registry.getClassFile(clean);
            if (!next) { return null; }
            currentFile = next;
        }

        const type = this.readFieldType(currentFile, target);
        if (type) {
            md.appendMarkdown(`**Campo anidado**\n\n`);
            md.appendMarkdown(`\`\`\`java\n${type} ${target}\n\`\`\`\n`);
            return new vscode.Hover(md);
        }
        return null;
    }

    private readFieldType(filePath: string, fieldName: string): string | undefined {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const re = new RegExp(
                `^\\s*(?:private|protected|public)\\s+(?!static\\s)([A-Za-z0-9_<>\\[\\],\\s.]+?)\\s+${fieldName}\\s*[=;]`, 'm'
            );
            const m = re.exec(content);
            return m ? m[1].trim() : undefined;
        } catch { return undefined; }
    }

    private findMethodSignature(filePath: string, methodName: string): string | undefined {
        try {
            const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
            const re = new RegExp(`public\\s+(.+\\s+${methodName}\\s*\\([^)]*\\))`);
            for (const line of lines) {
                const m = re.exec(line);
                if (m) { return `public ${m[1].trim()}`; }
            }
        } catch { /* ignore */ }
        return undefined;
    }
}
