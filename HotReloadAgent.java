import java.lang.instrument.Instrumentation;
import java.lang.instrument.ClassDefinition;
import java.nio.file.Files;
import java.io.File;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.net.ServerSocket;
import java.net.Socket;

/**
 * Agente Java que permite el Hot-Reload de clases en caliente.
 * Se comunica con la extensión MM43 de VS Code vía TCP.
 * 
 * Protocolo de entrada:  NombreClase|RutaArchivo.class\n
 * Protocolo de salida:   OK|NombreClase\n   o   ERROR|NombreClase|mensaje\n
 * 
 * El puerto se resuelve en este orden:
 *   1. agentArgs (parámetro del -javaagent:path=PUERTO)
 *   2. System property -Dmm43.agent.port
 *   3. Puerto por defecto 9999
 */
public class HotReloadAgent {
    private static Instrumentation inst;
    private static final int DEFAULT_PORT = 9999;

    public static void premain(String agentArgs, Instrumentation inst) {
        HotReloadAgent.inst = inst;
        int port = resolvePort(agentArgs);
        System.out.println("[HotReloadAgent] Premain cargado. Puerto: " + port);
        startServer(port);
    }

    public static void agentmain(String agentArgs, Instrumentation inst) {
        HotReloadAgent.inst = inst;
        int port = resolvePort(agentArgs);
        System.out.println("[HotReloadAgent] Agentmain cargado. Puerto: " + port);
        startServer(port);
    }

    /**
     * Resuelve el puerto TCP en orden de precedencia:
     * agentArgs > System property > DEFAULT_PORT
     */
    private static int resolvePort(String agentArgs) {
        // 1. agentArgs directamente
        if (agentArgs != null && !agentArgs.trim().isEmpty()) {
            try {
                return Integer.parseInt(agentArgs.trim());
            } catch (NumberFormatException e) {
                System.err.println("[HotReloadAgent] agentArgs no es un puerto valido: '" + agentArgs + "', probando System property...");
            }
        }
        // 2. System property -Dmm43.agent.port
        String sysProp = System.getProperty("mm43.agent.port");
        if (sysProp != null && !sysProp.trim().isEmpty()) {
            try {
                return Integer.parseInt(sysProp.trim());
            } catch (NumberFormatException e) {
                System.err.println("[HotReloadAgent] mm43.agent.port no es valido: '" + sysProp + "', usando default.");
            }
        }
        // 3. Default
        return DEFAULT_PORT;
    }

    private static void startServer(int port) {
        Thread serverThread = new Thread(() -> {
            try (ServerSocket serverSocket = new ServerSocket(port)) {
                System.out.println("[HotReloadAgent] Servidor TCP escuchando en puerto " + port);
                while (true) {
                    try (Socket socket = serverSocket.accept();
                         BufferedReader reader = new BufferedReader(
                                 new InputStreamReader(socket.getInputStream()));
                         PrintWriter writer = new PrintWriter(socket.getOutputStream(), true)) {

                        String line = reader.readLine();
                        if (line != null && line.contains("|")) {
                            String[] parts = line.split("\\|");
                            if (parts.length >= 2) {
                                String className = parts[0];
                                String filePath = parts[1];
                                try {
                                    redefinir(className, filePath);
                                    writer.println("OK|" + className);
                                } catch (Exception e) {
                                    String msg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
                                    writer.println("ERROR|" + className + "|" + msg);
                                    System.err.println("[HotReloadAgent] Error al redefinir " + className + ": " + msg);
                                }
                            }
                        }
                    } catch (Exception e) {
                        System.err.println("[HotReloadAgent] Error en conexion: " + e.getMessage());
                    }
                }
            } catch (Exception e) {
                System.err.println("[HotReloadAgent] Error critico en servidor TCP (puerto " + port + "): " + e.getMessage());
            }
        });
        serverThread.setDaemon(true);
        serverThread.setName("MM43-HotReload-TCP");
        serverThread.start();
    }

    public static void redefinir(String nombreClase, String rutaArchivo) throws Exception {
        File file = new File(rutaArchivo);
        if (!file.exists()) {
            throw new Exception("Archivo no encontrado: " + rutaArchivo);
        }
        byte[] bytes = Files.readAllBytes(file.toPath());

        Class<?> targetClass = null;
        for (Class<?> clazz : inst.getAllLoadedClasses()) {
            if (clazz.getName().equals(nombreClase)) {
                targetClass = clazz;
                break;
            }
        }

        if (targetClass == null) {
            throw new Exception("Clase no cargada en la JVM: " + nombreClase);
        }

        inst.redefineClasses(new ClassDefinition(targetClass, bytes));
        System.out.println("[HotReloadAgent] >>> CLASE REDEFINIDA: " + nombreClase + " (ClassLoader: "
                + targetClass.getClassLoader() + ")");
    }
}
