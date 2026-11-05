
## 7. Arquitectura objetivo

### 7.1 Diagrama

```
 Ctrl+S .java ─► AssetWatcher ─► HotReloadOrchestrator (ex AgenteHotReloadManager)
                                   cola · debounce · revisión · JavaChangeAnalyzer
                                   compile (Maven) ─► syncExplodedClasses  ──► SyncResult{changed[],removed[]}
                                   │ ChangedClass[]
                                   ▼
                     ReloadStrategyResolver ◄── JvmCapabilityResolver
                      ├─ HotswapAgentStrategy ─► (agente recarga solo) ─ HotswapLogObserver ◄─ hotswap-agent.log
                      ├─ JdwpStrategy ─► JdwpClient  (o customRequest 'redefineClasses' si hay sesión Java Debug)
                      └─ NoopStrategy
                     fallo real / estructural no soportado ─► RedeployService
                     stale-loader ─► aviso + acción "Reiniciar servidor" (NO redeploy)

 Config:  <workspace>/.mm43/hotswap-agent.properties ──(propertiesFilePath)──► agente
          HotswapAgentInstaller ──asadmin create-jvm-options──► domain
 UI:      HotswapProvider (TreeView; when: mm43.jvmKind == dcevm)
```


### 7.2 Línea JVM que genera el instalador

```
-javaagent:C:/Java/hotswap-agent-2.0.3.jar=autoHotswap=true,propertiesFilePath=<ws>/.mm43/hotswap-agent.properties[,disablePlugin=<Nombre>]...
```

- Solo pares `k=v`; rutas con `/`, sin `,` ni `=` (H2).
- Con `asadmin create-jvm-options` el `:` se escapa como `\:` (ej. `C\:/Java/...`). **[VERIFICAR]** el escape exacto en tu versión de asadmin.
- Añadir `-XXaltjvm=dcevm` **solo** si `JvmCapabilityResolver.kind == 'dcevm-alt'`.

### 7.3 `.properties` base generado por MM43

```properties
LOGFILE=<ws>/.mm43/hotswap-agent.log
LOGFILE.append=true
LOG_TO_CONSOLE=false
LOGGER=info
LOGGER.org.hotswap.agent.config.PluginManager=debug
LOGGER.org.hotswap.agent.plugin.hotswapper=trace
disabledPlugins=
```

`extraClasspath` y `watchResources` **vacíos** por defecto (la config es global a todos los classloaders). Al escribir rutas, convertir `\` → `/`.

### 7.4 Tres niveles de aplicación de cambios (la UI debe mostrarlos)

| Qué | Dónde vive | Se aplica con |
|---|---|---|
| `-javaagent`, args del agente, `-D` | `domain.xml` vía asadmin | **Reiniciar servidor** |
| Propiedades del `.properties` (plugins, logs, `watchResources`, …) | `.mm43/hotswap-agent.properties` | **Redeploy de la app** (se relee al crear el classloader) |
| Preferencias de MM43 (driver, timeouts) | settings de VS Code | Inmediato |

> Ojo: redeploy crea un classloader nuevo y puede dejar uno obsoleto (RC-2). Si se confirma la hipótesis, preferir reinicio de servidor tras muchos redeploys.

### 7.5 Capacidad de JVM

`JvmCapabilityResolver.resolve()` devuelve `{ kind: 'dcevm' | 'dcevm-alt' | 'standard' | 'unknown', javaHome, versionOutput, debugPort }`.

- `dcevm`: `java -version` contiene firma DCEVM (caso del dueño). Sin `-XXaltjvm`.
- `dcevm-alt`: DCEVM instalado como alt-jvm pero no por defecto **[VERIFICAR]** detección por carpeta en el JDK.
- `standard`: sin firma.
- Reutiliza la lógica de `DcevmValidator` (lectura de `AS_JAVA`, `java -version`, firmas).
- Caché invalidada por mtime de `asenv.bat` y por cambios de configuración.
- Publica `vscode.commands.executeCommand('setContext', 'mm43.jvmKind', kind)`.
- `debugPort`: leer `debug-options` de `domain.xml` (default 9009) **[VERIFICAR]**.

### 7.6 Tipos TypeScript (contratos)

```ts
export type JvmKind = 'dcevm' | 'dcevm-alt' | 'standard' | 'unknown';
export type ReloadMode = 'hotswap-agent' | 'jdwp' | 'none';

