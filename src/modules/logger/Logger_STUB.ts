/**
 * MM43 - Logger stub para el módulo de Control de Versión
 *
 * NOTA: Este archivo es solo un STUB de referencia.
 * El sistema real de logging ya existe en tu extensión en:
 *   src/modules/logger/Logger.ts
 *
 * El módulo de Control de Versión importa Logger desde esa ruta.
 * Si tu Logger tiene una API diferente, ajusta las llamadas en:
 *   - GitPlumbing.ts
 *   - FlatteningEngine.ts
 *   - VersionControlCommands.ts
 *   - Context_VersionControl_Integration.ts
 *
 * API esperada por el módulo de VC:
 */

export class Logger {
    static info(category: string, message: string): void {
        // Tu implementación existente
        console.log(`[${category}] INFO: ${message}`);
    }

    static warn(category: string, message: string): void {
        console.warn(`[${category}] WARN: ${message}`);
    }

    static error(category: string, message: string): void {
        console.error(`[${category}] ERROR: ${message}`);
    }
}

/**
 * Si tu Logger usa una API distinta (e.g., Logger.log('INFO', cat, msg)),
 * crea un adaptador en cada archivo o ajusta las llamadas directamente.
 *
 * Categorías usadas por el módulo VC:
 *   - 'VERSION_CONTROL'  → eventos del motor y comandos
 *   - 'GIT'              → operaciones de GitPlumbing
 */
