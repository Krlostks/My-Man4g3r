/**
 * Tipos para el modulo de Base de Datos MM43.
 * Define las estructuras de datos para pools, recursos JDBC
 * y la configuracion del asistente de aprovisionamiento.
 */

/** Motores de base de datos soportados */
export type DatabaseDriver = 'sqlserver' | 'mysql' | 'oracle' | 'postgresql';

/** Estado de salud de un connection pool */
export type PoolStatus = 'active' | 'inactive' | 'unknown' | 'error';

/** Configuracion de driver para cada motor soportado */
export interface DriverProfile {
    label: string;
    datasourceClassname: string;
    defaultPort: number;
    resType: string;
    iconId: string;
}

/** Mapeo de drivers soportados con su configuracion tecnica */
export const DRIVER_PROFILES: Record<DatabaseDriver, DriverProfile> = {
    sqlserver: {
        label: 'SQL Server',
        datasourceClassname: 'com.microsoft.sqlserver.jdbc.SQLServerDataSource',
        defaultPort: 1433,
        resType: 'javax.sql.DataSource',
        iconId: 'database',
    },
    mysql: {
        label: 'MySQL',
        datasourceClassname: 'com.mysql.cj.jdbc.MysqlDataSource',
        defaultPort: 3306,
        resType: 'javax.sql.DataSource',
        iconId: 'database',
    },
    oracle: {
        label: 'Oracle',
        datasourceClassname: 'oracle.jdbc.pool.OracleDataSource',
        defaultPort: 1521,
        resType: 'javax.sql.DataSource',
        iconId: 'database',
    },
    postgresql: {
        label: 'PostgreSQL',
        datasourceClassname: 'org.postgresql.ds.PGSimpleDataSource',
        defaultPort: 5432,
        resType: 'javax.sql.DataSource',
        iconId: 'database',
    },
};

/** Configuracion completa para crear un JDBC Connection Pool */
export interface PoolConfig {
    poolName: string;
    driver: DatabaseDriver;
    host: string;
    port: number;
    databaseName: string;
    user: string;
    password: string;
    /** Propiedades adicionales clave=valor para el pool */
    additionalProperties?: Record<string, string>;
}

/** Representacion de un Connection Pool existente en el servidor */
export interface JdbcPool {
    name: string;
    datasourceClassname: string;
    status: PoolStatus;
    properties: Record<string, string>;
}

/** Representacion de un JDBC Resource existente en el servidor */
export interface JdbcResource {
    jndiName: string;
    poolName: string;
    enabled: boolean;
}

/**
 * Ambito original del JNDI detectado en persistence.xml:
 * - 'global': JNDI sin prefijo java:app/ (ej: jdbc/miPool). Funciona con asadmin directamente.
 * - 'app-scoped': tiene prefijo java:app/ (ej: java:app/jdbc/miPool). Requiere migracion a global.
 */
export type ResourceScope = 'global' | 'app-scoped';

/** Resultado del escaneo de un persistence.xml */
export interface PersistenceUnit {
    unitName: string;
    /** JNDI tal cual aparece en persistence.xml */
    jtaDataSource: string;
    /**
     * JNDI normalizado para uso global en el servidor.
     * Si el original es "java:app/jdbc/egobsaden", el global sera "jdbc/egobsaden".
     * Si ya es global (sin prefijo java:app/), sera identico al original.
     */
    globalJndiName: string;
    projectName: string;
    projectPath: string;
    /** Ambito detectado a partir del prefijo JNDI */
    scope: ResourceScope;
}

/** Estado de sincronizacion entre lo que pide el codigo y lo que existe en el servidor */
export interface ResourceSyncState {
    unit: PersistenceUnit;
    existsOnServer: boolean;
    associatedPool?: JdbcPool;
}

