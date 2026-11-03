import * as fs from 'fs';
import * as path from 'path';
import { ComponentDefinition } from "../common";
import { ComponentExtractor } from "./common";
import type { IParseEngine } from "./common";

/**
 * Lee un JSON de taglib (`<dataRoot>/<folder>/<file>.json`).
 * `dataRoot` se inyecta desde la extensión: `__dirname` no sirve con esbuild (apunta a dist/).
 */
class TagLib implements IParseEngine {
    constructor(
        private readonly dataRoot: string,
        private readonly folder: string,
        private readonly file: string
    ) { }

    public parse(): ComponentDefinition[] {
        const jsonPath = path.join(this.dataRoot, this.folder, `${this.file}.json`);
        if (!fs.existsSync(jsonPath)) {
            throw new Error(`Archivo de datos no encontrado: ${jsonPath}`);
        }
        const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        return ComponentExtractor.extract(json?.components?.component);
    }
}
export default TagLib;
