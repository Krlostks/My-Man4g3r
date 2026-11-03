import * as vscode from 'vscode';
import * as fs from 'fs';
import { BeanRegistry } from '../../../AI/BeanRegistry';
import { JavaClassIndex } from '../../java/JavaClassIndex';
import { findElRegions, extractRefs, collectRefs } from '../../parsing/ElParser';
import { ScopeResolver } from '../../parsing/ScopeResolver';

export class ElRenameProvider implements vscode.RenameProvider {
    private readonly scopeResolver: ScopeResolver;

    constructor(
        private readonly registry: BeanRegistry,
        private readonly classIndex: JavaClassIndex
    ) {
        this.scopeResolver = new ScopeResolver(classIndex);
    }

    prepareRename(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.Range | null {
        const fullText = document.getText();
        const offset = document.offsetAt(position);

        const regions = findElRegions(fullText);
        const region = regions.find((r) => offset >= r.bodyStart && offset <= r.bodyEnd);
        if (!region) {
            return null;
        }

        const refs = extractRefs(fullText, region.bodyStart, region.bodyEnd);
        for (const ref of refs) {
            const seg = ref.segments.find((s) => offset >= s.start && offset <= s.end);
            if (seg) {
                return new vscode.Range(
                    document.positionAt(seg.start),
                    document.positionAt(seg.end)
                );
            }
        }

        return null;
    }

    async provideRenameEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        newName: string,
        _token: vscode.CancellationToken
    ): Promise<vscode.WorkspaceEdit | null> {
        const fullText = document.getText();
        const offset = document.offsetAt(position);

        const regions = findElRegions(fullText);
        const region = regions.find((r) => offset >= r.bodyStart && offset <= r.bodyEnd);
        if (!region) {
            return null;
        }

        const refs = extractRefs(fullText, region.bodyStart, region.bodyEnd);
        let targetRef: (typeof refs)[0] | undefined;
        let targetSegIdx = -1;

        for (const ref of refs) {
            const idx = ref.segments.findIndex((s) => offset >= s.start && offset <= s.end);
            if (idx !== -1) {
                targetRef = ref;
                targetSegIdx = idx;
                break;
            }
        }

        if (!targetRef || targetSegIdx === -1) {
            return null;
        }

        const oldName = targetRef.segments[targetSegIdx].name;
        if (oldName === newName) {
            return null;
        }

        const isRootBean = targetSegIdx === 0;
        const rootBeanName = targetRef.segments[0].name;

        // Si es miembro, determinar la clase que lo declara
        let declaringClass: string | undefined;
        if (!isRootBean) {
            const chain = targetRef.segments.slice(0, targetSegIdx + 1).map((s) => s.name);
            const textBefore = fullText.substring(0, targetRef.segments[0].start);
            const scopeVars = this.scopeResolver.resolveScopeVariables(textBefore, fullText, targetRef.segments[0].start);
            const resolved = this.classIndex.resolveChain(rootBeanName, chain, scopeVars);
            declaringClass = resolved?.declaringClass;
        }

        const edit = new vscode.WorkspaceEdit();

        // 1. Buscar en todos los archivos .xhtml del workspace usando fs para eficiencia
        const xhtmlUris = await vscode.workspace.findFiles('**/*.xhtml', '**/node_modules/**');

        for (const uri of xhtmlUris) {
            try {
                const content = await fs.promises.readFile(uri.fsPath, 'utf-8');
                const fileRefs = collectRefs(content);

                for (const fRef of fileRefs) {
                    if (isRootBean) {
                        if (fRef.segments.length > 0 && fRef.segments[0].name === oldName) {
                            const seg = fRef.segments[0];
                            const start = this.positionFromOffset(content, seg.start);
                            const end = this.positionFromOffset(content, seg.end);
                            edit.replace(uri, new vscode.Range(start, end), newName);
                        }
                    } else {
                        // Miembro: verificar que el root bean coincida y la propiedad esté en esa posición
                        if (fRef.segments.length > targetSegIdx && fRef.segments[0].name === rootBeanName) {
                            const seg = fRef.segments[targetSegIdx];
                            if (seg.name === oldName) {
                                const start = this.positionFromOffset(content, seg.start);
                                const end = this.positionFromOffset(content, seg.end);
                                edit.replace(uri, new vscode.Range(start, end), newName);
                            }
                        }
                    }
                }
            } catch {
                // Archivo no legible
            }
        }

        // 2. Si se trata de un miembro con clase Java conocida, actualizar la declaración en el .java
        if (!isRootBean && declaringClass) {
            const javaFile = this.registry.getClassFile(declaringClass);
            if (javaFile && fs.existsSync(javaFile)) {
                try {
                    const javaContent = await fs.promises.readFile(javaFile, 'utf-8');
                    const javaUri = vscode.Uri.file(javaFile);

                    // Reemplazar campo
                    const fieldRe = new RegExp(`(\\b(?:private|protected|public)\\s+[\\w<>\\[\\],\\s.]+\\s+)(${oldName})(\\s*[=;])`, 'g');
                    let m: RegExpExecArray | null;
                    while ((m = fieldRe.exec(javaContent)) !== null) {
                        const start = this.positionFromOffset(javaContent, m.index + m[1].length);
                        const end = this.positionFromOffset(javaContent, m.index + m[1].length + oldName.length);
                        edit.replace(javaUri, new vscode.Range(start, end), newName);
                    }

                    // Reemplazar getter / setter si aplica
                    const capOld = oldName.charAt(0).toUpperCase() + oldName.slice(1);
                    const capNew = newName.charAt(0).toUpperCase() + newName.slice(1);

                    const getterRe = new RegExp(`(\\b(?:get|is))(${capOld})(\\s*\\(\\s*\\))`, 'g');
                    while ((m = getterRe.exec(javaContent)) !== null) {
                        const start = this.positionFromOffset(javaContent, m.index + m[1].length);
                        const end = this.positionFromOffset(javaContent, m.index + m[1].length + capOld.length);
                        edit.replace(javaUri, new vscode.Range(start, end), capNew);
                    }

                    const setterRe = new RegExp(`(\\bset)(${capOld})(\\s*\\()`, 'g');
                    while ((m = setterRe.exec(javaContent)) !== null) {
                        const start = this.positionFromOffset(javaContent, m.index + m[1].length);
                        const end = this.positionFromOffset(javaContent, m.index + m[1].length + capOld.length);
                        edit.replace(javaUri, new vscode.Range(start, end), capNew);
                    }
                } catch {
                    // Ignorar error al leer .java
                }
            }
        }

        return edit.size > 0 ? edit : null;
    }

    private positionFromOffset(text: string, offset: number): vscode.Position {
        let line = 0;
        let lastNl = -1;
        for (let i = 0; i < offset && i < text.length; i++) {
            if (text[i] === '\n') {
                line++;
                lastNl = i;
            }
        }
        const col = offset - (lastNl + 1);
        return new vscode.Position(line, col);
    }
}

