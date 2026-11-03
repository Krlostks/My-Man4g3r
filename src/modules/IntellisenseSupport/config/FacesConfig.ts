import * as vscode from 'vscode';

/** Sección de configuración de Faces Intellisense dentro de MM43. */
export const CONFIG_SECTION = 'mm43.faces';

export interface FacesSettings {
    facesVersion: string;
    primeVersion: string;
    primeExtVersion: string;
    omniVersion: string;
    richVersion: string;
    elDiagnostics: boolean;
}

/** Valores de facesVersion que usan los datos de la carpeta `jsf` (sin sufijo de versión). */
export const LEGACY_FACES = ['java-server-faces(1.0 - 2.2)', 'jakarta-server-faces(2.3 - 3.0)'];

export const DEFAULT_SETTINGS: FacesSettings = {
    facesVersion: LEGACY_FACES[0],
    primeVersion: 'primefaces-12.0.0',
    primeExtVersion: 'primefaces-extensions-12.0.0',
    omniVersion: 'omnifaces-3.0',
    richVersion: 'richfaces-4.5.17',
    elDiagnostics: true
};

export function isLegacyFaces(version: string): boolean {
    return LEGACY_FACES.includes(version);
}

/** Lee la configuración vigente (siempre fresca, nunca se cachea a nivel de módulo). */
export function readSettings(): FacesSettings {
    const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return {
        facesVersion: c.get<string>('facesVersion') || DEFAULT_SETTINGS.facesVersion,
        primeVersion: c.get<string>('primeVersion') || DEFAULT_SETTINGS.primeVersion,
        primeExtVersion: c.get<string>('primeExtVersion') || DEFAULT_SETTINGS.primeExtVersion,
        omniVersion: c.get<string>('omniVersion') || DEFAULT_SETTINGS.omniVersion,
        richVersion: c.get<string>('richVersion') || DEFAULT_SETTINGS.richVersion,
        elDiagnostics: c.get<boolean>('elDiagnostics') ?? DEFAULT_SETTINGS.elDiagnostics
    };
}
