import * as vscode from 'vscode';
import * as path from 'path';
import { BeanRegistry } from '../AI/BeanRegistry';
import { NamespaceRegistry } from './registry/NamespaceRegistry';
import { readSettings, CONFIG_SECTION } from './config/FacesConfig';
import { FacesCompletionProvider } from './providers/FacesCompletionProvider';
import { FacesHoverProvider } from './providers/FacesHoverProvider';
import { ElCompletionProvider } from './providers/el/ElCompletionProvider';
import { ElHoverProvider } from './providers/el/ElHoverProvider';
import { ElDiagnosticProvider } from './providers/el/ElDiagnosticProvider';
import { ElRenameProvider } from './providers/el/ElRenameProvider';
import { JavaClassIndex } from './java/JavaClassIndex';
import { Logger } from '../logger/Logger';

/**
 * Inicializa y registra todo el soporte de Faces Intellisense:
 *  - Autocompletado y hover de componentes y atributos (JSF, Jakarta, PrimeFaces, OmniFaces, RichFaces).
 *  - Autocompletado, hover, validación y renombrado de expresiones EL (#{...}).
 *  - Seguimiento avanzado de Beans (Lombok, JavaBeans getters/setters, herencia extends y variables de scope).
 */
export function activateFacesIntellisense(
    context: vscode.ExtensionContext,
    beanRegistry: BeanRegistry
): void {
    const dataRoot = path.join(context.extensionPath, 'src', 'modules', 'IntellisenseSupport', 'parse-engines', 'data');

    const namespaceRegistry = new NamespaceRegistry(dataRoot, readSettings);
    const classIndex = new JavaClassIndex(beanRegistry);

    const facesCompletion = new FacesCompletionProvider(namespaceRegistry);
    const facesHover = new FacesHoverProvider(namespaceRegistry);

    const elCompletion = new ElCompletionProvider(beanRegistry, classIndex);
    const elHover = new ElHoverProvider(beanRegistry, classIndex);
    const elDiagnostics = new ElDiagnosticProvider(beanRegistry, classIndex);
    const elRename = new ElRenameProvider(beanRegistry, classIndex);

    const xhtmlSelector: vscode.DocumentSelector = [
        { language: 'html', pattern: '**/*.xhtml' }
    ];

    context.subscriptions.push(
        // Autocompletado de componentes y atributos Faces
        vscode.languages.registerCompletionItemProvider(xhtmlSelector, facesCompletion, ':', ' '),

        // Autocompletado de expresiones EL (sugiere beans, propiedades, métodos y variables de scope)
        vscode.languages.registerCompletionItemProvider(xhtmlSelector, elCompletion, '#', '{', '.'),

        // Hover sobre expresiones EL (info de bean, propiedad, método, tipo y clase de origen)
        vscode.languages.registerHoverProvider(xhtmlSelector, elHover),

        // Hover sobre tags y atributos Faces
        vscode.languages.registerHoverProvider(xhtmlSelector, facesHover),

        // Renombrado sincrónico en archivos XHTML y clases Java
        vscode.languages.registerRenameProvider(xhtmlSelector, elRename),

        // Colección de diagnósticos EL
        elDiagnostics
    );

    // Reaccionar a cambios de configuración mm43.faces.*
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(CONFIG_SECTION)) {
                namespaceRegistry.reset();
                elDiagnostics.clear();
                vscode.workspace.textDocuments.forEach((doc) => {
                    if (doc.fileName.endsWith('.xhtml')) {
                        elDiagnostics.validate(doc);
                    }
                });
                Logger.info('XHTML', 'Configuración de Faces actualizada y cachés reseteadas.');
            }
        })
    );

    // Comando para limpiar caché bajo demanda
    context.subscriptions.push(
        vscode.commands.registerCommand('mm43.xhtml.clearCache', () => {
            namespaceRegistry.reset();
            elDiagnostics.clear();
            Logger.info('XHTML', 'Caché de Faces / XHTML limpiada.');
            vscode.window.showInformationMessage('MM43: Caché de Faces / XHTML limpiada exitosamente.');
        })
    );

    Logger.info('XHTML', 'Faces Intellisense cargado correctamente.');
}

