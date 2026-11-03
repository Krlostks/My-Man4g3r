import { XmlNamespace } from "../../common";
import { FacesSettings, isLegacyFaces } from "../../config/FacesConfig";

function versionSuffix(version: string): string {
    const i = version.lastIndexOf('-');
    return i >= 0 ? version.substring(i) : '';
}

/**
 * Catálogo de namespaces soportados. Se construye bajo demanda a partir de la configuración
 * vigente (nada se evalúa al importar el módulo).
 */
export class ParseEngineRegistry {
    public static buildNamespaces(s: FacesSettings): XmlNamespace[] {
        const legacy = isLegacyFaces(s.facesVersion);
        const facesFolder = legacy ? 'jsf' : 'jakarta';
        const facesFile = (tag: string) => (legacy ? tag : `${tag}${versionSuffix(s.facesVersion)}`);
        const rich = versionSuffix(s.richVersion);

        return [
            new XmlNamespace('h', 'JSF HTML',
                ['http://java.sun.com/jsf/html', 'http://xmlns.jcp.org/jsf/html', 'jakarta.faces.html'],
                facesFolder, facesFile('h')),
            new XmlNamespace('f', 'JSF Core',
                ['http://java.sun.com/jsf/core', 'http://xmlns.jcp.org/jsf/core', 'jakarta.faces.core'],
                facesFolder, facesFile('f')),
            new XmlNamespace('c', 'JSTL Core',
                ['http://java.sun.com/jsp/jstl/core', 'http://java.sun.com/jstl/core', 'http://xmlns.jcp.org/jsp/jstl/core', 'jakarta.tags.core'],
                facesFolder, facesFile('c')),
            new XmlNamespace('cc', 'JSF Composite',
                ['http://java.sun.com/jsf/composite', 'http://xmlns.jcp.org/jsf/composite', 'jakarta.faces.composite'],
                facesFolder, facesFile('cc')),
            new XmlNamespace('ui', 'JSF Facelets',
                ['http://java.sun.com/jsf/facelets', 'http://xmlns.jcp.org/jsf/facelets', 'jakarta.faces.facelets'],
                facesFolder, facesFile('ui')),
            new XmlNamespace('p', 'PrimeFaces',
                ['http://primefaces.org/ui', 'primefaces'],
                'primefaces', s.primeVersion),
            new XmlNamespace('pe', 'PrimeFaces Extensions',
                ['http://primefaces.org/ui/extensions', 'primefaces.extensions'],
                'primefaces', s.primeExtVersion),
            new XmlNamespace('o', 'OmniFaces',
                ['http://omnifaces.org/ui', 'omnifaces.ui'],
                'omnifaces', s.omniVersion),
            new XmlNamespace('a4j', 'RichFaces a4j',
                ['http://richfaces.org/a4j'],
                'richfaces', `a4j${rich}`),
            new XmlNamespace('r', 'RichFaces',
                ['http://richfaces.org/rich'],
                'richfaces', `richfaces${rich}`)
        ];
    }
}
export default ParseEngineRegistry;
