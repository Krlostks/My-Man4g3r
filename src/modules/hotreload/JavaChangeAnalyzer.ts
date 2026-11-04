import * as crypto from 'crypto';

export type JavaChangeKind = 'unchanged' | 'method-body' | 'structural' | 'unknown';

export interface JavaSnapshot {
    contentHash: string;
    structureHash: string;
    bodyHash: string;
}

export interface JavaChangeAnalysis {
    kind: JavaChangeKind;
    previous: JavaSnapshot;
    current: JavaSnapshot;
}

interface JavaMethod {
    signature: string;
    body: string;
}

/**
 * Compara la estructura declarada de una clase Java sin depender de git ni del mtime.
 * Es un analizador ligero: no reemplaza un AST completo, pero evita clasificar cada
 * método existente como estructural, que era el comportamiento anterior.
 */
export class JavaChangeAnalyzer {
    static analyze(previousContent: string, currentContent: string): JavaChangeAnalysis {
        const previous = this.createSnapshot(previousContent);
        const current = this.createSnapshot(currentContent);

        if (previous.contentHash === current.contentHash) {
            return { kind: 'unchanged', previous, current };
        }
        if (previous.structureHash !== current.structureHash) {
            return { kind: 'structural', previous, current };
        }
        if (previous.bodyHash !== current.bodyHash) {
            return { kind: 'method-body', previous, current };
        }
        return { kind: 'unchanged', previous, current };
    }

    static createSnapshot(content: string): JavaSnapshot {
        const sanitized = this.sanitize(content);
        const methods = this.extractMethods(sanitized);
        const methodSignatures = methods.map(method => method.signature).sort();
        const fields = this.extractFields(sanitized, methods).sort();
        const classDeclaration = this.extractClassDeclaration(sanitized);
        const structure = JSON.stringify({ classDeclaration, fields, methodSignatures });
        const bodies = methods
            .map(method => `${method.signature}:{${this.normalize(method.body)}}`)
            .sort()
            .join('|');

        return {
            contentHash: this.hash(this.normalize(sanitized)),
            structureHash: this.hash(structure),
            bodyHash: this.hash(bodies),
        };
    }

    private static extractMethods(content: string): JavaMethod[] {
        const methods: JavaMethod[] = [];
        const methodPattern = /((?:(?:public|protected|private|static|final|synchronized|abstract|native|strictfp|default)\s+)*(?:<[^>{}]+>\s*)?(?:[\w$?.<>\[\],]+\s+)?[\w$]+\s*\([^(){}]*\)(?:\s+throws\s+[\w$.,\s]+)?\s*)\{/g;
        let match: RegExpExecArray | null;

        while ((match = methodPattern.exec(content)) !== null) {
            const declaration = match[1].trim();
            const nameMatch = declaration.match(/([\w$]+)\s*\([^(){}]*\)\s*(?:throws\s+[\w$.,\s]+)?$/);
            if (!nameMatch || this.isControlStatement(nameMatch[1])) { continue; }

            const openBrace = methodPattern.lastIndex - 1;
            const closeBrace = this.findMatchingBrace(content, openBrace);
            if (closeBrace < 0) { continue; }

            methods.push({
                signature: this.normalizeSignature(declaration),
                body: content.slice(openBrace + 1, closeBrace),
            });
            methodPattern.lastIndex = closeBrace + 1;
        }

        return methods;
    }

    private static extractFields(content: string, _methods: JavaMethod[]): string[] {
        const fields: string[] = [];
        let depth = 0;
        let statementStart = -1;

        for (let index = 0; index < content.length; index++) {
            const character = content[index];
            if (character === '{') {
                depth++;
                if (depth === 1) { statementStart = index + 1; }
                continue;
            }
            if (character === '}') {
                depth--;
                statementStart = depth === 1 ? index + 1 : statementStart;
                continue;
            }
            if (character === ';' && depth === 1 && statementStart >= 0) {
                const declaration = this.normalize(content.slice(statementStart, index));
                if (/^(?:(?:public|protected|private|static|final|volatile|transient)\s+)*[\w$<>,.?\[\]]+\s+[\w$]+(?:\s*=.*)?$/.test(declaration)) {
                    fields.push(declaration);
                }
                statementStart = index + 1;
            }
        }

        return fields;
    }

    private static extractClassDeclaration(content: string): string {
        const declarations = content.match(/\b(?:class|interface|enum|record)\s+[\w$]+[^\{]*/g) ?? [];
        return declarations.map(value => this.normalize(value)).sort().join('|');
    }

    private static sanitize(content: string): string {
        return content
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/\/\/[^\r\n]*/g, ' ')
            .replace(/"(?:\\.|[^"\\])*"/g, '""')
            .replace(/'(?:\\.|[^'\\])*'/g, "''");
    }

    private static normalize(value: string): string {
        return value.replace(/\s+/g, ' ').trim();
    }

    private static normalizeSignature(value: string): string {
        return this.normalize(value)
            .replace(/\s*,\s*/g, ',')
            .replace(/\s*([()<>\[\]])\s*/g, '$1');
    }

    private static findMatchingBrace(content: string, openingBrace: number): number {
        let depth = 0;
        for (let index = openingBrace; index < content.length; index++) {
            if (content[index] === '{') { depth++; }
            if (content[index] === '}') {
                depth--;
                if (depth === 0) { return index; }
            }
        }
        return -1;
    }

    private static isControlStatement(name: string): boolean {
        return new Set(['if', 'for', 'while', 'switch', 'catch', 'try', 'do', 'synchronized']).has(name);
    }

    private static hash(value: string): string {
        return crypto.createHash('sha256').update(value, 'utf8').digest('hex').substring(0, 16);
    }
}
