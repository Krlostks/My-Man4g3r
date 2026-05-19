/**
 * BeanScanner — Parsea archivos .java y extrae beans @Named.
 *
 * Reglas @Named (CDI):
 *  - @Named sin valor  → nombre EL = className con primera letra minúscula
 *  - @Named("nombre")  → nombre EL = valor del string
 *
 * El parseo es regex-based (sin AST completo) para mantener velocidad.
 * Asunciones del proyecto:
 *  - Beans en src/main/java/**\/*.java
 *  - Un solo @Named por archivo
 *  - Métodos públicos relevantes detectados por firma
 */

import * as fs from 'fs';
import * as path from 'path';
import { BeanEntry, BeanRegistry } from './BeanRegistry';
import { ProjectConfig } from '../../config/types';
import { Logger } from '../logger/Logger';

// ─── Regexes ───────────────────────────────────────────────────────────────

/** Captura: @Named  o  @Named("valor") */
const RE_NAMED = /@Named\s*(?:\(\s*"([^"]+)"\s*\))?/;

/** Captura el nombre de la clase pública */
const RE_CLASS = /public\s+class\s+(\w+)/;

/** Captura métodos públicos (no static, no constructor): visibilidad + tipo + nombre + '(' */
const RE_METHOD = /^\s*public\s+(?!static\s+(?:void\s+main|class))(?:\w[\w<>\[\],\s]*?\s+)(\w+)\s*\(/gm;

/** Captura campos de instancia públicos y privados con getter implícito, extrayendo el tipo (grupo 1) y el nombre (grupo 2) */
const RE_FIELD = /^\s*(?:private|protected|public)\s+(?!static\s|final\s+static\s)([A-Za-z0-9_<>\[\],\s.]+?)\s+(\w+)\s*[=;]/gm;

// ─── BeanScanner ───────────────────────────────────────────────────────────

export class BeanScanner {

    constructor(private registry: BeanRegistry) {}

    /**
     * Escanea todos los proyectos configurados.
     * Llamado una vez en activate() y cuando se agrega un proyecto nuevo.
     */
    async scanAll(projects: ProjectConfig[]): Promise<void> {
        let total = 0;
        for (const project of projects) {
            const javaRoot = path.join(project.rootPath, 'src', 'main', 'java');
            if (!fs.existsSync(javaRoot)) { continue; }
            const count = await this.scanDirectory(javaRoot);
            total += count;
            Logger.info('AI', `${project.name}: ${count} beans indexados.`);
        }
        Logger.info('AI', `BeanRegistry listo. Total: ${total} beans.`);
    }

    /**
     * (Re)procesa un único archivo .java.
     * Llamado por el FileWatcher en cada cambio.
     * Respeta lastModified para no re-parsear si no cambió.
     */
    scanFile(filePath: string): void {
        if (!filePath.endsWith('.java')) { return; }

        try {
            const stat = fs.statSync(filePath);
            const lastModified = stat.mtimeMs;

            // Skip si ya está indexado y no cambió
            if (this.registry.isUpToDate(filePath, lastModified)) { return; }

            const content = fs.readFileSync(filePath, 'utf-8');
            const entry = this.parseJavaFile(filePath, content, lastModified);

            if (entry) {
                this.registry.register(entry);
                Logger.info('AI', `Re-indexado: ${entry.beanName} (${path.basename(filePath)})`);
            } else {
                // El archivo ya no tiene @Named (ej. lo removieron): invalidar
                this.registry.invalidate(filePath);
            }
        } catch (err) {
            Logger.error('AI', `Error escaneando ${filePath}: ${String(err)}`);
        }
    }

    // ─── Privado ─────────────────────────────────────────────────────────────

    private async scanDirectory(dir: string): Promise<number> {
        const javaFiles = this.collectJavaFiles(dir);
        let count = 0;

        for (const filePath of javaFiles) {
            try {
                const stat = fs.statSync(filePath);
                const lastModified = stat.mtimeMs;

                if (this.registry.isUpToDate(filePath, lastModified)) {
                    count++; // ya indexado y vigente
                    continue;
                }

                const content = fs.readFileSync(filePath, 'utf-8');
                const entry = this.parseJavaFile(filePath, content, lastModified);
                if (entry) {
                    this.registry.register(entry);
                    count++;
                }
            } catch (err) {
                Logger.warn('AI', `No se pudo leer ${filePath}: ${String(err)}`);
            }
        }

        return count;
    }

    /**
     * Parsea el contenido de un .java y devuelve un BeanEntry si tiene @Named.
     * Devuelve undefined si no es un bean CDI.
     */
    private parseJavaFile(
        filePath: string,
        content: string,
        lastModified: number
    ): BeanEntry | undefined {

        // Nombre de la clase
        const classMatch = RE_CLASS.exec(content);
        if (classMatch) {
            this.registry.registerClass(classMatch[1], filePath);
        }

        // ¿Tiene @Named?
        const namedMatch = RE_NAMED.exec(content);
        if (!namedMatch) { return undefined; }

        if (!classMatch) { return undefined; }
        const className = classMatch[1];

        // Nombre EL del bean
        const beanName = namedMatch[1]
            ? namedMatch[1]                                           // @Named("explicit")
            : className.charAt(0).toLowerCase() + className.slice(1); // @Named → camelCase

        // Métodos públicos
        const methods = new Set<string>();
        let mMatch: RegExpExecArray | null;
        const reMeth = new RegExp(RE_METHOD.source, 'gm');
        while ((mMatch = reMeth.exec(content)) !== null) {
            const name = mMatch[1];
            // Excluir constructores (mismo nombre que la clase) y getters/setters si se quiere
            if (name !== className) {
                methods.add(name);
            }
        }

        // Fields (propiedades)
        const fields = new Set<string>();
        const fieldTypes = new Map<string, string>();
        let fMatch: RegExpExecArray | null;
        const reField = new RegExp(RE_FIELD.source, 'gm');
        while ((fMatch = reField.exec(content)) !== null) {
            const fieldType = fMatch[1].trim();
            const fieldName = fMatch[2];
            fields.add(fieldName);
            fieldTypes.set(fieldName, fieldType);
        }

        return { beanName, className, filePath, methods, fields, fieldTypes, lastModified };
    }

    /** Colecta recursivamente todos los .java bajo un directorio */
    private collectJavaFiles(dir: string): string[] {
        const result: string[] = [];
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    result.push(...this.collectJavaFiles(full));
                } else if (e.isFile() && e.name.endsWith('.java')) {
                    result.push(full);
                }
            }
        } catch { /* directorio no accesible, skip */ }
        return result;
    }
}
