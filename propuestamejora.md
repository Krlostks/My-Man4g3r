**Analisis modulo UI — Proyectos + Servidor**

Archivos: `ProjectsProvider.ts`, `ServerProvider.ts`, `StatusBarManager.ts`. TreeView plano, sin webview custom. Todo va por `vscode.TreeItem` + comandos registrados en `package.json`.

## Puntos positivos diseño actual

- Simple, TreeDataProvider nativo → integra bien con theme VSCode, sin CSS/JS extra que mantener.
- Separación clara: Projects (build/deploy) vs Server (lifecycle + agente).
- Refresh reactivo via `ConfigManager.onDidChange` — buen patrón observer.
- StatusBar ya usa color semántico (warning/error bg) — base útil pa expandir.
- Contextos (`contextValue`) bien definidos → permite menús contextuales por tipo item.

## Puntos negativos / gaps

1. **Flujo plano, sin jerarquía de frecuencia.** Netbeans/Eclipse separan: toolbar rápida (Run/Debug/Stop) vs menú project (Clean, Profile, Custom Goals). Acá todo son items de árbol al mismo nivel — click extra siempre pa expandir proyecto.
2. **Sin indicador de progreso persistente.** Spinner solo vive en `mostrarSpinner()` transitorio (status bar message, 3seg). No hay estado "compilando X archivos" visible en el TreeView mismo — usuario no sabe qué pasa si compilación tarda.
3. **Sin feedback de cola HotReload.** `AgenteHotReloadManager` maneja `compilationQueue`/`changeQueue` internamente pero UI no expone tamaño de cola, últimos resultados, ni historial de hotswaps (success/fail). Todo es fire-and-forget con notificación fugaz.
4. **mvn rígido — solo goals fijos.** Comandos: Run, Build Exploded, Clean Install, Update Deps (-U), Export WAR. No hay "goal custom" (ej `mvn test -Dtest=X`), no hay toggle skipTests, no hay selector de profile (`-P prod`). Eclipse/Netbeans siempre traen "Custom Goals..." como escape hatch.
5. **Watcher y Agente desacoplados visualmente del ciclo compile.** `AgenteHotReloadManager` (compilación background) no tiene ningún nodo en `ServerProvider` ni `ProjectsProvider` — solo existe indirectamente vía Watcher ON/OFF en status bar, que es otro módulo (`file watcher` genérico, no el compilador incremental).
6. **Sin distinción "básico" vs "avanzado".** Todo mezclado en un solo árbol → usuario junior ve 10+ acciones de una y no sabe cuál usar día a día.
7. **DeployedApps lazy-load ok, pero sin acción rápida "abrir en browser" o "ver URL".**

## Propuesta de mejora

### A. Reestructurar Projects en 2 grupos (colapsables)
```
▾ MiProyecto
  ⚡ Acciones Rápidas          ← siempre visibles, uso diario
     ▶ Run (Build+Deploy)
     🔥 Hot Reload
     🧹 Clean Install
  ▸ Maven Avanzado              ← colapsado por default
     Build Exploded
     Update Deps (-U)
     Export WAR
     Custom Goal...             ← NUEVO: input box, ej "test -Dtest=Foo"
     Toggle Skip Tests           ← NUEVO: checkbox persistente en config proyecto
     Perfil Maven...             ← NUEVO: quickpick de -P profiles detectados en pom.xml
  🗑 Eliminar
```
Justificación: Netbeans/Eclipse separan "toolbar diaria" de "Project > Properties/Advanced". Reduce carga cognitiva, mismo patrón mental que ya conocen devs Java.

### B. Nodo "Compilación / HotReload" dedicado en ServerProvider (o nuevo TreeView)
```
▾ Hot-Reload Dinámico
   Estado: ⚡ Activo (agente DCEVM)
   Cola: 0 pendientes
   Último: ✅ ParametrosController.java (1.2s) hace 4s
   ▸ Historial (últimos 20)        ← click abre panel/log
```
Justificación: hoy `compilationQueue`/`lastHashes` viven solo en memoria de `AgenteHotReloadManager`, invisibles. Exponer un getter (`getQueueSize()`, `getLastResults()`) y suscribir un `EventEmitter` propio (como ya hace `ConfigManager.onDidChange`) permite refrescar este nodo en tiempo real sin polling.

Implementación sugerida (solo diseño, no código ahora):
- Agregar `private static onCompileEvent = new vscode.EventEmitter<CompileEvent>()` en `AgenteHotReloadManager`.
- Emitir evento en `ejecutarJob()` al iniciar/terminar cada job.
- `HotReloadStatusProvider` (nuevo TreeDataProvider o reusar ServerProvider) se suscribe y refresca.
- Status bar item nuevo: `$(sync) HotReload: 2 en cola` cuando `queue.length > 0`, vuelve a estado normal cuando vacía — más útil que spinner transitorio de 3seg.

