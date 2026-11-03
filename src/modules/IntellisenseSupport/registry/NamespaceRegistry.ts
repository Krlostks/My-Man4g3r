import * as vscode from 'vscode';
import { XmlNamespace } from '../common';
import { FacesSettings } from '../config/FacesConfig';
import { Component } from '../model';
import ParseEngineGateway from '../parse-engine-gateway';
import ParseEngineRegistry from '../parse-engines/common/parse-engine-registry';
import { Logger } from '../../logger/Logger';

const XMLNS_RE = /xmlns:([\w.-]+)\s*=\s*(["'])(.*?)\2/g;
/** Los xmlns viven en el tag raíz; no hace falta escanear todo el documento. */
const HEAD_CHARS = 30000;

interface DocPrefixes {
    version: number;
    prefixes: Map<string, XmlNamespace>;
}

export class NamespaceRegistry {
    private namespaces: XmlNamespace[] = [];
    private docCache = new Map<string, DocPrefixes>();

    constructor(
        private readonly dataRoot: string,
        private readonly settings: () => FacesSettings
    ) {
        this.reset();
    }

    /** Recalcula el catálogo con la configuración vigente y descarta toda cache. */
    reset(): void {
        ParseEngineGateway.clear();
        this.namespaces = ParseEngineRegistry.buildNamespaces(this.settings());
        this.docCache.clear();
    }

    /** prefijo → namespace, según los xmlns declarados en el documento (cache por versión del doc). */
    prefixesOf(doc: vscode.TextDocument): Map<string, XmlNamespace> {
        const key = doc.uri.toString();
        const cached = this.docCache.get(key);
        if (cached && cached.version === doc.version) {
            return cached.prefixes;
        }

        const head = doc.getText(new vscode.Range(new vscode.Position(0, 0), doc.positionAt(HEAD_CHARS)));
        const prefixes = new Map<string, XmlNamespace>();
        const re = new RegExp(XMLNS_RE.source, 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(head)) !== null) {
            const prefix = m[1];
            const url = m[3];
            const ns = this.namespaces.find((n) => n.urls.includes(url));
            if (ns) {
                prefixes.set(prefix, ns);
            }
        }
        this.docCache.set(key, { version: doc.version, prefixes });
        return prefixes;
    }

    resolve(doc: vscode.TextDocument, prefix: string): XmlNamespace | undefined {
        return this.prefixesOf(doc).get(prefix);
    }

    /** Componentes del namespace; carga el JSON la primera vez. Si falla, devuelve mapa vacío. */
    components(ns: XmlNamespace): Map<string, Component> {
        if (ns.components) {
            return ns.components;
        }
        try {
            ns.components = ParseEngineGateway.load(this.dataRoot, ns.folder, ns.file);
            Logger.debug('XHTML', `Taglib cargado: ${ns.folder}/${ns.file} (${ns.components.size} componentes)`);
        } catch (err) {
            Logger.warn('XHTML', `No se pudo cargar taglib '${ns.id}' (${ns.folder}/${ns.file}): ${String(err)}`);
            ns.components = new Map();
        }
        return ns.components;
    }
}
