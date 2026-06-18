import * as path from 'path';
import * as vscode from 'vscode';
import { XmlNamespace, DEFAULT_NAMESPACES } from "../models/XmlNamespace";
import { ComponentDefinition } from '../models';
import { ComponentExtractor } from '../parser/ComponentExtractor';
import * as fs from 'node:fs';
import { Logger } from '../../logger/Logger';

export class NamespacerRegistry {

    private namespacers: XmlNamespace[] = [];
    private extensionPath: string;
    private failedNamespaces: Set<string> = new Set();

    constructor(extensionPath: string) {
        this.extensionPath = extensionPath;
        this.namespacers = JSON.parse(JSON.stringify(DEFAULT_NAMESPACES)) as XmlNamespace[];
    }

    detectarNamespacers(document: vscode.TextDocument, position: vscode.Position): void {
        const rango = new vscode.Range(new vscode.Position(0, 0), position);
        const textoDetectado = document.getText(rango);

        this.namespacers.forEach((namespace) => {
            namespace.aliasEnDocumento = '';
            for (const url of namespace.urls) {
                if (textoDetectado.includes(`"${url}"`)) {
                    namespace.aliasEnDocumento = this.extraerAlias(textoDetectado, url);
                    this.cargarContenido(namespace);
                    break;
                }
            }
        });
    }

    extraerAlias(texto: string, url: string): string {
        // Buscar patrón xmlns:PREFIX="URL" directamente con regex
        // Más robusto que substring arithmetic
        const regex = new RegExp(`xmlns:([\\w]+)=["']${url.replace(/\//g, '\\/')}["']`);
        const match = texto.match(regex);
        if (match) {
            console.log("el match es: ", match[1]);            
            return `<${match[1]}:`;
        }
        // fallback: método original corregido
        const index = texto.indexOf(url);
        const inicio = texto.substring(0, index);
        const xmlNamespaceIndex = inicio.lastIndexOf('xmlns:');
        // Extraer solo el prefijo: desde después de "xmlns:" hasta el "="
        const desdePrefix = inicio.substring(xmlNamespaceIndex + 6);
        const prefijo = desdePrefix.split('=')[0].trim();
        console.log("el prefijo es: ", prefijo);
        return `<${prefijo}:`;
    }

    cargarContenido(namespace: XmlNamespace): void {
        if (namespace.definicionUnica.length > 0) { return; }
        if (!namespace.nombreArchivo || this.failedNamespaces.has(namespace.id)) { return; }

        const jsonRuta = path.join(
            this.extensionPath, 'src', 'modules', 'xhtml', 'data', `${namespace.nombreArchivo}.json`
        );
        if (!fs.existsSync(jsonRuta)) {
            console.warn(`[MM43] Archivo no encontrado para namespace '${namespace.id}': ${jsonRuta}`);
            this.failedNamespaces.add(namespace.id);
            return;
        }

        try {
            namespace.definicionUnica = ComponentExtractor.cargarDeArchivo(
                this.extensionPath,
                namespace.nombreArchivo
            );
        } catch (error) {
            console.error(`[MM43] Error al cargar namespace '${namespace.id}':`, error);
            this.failedNamespaces.add(namespace.id);
        }
    }

    obtenerNameSpace(alias: string) {
        return this.namespacers.find((namespace) => namespace.aliasEnDocumento === alias);
    }

    limpiarCache() {
        this.failedNamespaces.clear();
        this.namespacers.forEach(ns => {
            ns.definicionUnica = [];
            ns.aliasEnDocumento = '';
        });
    }

    obtenerDefiniciones(ns: XmlNamespace): ComponentDefinition[] {
        return ns.definicionUnica;
    }
}