### C. Toolbar contextual estilo Eclipse (view/title + inline)
- Agregar iconos inline en `view/title` para proyecto seleccionado: Run, Stop-equivalent (N/A pa Maven pero sí "Cancel job" si se agrega cancelación a la cola), Refresh.
- `view/item/context` ya tiene inline actions — bien, pero faltan pa "Custom Goal" y "Cancelar compilación en curso" (actualmente no hay forma de cancelar un job en `compilationQueue`).

### D. Mejoras server

- Agregar indicador de "última acción" (ej "Redeploy hace 2min — OK") — hoy solo estado binario ON/OFF.
- Botón rápido "Abrir en navegador" por cada `DeployedApp` (usa `vscode.env.openExternal`), aprovecha `app.name`+puerto conocido.
- Separar sección Agente Hot-Reload en subgrupo colapsable — ya casi listo (`buildAgentActions`), solo falta colapsarlo como grupo real en vez de flat list con separadores manuales (`'──...──'` como TreeItem es hack visual, mejor usar TreeItem real colapsable).

### E. Config nueva necesaria (`ProjectConfig` extendido)
```ts
interface ProjectConfig {
  ...
  skipTests?: boolean;      // toggle persistente
  mavenProfile?: string;    // -P activo
  lastCustomGoal?: string;  // recordar último goal custom usado
}
```

## Resumen priorizado

| Prioridad | Mejora | Esfuerzo |
|---|---|---|
| Alta | Nodo estado HotReload (cola+último resultado) | Medio — requiere EventEmitter en Manager |
| Alta | Separar Acciones Rápidas vs Avanzado en Projects | Bajo — solo reorganizar `getChildren()` |
| Media | Custom Goal + Skip Tests + Profile picker | Medio — nuevo comando + quickpick + persist config |
| Media | Status bar cola HotReload | Bajo |
| Baja | Cancelar job en cola | Medio-alto — requiere abort logic en worker |
| Baja | Abrir app en browser | Bajo |

Sin editar nada — plan listo pa revisar antes de implementar.

**Analisis UI — Sección Servidor (`ServerProvider.ts` + `StatusBarManager.ts`)**

## Puntos positivos diseño actual

- Estado servidor bien modelado (`ServerState`: running/starting/stopping/stopped/unknown) con iconos semánticos por estado.
- Lazy-load de apps desplegadas (`deployedAppsLoaded`) — evita llamada innecesaria al servidor si usuario nunca expande el nodo.
- Sección Agente Hot-Reload ya condicional (`buildAgentActions`) — cambia UI según si hay agente importado o no, buen patrón adaptativo.
- StatusBar con colores (`warningBackground`/`errorBackground`) da feedback rápido sin abrir sidebar.
- Comandos click-to-toggle en status bar (`click watcher OFF → start`) — UX directa, un solo click.

## Puntos negativos / gaps

1. **Árbol plano de 15+ items sin jerarquía real.** Todo mezclado: status, watcher, agente, apps, acciones lifecycle, acciones limpieza, config. Netbeans/Eclipse separan "Server" (start/stop/restart) de "Modules" (deploy/undeploy) de "Properties". Acá todo al mismo nivel visual.
2. **Separadores fake con TreeItem texto (`'─────────────────'`).** Hack visual, no colapsable, ocupa espacio fijo, no escala si agregás más secciones. VSCode soporta grupos colapsables reales — no se usan.
3. **Sin indicador de recursos del servidor.** No hay memoria/CPU/puerto/PID visible. Netbeans muestra puerto HTTP y estado de deploy por módulo; acá solo nombre+tipo de app.
4. **Logs solo por comando "Ver Logs" — abre output channel externo.** No hay preview/tail inline en el árbol (ej últimas 3 líneas de error si el server falló al iniciar).
5. **Sin feedback de "por qué" falló un start/stop.** Estado pasa a `stopped` sin más contexto — usuario debe ir manualmente a Ver Logs pa diagnosticar.
6. **Acciones destructivas (Limpiar Caches, Eliminar Config Servidor) mezcladas sin fricción extra** con acciones seguras (Ver Logs) — incrementa riesgo de click erróneo. Eclipse pide confirm en "Clean" server-level; acá no hay diferenciación visual de "peligro".
7. **Undeploy por app existe pero no hay "Redeploy individual"** — solo `restartServer` que es Redeploy Completo (todo el servidor). Si tenés 5 apps desplegadas y solo 1 falló, no hay opción quirúrgica.
8. **Conexión Hot-Reload dinámico invisible en este panel.** `buildAgentStatusItem()` solo muestra modo (DCEVM/Básico) — no showea si el agente TCP está realmente conectado/escuchando ahora mismo, ni actividad reciente (compilaciones enviadas al agente).
9. **`domain` mostrado en `description` del status item, ok, pero no hay quick-link "abrir consola admin" (asadmin console URL).**

