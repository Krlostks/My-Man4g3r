import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as net from 'net';
import { spawn, ChildProcess } from 'child_process';
import { ProjectConfig } from '../../config/types';
import { ConfigManager } from '../../config/ConfigManager';
import { Logger } from '../logger/Logger';
import { HotReloadClient } from './HotReloadClient';
import { DcevmValidator } from './DcevmValidator';

type ChangeType = 'local' | 'external' | 'structural' | 'unknown';
type CompilacionPrioridad = 'high' | 'normal' | 'low';

interface FileMetadata {
    mtime: number;
    size: number;
    contentHash: string;
    lastCompilation?: number;
}

interface CompilacionJob {
    id: string;
    javaFile: string;
    project: ProjectConfig;
    prioridad: CompilacionPrioridad;
    intentos: number;
    timestamp: number;
    changeType: ChangeType;
    resolve: (success: boolean) => void;
    reject: (error: Error) => void;
}
interface CompilerServer {
    process: ChildProcess | null;
    ready: boolean;
    port: number;
    projectName: string;
    lastUsed: number;
    socket: net.Socket | null;
}

const COMPILER_SERVER_PORT_BASE = 24000;
const MAX_RETRIES = 3;
const RETRY_DELAY_BASE = 1000;
const BATCH_SIZE = 5;
const FILE_WATCH_DEBOUNCE = 300;
const EXTERNAL_CHANGE_THRESHOLD_MS = 3000;


export class AgenteHotReloadManager {

    private static compilerServers: Map<string, CompilerServer> = new Map();

    private static compilationQueue: CompilacionJob[] = [];
    private static isWorkerRunning = false;
    private static workerPromise: Promise<void> | null = null;

    private static fileMetadataCache: Map<string, FileMetadata> = new Map();

    private static dependenciaCache: Map<string, Set<string>> = new Map();
    private static reverseDependenciaCache: Map<string, Set<string>> = new Map();
    
    private static changeQueue: { filename: string, project: ProjectConfig }[] = [];
    private static processTimer: ReturnType<typeof setTimeout> | undefined;
    private static THRESHOLD = 50;    
    private static isPaused: boolean = false;
    private static lastHashes: Map<string, string> = new Map();
    private static activeStatusMessages: Map<string, vscode.Disposable> = new Map();

    constructor() { }

    static setPaused(paused: boolean): void {
        Logger.debug('DEBUG', `setPaused invocado (paused: ${paused})`);
        this.isPaused = paused;
        if (paused) {
            Logger.info('HOTRELOAD', '⏸ Watcher pausado temporalmente.');
        } else {
            Logger.info('HOTRELOAD', '▶ Watcher reanudado.');
        }
    }

    static async cambioEnCaliente(filename: string, project: ProjectConfig): Promise<void> {
        if (this.isPaused) { return; }

        if (!filename.endsWith('.java')) { return; }

        filename = filename.replace(/[\r\n]/g, '').trim();

        const javaAbsPath = path.isAbsolute(filename) ? filename : path.join(project.rootPath, 'src', 'main', 'java', filename);
        if (!fs.existsSync(javaAbsPath)) { return; }

        try {
            const content = fs.readFileSync(javaAbsPath);
            const hash = crypto.createHash('md5').update(content).digest('hex');
            if (this.lastHashes.get(javaAbsPath) === hash) { return; }
            this.lastHashes.set(javaAbsPath, hash);
        } catch (e) {
            Logger.error('HOTRELOAD', `Error calculando hash para ${filename}: ${e}`);
        }

        this.mostrarSpinner(javaAbsPath);

        this.changeQueue.push({ filename, project });        
        if (this.processTimer) { clearTimeout(this.processTimer); }

        this.processTimer = setTimeout(() => {
            this.procesarCola();
        }, 800);
    }

    private static async procesarCola(): Promise<void> {
        const queue = [...this.changeQueue];
        this.changeQueue = [];

        if (queue.length === 0) { return; }

        Logger.debug('DEBUG', `procesarCola invocado con ${queue.length} cambios`);

        if (queue.length > this.THRESHOLD) {
            Logger.warn('HOTRELOAD', ` Detectados ${queue.length} cambios simultáneos. Saturación probable.`);
            const choice = await vscode.window.showWarningMessage(
                `[MM43] Se detectaron ${queue.length} cambios en archivos Java. ` +
                '¿Desea procesar todos uno por uno o realizar un Redeploy Completo?',
                'Procesar todo (Lento)', 'Redeploy Completo'
            );

            if (choice === 'Redeploy Completo') {
                queue.forEach(item => {
                    const javaAbsPath = path.isAbsolute(item.filename) ? item.filename : path.join(item.project.rootPath, 'src', 'main', 'java', item.filename);
                    this.removerSpinner(javaAbsPath);
                });
                vscode.commands.executeCommand('mm43.restartServer');
                return;
            } else if (!choice) {
                queue.forEach(item => {
                    const javaAbsPath = path.isAbsolute(item.filename) ? item.filename : path.join(item.project.rootPath, 'src', 'main', 'java', item.filename);
                    this.removerSpinner(javaAbsPath);
                });
                return;
            }
        }

        const uniqueFiles = new Map<string, { filename: string, project: ProjectConfig }>();
        queue.forEach(q => uniqueFiles.set(`${q.project.name}:${q.filename}`, q));

        Logger.info('HOTRELOAD', `Procesando cola de recarga (${uniqueFiles.size} archivos únicos)...`);

        for (const [key, item] of uniqueFiles) {
            await this.colaDeCompilacion(item.filename, item.project);
        }
    }

