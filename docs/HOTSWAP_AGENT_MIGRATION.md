# Migración del módulo Hot-Reload de MM43 a HotswapAgent (DCEVM) + JDWP (JVM estándar)

**ADR-001 (v3)** · Estado: Propuesto · Fecha: 2026-11-04 · Autor del requerimiento: dueño del repo
**Repo:** `C:\proyectos\ExtensionVSCode\MM43` (extensión VS Code, TypeScript, esbuild)
**Agente:** `C:\Java\hotswap-agent-2.0.3.jar` (release 2.0.3, 2026-01-22). Código fuente de referencia: `C:\proyectos\ExtensionVSCode\hw\HotswapAgent` (**2.0.4-SNAPSHOT**, posterior al release).

---

## 0. Cómo usar este documento (para el agente implementador)

1. Lee las secciones 1 a 4 completas antes de tocar código. La sección 4 contiene evidencia real de una prueba que **cambia el orden del plan**.
2. Implementa por **fases** (sección 8) en el orden indicado. Cada tarea tiene ID (`T-xx`), archivos, cambios y criterio de aceptación.
3. Lo marcado **[VERIFICAR]** no está confirmado. No lo asumas: valida con el experimento indicado (sección 8, "Experimentos") o pregunta al dueño del repo.
4. No modifiques los módulos ajenos al hot-reload: `AI/`, `IntellisenseSupport/`, `versioncontrol/`, `database/`.
5. No agregues dependencias npm nuevas.
6. Convenciones del repo: código y comentarios en español, clases con métodos `static` en gestores (`ConfigManager`, `AgenteHotReloadManager`), logging con `Logger.info('CATEGORIA', msg)`. Antes de usar una categoría nueva de `Logger`, revisa `src/modules/logger/Logger.ts` para ver cuáles son válidas.
7. El archivo `HotReloadAgent.java` (raíz de MM43 y `Agente\src\`) **se va a borrar**; no lo mantengas ni lo uses como referencia de protocolo.

---

## 1. Resumen ejecutivo

**Objetivo.** Reemplazar el agente propio (`HotReloadAgent.java`, protocolo TCP `REDEFINE|clase|ruta`) por **HotswapAgent** y:

- Con **JVM DCEVM**: recarga automática al guardar usando HotswapAgent con `autoHotswap=true`. MM43 compila, sincroniza el exploded y **observa el log del agente** para confirmar. Además, un apartado nuevo en el sidebar para gestionar parámetros y plugins del agente.
- Con **JVM estándar**: recarga automática mediante **JDWP** (`RedefineClasses`) con el servidor en modo debug (ya arranca con `asadmin start-domain --debug`). El agente **no** se carga. Cambios estructurales → redeploy.
- En ambos casos se conserva el hotswapper automático (cola, debounce, clasificación de cambios, fallback a redeploy).

**Tres hallazgos críticos** (detalle en sección 4):

1. **Tormenta de recargas causada por MM43.** `MavenManager.syncDirectory` copia **todos** los `.class` de `target/classes` a `WEB-INF/classes` en cada sincronización (`fs.copyFileSync` incondicional). El agente ve cambio en todas las clases cargadas y las manda a redefinir. Hay que sincronizar **solo lo que cambió**, de forma atómica. Esto es independiente del agente y se hace primero.
2. **Errores `IllegalStateException: This web container has not yet been started`** en el log real. Hipótesis fuerte: hay classloaders **obsoletos** (de despliegues anteriores) que siguen vigilados por el agente. Los mensajes duplicados en el mismo milisegundo lo sugieren. El observador de log debe tratarlos como ruido clasificado, **no** como fallo de recarga, y **no** debe disparar redeploy (un redeploy crea otro classloader y empeora el problema).
3. **El agente no expone canal de control.** No hay socket ni JMX. Se configura por args del `-javaagent`, por un `.properties` externo (`propertiesFilePath`) y por `-D`. La confirmación de resultado solo puede salir del log del agente.

**Camino mínimo funcional con DCEVM:** F0 → F1 → F2 → F4 → F5.

---

## 2. Contexto: estado actual de MM43

### 2.1 Mapa de archivos relevantes

| Archivo | Rol | Notas |
|---|---|---|
| `src/modules/hotreload/AgenteHotReloadManager.ts` | Orquestador estático del hot-reload | Cola, debounce 800 ms, revisiones por archivo, worker serial, reintentos, clasificación, fallback a redeploy, spinners de status bar. También `importAgent`, `injectAgentOptions`, `openDomainXml`, `removeAgent`. Contiene mucho **código muerto** (ver 2.3). |
| `src/modules/hotreload/HotReloadClient.ts` | Cliente TCP del agente viejo | `REDEFINE`, `PING`, `CAPABILITIES`. **Se elimina.** |
| `src/modules/hotreload/ReloadStrategy.ts` | Estrategias `DcevmReloadStrategy`, `StandardJvmReloadStrategy`, `NoopReloadStrategy`; `createReloadStrategy()` lee `agentMode` persistido | Ambas estrategias reales usan el mismo TCP; solo difiere `supports('structural')`. |
| `src/modules/hotreload/DcevmValidator.ts` | Detecta DCEVM leyendo `AS_JAVA` de `asenv.bat` y ejecutando `java -version` | Solo se invoca al importar agente. Firmas: `dcevm`, `dynamic code evolution`, `trava`, etc. |
| `src/modules/hotreload/JavaChangeAnalyzer.ts` | Clasifica `method-body` / `structural` / `unchanged` por snapshots (hash de estructura y cuerpos) | Se conserva tal cual. |
| `src/config/ConfigManager.ts`, `src/config/types.ts` | Settings `mm43.*` (`agentPath`, `agentMode`, `hotReloadPort`, `structuralChangeBehavior`, `reloadFailureFallback`, `jdkPath`, `serverPath`, `serverDomain`) y tipos (`AgentMode`, `ProjectConfig`) | |
| `src/modules/maven/MavenManager.ts` | `buildExploded`, `compileIncremental`, `buildExplodedIncremental`, `syncExplodedClasses`, `syncDirectory` | **Aquí está la causa raíz RC-1** (sección 4). |
| `src/modules/server/ServerManager.ts` | Ciclo de vida del dominio (`start` usa `--debug`), `fastRedeployAndWait`, `redeployAndWait`, `listApplications` | |
| `src/modules/server/RedeployService.ts` | Serializa redeploys (build + `fastRedeployAndWait`) | |
| `src/modules/server/AssetWatcher.ts` | `onDidSaveTextDocument`: webapp → copia al exploded; `.java` → `AgenteHotReloadManager.cambioEnCaliente` | Sigue siendo el origen de eventos. |
| `src/modules/server/LogTailer.ts` | Tail de `server.log` | Referencia de patrón para el nuevo observador. |
| `src/ui/ServerProvider.ts` | TreeView "Servidor Payara" con sección "Agente Hot-Reload" plana y separadores falsos | Se reemplaza la sección por el nuevo apartado. |
| `src/Context.ts` | Activación: registra vistas y comandos (`mm43.importAgent`, `mm43.removeAgent`, `mm43.injectAgentOptions`, `mm43.openDomainXml`, `mm43.compilarJava`, …) | |
| `package.json` | Vistas (`mm43.projectsView`, `mm43.serverView`, `mm43.logsView`, `mm43.databaseView`, `mm43VersionControl`), comandos, settings | |
| `propuestamejora.md` | Propuestas de UI previas (nodo de estado HotReload, colapsables reales, conexión viva del agente) | Alineado con la Fase 6. |

### 2.2 Flujo actual (resumido)

```
Ctrl+S .java → AssetWatcher → cambioEnCaliente (md5, revisión) → debounce 800 ms
 → procesarCola (dedupe; >50 archivos → pregunta redeploy completo)
 → worker serial → ejecutarJob:
     analizarTipoCambio (JavaChangeAnalyzer) → local | structural
     compilarParaHotReload → MavenManager.buildExplodedIncremental
         = mvn compile  +  syncExplodedClasses (copia TODO target/classes → WEB-INF/classes)
     aplicarHotSwapConFallback → HotReloadClient (TCP) → fallo → RedeployService
```

### 2.3 Defectos conocidos que afectan la migración

1. `syncDirectory` copia todo siempre, no es atómico, y borra entradas ausentes en origen (ver RC-1).
2. `agentMode` (`none|standard|basic|dcevm`) se **persiste** al importar el agente; queda obsoleto si cambia `AS_JAVA`. Debe derivarse.
3. Solo se envía a redefinir **una** clase por archivo `.java` (las internas/anónimas `Foo$1.class` no).
4. `injectAgentOptions` escribe comandos PowerShell (`& "asadmin" ...`) en una terminal: no es idempotente, no verifica, no limpia opciones previas.
5. Código muerto en `AgenteHotReloadManager`: `crearServidor`, `MM43CompilerServer`, `compilarConServidor`, `obtenerServidor`, `destruirServidor`, `limpiarServidoresInactivos`, `compilarConAnalisisEstructural`, `encontrarClasesAfectadas`, `ordenarTopologicamente`, `javaToClassName` (si queda sin uso), `obtenerTodosLosJavaFiles`, `compilarModuloCompleto`, `compilarConServidor`. Verificar uso real antes de borrar.
6. `package.json` declara `mm43.hotReloadPort` y `mm43.agentMode`; `ServerProvider` y `Context.ts` los consumen.

### 2.4 Entorno del dueño

- Windows + PowerShell. Servidor **Payara/GlassFish** gestionado con `asadmin`. Deploy **exploded** desde `target/<warName>`.
- JVM del servidor: `java version "1.8.0_181"`, `Dynamic Code Evolution 64-Bit Server VM (build 25.71-b01-dcevmlight-26)` → DCEVM **parcheado en sitio** (el `java -version` ya lo muestra). Por eso **no** se necesita `-XXaltjvm=dcevm` **[VERIFICAR]**.
- Proyecto de prueba real: `C:\sigaf_git\sigaf\Vialidad\sigafVialidad` (war `sigafVialidad`, paquete `mx.com.smartsoft.sigafvialidad`).
- Existe también `C:\proyectos\ExtensionVSCode\hotswap-agent.jar` de versión desconocida **[VERIFICAR]**; el jar de referencia es `C:\Java\hotswap-agent-2.0.3.jar`.

---

## 3. HotswapAgent: hechos verificados

Fuentes: `hw\HotswapAgent\README.md`, `hotswap-agent.properties` del core, `HotswapAgent.java`, `PluginConfiguration.java`, `PluginManager.java`, `HotswapperPlugin.java`, `WatchHandler.java`, `LogConfigurationHelper.java`, `AgentLogger*.java`, plugins `tomcat` y `glassfish`, **y el log real del dueño (sección 4)**.

> **Divergencia de versión.** El código en `hw\` es 2.0.4-SNAPSHOT; el jar en uso es 2.0.3. Todo lo que dependa de nombres exactos (propiedades de sistema, mensajes de log) debe contrastarse con el log real del jar 2.0.3. El formato de línea y el mensaje de `HotswapperPlugin` **sí** quedaron confirmados por el log real.

| # | Hecho | Fuente | Implicación |
|---|---|---|---|
| H1 | Args válidos de `-javaagent:<jar>=k1=v1,k2=v2`: `autoHotswap`, `disablePlugin` (repetible), `propertiesFilePath`, `LOGGER` (nivel raíz). | `HotswapAgent.parseArgs` | Todo lo demás va en `.properties`. |
| H2 | Un arg **sin `=`** provoca `ArrayIndexOutOfBounds` (accede a `val[1]` tras advertir). Los valores no pueden contener `,` ni `=`. | `parseArgs` | MM43 solo emite pares `clave=valor` y valida rutas. |
| H3 | `propertiesFilePath=<ruta>`: un `.properties` **externo** leído por **cada** classloader al inicializarse. Se mezcla con `System.getProperties()`. | `PluginConfiguration.loadConfigurationFile` | La config vive en un archivo de MM43; **no** hay que copiar nada a `WEB-INF/classes`. Es **global** para todos los classloaders. |
| H4 | En archivo la propiedad es `disabledPlugins` (coma). Como arg es `disablePlugin`. Como `-D`: README/source 2.0.4 dicen `-Dhotswapagent.disablePlugin=A,B`; las notas del release 2.0.3 dicen `-DdisablePlugin=...`. | properties, `HotswapAgent.java`, release notes | Para plugins deshabilitados globales usar el **arg** `disablePlugin=` (estable en ambas). No depender del nombre del `-D`. |
| H5 | `autoHotswap=true` (arg) activa `HotswapperPlugin` en cada classloader. Observa `.class` en **directorios locales** del classpath del loader (`getResources("")`), eventos MODIFY/CREATE; ignora DELETE. Solo recarga clases **ya cargadas**. Agrupa en el `Scheduler` con retardo de 100 ms. Sin `autoHotswap.port` usa `Instrumentation.redefineClasses`. | `HotswapperPlugin`, `WatchHandler` | El exploded debe ser el directorio real del loader. Por eso importa **qué y cómo** escribe MM43 ahí (RC-1). |
| H6 | `autoHotswap.port` hace el hotswap por JPDA y requiere `tools.jar` en el classloader. | `HotswapperPlugin`, README plugin | Descartado para JDK 8 + Payara (frágil). |
| H7 | Soporte Payara/GlassFish: `TomcatPlugin` acepta `org.glassfish.web.loader.WebappClassLoader`; `GlassFishPlugin` abre boot-delegation de Felix. | plugins `tomcat`, `glassfish` | Confirmado en el log real: el loader reportado es `org.glassfish.web.loader.WebappClassLoader`. |
| H8 | `webappDir` no soportado en GlassFish (comentario del `.properties`). | properties | `AssetWatcher` sigue sincronizando webapp. |
| H9 | Formato de log: `HOTSWAP AGENT: HH:mm:ss.SSS NIVEL (clase) - mensaje`, con stack traces en líneas siguientes. Niveles en orden: `ERROR, RELOAD, WARNING, INFO, DEBUG, TRACE`. | `AgentLoggerHandler`, `AgentLogger`; **confirmado en log real** | Con `LOGGER=error` no sale `RELOAD`. Parser debe soportar entradas multilínea. |
| H10 | `LOGFILE=<ruta>` redirige el log; se **reabre en cada classloader** y **trunca** salvo `LOGFILE.append=true`. `LOG_TO_CONSOLE=false` silencia consola. | `LogConfigurationHelper` | Siempre `append=true`. En `.properties` usar `/` (el `\` es escape). |
| H11 | `PluginManager.hotswap` registra `RELOAD ... Reloading classes [..] (autoHotswap)` (nivel RELOAD). El éxito (`... reloaded classes [..]`) y el fallo (`... Fail to reload classes [..], msg is ..`) son **DEBUG** de `PluginManager`. "Clase no cargada aún" es **TRACE** de `HotswapperPlugin`. "Class X will be reloaded from URL" es **DEBUG** de `HotswapperPlugin` (visto en el log real). | `PluginManager`, `HotswapperPlugin`, log real | Subir esos loggers: `LOGGER.org.hotswap.agent.config.PluginManager=debug`, `LOGGER.org.hotswap.agent.plugin.hotswapper=trace`. |
| H12 | Límites con DCEVM: no soporta cambio de superclase. Enums/estáticos nuevos: `ClassInitPlugin`; anónimas: `AnonymousClassPatch`. Ambos en core. | README, plugins jvm | Cambio de jerarquía → fallo → redeploy. |
| H13 | Release 2.0.3: ajustes de watcher (evento `ENTRY_CREATE` "falso" para archivos en directorios nuevos, init de watcher+scheduler antes de la config de plugins), `-DdisablePlugin`, ajustes GlassFish 7. | notas del release | Posibles diferencias de comportamiento vs. 2.0.4-SNAPSHOT. |
| H14 | No existe canal de control en runtime. La config se lee al crear el classloader. | código | 3 niveles de aplicación (tabla 7.4). |
| H15 | Plugins descubiertos (log real, truncado): `ClassInitPlugin, AnonymousClassPatch, JdkPlugin, Hotswapper, WatchResources, Hibernate, HibernateJakarta, Hibernate3, Hibernate3JPA, …` → es el jar "fat" con todos los plugins. | log real | El schema de plugins se genera de los nombres reales `@Plugin(name=…)`. |

---

## 4. Evidencia real y causas raíz

### 4.1 Lo que pasó (log del dueño, 22:47)

El dueño ejecutó un **build exploded completo** (que recompiló todo) con el servidor y el agente activos. Extracto relevante del log del agente:

```
HOTSWAP AGENT: 22:47:05.536 DEBUG (org.hotswap.agent.plugin.hotswapper.HotswapperPlugin) - Class mx.com.smartsoft.sigafvialidad.business.CatOficialBusiness will be reloaded from URL file:/C:/sigaf_git/.../target/sigafVialidad/WEB-INF/classes/.../CatOficialBusiness.class
HOTSWAP AGENT: 22:47:05.536 DEBUG (…HotswapperPlugin) - Class …CatOficialBusiness will be reloaded from URL …            <- mismo ms, misma URL (duplicado)
HOTSWAP AGENT: 22:47:05.541 DEBUG (…HotswapperPlugin) - Class …CatTipoInfraccionBusiness will be reloaded from URL …
HOTSWAP AGENT: 22:47:05.541 DEBUG (…HotswapperPlugin) - Class …CatTipoInfraccionBusiness will be reloaded from URL …   <- duplicado
HOTSWAP AGENT: 22:47:05.615 ERROR (org.hotswap.agent.annotation.handler.WatchEventCommand) - InvocationTargetException in method 'watchReload' class '…CatTipoInfraccionBusiness' classLoader 'org.glassfish.web.loader.WebappClassLoader' on plugin 'org.hotswap.agent.plugin.hotswapper.HotswapperPlugin'
java.lang.reflect.InvocationTargetException
	…
Caused by: java.lang.IllegalStateException: This web container has not yet been started
	at org.glassfish.web.loader.WebappClassLoader.loadClass(WebappClassLoader.java:1705)
	at org.hotswap.agent.plugin.hotswapper.HotswapperPlugin.watchReload(HotswapperPlugin.java:84)
```

Y al inicio del servidor: `Discovered plugins: [ClassInitPlugin, AnonymousClassPatch, JdkPlugin, Hotswapper, WatchResources, Hibernate, …]`.

Qué **confirma**: el agente carga, el plugin Hotswapper se engancha al `WebappClassLoader` de Payara, vigila `target/sigafVialidad/WEB-INF/classes` y reacciona a cambios de `.class`. La integración básica con Payara funciona.

Qué **no** muestra: el extracto no incluye ninguna línea `RELOAD … Reloading classes` ni `reloaded classes`. No se sabe si algún loader llegó a recargar. **[VERIFICAR] con el log completo (Experimento E-1).**

---------------IMPORTANTE--------------------------------
Soy el sueño del repo el que esta escribiendo estas lineas, el log completo fue este: 
HOTSWAP AGENT: 22:40:47.901 DEBUG (org.hotswap.agent.plugin.hotswapper.HotswapperPlugin) - Init plugin at classLoader sun.misc.Launcher$AppClassLoader@18b4aac2
HOTSWAP AGENT: 22:40:47.907 INFO (org.hotswap.agent.config.PluginRegistry) - Plugin 'org.hotswap.agent.plugin.hotswapper.HotswapperPlugin' initialized in ClassLoader 'sun.misc.Launcher$AppClassLoader@18b4aac2'.
HOTSWAP AGENT: 22:40:48.112 INFO (org.hotswap.agent.config.PluginRegistry) - Discovered plugins: [ClassInitPlugin, AnonymousClassPatch, JdkPlugin, Hotswapper, WatchResources, Hibernate, HibernateJakarta, Hibernate3, Hibernate3JPA, Spring, SpringBoot, Jersey1, Jersey2, Jetty, Tomcat, ZK, Logback, Log4j2, MyFaces, Mojarra, Omnifaces, ELResolver, WildFlyELResolver, OsgiEquinox, Owb, OwbJakarta, Proxy, WebObjects, Weld, WeldJakarta, JBossModules, ResteasyRegistry, Deltaspike, DeltaspikeJakarta, GlassFish, Weblogic, Vaadin, Wicket, CxfJAXRS, FreeMarker, Undertow, MyBatis, MyBatisPlus, IBatis, JacksonPlugin, Idea, Thymeleaf, Velocity, Sponge]
HOTSWAP AGENT: 22:40:48.121 DEBUG (org.hotswap.agent.config.PluginManager) - Registering transformer 
HOTSWAP AGENT: 22:40:48.125 DEBUG (org.hotswap.agent.plugin.hotswapper.HotswapperPlugin) - Bootstrap class loader is null, hotswapper skipped.
HOTSWAP AGENT: 22:40:49.041 DEBUG (org.hotswap.agent.plugin.hotswapper.HotswapperPlugin) - Init plugin at classLoader java.net.URLClassLoader@3972a855
HOTSWAP AGENT: 22:40:49.041 INFO (org.hotswap.agent.config.PluginRegistry) - Plugin 'org.hotswap.agent.plugin.hotswapper.HotswapperPlugin' initialized in ClassLoader 'java.net.URLClassLoader@3972a855'.
HOTSWAP AGENT: 22:40:49.195 DEBUG (org.hotswap.agent.plugin.hotswapper.HotswapperPlugin) - Init plugin at classLoader java.net.URLClassLoader@47f9738
HOTSWAP AGENT: 22:40:49.196 INFO (org.hotswap.agent.config.PluginRegistry) - Plugin 'org.hotswap.agent.plugin.hotswapper.HotswapperPlugin' initialized in ClassLoader 'java.net.URLClassLoader@47f9738'.
HOTSWAP AGENT: 22:41:32.312 DEBUG (org.hotswap.agent.plugin.hotswapper.HotswapperPlugin) - Init plugin at classLoader WebappClassLoader (delegate=true) JarNames: []; canonicalLoaderDir: C:\payara5\glassfish\domains\domain1\generated\jsp\sigafAdministrador\loader_1265187481\; Object: 4b693a99 Created: 4/11/2026 10:41:27 PM
HOTSWAP AGENT: 22:41:32.331 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\domains\domain1\lib\classes 
HOTSWAP AGENT: 22:41:32.336 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\jaxr-ra 
HOTSWAP AGENT: 22:41:32.337 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__ds_jdbc_ra 
HOTSWAP AGENT: 22:41:32.340 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\jmsra 
HOTSWAP AGENT: 22:41:32.341 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__dm_jdbc_ra 
HOTSWAP AGENT: 22:41:32.342 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__cp_jdbc_ra 
HOTSWAP AGENT: 22:41:32.343 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__xa_jdbc_ra 
HOTSWAP AGENT: 22:41:32.346 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\jaxr-ra 
HOTSWAP AGENT: 22:41:32.347 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__ds_jdbc_ra 
HOTSWAP AGENT: 22:41:32.347 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\jmsra 
HOTSWAP AGENT: 22:41:32.348 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__dm_jdbc_ra 
HOTSWAP AGENT: 22:41:32.348 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__cp_jdbc_ra 
HOTSWAP AGENT: 22:41:32.349 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__xa_jdbc_ra 
HOTSWAP AGENT: 22:41:32.350 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\sigaf_git\sigaf\AdministradorAplicaciones\AdministradorAplicaciones\sigafAdministrador\target\sigafAdministrador\WEB-INF\classes 
HOTSWAP AGENT: 22:41:32.352 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\domains\domain1\generated\ejb\sigafAdministrador 
HOTSWAP AGENT: 22:41:32.358 INFO (org.hotswap.agent.config.PluginRegistry) - Plugin 'org.hotswap.agent.plugin.hotswapper.HotswapperPlugin' initialized in ClassLoader 'WebappClassLoader (delegate=true) JarNames: []; canonicalLoaderDir: C:\payara5\glassfish\domains\domain1\generated\jsp\sigafAdministrador\loader_1265187481\; Object: 4b693a99 Created: 4/11/2026 10:41:27 PM'.
HOTSWAP AGENT: 22:41:35.060 DEBUG (org.hotswap.agent.plugin.hotswapper.HotswapperPlugin) - Init plugin at classLoader ASURLClassLoader : 
urlSet = [URLEntry : file:/C:/payara5/glassfish/lib/install/applications/__ds_jdbc_ra/, URLEntry : file:/C:/payara5/glassfish/lib/install/applications/__ds_jdbc_ra/__ds_jdbc_ra.jar]
doneCalled = false 
 Parent -> com.sun.enterprise.loader.CurrentBeforeParentClassLoader@4f66f671

HOTSWAP AGENT: 22:41:35.061 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\domains\domain1\lib\classes 
HOTSWAP AGENT: 22:41:35.062 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__ds_jdbc_ra 
HOTSWAP AGENT: 22:41:35.062 INFO (org.hotswap.agent.config.PluginRegistry) - Plugin 'org.hotswap.agent.plugin.hotswapper.HotswapperPlugin' initialized in ClassLoader 'ASURLClassLoader : 
urlSet = [URLEntry : file:/C:/payara5/glassfish/lib/install/applications/__ds_jdbc_ra/, URLEntry : file:/C:/payara5/glassfish/lib/install/applications/__ds_jdbc_ra/__ds_jdbc_ra.jar]
doneCalled = false 
 Parent -> com.sun.enterprise.loader.CurrentBeforeParentClassLoader@4f66f671
'.
HOTSWAP AGENT: 22:41:37.021 DEBUG (org.hotswap.agent.plugin.hotswapper.HotswapperPlugin) - Init plugin at classLoader ASURLClassLoader : 
urlSet = [URLEntry : file:/C:/payara5/glassfish/lib/install/applications/__ds_jdbc_ra/, URLEntry : file:/C:/payara5/glassfish/lib/install/applications/__ds_jdbc_ra/__ds_jdbc_ra.jar]
doneCalled = false 
 Parent -> com.sun.enterprise.loader.CurrentBeforeParentClassLoader@4f66f671

HOTSWAP AGENT: 22:41:37.023 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\domains\domain1\lib\classes 
HOTSWAP AGENT: 22:41:37.023 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__ds_jdbc_ra 
HOTSWAP AGENT: 22:41:37.024 INFO (org.hotswap.agent.config.PluginRegistry) - Plugin 'org.hotswap.agent.plugin.hotswapper.HotswapperPlugin' initialized in ClassLoader 'ASURLClassLoader : 
urlSet = [URLEntry : file:/C:/payara5/glassfish/lib/install/applications/__ds_jdbc_ra/, URLEntry : file:/C:/payara5/glassfish/lib/install/applications/__ds_jdbc_ra/__ds_jdbc_ra.jar]
doneCalled = false 
 Parent -> com.sun.enterprise.loader.CurrentBeforeParentClassLoader@4f66f671
'.
HOTSWAP AGENT: 22:41:39.640 DEBUG (org.hotswap.agent.plugin.hotswapper.HotswapperPlugin) - Init plugin at classLoader WebappClassLoader (delegate=true) JarNames: []; canonicalLoaderDir: C:\payara5\glassfish\domains\domain1\generated\jsp\sigafAdministrador\loader_203295430\; Object: c1e0ac6 Created: 4/11/2026 10:41:34 PM
HOTSWAP AGENT: 22:41:39.646 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\domains\domain1\lib\classes 
HOTSWAP AGENT: 22:41:39.647 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\jaxr-ra 
HOTSWAP AGENT: 22:41:39.648 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__ds_jdbc_ra 
HOTSWAP AGENT: 22:41:39.649 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\jmsra 
HOTSWAP AGENT: 22:41:39.649 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__dm_jdbc_ra 
HOTSWAP AGENT: 22:41:39.650 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__cp_jdbc_ra 
HOTSWAP AGENT: 22:41:39.651 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__xa_jdbc_ra 
HOTSWAP AGENT: 22:41:39.652 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\sigaf_git\sigaf\AdministradorAplicaciones\AdministradorAplicaciones\sigafAdministrador\target\sigafAdministrador\WEB-INF\classes 
HOTSWAP AGENT: 22:41:39.654 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\domains\domain1\generated\ejb\sigafAdministrador 
HOTSWAP AGENT: 22:41:39.655 INFO (org.hotswap.agent.config.PluginRegistry) - Plugin 'org.hotswap.agent.plugin.hotswapper.HotswapperPlugin' initialized in ClassLoader 'WebappClassLoader (delegate=true) JarNames: []; canonicalLoaderDir: C:\payara5\glassfish\domains\domain1\generated\jsp\sigafAdministrador\loader_203295430\; Object: c1e0ac6 Created: 4/11/2026 10:41:34 PM'.
HOTSWAP AGENT: 22:41:54.703 DEBUG (org.hotswap.agent.plugin.hotswapper.HotswapperPlugin) - Init plugin at classLoader WebappClassLoader (delegate=true) JarNames: []; canonicalLoaderDir: C:\payara5\glassfish\domains\domain1\generated\jsp\sigafVialidad\loader_1857528088\; Object: 6eb7a118 Created: 4/11/2026 10:41:54 PM
HOTSWAP AGENT: 22:41:54.715 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\domains\domain1\lib\classes 
HOTSWAP AGENT: 22:41:54.716 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\jaxr-ra 
HOTSWAP AGENT: 22:41:54.716 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__ds_jdbc_ra 
HOTSWAP AGENT: 22:41:54.718 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\jmsra 
HOTSWAP AGENT: 22:41:54.719 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__dm_jdbc_ra 
HOTSWAP AGENT: 22:41:54.719 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__cp_jdbc_ra 
HOTSWAP AGENT: 22:41:54.720 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__xa_jdbc_ra 
HOTSWAP AGENT: 22:41:54.720 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\jaxr-ra 
HOTSWAP AGENT: 22:41:54.720 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__ds_jdbc_ra 
HOTSWAP AGENT: 22:41:54.721 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\jmsra 
HOTSWAP AGENT: 22:41:54.721 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__dm_jdbc_ra 
HOTSWAP AGENT: 22:41:54.726 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__cp_jdbc_ra 
HOTSWAP AGENT: 22:41:54.726 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__xa_jdbc_ra 
HOTSWAP AGENT: 22:41:54.727 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\sigaf_git\sigaf\Vialidad\sigafVialidad\target\sigafVialidad\WEB-INF\classes 
HOTSWAP AGENT: 22:41:54.728 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\domains\domain1\generated\ejb\sigafVialidad 
HOTSWAP AGENT: 22:41:54.729 INFO (org.hotswap.agent.config.PluginRegistry) - Plugin 'org.hotswap.agent.plugin.hotswapper.HotswapperPlugin' initialized in ClassLoader 'WebappClassLoader (delegate=true) JarNames: []; canonicalLoaderDir: C:\payara5\glassfish\domains\domain1\generated\jsp\sigafVialidad\loader_1857528088\; Object: 6eb7a118 Created: 4/11/2026 10:41:54 PM'.
HOTSWAP AGENT: 22:41:58.121 DEBUG (org.hotswap.agent.plugin.hotswapper.HotswapperPlugin) - Init plugin at classLoader WebappClassLoader (delegate=true) JarNames: []; canonicalLoaderDir: C:\payara5\glassfish\domains\domain1\generated\jsp\sigafVialidad\loader_2062574863\; Object: 7af0650f Created: 4/11/2026 10:41:56 PM
HOTSWAP AGENT: 22:41:58.125 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\domains\domain1\lib\classes 
HOTSWAP AGENT: 22:41:58.126 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\jaxr-ra 
HOTSWAP AGENT: 22:41:58.126 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__ds_jdbc_ra 
HOTSWAP AGENT: 22:41:58.127 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\jmsra 
HOTSWAP AGENT: 22:41:58.127 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__dm_jdbc_ra 
HOTSWAP AGENT: 22:41:58.128 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__cp_jdbc_ra 
HOTSWAP AGENT: 22:41:58.128 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\lib\install\applications\__xa_jdbc_ra 
HOTSWAP AGENT: 22:41:58.129 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\sigaf_git\sigaf\Vialidad\sigafVialidad\target\sigafVialidad\WEB-INF\classes 
HOTSWAP AGENT: 22:41:58.131 INFO (org.hotswap.agent.watch.nio.TreeWatcherNIO) - Registering directory C:\payara5\glassfish\domains\domain1\generated\ejb\sigafVialidad 
HOTSWAP AGENT: 22:41:58.132 INFO (org.hotswap.agent.config.PluginRegistry) - Plugin 'org.hotswap.agent.plugin.hotswapper.HotswapperPlugin' initialized in ClassLoader 'WebappClassLoader (delegate=true) JarNames: []; canonicalLoaderDir: C:\payara5\glassfish\domains\domain1\generated\jsp\sigafVialidad\loader_2062574863\; Object: 7af0650f Created: 4/11/2026 10:41:56 PM'.
HOTSWAP AGENT: 22:42:14.552 INFO (org.hotswap.agent.config.PluginRegistry) - Plugin 'org.hotswap.agent.plugin.omnifaces.OmnifacesPlugin' initialized in ClassLoader 'WebappClassLoader (delegate=true; repositoryURLs=file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/primefaces-12.0.0-RC3.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/jasperreports-6.21.4.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/SparseBitSet-1.2.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/commons-collections-3.2.2.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/commons-codec-1.10.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/ooxml-schemas-1.4.jar,file:/C:/payara5/glassfish/domains/domain1/generated/ejb/sigafAdministrador//,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/primefaces-extensions-4.0.0.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/jackson-databind-2.16.1.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/jcommon-1.0.23.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/ant-launcher-1.7.1.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/poi-ooxml-schemas-4.1.2.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/commons-lang3-3.1.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/openpdf-1.3.32.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/jackson-annotations-2.17.1.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/classes/,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/xmlbeans-3.0.1.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/gson-2.2.4.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/commons-compress-1.19.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/jasperreports-fonts-6.0.0.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/curvesapi-1.06.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/jfreechart-1.0.19.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/avalon-framework-impl-4.2.0.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/commons-collections4-4.2.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/commons-digester-2.1.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/commons-io-2.5.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/ecj-3.21.0.jar,file:/C:/payara5/glassfish/domains/domain1/generated/sigafAdministrador/,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/barcode4j-2.1.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/poi-4.1.2.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/poi-ooxml-4.1.2.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/commons-beanutils-1.9.4.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/woodstox-core-6.6.2.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/jackson-core-2.17.1.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/commons-logging-1.1.1.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/ant-1.7.1.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/stax2-api-4.2.2.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/omnifaces-2.6.1.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/mssql-jdbc-13.1.1.jre8-preview.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/commons-cli-1.0.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/commons-lang-2.6.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/commons-math3-3.6.1.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/jackson-dataformat-xml-2.17.1.jar,file:/C:/sigaf_git/sigaf/AdministradorAplicaciones/AdministradorAplicaciones/sigafAdministrador/target/sigafAdministrador/WEB-INF/lib/byte-buddy-1.15.11.jar) JarNames: []; canonicalLoaderDir: C:\payara5\glassfish\domains\domain1\generated\jsp\sigafAdministrador\loader_203295430\; Object: c1e0ac6 Created: 4/11/2026 10:41:34 PM'.
HOTSWAP AGENT: 22:42:14.553 INFO (org.hotswap.agent.plugin.omnifaces.OmnifacesPlugin) - Omnifaces plugin initialized.
HOTSWAP AGENT: 22:42:19.127 INFO (org.hotswap.agent.config.PluginRegistry) - Plugin 'org.hotswap.agent.plugin.omnifaces.OmnifacesPlugin' initialized in ClassLoader 'WebappClassLoader (delegate=true; repositoryURLs=file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/commons-beanutils-1.9.4.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/classes/,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/xml-apis-1.4.01.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/barcode4j-2.1.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/jackson-dataformat-xml-2.17.1.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/jasperreports-6.21.4.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/commons-cli-1.0.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/jasperreports-fonts-6.0.0.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/poi-ooxml-5.2.5.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/avalon-framework-impl-4.2.0.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/xmlgraphics-commons-2.9.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/ant-launcher-1.7.1.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/jackson-databind-2.16.1.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/commons-compress-1.25.0.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/poi-5.2.5.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/commons-collections-3.2.2.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/commons-digester-2.1.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/jxl-2.6.12.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/byte-buddy-1.15.11.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/jackson-annotations-2.17.1.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/jackson-core-2.17.1.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/commons-io-2.14.0.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/jcommon-1.0.23.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/commons-logging-1.1.1.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/commons-lang-1.0.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/jfreechart-1.0.19.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/openpdf-1.3.32.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/commons-codec-1.16.0.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/commons-math3-3.6.1.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/junit-3.7.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/curvesapi-1.08.jar,file:/C:/payara5/glassfish/domains/domain1/generated/ejb/sigafVialidad//,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/ecj-3.21.0.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/xmlbeans-5.2.0.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/xml-apis-ext-1.3.04.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/primefaces-12.0.0-RC3.jar,file:/C:/payara5/glassfish/domains/domain1/generated/sigafVialidad/,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/log4j-1.2.14.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/log4j-api-2.21.1.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/batik-all-1.17.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/omnifaces-2.6.1.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/commons-collections4-4.2.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/woodstox-core-6.6.2.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/stax2-api-4.2.2.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/SparseBitSet-1.3.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/ant-1.7.1.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/mssql-jdbc-13.1.1.jre8-preview.jar,file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/lib/poi-ooxml-lite-5.2.5.jar) JarNames: []; canonicalLoaderDir: C:\payara5\glassfish\domains\domain1\generated\jsp\sigafVialidad\loader_2062574863\; Object: 7af0650f Created: 4/11/2026 10:41:56 PM'.
HOTSWAP AGENT: 22:42:19.128 INFO (org.hotswap.agent.plugin.omnifaces.OmnifacesPlugin) - Omnifaces plugin initialized.
HOTSWAP AGENT: 22:42:20.430 DEBUG (org.hotswap.agent.plugin.hotswapper.HotswapperPlugin) - Init plugin at classLoader javax.management.remote.rmi.NoCallStackClassLoader@1816426
HOTSWAP AGENT: 22:42:20.437 INFO (org.hotswap.agent.config.PluginRegistry) - Plugin 'org.hotswap.agent.plugin.hotswapper.HotswapperPlugin' initialized in ClassLoader 'javax.management.remote.rmi.NoCallStackClassLoader@1816426'.
HOTSWAP AGENT: 22:42:20.937 DEBUG (org.hotswap.agent.plugin.hotswapper.HotswapperPlugin) - Init plugin at classLoader javax.management.remote.rmi.NoCallStackClassLoader@c888f
HOTSWAP AGENT: 22:42:20.938 INFO (org.hotswap.agent.config.PluginRegistry) - Plugin 'org.hotswap.agent.plugin.hotswapper.HotswapperPlugin' initialized in ClassLoader 'javax.management.remote.rmi.NoCallStackClassLoader@c888f'.
HOTSWAP AGENT: 22:47:05.598 DEBUG (org.hotswap.agent.plugin.hotswapper.HotswapperPlugin) - Class mx.com.smartsoft.sigafvialidad.business.CatModeloVehiculoBusiness will be reloaded from URL file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/classes/mx/com/smartsoft/sigafvialidad/business/CatModeloVehiculoBusiness.class
HOTSWAP AGENT: 22:47:05.598 DEBUG (org.hotswap.agent.plugin.hotswapper.HotswapperPlugin) - Class mx.com.smartsoft.sigafvialidad.business.CatModeloVehiculoBusiness will be reloaded from URL file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/classes/mx/com/smartsoft/sigafvialidad/business/CatModeloVehiculoBusiness.class
HOTSWAP AGENT: 22:47:05.607 ERROR (org.hotswap.agent.annotation.handler.WatchEventCommand) - InvocationTargetException in method 'watchReload' class 'mx.com.smartsoft.sigafvialidad.business.CatModeloVehiculoBusiness' classLoader 'org.glassfish.web.loader.WebappClassLoader' on plugin 'org.hotswap.agent.plugin.hotswapper.HotswapperPlugin'
java.lang.reflect.InvocationTargetException
	at sun.reflect.GeneratedMethodAccessor226.invoke(Unknown Source)
	at sun.reflect.DelegatingMethodAccessorImpl.invoke(DelegatingMethodAccessorImpl.java:43)
	at java.lang.reflect.Method.invoke(Method.java:498)
	at org.hotswap.agent.annotation.handler.WatchEventCommand.onWatchEvent(WatchEventCommand.java:192)
	at org.hotswap.agent.annotation.handler.WatchEventCommand.executeCommand(WatchEventCommand.java:100)
	at org.hotswap.agent.command.impl.CommandExecutor.run(CommandExecutor.java:43)
Caused by: java.lang.IllegalStateException: This web container has not yet been started
	at org.glassfish.web.loader.WebappClassLoader.loadClass(WebappClassLoader.java:1705)
	at org.glassfish.web.loader.WebappClassLoader.loadClass(WebappClassLoader.java:1662)
	at org.hotswap.agent.plugin.hotswapper.HotswapperPlugin.watchReload(HotswapperPlugin.java:84)
	... 6 more

HOTSWAP AGENT: 22:47:05.534 DEBUG (org.hotswap.agent.plugin.hotswapper.HotswapperPlugin) - Class mx.com.smartsoft.sigafvialidad.business.BitacoraBusiness will be reloaded from URL file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/classes/mx/com/smartsoft/sigafvialidad/business/BitacoraBusiness.class
HOTSWAP AGENT: 22:47:05.608 ERROR (org.hotswap.agent.annotation.handler.WatchEventCommand) - InvocationTargetException in method 'watchReload' class 'mx.com.smartsoft.sigafvialidad.business.BitacoraBusiness' classLoader 'org.glassfish.web.loader.WebappClassLoader' on plugin 'org.hotswap.agent.plugin.hotswapper.HotswapperPlugin'
java.lang.reflect.InvocationTargetException
	at sun.reflect.NativeMethodAccessorImpl.invoke0(Native Method)
	at sun.reflect.NativeMethodAccessorImpl.invoke(NativeMethodAccessorImpl.java:62)
	at sun.reflect.DelegatingMethodAccessorImpl.invoke(DelegatingMethodAccessorImpl.java:43)
	at java.lang.reflect.Method.invoke(Method.java:498)
	at org.hotswap.agent.annotation.handler.WatchEventCommand.onWatchEvent(WatchEventCommand.java:192)
	at org.hotswap.agent.annotation.handler.WatchEventCommand.executeCommand(WatchEventCommand.java:100)
	at org.hotswap.agent.command.impl.CommandExecutor.run(CommandExecutor.java:43)
Caused by: java.lang.IllegalStateException: This web container has not yet been started
	at org.glassfish.web.loader.WebappClassLoader.loadClass(WebappClassLoader.java:1705)
	at org.glassfish.web.loader.WebappClassLoader.loadClass(WebappClassLoader.java:1662)
	at org.hotswap.agent.plugin.hotswapper.HotswapperPlugin.watchReload(HotswapperPlugin.java:84)
	... 7 more

HOTSWAP AGENT: 22:47:05.535 DEBUG (org.hotswap.agent.plugin.hotswapper.HotswapperPlugin) - Class mx.com.smartsoft.sigafvialidad.business.BitacoraBusiness will be reloaded from URL file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/classes/mx/com/smartsoft/sigafvialidad/business/BitacoraBusiness.class
HOTSWAP AGENT: 22:47:05.536 DEBUG (org.hotswap.agent.plugin.hotswapper.HotswapperPlugin) - Class mx.com.smartsoft.sigafvialidad.business.CatTipoInfraccionBusiness will be reloaded from URL file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/classes/mx/com/smartsoft/sigafvialidad/business/CatTipoInfraccionBusiness.class
HOTSWAP AGENT: 22:47:05.538 DEBUG (org.hotswap.agent.plugin.hotswapper.HotswapperPlugin) - Class mx.com.smartsoft.sigafvialidad.business.CatOficialBusiness will be reloaded from URL file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/classes/mx/com/smartsoft/sigafvialidad/business/CatOficialBusiness.class
HOTSWAP AGENT: 22:47:05.610 ERROR (org.hotswap.agent.annotation.handler.WatchEventCommand) - InvocationTargetException in method 'watchReload' class 'mx.com.smartsoft.sigafvialidad.business.CatOficialBusiness' classLoader 'org.glassfish.web.loader.WebappClassLoader' on plugin 'org.hotswap.agent.plugin.hotswapper.HotswapperPlugin'
java.lang.reflect.InvocationTargetException
	at sun.reflect.NativeMethodAccessorImpl.invoke0(Native Method)
	at sun.reflect.NativeMethodAccessorImpl.invoke(NativeMethodAccessorImpl.java:62)
	at sun.reflect.DelegatingMethodAccessorImpl.invoke(DelegatingMethodAccessorImpl.java:43)
	at java.lang.reflect.Method.invoke(Method.java:498)
	at org.hotswap.agent.annotation.handler.WatchEventCommand.onWatchEvent(WatchEventCommand.java:192)
	at org.hotswap.agent.annotation.handler.WatchEventCommand.executeCommand(WatchEventCommand.java:100)
	at org.hotswap.agent.command.impl.CommandExecutor.run(CommandExecutor.java:43)
Caused by: java.lang.IllegalStateException: This web container has not yet been started
	at org.glassfish.web.loader.WebappClassLoader.loadClass(WebappClassLoader.java:1705)
	at org.glassfish.web.loader.WebappClassLoader.loadClass(WebappClassLoader.java:1662)
	at org.hotswap.agent.plugin.hotswapper.HotswapperPlugin.watchReload(HotswapperPlugin.java:84)
	... 7 more
................................repitiendo errores y exitos debido a carga masiva de classess por el build...................... HOTSWAP AGENT: 22:47:16.527 DEBUG (org.hotswap.agent.plugin.hotswapper.HotswapperPlugin) - Class mx.com.smartsoft.sigafvialidad.entity.sigafvialidad.ReporteConteoInfraccionesOficialTabulador will be reloaded from URL file:/C:/sigaf_git/sigaf/Vialidad/sigafVialidad/target/sigafVialidad/WEB-INF/classes/mx/com/smartsoft/sigafvialidad/entity/sigafvialidad/ReporteConteoInfraccionesOficialTabulador.class
HOTSWAP AGENT: 22:47:18.142 DEBUG (org.hotswap.agent.config.PluginManager) - ... reloaded classes [mx.com.smartsoft.sigafvialidad.dao.egobsaden.SdndempDao, mx.com.smartsoft.sigafvialidad.dao.ebogsci.ScidReciboDAO, mx.com.smartsoft.sigafvialidad.dao.ebogsci.SciDDetalleReciboDAO, mx.com.smartsoft.sigafvialidad.dao.ebogsci.SciCConceptosDAO, mx.com.smartsoft.sigafvialidad.dao.ebogsci.ScirusuDeptoDAO] (autoHotswap)
HOTSWAP AGENT: 22:47:18.551 RELOAD (org.hotswap.agent.config.PluginManager) - Reloading classes [mx.com.smartsoft.sigafvialidad.dao.sigafvialidad.SvialreglasinhabilesDAO, mx.com.smartsoft.sigafvialidad.dao.egobsaden.SdndempDao, mx.com.smartsoft.sigafvialidad.dao.sigafvialidad.SvialtiposinhabilesDAO, mx.com.smartsoft.sigafvialidad.dao.sigafvialidad.CatTipoInfraccionDao, mx.com.smartsoft.sigafvialidad.dao.sigafvialidad.CatEntidadFederativaDao, ............ HOTSWAP AGENT: 22:47:18.780 DEBUG (org.hotswap.agent.config.PluginManager) - ... Fail to reload classes [mx.com.smartsoft.sigafvialidad.dao.sigafvialidad.SvialreglasinhabilesDAO, mx.com.smartsoft.sigafvialidad.dao.egobsaden.SdndempDao, mx.com.smartsoft.sigafvialidad.dao.sigafvialidad.SvialtiposinhabilesDAO,........ ten en cuenta el log completo
---------------IMPORTANTE--------------------------------

### 4.2 Causas raíz

**RC-1 (confirmada por código): MM43 provoca la tormenta.**
`MavenManager.syncDirectory` hace `fs.copyFileSync(sourcePath, destinationPath)` para **todos** los archivos de `target/classes`, y luego borra lo que sobra en destino. Cada guardado de un `.java` (vía `buildExplodedIncremental`) reescribe cientos de `.class` idénticos en `WEB-INF/classes`. El agente recibe MODIFY/CREATE de todas y redefine todas las cargadas. Además la copia **no es atómica**: el agente puede leer un `.class` a medias. Un build exploded completo (`war:exploded`) agrava el efecto.
→ Corrección: sincronizar **solo clases cuyo contenido cambió**, escribir a un temporal y **renombrar**, y devolver la lista de cambios (que además alimenta `ChangedClass[]`).

**RC-2 (hipótesis fuerte, no confirmada): classloaders obsoletos vigilados.**
`WebappClassLoader.loadClass` lanza `This web container has not yet been started` cuando el loader no está en estado "started" (p. ej. ya detenido por un undeploy/redeploy). Como `findLoadedClass` sí devolvió la clase (el plugin llegó a "will be reloaded"), el loader tiene clases cargadas pero está **detenido**: un loader de un despliegue anterior cuyo watcher no se cerró. Apoyo: líneas duplicadas en el mismo milisegundo con la misma URL (dos loaders vigilando el mismo directorio). MM43 hace `redeploy` como fallback (`fastRedeployAndWait`), lo que genera nuevos loaders.
→ Consecuencias de diseño: (a) el observador debe clasificar ese error como `stale-loader` y **no** como fallo de recarga; (b) no disparar redeploy por esa causa; (c) mostrar al usuario un aviso con acción "Reiniciar servidor"; (d) opción avanzada: parchear `GlassFishPlugin` en `hw\HotswapAgent` para cerrar el classloader en `WebappClassLoader.stop` y construir un jar propio (solo uso local; el agente es GPL-2).

**RC-3: el resultado de una recarga es la unión de varios loaders.**
El log no identifica qué loader falló (solo su nombre de clase, siempre `org.glassfish.web.loader.WebappClassLoader`). Una clase está `reloaded` si **al menos un** loader vivo la recargó, aunque otro loader obsoleto produzca ERROR.

### 4.3 Preguntas aún abiertas

- ¿Algún loader recargó con éxito en esa ráfaga? (E-1) Respuesta(dueño): coloque ya el log completo
- ¿Los errores desaparecen con un servidor recién arrancado + un solo deploy + cambio de una sola clase? (E-2) si
- ¿Qué cambios estructurales soporta realmente `dcevmlight-26`? (E-4) Respuesta(dueño): coloque ya el log completo
- ¿Qué versión es `C:\proyectos\ExtensionVSCode\hotswap-agent.jar`? (E-6) es una version antigua de mi agente propio (el cual ya no se usará)

---

## 5. Requisitos

**Funcionales**

- RF1: JVM DCEVM → recarga automática vía HotswapAgent (métodos, campos, métodos nuevos; no superclase).
- RF2: JVM estándar → recarga automática vía JDWP (cuerpos de método). Estructural → redeploy según `structuralChangeBehavior`.
- RF3: Sidebar nuevo "Hotswap Agent", visible solo con DCEVM: estado, parámetros editables, plugins on/off, actividad, acciones.
- RF4: Instalar/desinstalar el agente en el dominio sin editar `domain.xml` a mano; idempotente.
- RF5: Historial de recargas (clase, ms, resultado) y estado de preparación del agente.

**No funcionales**

- RNF1: Confirmación típica < 3 s; timeout configurable (15 s).
- RNF2: Ninguna operación escribe en `WEB-INF/classes` archivos sin cambios.
- RNF3: Modo de JVM **derivado**, no persistido.
- RNF4: Sin dependencias npm nuevas. Validación de jar con `jar xf` del JDK.
- RNF5: Compatible con Windows/PowerShell.

**Restricciones**: Java 8, Payara/GlassFish, deploy exploded, agente GPL-2 usado como jar externo (no se redistribuye dentro de la extensión).

---

## 6. Decisión (ADR)


**Elegida (Opción A):** con DCEVM, `autoHotswap=true`; MM43 compila, sincroniza solo lo cambiado y **observa el log**. Con JVM estándar, `JdwpStrategy`
.

| | **A: autoHotswap + observar log** | B: MM43 dispara por JDWP siempre; agente solo plugins | C: mantener agente propio |
|---|---|---|---|
| Confirmación | Asíncrona (log) | Síncrona con códigos de error | TCP propio |
| Choca con debugger de VS Code | **No** | **Sí** (JDWP admite 1 cliente) | No |
| Código nuevo | Observador de log + parser | `JdwpClient` (se necesita igual para estándar) | Mantener Java propio |
| Plugins de frameworks | Sí | Sí | No |
| Requisito del dueño | Cumple | Cumple | No cumple |

**Trade-off:** A pierde confirmación síncrona y depende del formato del log. Mitigación: `JdwpClient` se escribe de todos modos, así que se expone `mm43.hotswap.dcevmDriver = agent | jdwp` como escape.

**Descartado:** `autoHotswap.port` (JPDA del agente, requiere `tools.jar`), cargar el agente en JVM estándar (el dueño pidió que solo corra con DCEVM), copiar `hotswap-agent.properties` a `WEB-INF/classes` (innecesario con `propertiesFilePath`).

**Consecuencias.** Más fácil: un agente mantenido por la comunidad, plugins de frameworks, estructurales en DCEVM, config declarativa. Más difícil: parseo de log, cambios de JVM/args exigen reinicio, dos estrategias que mantener. A revisar: configuración por app (hoy global), modo `core` del agente si el arranque se vuelve lento, parche al plugin GlassFish (RC-2).

---
