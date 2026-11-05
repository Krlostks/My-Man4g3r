import * as vscode from 'vscode';

export interface javaAcompilar {
    ruta: string;
    proyecto: ProjectConfig;
    validarClaspath(): Promise<boolean>
}

export interface comandoPersonalizado {
    id: string;
    nombre: string;
    tipoComando: string;
    argumentos: string[];
    flags?: Record<string, string | boolean>;
    rutaEjecucion?: string;
    environment?: NodeJS.ProcessEnv;
    validar(): Promise<boolean>;
    ejecutar(): Promise<CommandResult>;
}


export interface CommandResult {
    success: boolean;
    salida?: String | Buffer;
    error?: String | Buffer;
}

export interface ICommand {
    id: string;
    name: string;
    toTask(context?: vscode.ExtensionContext): vscode.Task;
    validate(): Promise<boolean>;
    execute(outputChannel?: vscode.OutputChannel): Promise<CommandResult>;
}

export interface ProjectConfig {
    name: string;
    rootPath: string;
    warName: string;
    classpath?: string;
}

export interface datosGenericos {
    clave: string;
    valor: string;
}

export interface ServerConfig {
    serverPath: string;
    serverType?: string;
    domain: string;
}
export interface VersionVector {
    [developerId: string]: number;
}

/**
 * Relación causal entre dos vectores de versión.
 * - BEFORE: A causalmente precede a B (A < B)
 * - AFTER:  B causalmente precede a A (A > B)
 * - CONCURRENT: Sin relación causal (A || B) → posible conflicto semántico
 * - EQUAL: Idénticos
 */
export type CausalRelation = 'BEFORE' | 'AFTER' | 'CONCURRENT' | 'EQUAL';

/**
 * Metadatos MM43 inyectados en cada commit.
 * Se almacenan como trailer en el mensaje de commit con prefijo "MM43-VV:".
 */
export interface CommitMetadata {
    versionVector: VersionVector;
    featureId?: string;
    developerId: string;
    timestamp: number; // Unix timestamp local (solo referencial, no autoritativo)
}

/**
 * Información de un commit enriquecida con metadatos MM43.
 */
export interface EnrichedCommit {
    sha: string;
    shortSha: string;
    message: string;
    author: string;
    authorEmail: string;
    date: string;
    metadata?: CommitMetadata;
    isOnServer?: boolean;
    featureRef?: string; // refs/features/[ID]/head
}

/**
 * Feature (tarea lógica) rastreada por el motor.
 * Vive en refs/features/[featureId]/
 */
export interface Feature {
    id: string;
    name: string;
    startRef: string;   // refs/features/[ID]/start
    headRef: string;    // refs/features/[ID]/head
    startSha: string;
    headSha: string;
    developerId: string;
    commits: EnrichedCommit[];
    status: 'active' | 'integrated' | 'conflict' | 'closed' | 'open';
}

/**
 * Representa el estado de un archivo en git status
 */
export interface GitFileStatus {
    path: string;
    status: string; // 'M', 'A', 'D', 'R', '??', etc.
}

/**
 * Representa un stash de git
 */
export interface GitStash {
    index: number;
    message: string;
}

/**
 * Estado del panel de Control de Versión (para la UI).
 */
export interface VersionControlState {
    currentBranch: string;
    currentFeature?: Feature;
    allFeatures: Feature[];
    pendingConflicts: ConflictInfo[];
    orphanCommits: EnrichedCommit[];
    stagedFiles: GitFileStatus[];
    unstagedFiles: GitFileStatus[];
    untrackedFiles: GitFileStatus[];
    stashes: GitStash[];
    trunkHead: string;
    isRebasing: boolean;
    lastError?: string;
}

/**
 * Información de un conflicto semántico detectado entre commits concurrentes.
 */
export interface ConflictInfo {
    commitA: string;
    commitB: string;
    vectorA: VersionVector;
    vectorB: VersionVector;
    filesAffected: string[];
    detectedAt: string;
}

/**
 * Resultado de la operación de aplanamiento (flatten).
 */
export interface FlattenResult {
    success: boolean;
    newHeadSha?: string;
    integratedFeatureId?: string;
    conflictsFound: ConflictInfo[];
    message: string;
}

export type AgentMode = 'none' | 'standard' | 'basic' | 'dcevm';
export type StructuralChangeBehavior = 'auto-redeploy' | 'confirm' | 'notify';
export type ReloadFailureFallback = 'auto-redeploy' | 'none';

// ─── Tipos nuevos para HotswapAgent ──────────────────────────────────────────

/** Clase modificada detectada en la sincronizacion incremental. */
export interface ChangedClass {
    /** Nombre canonico (ej. 'a.b.Foo$1'). */
    className: string;
    /** Ruta absoluta del .class en WEB-INF/classes. */
    classFile: string;
    /** Hash SHA-256 (64 caracteres hexadecimales) del bytecode sincronizado. */
    hash: string;
}

/** Resultado de la sincronizacion incremental de WEB-INF/classes. */
export interface SyncResult {
    /** Clases cuyo bytecode fue copiado (nuevo o modificado). */
    changed: ChangedClass[];
    /** Rutas relativas a classRoot de los .class eliminados. */
    removed: string[];
}

/** Capacidad de la JVM que usa el servidor. */
export type JvmKind = 'dcevm' | 'dcevm-alt' | 'standard' | 'unknown';

/** Modo de recarga activo (derivado de JvmKind + config). */
export type ReloadMode = 'hotswap-agent' | 'jdwp' | 'none';

/** Estado del resultado de recarga por clase. */
export type ReloadStatus =
    | 'reloaded'
    | 'skipped-not-loaded'
    | 'failed'
    | 'stale-loader'
    | 'timeout';

/** Resultado de recarga de una clase individual. */
export interface ReloadOutcome {
    className: string;
    status: ReloadStatus;
    ms: number;
    message?: string;
}

/** Contexto que recibe una estrategia de recarga. */
export interface ReloadContext {
    project: ProjectConfig;
    classes: ChangedClass[];
    changeType: 'method-body' | 'structural';
}

/** Resultado agregado de un ciclo de recarga. */
export interface HotswapReloadResult {
    success: boolean;
    outcomes: ReloadOutcome[];
    requiresRedeploy: boolean;
    requiresServerRestart: boolean;
    message: string;
}

export interface AgentConfig {
    agentPath: string;
    mode: AgentMode;
}

export type WatcherState = 'stopped' | 'running' | 'error';

export type ServerState = 'stopped' | 'running' | 'starting' | 'stopping' | 'unknown';



// Tipos para primefaces y omnifaces

export interface Attribute {
    readonly name: string;
    readonly type: string;
    readonly description: string;
    readonly required: boolean;
}

export interface Component {
    readonly name: string;
    readonly description: string;
    readonly attributes: Attribute[];
}

export type FrameworkMetadataCollection = Record<string, Component>;