    private static async colaDeCompilacion(javaFile: string, project: ProjectConfig, prioridad: CompilacionPrioridad = 'normal'):Promise<boolean>{        
        return new Promise((resolve, reject)=>{
            const job:CompilacionJob ={
                id:`${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                javaFile,
                project,
                prioridad,
                intentos:0,
                timestamp:Date.now(),
                changeType:'unknown',
                resolve,
                reject
            };

            this.compilationQueue.push(job);
            this.compilationQueue.sort((a, b) => {
                const pOrder = { high: 0, normal: 1, low: 2 };
                if (pOrder[a.prioridad] !== pOrder[b.prioridad]) {
                    return pOrder[a.prioridad] - pOrder[b.prioridad];
                }
                return a.timestamp - b.timestamp;
            });

            if (!this.isWorkerRunning || !this.workerPromise) {
                this.workerPromise = this.runCompilationWorker();
            }
        })
    }

    private static async runCompilationWorker(): Promise<void> {
        this.isWorkerRunning = true;
        Logger.debug('DEBUG', 'CompilationWorker iniciado');

        while (this.compilationQueue.length > 0) {
            const batch = this.compilationQueue.splice(0, BATCH_SIZE);
            
            // Ejecutar batch en paralelo
            const promises = batch.map(job => this.ejecutarJob(job));
            await Promise.allSettled(promises);

            // Limpiar servidores inactivos
            this.limpiarServidoresInactivos();
        }

        this.isWorkerRunning = false;
        this.workerPromise = null;
        Logger.debug('DEBUG', 'CompilationWorker detenido');
    }

    private static async ejecutarJob(job: CompilacionJob): Promise<void> {
        try {
            job.intentos++;

            // 1. Analizar tipo de cambio
            if (job.changeType === 'unknown') {
                job.changeType = await this.analizarTipoCambio(job.javaFile, job.project);
            }            

            // 2. Ejecutar estrategia segun tipo
            let success = false;
            switch (job.changeType) {
                case 'external':
                    success = await this.compilarConServidor(job.javaFile, job.project);
                    if (!success) {
                        success = await this.compilarModuloCompleto(job.javaFile, job.project);
                    }
                    break;
                case 'structural':
                    success = await this.compilarConAnalisisEstructural(job.javaFile, job.project);
                    break;
                case 'local':
                default:
                    success = await this.compilarConServidor(job.javaFile, job.project);
                    break;
            }

            if (success) {
                job.resolve(true);
                await this.enviarHotswap(job.javaFile, job.project);
            } else if (job.intentos < MAX_RETRIES) {
                // Retry con delay exponencial
                const delay = RETRY_DELAY_BASE * Math.pow(2, job.intentos - 1);
                Logger.debug('DEBUG', `Retry ${job.intentos}/${MAX_RETRIES} en ${delay}ms`);
                await this.delay(delay);
                this.compilationQueue.unshift(job);
            } else {
                Logger.error('HOTRELOAD', `Falló tras ${MAX_RETRIES} intentos: ${job.javaFile}`);
                job.resolve(false);
                const basename = path.basename(job.javaFile, '.java');
                this.removerSpinner(job.javaFile, `Hotswap ❌ : ${basename}`, 3000);
            }

        } catch (error) {
            Logger.error('HOTRELOAD', `Error en job ${job.id}: ${error}`);
            job.reject(error as Error);
            const basename = path.basename(job.javaFile, '.java');
            this.removerSpinner(job.javaFile, `Hotswap ❌ : ${basename}`, 3000);
        }
    }

    private static async analizarTipoCambio(javaFile: string, project: ProjectConfig): Promise<ChangeType> {
        let stats: fs.Stats;
        try {
            stats = fs.statSync(javaFile);
        } catch {
            return 'unknown';
        }

        const cached = this.fileMetadataCache.get(javaFile);
        const now = Date.now();
        const mtime = stats.mtimeMs;

        if (!cached) {
            this.fileMetadataCache.set(javaFile, {
                mtime,
                size: stats.size,
                contentHash: await this.hashFile(javaFile)
            });
            return 'local';
        }

        const timeSinceLastChange = mtime - cached.mtime;
        const sizeChanged = stats.size !== cached.size;

        if (timeSinceLastChange < EXTERNAL_CHANGE_THRESHOLD_MS && sizeChanged) {
            Logger.debug('DEBUG', `Cambio EXTERNAL detectado en ${path.basename(javaFile)}`);
            return 'external';
        }

        // Verificar si cambio es estructural
        if (await this.esCambioEstructural(javaFile)) {
            Logger.debug('DEBUG', `Cambio STRUCTURAL detectado en ${path.basename(javaFile)}`);
            return 'structural';
        }

        // Verificar git status para cambios externos
        if (await this.tieneCambiosGit(javaFile, project)) {
            return 'external';
        }

        // Actualizar cache
        this.fileMetadataCache.set(javaFile, {
            ...cached,
            mtime,
            size: stats.size,
            contentHash: await this.hashFile(javaFile)
        });

        return 'local';
    }

    private static async tieneCambiosGit(javaFile: string, project: ProjectConfig): Promise<boolean> {
        return new Promise((resolve) => {
            const { exec } = require('child_process');
            const relativePath = path.relative(project.rootPath, javaFile).replace(/\\/g, '/');
            
            // git status --porcelain devuelve info si el archivo cambio
            exec(
                `git status --porcelain "${relativePath}"`,
                { cwd: project.rootPath, timeout: 5000 },
                (error: any, stdout: string) => {
                    if (error) {
                        resolve(false);
                        return;
                    }
                    // Si tiene contenido, cambio externo
                    resolve(stdout.trim().length > 0);
                }
            );
        });
    }

    private static async hashFile(filePath: string): Promise<string> {
        try {
            const content = fs.readFileSync(filePath);
            return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
        } catch {
            return '';
        }
    }

    private static async esCambioEstructural(javaFile: string): Promise<boolean> {
        try {
            const content = fs.readFileSync(javaFile, 'utf8');
            
            // Patrones de cambio estructural
            const structuralPatterns = [
                /^\s*(public|private|protected)\s+(static\s+)?(final\s+)?\w+\s+\w+\s*\(/m,
                /^\s*import\s+[\w\.]+\s*;/m,
                /^\s*@(Override|Deprecated|Singleton|Component|Service|Repository)\b/m,
                /^\s*(public|protected)\s+\w+\s+\w+\s*\{/m,
            ];

            for (const pattern of structuralPatterns) {
                if (pattern.test(content)) {
                    return true;
                }
            }
            return false;
        } catch {
            return false;
        }
    }
    private static getServerKey(project: ProjectConfig): string {
        return `${project.name}__${project.rootPath}`;
    }

    private static async crearServidor(project: ProjectConfig): Promise<CompilerServer> {
        const port = COMPILER_SERVER_PORT_BASE + (project.name.length % 1000);

        // Necesitamos la ruta a 'java', NO a 'javac' (getJdkPath devuelve javac)
        const javaBin = this.getJavaExecutable();
        const jdkPath = ConfigManager.getJdkPath();
        const classpath = project.classpath;
        const outputDir = path.join(project.rootPath, 'target', project.warName, 'WEB-INF', 'classes');

        // Asegurar que el directorio de clases existe
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const serverCode = `
import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.util.*;
import javax.tools.*;
import javax.tools.JavaCompiler.*;

public class MM43CompilerServer {
    private ServerSocket server;
    private JavaCompiler compiler;
    private StandardJavaFileManager fileManager;
    private String classpath;
    private String outputDir;
    private volatile boolean running = true;

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(args[0]);
        String cp = args[1];
        String out = args[2];
        System.out.println("STARTING|" + port);
        new MM43CompilerServer(cp, out).run(port);
    }

    public MM43CompilerServer(String classpath, String outputDir) {
        this.classpath = classpath;
        this.outputDir = outputDir;
        this.compiler = ToolProvider.getSystemJavaCompiler();
    }

    public void run(int port) throws Exception {
        server = new ServerSocket();
        server.setReuseAddress(true);
        server.bind(new InetSocketAddress(port));
        System.out.println("READY|" + port);
        
        while (running) {
            try {
                Socket client = server.accept();
                client.setSoTimeout(30000);
                handle(client);
            } catch (SocketTimeoutException e) {
                // Continue
            }
        }
    }

    private void handle(Socket client) {
        try (BufferedReader in = new BufferedReader(
                new InputStreamReader(client.getInputStream(), "UTF-8"));
             PrintWriter out = new PrintWriter(
                new OutputStreamWriter(client.getOutputStream(), "UTF-8"), true)) {
            
            String line;
            while ((line = in.readLine()) != null && !line.isEmpty()) {
                String[] parts = line.split("\\\\|", 2);
                String cmd = parts[0];
                
                switch (cmd) {
                    case "COMPILE":
                        String result = compile(parts[1]);
                        out.println(result);
                        break;
                    case "PING":
                        out.println("PONG");
                        break;
                    case "QUIT":
                        running = false;
                        out.println("BYE");
                        return;
                }
            }
        } catch (Exception e) {
            System.err.println("ERROR|" + e.getMessage());
        }
    }

    private String compile(String javaFile) {
        try {
            File file = new File(javaFile);
            if (!file.exists()) {
                return "ERROR|File not found";
            }
            
            this.fileManager = compiler.getStandardFileManager(null, null, null);
            
            List<String> options = Arrays.asList(
                "-encoding", "UTF-8",
                "-cp", classpath,
                "-d", outputDir,
                "-g",
                "-proc:none"
            );
            
            Iterable<? extends JavaFileObject> units =
                fileManager.getJavaFileObjectsFromFiles(Collections.singletonList(file));
            
            JavaCompiler.CompilationTask task = compiler.getTask(
                new StringWriter(), fileManager, null, options, null, units);
            
            boolean ok = task.call();
            fileManager.close();
            
            return ok ? "OK" : "ERROR|Compilation failed";
        } catch (Exception e) {
            return "ERROR|" + e.getMessage();
        }
    }
}
`;

        const serverDir = path.join(project.rootPath, 'target', 'mm43_temp');
        if (!fs.existsSync(serverDir)) { fs.mkdirSync(serverDir, { recursive: true }); }

        const serverJava = path.join(serverDir, 'MM43CompilerServer.java');
        const serverClass = path.join(serverDir, 'MM43CompilerServer.class');
        
        // Eliminar clases anteriores si existen
        if (fs.existsSync(serverClass)) { fs.unlinkSync(serverClass); }
        if (fs.existsSync(serverJava)) { fs.unlinkSync(serverJava); }

        fs.writeFileSync(serverJava, serverCode, 'utf8');

        // Compilar el servidor con javac
        const compileCmd = `"${jdkPath}" -d "${serverDir}" "${serverJava}"`;
        Logger.debug('DEBUG', `Compilando servidor: ${compileCmd}`);
        const compileResult = await this.execCommand(compileCmd, 30000);
        if (compileResult.stderr) {
            Logger.debug('DEBUG', `javac stderr: ${compileResult.stderr}`);
        }
        if (compileResult.stdout) {
            Logger.debug('DEBUG', `javac stdout: ${compileResult.stdout}`);
        }
        
        // Verificar que el .class fue generado
        if (fs.existsSync(serverClass)) {
            Logger.debug('DEBUG', `.class generado: ${serverClass}`);
        } else {
            Logger.error('HOTRELOAD', `.class NO generado en: ${serverClass}`);
        }

        // Buscar tools.jar (necesario para javax.tools en JDK 8)
        const toolsJar = this.findToolsJar(jdkPath);

        // Iniciar el servidor con JAVA (no javac)
        // El classpath debe incluir el dir donde esta .class + tools.jar (si existe)
        const serverClasspath = toolsJar ? `${serverDir};${toolsJar}` : serverDir;
        const fullClasspath = `${outputDir};${classpath}`;
        const serverProcess = spawn(javaBin, [
            '-cp', serverClasspath,
            'MM43CompilerServer',
            port.toString(),
            fullClasspath,
            outputDir
        ], { cwd: serverDir });

        const server: CompilerServer = {
            process: serverProcess,
            ready: false,
            port,
            projectName: project.name,
            lastUsed: Date.now(),
            socket: null
        };

        // Escuchar output del servidor
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                Logger.warn('HOTRELOAD', 'Timeout esperando servidor de compilacion');
                resolve();
            }, 8000);

            serverProcess.stdout?.on('data', (data: Buffer) => {
                const msg = data.toString().trim();
                Logger.debug('DEBUG', `CompilerServer: ${msg}`);
                if (msg.includes('READY|')) {
                    server.ready = true;
                    clearTimeout(timeout);
                    resolve();
                }
            });

            serverProcess.stderr?.on('data', (data: Buffer) => {
                Logger.debug('DEBUG', `CompilerServer stderr: ${data.toString().trim()}`);
            });
        });

        return server;
    }

    /**
     * Obtiene la ruta al ejecutable 'java' del JDK configurado.
     * A diferencia de ConfigManager.getJdkPath() que devuelve 'javac',
     * este metodo devuelve la ruta a 'java' para poder ejecutar clases.
     */
    private static getJavaExecutable(): string {
        // Obtener el JAVA_HOME a partir de donde esta javac
        const javacPath = ConfigManager.getJdkPath();
        if (!javacPath) { return 'java'; }

        // javacPath puede ser:
        // - "C:\\Java\\jdk1.8.0_181\\bin\\javac.exe"  -> javaBin = "C:\\Java\\jdk1.8.0_181\\bin\\java.exe"
        // - "javac"  -> fallback a 'java'
        const javaExe = process.platform === 'win32' ? 'java.exe' : 'java';

        if (javacPath.includes('bin')) {
            // Reemplazar javac por java en la ruta
            const javaBin = javacPath.replace(/\\javac(\.exe)?$/i, `\\${javaExe}`)
                                    .replace(/\/javac(\.exe)?$/i, `/${javaExe}`);
            if (fs.existsSync(javaBin)) {
                return javaBin;
            }
        }

        // Fallback: buscar 'java' en el mismo directorio que javac
        if (fs.existsSync(javacPath)) {
            const dir = path.dirname(javacPath);
            const javaBin = path.join(dir, javaExe);
            if (fs.existsSync(javaBin)) {
                return javaBin;
            }
        }

        // Fallback final
        return 'java';
    }

    /**
     * Encuentra tools.jar necesario para javax.tools.JavaCompiler.
     * En JDK 8 está en $JAVA_HOME/lib/tools.jar.
     * En JDK 9+ es un módulo y no necesita tools.jar.
     */
    private static findToolsJar(javacPath: string): string | null {
        try {
            // Obtener directorio JDK desde javac.exe
            const javacDir = path.dirname(javacPath);
            const jdkDir = path.dirname(javacDir); // subir de bin/ a JDK root
            
            // JDK 8: tools.jar en lib/
            const toolsJar = path.join(jdkDir, 'lib', 'tools.jar');
            if (fs.existsSync(toolsJar)) {
                Logger.debug('DEBUG', `tools.jar encontrado: ${toolsJar}`);
                return toolsJar;
            }
            
            // JDK 9+: javax.tools está en el módulo java.compiler
            // No necesita tools.jar
            Logger.debug('DEBUG', 'JDK 9+ detectado, tools.jar no necesario');
            return null;
        } catch (error) {
            Logger.debug('DEBUG', `Error buscando tools.jar: ${error}`);
            return null;
        }
    }

    private static async compilarConServidor(javaFile: string, project: ProjectConfig): Promise<boolean> {
        // Usar javac directo: mas simple y confiable que servidor TCP persistente.
        // El servidor TCP agrega latency de ~5 seg (compilar java, iniciar JVM, handshake)
        // sin beneficio real para compilacion individual.
        return this.compilarConJavac(javaFile, project);
    }
    private static async obtenerServidor(project: ProjectConfig): Promise<CompilerServer> {
        const key = this.getServerKey(project);

        if (this.compilerServers.has(key)) {
            const server = this.compilerServers.get(key)!;
            server.lastUsed = Date.now();
            
            if (server.ready && (server.socket?.destroyed === false)) {
                return server;
            }
        }

        // Crear nuevo servidor
        const server = await this.crearServidor(project);
        this.compilerServers.set(key, server);
        return server;
    }
    private static destruirServidor(project: ProjectConfig): void {
        const key = this.getServerKey(project);
        const server = this.compilerServers.get(key);
        if (server) {
            server.process?.kill();
            server.socket?.destroy();
            this.compilerServers.delete(key);
        }
    }

    private static limpiarServidoresInactivos(): void {
        const now = Date.now();
        const TIMEOUT = 5 * 60 * 1000; // 5 minutos

        for (const [key, server] of this.compilerServers) {
            if (now - server.lastUsed > TIMEOUT) {
                Logger.debug('DEBUG', `Limpiando servidor inactivo: ${server.projectName}`);
                server.process?.kill();
                server.socket?.destroy();
                this.compilerServers.delete(key);
            }
        }
    }

    private static async compilarConJavac(javaFile: string, project: ProjectConfig): Promise<boolean> {
        const jdkPath = ConfigManager.getJdkPath();
        const outputDir = path.join(project.rootPath, 'target', project.warName, 'WEB-INF', 'classes');
        const classpath = project.classpath;
        const localClasses = outputDir;
        const fullClasspath = `${localClasses};${classpath}`;

        return new Promise((resolve) => {
            const { exec } = require('child_process');
            const tempDir = path.join(project.rootPath, 'target', 'temp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            
            // Classpath puede superar el limite de linea de comandos de Windows (~8191 chars).
            // Se usa un argfile (@archivo) soportado por javac desde JDK8. Se usan '/' para
            // evitar problemas de escape de '\\' dentro de las comillas del argfile.
            const toSlash = (p: string) => p.replace(/\\/g, '/');
            const argFile = path.join(tempDir, `argfile_${Date.now()}.txt`);
            const argContent = `-encoding UTF-8\n-cp "${toSlash(fullClasspath)}"\n-d "${toSlash(outputDir)}"\n"${toSlash(javaFile)}"\n`;

            try {
                fs.writeFileSync(argFile, argContent, 'utf8');
                const cmd = `"${jdkPath}" @"${argFile}"`;

                exec(cmd, { timeout: 30000 }, (error: any, stdout: string, stderr: string) => {
                try { fs.unlinkSync(argFile); } catch {}
                if (error) {
                    console.log("el error es :" + error.message);
                    console.log("el stderr es :" + stderr);
                    console.log("el stdout es :" + stdout);
                    
                    if (stderr.includes('cannot find symbol')) {
                        Logger.debug('DEBUG', 'Símbolo no encontrado, reintentando...');                        
                        setTimeout(() => resolve(true), 500);
                    } else {
                        Logger.error('HOTRELOAD', `javac error: ${stderr}`);
                        resolve(false);
                    }
                } else {
                    resolve(true);
                }
            });
            } catch (error) {
                try { fs.unlinkSync(argFile); } catch {}
                resolve(false);
                console.log("error");
                
            }
            // const cmd = `"${jdkPath}" -encoding UTF-8 -cp "${fullClasspath}" -d "${outputDir}" "${javaFile}"`;            
            
            // exec(cmd, { timeout: 30000 }, (error: any, stdout: string, stderr: string) => {
            //     if (error) {
            //         console.log("el error es :" + error.message);
            //         console.log("el stderr es :" + stderr);
            //         console.log("el stdout es :" + stdout);
                    
            //         if (stderr.includes('cannot find symbol')) {
            //             Logger.debug('DEBUG', 'Símbolo no encontrado, reintentando...');                        
            //             setTimeout(() => resolve(true), 500);
            //         } else {
            //             Logger.error('HOTRELOAD', `javac error: ${stderr}`);
            //             resolve(false);
            //         }
            //     } else {
            //         resolve(true);
            //     }
            // });
        });
    }

    private static async compilarConAnalisisEstructural(javaFile: string, project: ProjectConfig): Promise<boolean> {
        Logger.info('HOTRELOAD', `Analisis estructural: ${path.basename(javaFile)}`);

        // Encontrar todas las clases afectadas
        const afectadas = await this.encontrarClasesAfectadas(javaFile, project);
        Logger.debug('DEBUG', `Clases afectadas: ${afectadas.length}`);

        // Compilar en orden topologico
        const ordenado = this.ordenarTopologicamente(afectadas, project);

        for (const file of ordenado) {
            const success = await this.compilarConServidor(file, project);
            if (!success) {
                Logger.debug('DEBUG', `Fallo en ${file}, recompilacion completa...`);
                return this.compilarModuloCompleto(javaFile, project);
            }
        }

        return true;
    }

    private static async encontrarClasesAfectadas(javaFile: string, project: ProjectConfig): Promise<string[]> {
        const javaRoot = path.join(project.rootPath, 'src', 'main', 'java');
        const className = this.javaToClassName(javaFile, javaRoot);
        const afectadas: Set<string> = new Set([javaFile]);

        const javaFiles = this.obtenerTodosLosJavaFiles(javaRoot);

        for (const file of javaFiles) {
            if (file === javaFile) { continue; }
            try {
                const content = fs.readFileSync(file, 'utf8');
                const pattern = new RegExp(className.replace('.', '\\.'));
                if (pattern.test(content)) {
                    afectadas.add(file);
                }
            } catch { /* ignorar */ }
        }

        return Array.from(afectadas);
    }

    private static javaToClassName(javaFile: string, javaRoot: string): string {
        const relative = path.relative(javaRoot, javaFile);
        return relative.replace(/\\/g, '/').replace(/\.java$/, '').replace(/\//g, '.');
    }

    private static obtenerTodosLosJavaFiles(root: string): string[] {
        const files: string[] = [];
        const walk = (dir: string) => {
            if (!fs.existsSync(dir)) { return; }
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(full); }
                else if (entry.name.endsWith('.java')) { files.push(full); }
            }
        };
        walk(root);
        return files;
    }

    private static ordenarTopologicamente(files: string[], project: ProjectConfig): string[] {
        const javaRoot = path.join(project.rootPath, 'src', 'main', 'java');

        const getImports = (file: string): Set<string> => {
            const content = fs.readFileSync(file, 'utf8');
            const imports = new Set<string>();
            const pattern = /import\s+([\w\.]+)\s*;/g;
            let m;
            while ((m = pattern.exec(content)) !== null) {
                imports.add(m[1]);
            }
            return imports;
        };

        return [...files].sort((a, b) => {
            const impA = getImports(a);
            const impB = getImports(b);
            const classA = this.javaToClassName(a, javaRoot);
            const classB = this.javaToClassName(b, javaRoot);
            if (impA.has(classB)) { return 1; }
            if (impB.has(classA)) { return -1; }
            return 0;
        });
    }

    private static async compilarModuloCompleto(javaFile: string, project: ProjectConfig): Promise<boolean> {
        Logger.info('HOTRELOAD', 'Compilacion completa del modulo...');

        const { exec } = require('child_process');
        const hasMaven = fs.existsSync(path.join(project.rootPath, 'pom.xml'));

        return new Promise((resolve) => {
            if (hasMaven) {
                const cmd = `cd "${project.rootPath}" && mvnd compile -DskipTests`;
                exec(cmd, { timeout: 180000 }, (error: any, stdout: string, stderr: string) => {
                    if (error) {
                        Logger.error('HOTRELOAD', `Maven failed: ${stderr || stdout}`);
                        resolve(false);
                    } else {
                        Logger.info('HOTRELOAD', 'Maven compile OK');
                        resolve(true);
                    }
                });
            } else {
                // Fallback javac
                this.compilarConJavac(javaFile, project).then(resolve);
            }
        });
    }

    // ============================================================
    // HOTSWAP
    // ============================================================

    private static async enviarHotswap(javaFile: string, project: ProjectConfig): Promise<void> {
        const agentMode = ConfigManager.getAgentMode();
        if (!agentMode || agentMode === 'none') {
            Logger.debug('DEBUG', 'Hotswap omitido: agente no configurado');
            this.removerSpinner(javaFile);
            return;
        }

        const javaRoot = path.join(project.rootPath, 'src', 'main', 'java');
        const relative = path.relative(javaRoot, javaFile);
        const className = relative.replace(/\\/g, '/').replace(/\.java$/, '').replace(/\//g, '.');

        const classFile = path.join(
            project.rootPath, 'target', project.warName,
            'WEB-INF', 'classes',
            relative.replace(/\.java$/, '.class')
        );

        if (!fs.existsSync(classFile)) {
            Logger.debug('DEBUG', `.class no encontrado: ${classFile}`);
            const basename = path.basename(javaFile, '.java');
            this.removerSpinner(javaFile, `Hotswap ❌ : ${basename}`, 3000);
            return;
        }        
        const fileName = javaFile.substring(javaFile.lastIndexOf('\\') + 1);

        let success = false;
        try {
            success = await HotReloadClient.sendReload(className, classFile);
        } catch (e) {
            Logger.error('HOTRELOAD', `Error enviando reload para ${fileName}: ${e}`);
        }
        
        const basename = path.basename(javaFile, '.java');
        if (success) {
            Logger.info('HOTRELOAD', `clase recargada exitosamente: ${fileName}`);
            this.removerSpinner(javaFile, `Hotswap ⚡ : ${basename}`, 3000);
        } else {
            Logger.warn('HOTRELOAD', `HotSwap failed: ${fileName}`);
            this.removerSpinner(javaFile, `Hotswap ❌ : ${basename}`, 3000);
        }
    }

    private static mostrarSpinner(javaFile: string): void {
        const basename = path.basename(javaFile, '.java');
        const existing = this.activeStatusMessages.get(javaFile);
        if (existing) {
            existing.dispose();
        }
        const statusMsg = vscode.window.setStatusBarMessage(`$(sync~spin) Hotswap: ${basename}...`);
        this.activeStatusMessages.set(javaFile, statusMsg);
    }

    private static removerSpinner(javaFile: string, finalMessage?: string, timeoutMs: number = 3000): void {
        const existing = this.activeStatusMessages.get(javaFile);
        if (existing) {
            existing.dispose();
            this.activeStatusMessages.delete(javaFile);
        }
        if (finalMessage) {
            vscode.window.setStatusBarMessage(finalMessage, timeoutMs);
        }
    }

    // ============================================================
    // UTILIDADES
    // ============================================================

    private static delay(ms: number): Promise<void> {
        return new Promise(r => setTimeout(r, ms));
    }

    private static execCommand(cmd: string, timeout: number = 30000): Promise<{ stdout: string; stderr: string }> {
        return new Promise((resolve) => {
            const { exec } = require('child_process');
            exec(cmd, { timeout }, (error: any, stdout: string, stderr: string) => {
                resolve({ stdout: stdout || '', stderr: stderr || '' });
            });
        });
    }


    


    

    

    /////////////////////////////////////////////////
    
    async importAgent(): Promise<void> {
        Logger.debug('DEBUG', 'importAgent invocado');
        const uris = await vscode.window.showOpenDialog({
            title: 'MM43 — Selecciona el archivo del Agente HotSwap (.jar)',
            openLabel: 'Seleccionar Agente',
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'Java Archive': ['jar'] }
        });

        if (!uris || uris.length === 0) {
            Logger.debug('DEBUG', 'Importación de agente cancelada por el usuario');
            return;
        }
        const agentPath = uris[0].fsPath;

        if (!fs.existsSync(agentPath)) {
            Logger.error('HOTRELOAD', `El archivo seleccionado no existe: ${agentPath}`);
            vscode.window.showErrorMessage(`[MM43] El archivo seleccionado no existe: ${agentPath}`);
            return;
        }

        Logger.info('HOTRELOAD', `Agente seleccionado: ${agentPath}`);

        const { serverPath } = ConfigManager.getServerConfig();
        if (!serverPath) {
            Logger.error('HOTRELOAD', 'Intento de importar agente sin servidor configurado');
            vscode.window.showErrorMessage('[MM43] Configure un servidor primero antes de importar el agente.');
            return;
        }

        Logger.debug('DEBUG', 'Validando DCEVM...');
        const dcevmResult = DcevmValidator.checkDcevm();
        Logger.info('HOTRELOAD', `Java Home del servidor: ${dcevmResult.javaHome}`);
        Logger.info('HOTRELOAD', `Salida java -version: ${dcevmResult.versionOutput.trim()}`);

        if (dcevmResult.isDcevm) {
            Logger.debug('DEBUG', 'DCEVM detectado, activando modo completo');
            await ConfigManager.setAgentPath(agentPath);
            await ConfigManager.setAgentMode('dcevm');
            vscode.window.showInformationMessage(
                '  Agente importado con DCEVM detectado. Hot-Reload completo habilitado (cambios estructurales soportados).'
            );
            Logger.info('HOTRELOAD', '  Modo DCEVM activado — soporte estructural completo.');
        } else {
            Logger.debug('DEBUG', 'DCEVM NO detectado, solicitando elección al usuario');
            const choice = await vscode.window.showWarningMessage(
                '⚠️ La JVM del servidor NO es DCEVM. El Hot-Reload será limitado (solo cuerpos de métodos). ' +
                '¿Qué desea hacer?',
                { modal: true },
                'Continuar con HotSwap Básico',
                'Configurar DCEVM manualmente'
            );

            if (choice === 'Continuar con HotSwap Básico') {
                Logger.debug('DEBUG', 'Usuario eligió HotSwap Básico');
                await ConfigManager.setAgentPath(agentPath);
                await ConfigManager.setAgentMode('basic');
                vscode.window.showInformationMessage(
                    '⚡ Agente importado en modo básico. Cambios en firmas de métodos o campos requerirán Redeploy Completo.'
                );
                Logger.info('HOTRELOAD', '⚡ Modo básico activado — solo cambios en cuerpos de métodos.');
            } else if (choice === 'Configurar DCEVM manualmente') {
                Logger.debug('DEBUG', 'Usuario eligió Configurar DCEVM manualmente');
                await this.openDcevmConfigFiles();
            }
        }
    }

    async injectAgentOptions(): Promise<void> {
        Logger.debug('DEBUG', 'injectAgentOptions invocado');
        const agentPath = ConfigManager.getAgentPath();
        const { serverPath, domain } = ConfigManager.getServerConfig();

        if (!agentPath || !serverPath) {
            Logger.error('HOTRELOAD', 'Inyectar agente falló: agente o servidor no configurados');
            vscode.window.showErrorMessage('[MM43] El agente o el servidor no están configurados.');
            return;
        }

        const asadmin = path.join(serverPath, 'bin', 'asadmin.bat');
        const port = ConfigManager.getHotReloadPort();

        const jvmOpt = `-javaagent:${agentPath}`.replace(/:/g, '\\:');
        const portOpt = `-Dmm43.agent.port=${port}`;

        const terminal = vscode.window.terminals.find(t => t.name === 'MM43 — Agent Setup') || vscode.window.createTerminal('MM43 — Agent Setup');
        terminal.show();

        Logger.info('HOTRELOAD', `Enviando comandos de inyección a asadmin...`);
        Logger.debug('DEBUG', `Inyectando JVM options: ${jvmOpt} y ${portOpt}`);
        terminal.sendText(`& "${asadmin}" create-jvm-options --target server-config "${jvmOpt}"`);
        terminal.sendText(`& "${asadmin}" create-jvm-options --target server-config "${portOpt}"`);

        vscode.window.showInformationMessage('🚀 Comandos de inyección enviados. Revise la terminal para confirmar el éxito.');
    }

    async openDomainXml(): Promise<void> {
        Logger.debug('DEBUG', 'openDomainXml invocado');
        const { serverPath, domain } = ConfigManager.getServerConfig();
        if (!serverPath || !domain) { return; }

        const domainXmlPath = path.join(serverPath, 'glassfish', 'domains', domain, 'config', 'domain.xml');

        if (fs.existsSync(domainXmlPath)) {
            Logger.debug('DEBUG', `Abriendo domain.xml: ${domainXmlPath}`);
            const doc = await vscode.workspace.openTextDocument(domainXmlPath);
            await vscode.window.showTextDocument(doc);
            Logger.info('HOTRELOAD', `Abierto para edición manual: ${domainXmlPath}`);
        } else {
            Logger.error('HOTRELOAD', `No se encontró domain.xml en: ${domainXmlPath}`);
            vscode.window.showErrorMessage(`[MM43] No se encontró domain.xml en: ${domainXmlPath}`);
        }
    }

    async openDcevmConfigFiles(): Promise<void> {
        Logger.debug('DEBUG', 'openDcevmConfigFiles invocado');
        const disclaimer = await vscode.window.showWarningMessage(
            '⚠️ RESPONSABILIDAD DEL USUARIO\n\n' +
            'Va a modificar la configuración del servidor para apuntar a una JDK con DCEVM. ' +
            'Esto es una operación manual. Debe:\n' +
            '1. Descargar e instalar DCEVM/Trava OpenJDK.\n' +
            '2. Cambiar la variable AS_JAVA en asenv.bat a la ruta de la nueva JDK.\n' +
            '3. Reiniciar el servidor.\n\n' +
            'MM43 NO se hace responsable de errores derivados de esta modificación.',
            { modal: true },
            'Entendido, abrir archivos'
        );

        if (disclaimer !== 'Entendido, abrir archivos') {
            Logger.debug('DEBUG', 'Usuario canceló apertura de archivos DCEVM');
            return;
        }

        const asenvPath = DcevmValidator.getAsenvPath();
        if (asenvPath) {
            Logger.debug('DEBUG', `Abriendo asenv.bat: ${asenvPath}`);
            const doc = await vscode.workspace.openTextDocument(asenvPath);
            await vscode.window.showTextDocument(doc);
            Logger.info('HOTRELOAD', `Abierto para edición: ${asenvPath}`);
        } else {
            Logger.error('HOTRELOAD', 'No se pudo encontrar asenv.bat');
            vscode.window.showErrorMessage('[MM43] No se pudo encontrar el archivo asenv.bat del servidor.');
        }
    }

    async removeAgent(): Promise<void> {
        Logger.debug('DEBUG', 'removeAgent invocado');
        await ConfigManager.removeAgent();
        Logger.info('HOTRELOAD', 'Agente eliminado de la configuración.');
        vscode.window.showInformationMessage('  Agente de Hot-Reload eliminado.');
    }

        
    
}


    

    
