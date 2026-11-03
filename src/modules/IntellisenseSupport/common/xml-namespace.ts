import { Component } from '../model';

/**
 * Namespace XML soportado (h, f, ui, p, o...). Las URLs son la unión de todas las variantes
 * (JSF clásico y Jakarta) para detectar el prefijo sin importar la versión configurada;
 * la versión solo decide qué archivo JSON se carga.
 */
class XmlNamespace {
    /** Componentes cargados de forma perezosa (nombre → definición). */
    components?: Map<string, Component>;

    constructor(
        public id: string,
        public label: string,
        public urls: string[],
        public folder: string,
        public file: string
    ) { }
}

export default XmlNamespace;