export interface ChangedClass {
  className: string;      // 'a.b.Foo' o 'a.b.Foo$1'
  classFile: string;      // ruta absoluta en WEB-INF/classes
  hash: string;
}

export interface SyncResult {
  changed: ChangedClass[];
  removed: string[];      // rutas relativas
}

export type ReloadStatus = 'reloaded' | 'skipped-not-loaded' | 'failed' | 'stale-loader' | 'timeout';

export interface ReloadOutcome {
  className: string;
  status: ReloadStatus;
  ms: number;
  message?: string;
}

export interface ReloadContext {
  project: ProjectConfig;
  classes: ChangedClass[];
  changeType: 'method-body' | 'structural';
}

export interface ReloadResult {
  success: boolean;
  outcomes: ReloadOutcome[];
  requiresRedeploy: boolean;
  requiresServerRestart: boolean;   // true si hay stale-loader
  message: string;
}

export interface ReloadStrategy {
  readonly name: string;
  supports(changeType: 'method-body' | 'structural'): boolean;
  reload(ctx: ReloadContext): Promise<ReloadResult>;
}
```

### 7.7 Reglas de parseo del log (`HotswapLogObserver`)

Encabezado de entrada: `^HOTSWAP AGENT: (\d{2}:\d{2}:\d{2}\.\d{3}) (ERROR|RELOAD|WARNING|INFO|DEBUG|TRACE) \(([^)]+)\) - (.*)$`. Las líneas que **no** empiezan por `HOTSWAP AGENT:` son continuación (stack trace) de la entrada anterior.

| Tipo | Logger | Nivel | Mensaje (patrón) | Significado |
|---|---|---|---|---|
| `accepted` | `…HotswapperPlugin` | DEBUG | `Class (\S+) will be reloaded from URL (\S+)` | Un loader aceptó la clase. N repeticiones = N loaders. |
| `skipped` | `…HotswapperPlugin` | TRACE | `Class (\S+) not loaded yet` | Clase no cargada: nada que recargar. |
| `reload-start` | `…config.PluginManager` | RELOAD | `Reloading classes \[(.*)\] \(autoHotswap\)` | Se intenta redefinir (lista separada por `, `). |
| `reload-ok` | `…config.PluginManager` | DEBUG | `\.\.\. reloaded classes \[(.*)\] \(autoHotswap\)` | Éxito. |
| `reload-fail` | `…config.PluginManager` | DEBUG | `\.\.\. Fail to reload classes \[(.*)\] \(autoHotswap\), msg is (.*)` | Fallo de redefinición. |
| `watch-error` | `…handler.WatchEventCommand` | ERROR | `InvocationTargetException in method 'watchReload' class '(\S+)' classLoader '(\S+)'` + continuación con `Caused by: (.*)` | Error del plugin para esa clase. |

**Clasificación de `watch-error`:** si el `Caused by` contiene `IllegalStateException: This web container has not yet been started` → `stale-loader` (ruido). Cualquier otra causa → `failed`.

**Resolución por clase** (tras una **ventana de asentamiento** `settleMs` sin entradas nuevas, default 1500 ms, o `reloadTimeoutMs` default 15000):

1. Hay `reload-ok` que la incluye → `reloaded` (aunque haya `stale-loader` de otro loader; RC-3).
2. Hay `reload-fail` que la incluye, o `watch-error` no-stale sin `reloaded` → `failed`.
3. Solo `watch-error` stale y ningún `reloaded` → `stale-loader`.
4. Hay `skipped` y nada más → `skipped-not-loaded` (cuenta como éxito).
5. Solo `reload-start` sin `reload-ok`/`fail` tras el timeout → `timeout` (aviso, **sin** redeploy).
6. Nada visto → `timeout`.

Casos de borde: el nombre de clase en el log es `Class.getName()` (`a.b.Foo$1` para internas). Una ráfaga puede traer varias clases en una sola línea `Reloading classes [..]`. El archivo puede truncarse (nuevo arranque): detectar `size < offset` y reiniciar offset a 0.

### 7.8 Estados de preparación del agente (nodo "Estado")

`NO_INSTALADO → INSTALADO_PENDIENTE_REINICIO → AGENTE_CARGADO → APP_ENGANCHADA → DEGRADADO`

- Instalado: `asadmin list-jvm-options` contiene la ruta del jar.
- Pendiente de reinicio: instalado después del último arranque del servidor.
- Cargado: `hotswap-agent.log` existe con mtime posterior al último arranque (y contiene `Discovered plugins`).
- App enganchada: línea `Tomcat plugin initialized - GlassFish …` posterior al último deploy **[VERIFICAR]** texto exacto en 2.0.3.
- Degradado: errores `stale-loader` recientes o `failed` repetidos.

---

## 8. Plan de implementación

### Orden recomendado y esfuerzo

| Fase | Contenido | Esfuerzo | Depende de |
|---|---|---|---|
| **F0** | Sync incremental atómico (RC-1) | 1 d | — |
| F1 | Capacidades de JVM + settings + migración | 1 d | — |
| F2 | Instalador del agente (asadmin) + `importAgent` | 1.5 d | F1 |
| F3 | Store/schema de configuración del agente | 2 d | F2 |
| F4 | `HotswapLogObserver` + sonda de estado | 2 d | F3 (ruta del log) |
| **F5** | Estrategias + orquestador (**MVP**) | 2 d | F0, F1, F4 |
| F6 | Sidebar "Hotswap Agent" | 2.5 d | F1, F3, F4 |
| F7 | `JdwpClient` + `JdwpStrategy` | 3 d | F1 |
| F8 | Limpieza y migración final | 0.5 d | F5 |
| F9 | Pruebas y endurecimiento (política stale-loader) | 2 d | todo |

### Experimentos (los ejecuta el dueño; ver resultados antes de cerrar F4/F5)

- **E-1:** Entregar el log completo de la ráfaga de 22:47 y buscar líneas `RELOAD`, `reloaded classes`, `Fail to reload`. Define si hay éxito parcial.
- **E-2 (RC-2):** Reiniciar el dominio limpio, **un solo deploy**, cambiar **una** clase (con F0 aplicado). Esperado: sin errores ISE. Luego `asadmin redeploy` y cambiar otra clase: ¿reaparecen ISE? Contar líneas de init de plugin vs. número de redeploys.
- **E-3:** Con `LOGGER.org.hotswap.agent.plugin.hotswapper=trace` y `PluginManager=debug`, capturar un ciclo completo y pegarlo como fixture de pruebas del parser.
- **E-4:** Matriz DCEVM en `dcevmlight-26`: cuerpo de método, método nuevo, campo nuevo, clase interna/anónima nueva, cambio de superclase.
- **E-5:** Probar el escape de `asadmin create-jvm-options` con `\:` y `/`; verificar con `list-jvm-options` y arrancando el dominio.
- **E-6:** Identificar versión de `C:\proyectos\ExtensionVSCode\hotswap-agent.jar` y decidir cuál usar.

---

### F0 — Sync incremental atómico (RC-1)

**T-01 — `MavenManager.syncExplodedClasses` / `syncDirectory`**
- Archivo: `src/modules/maven/MavenManager.ts`.
- Cambios:
  - Para cada archivo, **comparar** origen y destino (tamaño primero; si igual, hash SHA-256 del contenido). Copiar solo si difiere o no existe.
  - Escribir a `<destino>.mm43tmp` y `fs.renameSync` al nombre final (atómico en el mismo volumen). El agente ignora archivos que no son `.class`.
  - Borrar del destino solo lo que realmente ya no existe en origen. No borrar y recrear directorios.
  - Devolver `SyncResult { changed: ChangedClass[], removed: string[] }` (nuevo tipo en `types.ts`). Mantener compatibilidad: `buildExplodedIncremental` sigue devolviendo `boolean`; añadir `buildExplodedIncrementalDetailed(project): Promise<{ ok: boolean; sync?: SyncResult }>`.
  - Calcular `className` desde la ruta relativa (`a/b/Foo$1.class` → `a.b.Foo$1`).
- Aceptación: cambiar 1 método → `changed` contiene solo las clases realmente modificadas (outer + internas afectadas); el log del agente muestra solo esas. Un build sin cambios → `changed` vacío y **cero** eventos del agente.

**T-02 — Revisar `buildExploded` (`clean compile war:exploded`)**
- Cuando el servidor está `running` con agente activo, `war:exploded` puede reescribir clases. Documentar en el log de MM43 una advertencia y, si es viable, para el hot-reload usar solo `compile` + T-01 (ya es lo que hace `buildExplodedIncremental`).
- Aceptación: el flujo hot-reload nunca invoca `war:exploded`.
-----------comentario de dueño--------- 
asi es el hot reload no invoca war:exploded ademas ejeuctar clean solo si el servidor está apagado, si esta encendido entonces no usar clean
-----------comentario de dueño--------- 

### F1 — Capacidades de JVM y settings

**T-03 — `JvmCapabilityResolver`**
- Archivos: crear `src/modules/hotreload/JvmCapabilityResolver.ts`; conservar/absorber `DcevmValidator.ts`.
- Implementa 7.5. Exponer `resolve()`, `onDidChange` (EventEmitter) y `setContext('mm43.jvmKind')`.
- Aceptación: con la JVM del dueño → `dcevm`. Cambiar `AS_JAVA` recalcula sin reiniciar VS Code.

**T-04 — Settings nuevos y migración**
- Archivos: `package.json`, `src/config/ConfigManager.ts`, `src/config/types.ts`.
- Añadir: `mm43.hotswap.mode` (`auto|agent|jdwp|none`, default `auto`), `mm43.hotswap.agentJar` (migrar valor de `mm43.agentPath`), `mm43.hotswap.dcevmDriver` (`agent|jdwp`, default `agent`), `mm43.hotswap.settleMs` (1500), `mm43.hotswap.reloadTimeoutMs` (15000).
- Mantener `structuralChangeBehavior` y `reloadFailureFallback`.
- Deprecar y migrar `mm43.agentPath`, `mm43.agentMode`, `mm43.hotReloadPort` (leer valor viejo una vez, escribir el nuevo, marcar deprecado en `package.json`).
- Reemplazar `AgentMode` por `ReloadMode` en `types.ts`.
- Aceptación: instalaciones con settings viejos siguen funcionando tras migrar.

### F2 — Instalador del agente

**T-05 — `HotswapAgentInstaller`**
- Archivo: crear `src/modules/hotreload/HotswapAgentInstaller.ts`.
- Usar `ProcessRunner.run(asadminPath, args)` (no terminal).
- Flujo `install()`: validar `kind != 'standard'` → `list-jvm-options` → eliminar opciones previas que contengan `hotswap-agent` o `mm43.agent.port` o `-XXaltjvm` → `create-jvm-options` con la línea de 7.2 (escapada) → `list-jvm-options` para verificar → aviso "Requiere reiniciar el servidor" (con acción "Reiniciar ahora").
- Flujo `uninstall()`: elimina esas opciones.
- Generar/actualizar el `.properties` base (7.3) en `<workspace>/.mm43/` (carpeta nueva; añadir a `.gitignore` sugerida, no modificarlo sin preguntar).
- Aceptación: `install()` dos veces produce el mismo `list-jvm-options`.

**T-06 — `importAgent` validando el jar**
- Archivo: `AgenteHotReloadManager.ts` (o moverlo al instalador).
- Extraer `META-INF/MANIFEST.MF` con `jar xf` del JDK (ruta derivada de `ConfigManager.getJdkPath()`), exigir `Premain-Class: org.hotswap.agent.HotswapAgent`. Intentar leer versión de `version.properties`/`Implementation-Version`.
- Guardar en `mm43.hotswap.agentJar`. **Ya no** escribe modo en settings.
- Si `kind == 'standard'`: no ofrecer instalar; explicar que se usará JDWP.
- Aceptación: un jar incorrecto se rechaza con mensaje claro; uno correcto muestra su versión.

### F3 — Configuración del agente

**T-07 — Schema**
- Archivos: `resources/hotswap-agent-schema.json` y `scripts/gen-hotswap-schema.js`.
- Cada entrada: `key`, `type` (`bool|int|enum|path|list|string`), `default`, `doc`, `scope` (`arg|file|jvm`), `apply` (`restart|redeploy|live`), `group` (`Agente|Logs|Plugins|Avanzado`).
- Fuente: `hw\HotswapAgent\hotswap-agent-core\src\main\resources\hotswap-agent.properties` + nombres `@Plugin(name=…)` en `hw\HotswapAgent\plugin\**` (para la lista de plugins y `disabledPlugins`).
- Incluir al menos: `autoHotswap` (arg), `disablePlugin` (arg repetible), `propertiesFilePath` (arg, solo lectura), `LOGGER` (arg y file), `extraClasspath`, `watchResources`, `webappDir` (marcar "no soportado en GlassFish")----comentario dueño: esto aunque no lo soporte glassfish ya lo cubre AssetWatcher-------- , `disabledPlugins`, `autoHotswap.port` (marcar "no usar"), `weld.beanReloadStrategy`, `spring.basePackagePrefix`, `LOGFILE`, `LOGFILE.append`, `LOG_TO_CONSOLE`, `LOGGER.<pkg>`, `LOGGER_DATETIME_FORMAT`, `excludedClassLoaderPatterns`, `includedClassLoaderPatterns` (mutuamente excluyentes: error si ambos).
- Aceptación: todas las propiedades del `.properties` del core están representadas.

**T-08 — `HotswapPropertiesStore` y `HotswapConfigService`**
- Archivos: crear `src/modules/hotreload/HotswapPropertiesStore.ts`, `HotswapConfigService.ts`.
- Leer/escribir el `.properties` **preservando comentarios y orden**; normalizar rutas a `/`; validar que valores de **args** no contengan `,` ni `=`; no permitir `includedClassLoaderPatterns` y `excludedClassLoaderPatterns` a la vez.
- Mantener un estado "pendiente de aplicar" por propiedad (`restart` / `redeploy`) y exponer `onDidChange`.
- Las propiedades base de 7.3 son obligatorias y no deben poder borrarse desde la UI (sí ajustar niveles).
- Aceptación: round-trip sin perder comentarios; editar una propiedad `redeploy` la marca pendiente hasta ejecutar redeploy.

### F4 — Observador de log y sonda

**T-09 — `HotswapLogObserver`**
- Archivo: crear `src/modules/hotreload/HotswapLogObserver.ts` (referencia de patrón: `LogTailer.ts`).
- Seguir `hotswap-agent.log` desde un offset; soportar truncado; parsear con 7.7 incluyendo continuaciones multilínea.
- API: `waitForOutcome(classNames: string[], sinceMs: number): Promise<ReloadOutcome[]>` (aplica `settleMs` y `reloadTimeoutMs`), `onOutcome: Event<ReloadOutcome>`, `history(limit=50)`, `staleLoaderCount()`.
- Aceptación (tests de parser con fixtures reales: el log de la sección 4 y el de E-3): clasifica `stale-loader`, `reloaded`, `skipped-not-loaded`, `failed`; correlaciona clases internas; ráfagas de cientos de clases sin bloquear el hilo (procesar por lotes).

**T-10 — `HotswapAgentProbe`**
- Archivo: crear `src/modules/hotreload/HotswapAgentProbe.ts`.
- Calcula los estados de 7.8 (usa `asadmin list-jvm-options` + mtime/contenido del log + último arranque conocido por `ServerManager`).
- Reemplaza `HotReloadClient.isAgentAlive`.
- Aceptación: refleja instalado/pendiente/cargado/enganchado sin conexión TCP.

### F5 — Estrategias y orquestador (MVP)

**T-11 — `ReloadStrategy` nuevo**
- Archivo: `src/modules/hotreload/ReloadStrategy.ts`.
- Interfaz de 7.6. `HotswapAgentStrategy`: tras compilar+sincronizar, espera `observer.waitForOutcome(changed.map(c=>c.className), since)`.
  - Todos `reloaded` o `skipped-not-loaded` → éxito.
  - Algún `failed` → `requiresRedeploy = true`.
  - `stale-loader` → `requiresServerRestart = true`, **sin** redeploy.
  - `timeout` → éxito con advertencia, **sin** redeploy.
- `NoopStrategy` se mantiene. `JdwpStrategy` llega en F7.
- `resolveReloadStrategy()` async: usa `mm43.hotswap.mode`, `JvmCapabilityResolver` y `dcevmDriver`.
- Aceptación: con servidor+agente, guardar un `.java` muestra en el status bar ⚡ con el tiempo medido del log.

**T-12 — Refactor del orquestador**
- Archivo: `src/modules/hotreload/AgenteHotReloadManager.ts` (renombrar a `HotReloadOrchestrator.ts`; actualizar imports en `Context.ts`, `AssetWatcher.ts`, `ServerManager.ts`).
- `compilarParaHotReload` pasa a usar `buildExplodedIncrementalDetailed` y propaga `SyncResult.changed` como `ChangedClass[]` (reemplaza el cálculo de una sola clase en `enviarHotswap`/`aplicarRecarga`).
- Reemplazar `enviarHotswap`, `aplicarRecarga` y `aplicarHotSwapConFallback` por `strategy.reload(ctx)`.
- Reglas de fallback: `failed` → `reloadFailureFallback`; `stale-loader` → notificación con acción "Reiniciar servidor"; `timeout` → advertencia.
- Si `changed` está vacío (compilación sin cambios reales) → resolver el job sin recargar.
- Mantener: cola, debounce, revisiones, `JavaChangeAnalyzer`, reintentos, `setPaused`, spinners, persistencia de metadatos.
- Aceptación: flujo completo Ctrl+S → compile → sync → recarga → statusbar, con DCEVM.

### F6 — Sidebar "Hotswap Agent"

**T-13 — `HotswapProvider` y contribuciones**
- Archivos: crear `src/ui/HotswapProvider.ts`; editar `package.json` y `Context.ts`.
- Vista `mm43.hotswapView` en el contenedor `mm43-sidebar` con `when: mm43.jvmKind == dcevm`. Nodos:
  - **Estado:** JVM, versión del agente, modo, estado de preparación (7.8), contador de `stale-loader`.
  - **Pendiente de aplicar** (solo si hay cambios): acciones "Redeploy app" y "Reiniciar servidor".
  - **Parámetros:** agrupados por `group`; cada hoja con comando inline de edición (InputBox/QuickPick/toggle según `type`) e icono según `apply` (`restart`/`redeploy`).
  - **Plugins:** lista on/off que edita `disabledPlugins`.
  - **Actividad:** últimas 20 recargas (clase, ms, ✓ / ✗ / ⏭ / ⚠ stale).
  - **Acciones:** Instalar/Desinstalar agente, Abrir `.properties`, Abrir `hotswap-agent.log`.
- Comandos nuevos `mm43.hotswap.*` (`install`, `uninstall`, `editProperty`, `togglePlugin`, `applyRedeploy`, `restartServer`, `openProperties`, `openLog`, `refresh`).
- En `ServerProvider`: reemplazar la sección "Agente Hot-Reload" y los separadores `'──…'` por una línea de estado "Recarga: Agente | JDWP | Ninguna" (visible con cualquier JVM).
- Quitar comandos viejos (`mm43.injectAgentOptions`, `mm43.openDomainXml` si ya no aplica; conservar `openDomainXml` si se usa en otro lugar).
- Aceptación: con JVM estándar el apartado no aparece; con DCEVM, editar una propiedad la marca pendiente y aplicarla la limpia.

### F7 — Estrategia JDWP (JVM estándar)

**T-14 — `JdwpClient` y `JdwpStrategy`**
- Archivos: crear `src/modules/hotreload/JdwpClient.ts`, `JdwpStrategy.ts`.
- Cliente sobre `net`: handshake `JDWP-Handshake`; `VirtualMachine.IDSizes`; `VirtualMachine.CapabilitiesNew` (¿`canRedefineClasses`?); `VirtualMachine.ClassesBySignature` (firma `La/b/Foo;`) para **todas** las coincidencias (varios loaders); `VirtualMachine.RedefineClasses` con el bytecode de cada `ChangedClass`.
- Mapear errores `UNSUPPORTED_REDEFINITION_*` (método/campo añadido, cambio de jerarquía, etc.) → `requiresRedeploy = true`.
- Conexión rechazada/ocupada → estado "debugger ocupado": si hay sesión activa del Java Debug de VS Code, intentar `debugSession.customRequest('redefineClasses')` **[VERIFICAR]**; si no, avisar.
- Puerto: `JvmCapabilityResolver.debugPort`.
- Reutilizable como driver alterno en DCEVM (`dcevmDriver = jdwp`).
- Aceptación: con JVM estándar, cambio de cuerpo de método se aplica sin redeploy; método nuevo → redeploy según config.

### F8 — Limpieza

**T-15 — Eliminar lo viejo**
- Borrar `src/modules/hotreload/HotReloadClient.ts`, `HotReloadAgent.java` (raíz de MM43), el código muerto de 2.3 (#5), settings deprecados tras la migración, referencias a `-Dmm43.agent.port`.
- Quitar del dominio la opción vieja al instalar (T-05 ya lo hace).
- Aceptación: `npm run check-types` y `npm run lint` sin errores; ninguna referencia a `HotReloadClient`.

### F9 — Pruebas y endurecimiento

**T-16 — Tests**
- Unitarias (carpeta `src/test/`, framework ya configurado `vscode-test`/mocha): parser del log con fixtures reales, `HotswapPropertiesStore` (round-trip, rutas, validaciones), `JvmCapabilityResolver` con salidas de `java -version` (dcevm, trava, zulu, openjdk), `JdwpClient` contra un servidor falso, `syncDirectory` (solo cambia lo modificado; atomicidad; borrados).
- E2E manual (matriz):

| Caso | Esperado |
|---|---|
| DCEVM + cuerpo de método | `reloaded`, sin redeploy |
| DCEVM + método/campo nuevo | `reloaded` |
| DCEVM + cambio de superclase | `failed` → redeploy |
| DCEVM + clase no cargada | `skipped-not-loaded` |
| DCEVM + loader obsoleto (tras redeploy) | `stale-loader` clasificado, sin redeploy, aviso de reinicio |
| Build sin cambios | cero eventos del agente |
| Estándar + cuerpo de método | JDWP OK |
| Estándar + método nuevo | `UNSUPPORTED_REDEFINITION` → redeploy |
| Debugger de VS Code conectado (estándar) | delegación o aviso |
| `install()` dos veces | sin duplicados |
| Cambiar `AS_JAVA` | modo recalculado |

**T-17 — Política de classloaders obsoletos (según E-2)**
- Si E-2 confirma RC-2: contar redeploys desde el último arranque y sugerir reinicio tras N (configurable); estudiar parche a `GlassFishPlugin` (cerrar loader en `WebappClassLoader.stop`) como tarea separada y opcional.

---

## 9. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Classloaders obsoletos generan ruido y fugas (RC-2) | Clasificación `stale-loader`, no redeploy, aviso de reinicio, T-17 |
| Formato de log cambia entre 2.0.3 y 2.0.4+ | Fixtures reales por versión; parser tolerante; guardar versión del agente en UI |
| Éxito/fallo solo observable con `PluginManager=debug` | Se fuerza en el `.properties` base; `timeout` nunca dispara redeploy |
| Lectura de `.class` a medias | F0 escritura atómica (tmp + rename) |
| Tormenta de recargas por sync completo | F0 (RC-1) |
| Config global afecta a todos los classloaders | Defaults mínimos; sin `extraClasspath` global |
| EclipseLink (JPA por defecto en Payara) no tiene plugin | Cambios en entidades pueden requerir redeploy; documentar |
| Cada guardado ejecuta `mvn compile` (lento) | Optimización posterior: `javac` de un solo archivo con `project.classpath` ya existente |
| JDWP admite una sola conexión | Detectar ocupado; delegar al Java Debug o avisar |
| Agente GPL-2 | Solo se referencia el jar externo; no se redistribuye |
| Valores de args con `,`/`=` rompen el agente (H2) | Validación en el store y en el instalador |

**A revisar cuando crezca:** configuración distinta por app (hoy global), modo `core` del agente si el arranque se vuelve lento, reducir uso de Maven en el hot path.

---

## 10. Apéndices

### A. Comandos `asadmin` de referencia (verificar escape en E-5)

```powershell
asadmin list-jvm-options
asadmin create-jvm-options "-javaagent\:C\:/Java/hotswap-agent-2.0.3.jar=autoHotswap=true,propertiesFilePath=C\:/ruta/ws/.mm43/hotswap-agent.properties"
asadmin delete-jvm-options "-javaagent\:C\:/Java/hotswap-agent-2.0.3.jar=autoHotswap=true,propertiesFilePath=C\:/ruta/ws/.mm43/hotswap-agent.properties"
asadmin restart-domain <dominio>
```

### B. Mapa viejo → nuevo

| Antes | Después |
|---|---|
| `HotReloadAgent.java` + `HotReloadClient.ts` (TCP) | HotswapAgent + `HotswapLogObserver` |
| `mm43.agentMode` persistido | `JvmCapabilityResolver` derivado + `mm43.hotswap.mode` |
| `mm43.hotReloadPort` | Eliminado |
| `injectAgentOptions` (terminal) | `HotswapAgentInstaller` (asadmin, idempotente) |
| Sección plana en `ServerProvider` | `mm43.hotswapView` + línea de estado |
| Envío de 1 clase por archivo | `ChangedClass[]` (incluye internas) desde `SyncResult` |
| Copia total a `WEB-INF/classes` | Sync incremental atómico |

### C. Preguntas pendientes para el dueño

1. Log completo de la ráfaga de 22:47 (E-1).
2. Versión de Payara y ruta exacta del dominio. Respuesta: es payara5 pero tambien uso glassfish4
3. ¿Qué jar usar: `C:\Java\hotswap-agent-2.0.3.jar` o `C:\proyectos\ExtensionVSCode\hotswap-agent.jar`? (E-6) Respuesta: C:\Java\hotswap-agent-2.0.3.jar
4. ¿Se acepta crear la carpeta `<workspace>/.mm43/` y agregarla a `.gitignore`?Respuesta: si
5. ¿Se autoriza evaluar un parche local al `GlassFishPlugin` si RC-2 se confirma?Respuesta: no, solo mitiga ese error
