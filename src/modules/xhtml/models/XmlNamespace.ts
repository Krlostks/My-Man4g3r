import { ComponentDefinition } from "./ComponentDefinition";

export interface XmlNamespace{

    id: string;
    urls: string[];
    nombreArchivo: string;
    definicionUnica: ComponentDefinition[];
    aliasEnDocumento?: string;    
}

export const DEFAULT_NAMESPACES: XmlNamespace[] = [
    {
        id:'p',
        urls:['http://primefaces.org/ui'],
        nombreArchivo:"primefaces/primefaces-12.0.0",
        definicionUnica:[],
    },
    {
        id:'pe',
        urls:['http://primefaces.org/ui/extensions'],
        nombreArchivo:"primefaces-extensions/primefaces-extensions-12.0.0",
        definicionUnica:[],
    },
    {
        id:'o',
        urls:['http://omnifaces.org/ui'],
        nombreArchivo:"omnifaces/omnifaces-3.0",
        definicionUnica:[],
    },
    {
        id: 'h',
        urls: ['http://java.sun.com/jsf/html', 'jakarta.faces.html'],
        nombreArchivo: 'jsf/h',
        definicionUnica: []
    },
    {
        id: 'f',
        urls: ['http://java.sun.com/jsf/core', 'jakarta.faces.core'],
        nombreArchivo: 'jsf/f',
        definicionUnica: []
    }
]