## Propuesta de mejora

### A. Reestructurar árbol en grupos colapsables reales

```
▾ Estado del Servidor
   ● Servidor: ACTIVO — payara-domain1 @ C:\...
   ⚡ Agente Hot-Reload: DCEVM — conectado (puerto 9999)
   👁 Watcher Java: ACTIVO

▸ Acciones Rápidas             ← siempre expandido (uso diario)
   ▶ Iniciar Servidor
   ⏹ Detener Servidor
   🔄 Redeploy Completo
   📄 Ver Logs

▸ Aplicaciones Desplegadas (3)
   webapp1  [redeploy] [undeploy] [abrir 🔗]
   webapp2  ...

▸ Agente Hot-Reload             ← colapsado default
   Importar / Cambiar Agente
   Inyectar en Servidor (asadmin)
   Abrir domain.xml
   Eliminar Agente

▸ Mantenimiento (avanzado)      ← colapsado, ícono ⚠ si aplica
   Limpiar Caches
   Limpiar server.log
   Consultar Estado

▸ Configuración
   Configurar/Cambiar Servidor
   Eliminar Configuración
```

Justificación: reemplaza separadores fake por `TreeItem` con `collapsibleState` real. Reduce ruido visual, agrupa por frecuencia de uso (igual criterio aplicado a Projects en propuesta anterior) — consistencia entre ambos paneles.

### B. Indicador vivo de conexión Hot-Reload

Hoy `buildAgentStatusItem()` solo lee config estática (`agentPath`/`agentMode`). Proponer:

- `HotReloadClient` (ya existe en `modules/hotreload`) expone `isConnected(): boolean` + `lastPingMs`.
- Nuevo item: `⚡ Agente: Conectado (ping 12ms)` vs `⚠ Agente: Configurado pero sin respuesta` — distingue "está instalado" de "está funcionando ahora".
- Suscribir a evento (mismo patrón `EventEmitter` propuesto en análisis anterior para `AgenteHotReloadManager`) pa refrescar sin polling manual.

Esto cierra el gap #8 — hoy el usuario no sabe si el agente JVM realmente está escuchando o si quedó colgado tras un restart del server.

### C. Redeploy individual por app

- Agregar comando `mm43.redeployApp` con `arguments: [app.name]`, icon `refresh`, inline en `DeployedAppItem`.
- Requiere en backend (`ServerManager`) función que haga undeploy+deploy solo del `.war` correspondiente — probablemente ya existe la lógica de `deployExploded`, solo falta exponerla apuntando a proyecto específico en vez de "Agregar Proyecto al Servidor" genérico.

Justificación: hoy única opción es redeploy total (`restartServer`) — caro si el servidor tiene múltiples apps y solo una cambió.

### D. Confirmación en acciones destructivas

- `Limpiar Caches`, `Eliminar Configuración de Servidor`, `Eliminar Agente` → agregar `vscode.window.showWarningMessage(..., {modal:true}, 'Confirmar')` antes de ejecutar (patrón ya usado en `openDcevmConfigFiles` — reusar ese mismo estilo de disclaimer, ya existe en el código).

### E. Mini-log inline en status item

- Si `serverState === 'stopped'` tras un intento de start fallido, mostrar `description` con último error corto (ej "Puerto 8080 en uso") leído de las últimas líneas de `server.log`, en vez de solo "DETENIDO" sin contexto.

### F. Quick actions extra

- `🔗 Abrir consola admin` — abre `http://localhost:4848` (o puerto configurado) via `vscode.env.openExternal`.
- Por app desplegada: `🌐 Abrir en navegador` — construye URL con `app.name` + puerto HTTP conocido.

## Resumen priorizado

| Prioridad | Mejora | Esfuerzo |
|---|---|---|
| Alta | Grupos colapsables reales (quitar separadores fake) | Bajo |
| Alta | Indicador conexión viva Agente Hot-Reload | Medio — necesita `isConnected()` en `HotReloadClient` |
| Media | Redeploy individual por app | Medio-alto — lógica backend nueva |
| Media | Confirm modal en acciones destructivas | Bajo |
| Baja | Mini-log de último error en status | Medio — parsing server.log |
| Baja | Quick link consola admin + abrir app en browser | Bajo |

Sin editar nada — plan pa revisar.