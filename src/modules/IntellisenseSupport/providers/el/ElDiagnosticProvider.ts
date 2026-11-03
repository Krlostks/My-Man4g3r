import * as vscode from 'vscode';
import { BeanRegistry } from '../../../AI/BeanRegistry';
import { JavaClassIndex } from '../../java/JavaClassIndex';
import { collectRefs } from '../../parsing/ElParser';
import { ScopeResolver } from '../../parsing/ScopeResolver';
import { readSettings } from '../../config/FacesConfig';

const IMPLICIT_OBJECTS = new Set([
    'facesContext', 'view', 'component', 'cc',
    'request', 'session', 'application',
    'requestScope', 'viewScope', 'sessionScope', 'applicationScope',
    'param', 'paramValues', 'header', 'headerValues',
    'cookie', 'initParam', 'msg', 'bundle', 'flash'
]);

export class ElDiagnosticProvider implements vscode.Disposable {
    private diagnostics: vscode.DiagnosticCollection;
    private disposables: vscode.Disposable[] = [];
    private scopeResolver: ScopeResolver;

    constructor(
        private readonly registry: BeanRegistry,
        private readonly classIndex: JavaClassIndex
    ) {
        this.diagnostics = vscode.languages.createDiagnosticCollection('mm43-el');
        this.scopeResolver = new ScopeResolver(classIndex);

        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument((doc) => {
                if (this.isXhtml(doc)) {
                    this.validate(doc);
                }
            }),
            vscode.workspace.onDidOpenTextDocument((doc) => {
                if (this.isXhtml(doc)) {
                    this.validate(doc);
                }
            }),
            vscode.workspace.onDidCloseTextDocument((doc) => {
                this.diagnostics.delete(doc.uri);
            })
        );

        // Validar documentos ya abiertos si está habilitado
        vscode.workspace.textDocuments.forEach((doc) => {
            if (this.isXhtml(doc)) {
                this.validate(doc);
            }
        });
    }

    validate(document: vscode.TextDocument): void {
        const settings = readSettings();
        if (!settings.elDiagnostics) {
            this.diagnostics.delete(document.uri);
            return;
        }

        const diags: vscode.Diagnostic[] = [];
        const text = document.getText();
        const refs = collectRefs(text);

        for (const ref of refs) {
            if (ref.segments.length === 0) {
                continue;
            }

            const rootSeg = ref.segments[0];
            const rootName = rootSeg.name;

            // Ignorar objetos implícitos JSF
            if (IMPLICIT_OBJECTS.has(rootName)) {
                continue;
            }

            const textBefore = text.substring(0, rootSeg.start);
            const scopeVars = this.scopeResolver.resolveScopeVariables(textBefore, text, rootSeg.start);

            // Ignorar variables de ámbito (var="item", ui:param...)
            if (scopeVars.has(rootName)) {
                continue;
            }

            const bean = this.registry.resolve(rootName);
            if (!bean) {
                // Bean no encontrado en el índice
                const startPos = document.positionAt(rootSeg.start);
                const endPos = document.positionAt(rootSeg.end);
                diags.push(
                    new vscode.Diagnostic(
                        new vscode.Range(startPos, endPos),
                        `El bean o variable '${rootName}' no está registrado en el índice CDI.`,
                        vscode.DiagnosticSeverity.Information
                    )
                );
                continue;
            }

            // Si hay segmentos encadenados, verificar hasta dónde se puede resolver
            if (ref.segments.length > 1) {
                const chain = ref.segments.map((s) => s.name);
                const resolved = this.classIndex.resolveChain(rootName, chain, scopeVars);
                if (!resolved) {
                    // El último segmento no se pudo resolver
                    const lastSeg = ref.segments[ref.segments.length - 1];
                    const startPos = document.positionAt(lastSeg.start);
                    const endPos = document.positionAt(lastSeg.end);
                    diags.push(
                        new vscode.Diagnostic(
                            new vscode.Range(startPos, endPos),
                            `Miembro o propiedad '${lastSeg.name}' no resuelto en la cadena '${chain.join('.')}'.`,
                            vscode.DiagnosticSeverity.Hint
                        )
                    );
                }
            }
        }

        this.diagnostics.set(document.uri, diags);
    }

    clear(): void {
        this.diagnostics.clear();
    }

    private isXhtml(doc: vscode.TextDocument): boolean {
        return doc.fileName.endsWith('.xhtml');
    }

    dispose(): void {
        this.diagnostics.dispose();
        this.disposables.forEach((d) => d.dispose());
    }
}

