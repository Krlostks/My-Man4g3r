import * as fs from 'fs';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { ConfigManager } from '../../config/ConfigManager';
import { Logger } from '../logger/Logger';
import { PersistenceUnit, ResourceScope } from './types';

/**
 * Escanea los archivos persistence.xml de todos los proyectos configurados
 * y extrae los nombres JNDI de los DataSources que el codigo requiere.
 *
 * Detecta automaticamente si el JNDI usa el prefijo java:app/ (app-scoped)
 * y genera un nombre global normalizado para poder crearlo via asadmin.
 *
 * Busca en la ruta estandar de Maven:
 *   <rootPath>/src/main/resources/META-INF/persistence.xml
 */
export class PersistenceScanner {

    /** Ruta relativa dentro de un proyecto Maven donde vive el descriptor */
    private static readonly PERSISTENCE_REL_PATH = path.join(
        'src', 'main', 'resources', 'META-INF', 'persistence.xml'
    );

    /** Prefijo que indica recursos de ambito de aplicacion */
    private static readonly APP_SCOPE_PREFIX = 'java:app/';

    /**
     * Escanea todos los proyectos registrados en la configuracion
     * y devuelve las unidades de persistencia encontradas.
     */
    static scanAll(): PersistenceUnit[] {
        const projects = ConfigManager.getProjects();
        const units: PersistenceUnit[] = [];

        for (const project of projects) {
            const found = PersistenceScanner.scanProject(project.rootPath, project.name);
            units.push(...found);
        }

        Logger.info('DATABASE', `Escaneo completado: ${units.length} unidad(es) de persistencia encontrada(s).`);
        return units;
    }

    /**
     * Escanea un proyecto individual.
     */
    static scanProject(rootPath: string, projectName: string): PersistenceUnit[] {
        const filePath = path.join(rootPath, PersistenceScanner.PERSISTENCE_REL_PATH);

        if (!fs.existsSync(filePath)) {
            Logger.warn('DATABASE', `persistence.xml no encontrado en: ${projectName}`);
            return [];
        }

        try {
            const xmlContent = fs.readFileSync(filePath, 'utf-8');
            return PersistenceScanner.parse(xmlContent, projectName, rootPath);
        } catch (err) {
            Logger.error('DATABASE', `Error al leer persistence.xml de '${projectName}': ${String(err)}`);
            return [];
        }
    }

    /**
     * Normaliza un JNDI name quitando el prefijo java:app/ si existe.
     *
     * Ejemplos:
     *   "java:app/jdbc/egobsaden" -> "jdbc/egobsaden"
     *   "java:app/sigaf"          -> "jdbc/sigaf"  (agrega jdbc/ si no lo tiene)
     *   "jdbc/miPool"             -> "jdbc/miPool"  (ya es global, sin cambios)
     */
    static normalizeToGlobal(jndiName: string): string {
        let normalized = jndiName;

        // Quitar el prefijo java:app/
        if (normalized.startsWith(PersistenceScanner.APP_SCOPE_PREFIX)) {
            normalized = normalized.substring(PersistenceScanner.APP_SCOPE_PREFIX.length);
        }

        // Asegurar que tenga el prefijo jdbc/ para consistencia
        if (!normalized.startsWith('jdbc/')) {
            normalized = `jdbc/${normalized}`;
        }

        return normalized;
    }

    /**
     * Detecta el ambito de un JNDI name.
     */
    static detectScope(jndiName: string): ResourceScope {
        return jndiName.startsWith(PersistenceScanner.APP_SCOPE_PREFIX) ? 'app-scoped' : 'global';
    }

    /**
     * Parsea el contenido XML y extrae las unidades de persistencia.
     *
     * Estructura esperada:
     * <persistence>
     *   <persistence-unit name="...">
     *     <jta-data-source>java:app/jdbc/nombre</jta-data-source>
     *   </persistence-unit>
     * </persistence>
     */
    private static parse(xmlContent: string, projectName: string, projectPath: string): PersistenceUnit[] {
        const parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '@_',
        });

        const parsed = parser.parse(xmlContent);
        const units: PersistenceUnit[] = [];

        // Navegar la estructura del XML
        const persistence = parsed?.persistence;
        if (!persistence) {
            Logger.warn('DATABASE', `Formato invalido en persistence.xml de '${projectName}': falta nodo <persistence>.`);
            return [];
        }

        // persistence-unit puede ser un objeto o un array
        let puNodes = persistence['persistence-unit'];
        if (!puNodes) {
            return [];
        }

        if (!Array.isArray(puNodes)) {
            puNodes = [puNodes];
        }

        for (const pu of puNodes) {
            const unitName = pu['@_name'] || 'default';
            const jtaDs = pu['jta-data-source'];

            if (jtaDs) {
                const scope = PersistenceScanner.detectScope(jtaDs);
                const globalJndiName = PersistenceScanner.normalizeToGlobal(jtaDs);

                units.push({
                    unitName,
                    jtaDataSource: jtaDs,
                    globalJndiName,
                    projectName,
                    projectPath,
                    scope,
                });

                if (scope === 'app-scoped') {
                    Logger.warn('DATABASE',
                        `[${projectName}] PU '${unitName}': JNDI '${jtaDs}' usa java:app/ (app-scoped). ` +
                        `Se usara el nombre global '${globalJndiName}' para el servidor.`
                    );
                } else {
                    Logger.info('DATABASE', `[${projectName}] PU: '${unitName}' -> DataSource: '${jtaDs}'`);
                }
            }
        }

        return units;
    }
}
