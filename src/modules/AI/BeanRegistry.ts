/**
 * BeanRegistry — Estructura central del índice de beans JSF/CDI.
 *
 * Diseño:
 *  - Map<beanName, BeanEntry> → O(1) lookup por nombre EL
 *  - Map<filePath, beanName>  → O(1) invalidación por ruta al cambiar un .java
 *  - Set<string> para métodos y fields → O(1) membership check
 *  - Todo in-memory, sin disco; vive mientras la extensión vive.
 */

export interface BeanEntry {
    /** Nombre EL del bean (ej. "clienteBean") */
    beanName: string;
    /** Nombre de la clase Java (ej. "ClienteBean") */
    className: string;
    /** Ruta absoluta al archivo .java */
    filePath: string;
    /** Métodos públicos detectados */
    methods: Set<string>;
    /** Campos (properties) detectados */
    fields: Set<string>;
    /** Tipos de los campos detectados, e.g., 'view' -> 'GeneracionTicketView' */
    fieldTypes: Map<string, string>;
    /** Timestamp de última modificación para invalidación rápida */
    lastModified: number;
}

export class BeanRegistry {
    /** Índice principal: beanName → BeanEntry */
    private byName: Map<string, BeanEntry> = new Map();

    /** Índice inverso: filePath → beanName  (para invalidación O(1)) */
    private byFile: Map<string, string> = new Map();

    /** Índice global de clases Java: className → filePath */
    private classRegistry: Map<string, string> = new Map();

    registerClass(className: string, filePath: string): void {
        this.classRegistry.set(className, filePath);
    }

    getClassFile(className: string): string | undefined {
        return this.classRegistry.get(className);
    }

    // ─── Escritura ──────────────────────────────────────────────────────────

    /**
     * Registra o actualiza un bean en el índice.
     * Si ya existía una entrada para ese filePath, la reemplaza limpiamente.
     */
    register(entry: BeanEntry): void {
        // Si el archivo ya tenía un bean registrado con otro nombre, limpiar
        const oldName = this.byFile.get(entry.filePath);
        if (oldName && oldName !== entry.beanName) {
            this.byName.delete(oldName);
        }

        this.byName.set(entry.beanName, entry);
        this.byFile.set(entry.filePath, entry.beanName);
    }

    /**
     * Invalida y elimina la entrada asociada a un filePath.
     * Llamado por el FileWatcher cuando un .java es eliminado.
     */
    invalidate(filePath: string): void {
        const beanName = this.byFile.get(filePath);
        if (beanName) {
            this.byName.delete(beanName);
            this.byFile.delete(filePath);
        }
    }

    /**
     * Limpia todo el índice.
     * Útil para re-scan completo al agregar/eliminar proyectos.
     */
    clear(): void {
        this.byName.clear();
        this.byFile.clear();
    }

    // ─── Lectura ────────────────────────────────────────────────────────────

    /** Resolución principal: beanName → BeanEntry | undefined */
    resolve(beanName: string): BeanEntry | undefined {
        return this.byName.get(beanName);
    }

    /** ¿El archivo ya está indexado y sigue vigente? */
    isUpToDate(filePath: string, lastModified: number): boolean {
        const name = this.byFile.get(filePath);
        if (!name) { return false; }
        const entry = this.byName.get(name);
        return !!entry && entry.lastModified === lastModified;
    }

    /** Devuelve el beanName asociado a un filePath, si existe */
    getBeanNameForFile(filePath: string): string | undefined {
        return this.byFile.get(filePath);
    }

    /** Total de beans indexados (útil para logs/diagnóstico) */
    get size(): number {
        return this.byName.size;
    }

    /** Lista todos los bean names (útil para autocompletado futuro) */
    allBeanNames(): string[] {
        return Array.from(this.byName.keys());
    }
}
