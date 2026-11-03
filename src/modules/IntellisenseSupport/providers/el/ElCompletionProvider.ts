import * as vscode from 'vscode';
import { BeanRegistry } from '../../../AI/BeanRegistry';
import { JavaClassIndex } from '../../java/JavaClassIndex';
import { elContextAt } from '../../parsing/ElParser';
import { ScopeResolver } from '../../parsing/ScopeResolver';

const IMPLICIT_OBJECTS = [
    { name: 'facesContext', detail: 'JSF FacesContext' },
    { name: 'view', detail: 'JSF UIViewRoot' },
    { name: 'component', detail: 'JSF UIComponent' },
    { name: 'cc', detail: 'Composite Component Interface' },
    { name: 'requestScope', detail: 'Request Scope Map' },
    { name: 'viewScope', detail: 'View Scope Map' },
    { name: 'sessionScope', detail: 'Session Scope Map' },
    { name: 'applicationScope', detail: 'Application Scope Map' },
    { name: 'param', detail: 'Request Parameter Map' },
    { name: 'paramValues', detail: 'Request Parameter Values Map' },
    { name: 'header', detail: 'HTTP Request Header Map' },
    { name: 'cookie', detail: 'Cookie Map' },
    { name: 'initParam', detail: 'Context Init Parameter Map' }
];

export class ElCompletionProvider implements vscode.CompletionItemProvider {
    private readonly scopeResolver: ScopeResolver;

    constructor(
        private readonly registry: BeanRegistry,
        private readonly classIndex: JavaClassIndex
    ) {
        this.scopeResolver = new ScopeResolver(classIndex);
    }

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] | null {
        const textBefore = document.getText(
            new vscode.Range(new vscode.Position(0, 0), position)
        );

        const ctx = elContextAt(textBefore);
        if (!ctx) {
            return null;
        }

        const scopeVars = this.scopeResolver.resolveScopeVariables(textBefore);

        if (ctx.kind === 'root') {
            return this.suggestRoots(ctx.partial, scopeVars);
        }

        if (ctx.kind === 'member') {
            return this.suggestMembers(ctx.segments, ctx.partial, scopeVars);
        }

        return null;
    }

    private suggestRoots(partial: string, scopeVars: Map<string, string>): vscode.CompletionItem[] {
        const results: vscode.CompletionItem[] = [];
        const lower = partial.toLowerCase();

        // 1. Variables de scope (p:dataTable var="..." etc)
        for (const [varName, varType] of scopeVars) {
            if (!partial || varName.toLowerCase().startsWith(lower)) {
                const item = new vscode.CompletionItem(varName, vscode.CompletionItemKind.Variable);
                item.detail = `Var: ${varType}`;
                item.documentation = new vscode.MarkdownString(`Variable de ámbito declarada en etiqueta contenedora (\`${varType}\`).`);
                item.sortText = `0_${varName}`;
                results.push(item);
            }
        }

        // 2. Beans CDI (@Named)
        for (const beanName of this.registry.allBeanNames()) {
            if (!partial || beanName.toLowerCase().startsWith(lower)) {
                const entry = this.registry.resolve(beanName);
                const item = new vscode.CompletionItem(beanName, vscode.CompletionItemKind.Class);
                item.detail = entry ? `CDI Bean → ${entry.className}` : 'CDI Bean';
                item.sortText = `1_${beanName}`;
                results.push(item);
            }
        }

        // 3. Objetos implícitos JSF
        for (const imp of IMPLICIT_OBJECTS) {
            if (!partial || imp.name.toLowerCase().startsWith(lower)) {
                const item = new vscode.CompletionItem(imp.name, vscode.CompletionItemKind.Keyword);
                item.detail = imp.detail;
                item.sortText = `2_${imp.name}`;
                results.push(item);
            }
        }

        return results;
    }

    private suggestMembers(
        segments: { name: string; call: boolean; index: boolean }[],
        partial: string,
        scopeVars: Map<string, string>
    ): vscode.CompletionItem[] | null {
        const segNames = segments.map((s) => s.name);
        const resolved = this.classIndex.resolveChain(segNames[0], segNames, scopeVars);
        if (!resolved || !resolved.targetType) {
            return null;
        }

        const cleanClass = this.classIndex.cleanType(resolved.targetType);
        const classFile = this.registry.getClassFile(cleanClass);
        if (!classFile) {
            return null;
        }

        const classInfo = this.classIndex.getResolvedClassInfo(classFile);
        if (!classInfo) {
            return null;
        }

        const results: vscode.CompletionItem[] = [];
        const lower = partial.toLowerCase();

        // 1. Sugerir propiedades EL (getters, lombok, public fields)
        for (const [propName, prop] of classInfo.allProperties) {
            if (!partial || propName.toLowerCase().startsWith(lower)) {
                const item = new vscode.CompletionItem(propName, vscode.CompletionItemKind.Property);
                item.detail = `${prop.type} (${prop.source})`;
                const md = new vscode.MarkdownString();
                md.appendMarkdown(`**Propiedad:** \`${prop.type} ${propName}\`\n\n`);
                md.appendMarkdown(`*Declarada en \`${prop.originClass || classInfo.info.className}\`*\n\n`);
                if (prop.getter) {
                    md.appendMarkdown(`Getter: \`${prop.getter.signature}\`\n\n`);
                }
                if (prop.setter) {
                    md.appendMarkdown(`Setter: \`${prop.setter.signature}\`\n\n`);
                }
                item.documentation = md;
                item.sortText = `0_${propName}`;
                results.push(item);
            }
        }

        // 2. Sugerir métodos invocables (acciones, listeners, etc)
        for (const [methodName, methodList] of classInfo.allMethods) {
            // Evitar duplicar getters/setters ya sugeridos como propiedades limpias
            if (classInfo.allProperties.has(methodName)) {
                continue;
            }
            if (!partial || methodName.toLowerCase().startsWith(lower)) {
                const mainMethod = methodList[0];
                const item = new vscode.CompletionItem(methodName, vscode.CompletionItemKind.Method);
                item.detail = mainMethod.signature;
                const md = new vscode.MarkdownString();
                md.appendMarkdown(`\`\`\`java\n${mainMethod.signature}\n\`\`\`\n`);
                item.documentation = md;
                item.insertText = methodName;
                item.sortText = `1_${methodName}`;
                results.push(item);
            }
        }

        return results.length > 0 ? results : null;
    }
}

