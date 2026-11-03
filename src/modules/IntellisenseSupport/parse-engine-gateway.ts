import { Component } from "./model";
import TagLib from "./parse-engines/taglib";

/**
 * Fachada de carga de datos de taglibs. Cachea por archivo: varios namespaces
 * que apunten al mismo JSON no lo parsean dos veces.
 */
class ParseEngineGateway {
    private static cache = new Map<string, Map<string, Component>>();

    /** Devuelve nombre → componente. Lanza si el archivo no existe o es inválido. */
    public static load(dataRoot: string, folder: string, file: string): Map<string, Component> {
        const key = `${folder}/${file}`;
        const cached = ParseEngineGateway.cache.get(key);
        if (cached) {
            return cached;
        }
        const defs = new TagLib(dataRoot, folder, file).parse();
        const map = new Map<string, Component>();
        for (const def of defs) {
            if (!map.has(def.component.name)) {
                map.set(def.component.name, def.component);
            }
        }
        ParseEngineGateway.cache.set(key, map);
        return map;
    }

    public static clear(): void {
        ParseEngineGateway.cache.clear();
    }
}
export default ParseEngineGateway;
