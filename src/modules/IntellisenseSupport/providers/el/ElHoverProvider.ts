import * as vscode from 'vscode';
import { BeanRegistry } from '../../../AI/BeanRegistry';
import { JavaClassIndex } from '../../java/JavaClassIndex';
import { findElRegions, extractRefs } from '../../parsing/ElParser';
import { ScopeResolver } from '../../parsing/ScopeResolver';

export class ElHoverProvider implements vscode.HoverProvider {
    private readonly scopeResolver: ScopeResolver;

    constructor(
        private readonly registry: BeanRegistry,
        private readonly classIndex: JavaClassIndex
    ) {
        this.scopeResolver = new ScopeResolver(classIndex);
    }

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.Hover | null {
        const fullText = document.getText();
        const offset = document.offsetAt(position);

        // Buscar todas las regiones EL en el documento
        const regions = findElRegions(fullText);
        const region = regions.find((r) => offset >= r.bodyStart && offset <= r.bodyEnd);
        if (!region) {
            return null;
        }

        // Extraer referencias dentro de la región
        const refs = extractRefs(fullText, region.bodyStart, region.bodyEnd);
        for (const ref of refs) {
            const segIdx = ref.segments.findIndex((s) => offset >= s.start && offset <= s.end);
            if (segIdx === -1) {
                continue;
            }

            const targetSeg = ref.segments[segIdx];
            const segRange = new vscode.Range(
                document.positionAt(targetSeg.start),
                document.positionAt(targetSeg.end)
            );

            const textBefore = fullText.substring(0, targetSeg.start);
            const scopeVars = this.scopeResolver.resolveScopeVariables(textBefore);

            // Si es el primer segmento (raíz)
            if (segIdx === 0) {
                // 1. Variable de scope
                if (scopeVars.has(targetSeg.name)) {
                    const varType = scopeVars.get(targetSeg.name)!;
                    const md = new vscode.MarkdownString();
                    md.appendMarkdown(`**Variable de Ámbito EL**\n\n`);
                    md.appendMarkdown(`| | |\n|---|---|\n`);
                    md.appendMarkdown(`| **Nombre** | \`${targetSeg.name}\` |\n`);
                    md.appendMarkdown(`| **Tipo** | \`${varType}\` |\n`);
                    return new vscode.Hover(md, segRange);
                }

                // 2. Bean CDI
                const bean = this.registry.resolve(targetSeg.name);
                if (bean) {
                    const classInfo = this.classIndex.getClassInfo(bean.filePath);
                    const md = new vscode.MarkdownString();
                    md.appendMarkdown(`**CDI Bean** \`@Named\`\n\n`);
                    md.appendMarkdown(`| | |\n|---|---|\n`);
                    md.appendMarkdown(`| **Nombre EL** | \`${bean.beanName}\` |\n`);
                    md.appendMarkdown(`| **Clase Java** | \`${bean.className}\` |\n`);
                    if (classInfo) {
                        md.appendMarkdown(`| **Propiedades** | ${classInfo.properties.size} |\n`);
                        md.appendMarkdown(`| **Métodos** | ${classInfo.methods.size} |\n`);
                    }
                    return new vscode.Hover(md, segRange);
                }
            }

            // Segmento anidado o método
            const chain = ref.segments.slice(0, segIdx + 1).map((s) => s.name);
            const resolved = this.classIndex.resolveChain(chain[0], chain, scopeVars);
            if (!resolved) {
                return null;
            }

            const md = new vscode.MarkdownString();
            md.isTrusted = true;

            if (resolved.targetProperty) {
                const prop = resolved.targetProperty;
                md.appendMarkdown(`**Propiedad EL:** \`${prop.name}\`\n\n`);
                md.appendMarkdown(`\`\`\`java\n${prop.type} ${prop.name}\n\`\`\`\n\n`);
                md.appendMarkdown(`*Declarada en \`${resolved.declaringClass || 'desconocida'}\`*\n\n`);
                if (prop.getter) {
                    md.appendMarkdown(`*Getter:* \`${prop.getter.signature}\`\n\n`);
                }
                if (prop.setter) {
                    md.appendMarkdown(`*Setter:* \`${prop.setter.signature}\`\n\n`);
                }
                return new vscode.Hover(md, segRange);
            }

            if (resolved.targetMethod) {
                const meth = resolved.targetMethod;
                md.appendMarkdown(`**Método Java:** \`${meth.name}\`\n\n`);
                md.appendMarkdown(`\`\`\`java\n${meth.signature}\n\`\`\`\n\n`);
                md.appendMarkdown(`*Clase: \`${resolved.declaringClass || 'desconocida'}\`*\n`);
                return new vscode.Hover(md, segRange);
            }

            if (resolved.targetType) {
                md.appendMarkdown(`**Tipo resuelto:** \`${resolved.targetType}\`\n\n`);
                md.appendMarkdown(`*Clase: \`${resolved.declaringClass || 'desconocida'}\`*\n`);
                return new vscode.Hover(md, segRange);
            }
        }

        return null;
    }
}

