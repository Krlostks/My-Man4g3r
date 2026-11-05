# Estado de migración a HotswapAgent

> Documento vivo de seguimiento. Se actualiza después de cada tarea, experimento o decisión.
>
> Documentos base:
> - `docs/HOTSWAP_AGENT_MIGRATION.md`: contexto, hallazgos, requisitos y decisiones.
> - `docs/HOTSWAP_AGENT_MIGRATION2.md`: arquitectura objetivo, contratos, tareas y pruebas.
>
---

## 1. Estado general

- **Estado:** Implementación parcial en curso; ninguna fase cumple todavía todos sus criterios de aceptación.
- **Fase actual:** F0 en curso. Hay trabajo adelantado parcial en F1–F4, todavía sin integración funcional ni evidencia de aceptación.
- **Objetivo MVP:** `F0 → F1 → F2 → F4 → F5` con DCEVM.
- **Última actualización:** 2026-11-05.
- **Repositorio:** `MM43`.
- **Cambios de código revisados:** modificaciones preparadas en 10 archivos; este documento registra su estado.
- **Estado del árbol revisado:** las modificaciones existentes estaban staged; no se encontraron tests nuevos de migración.

### Decisiones confirmadas por el dueño

- El jar a utilizar es `C:\Java\hotswap-agent-2.0.3.jar`.
- También se utilizarán entornos Payara 5 y GlassFish 4; cualquier integración debe evitar depender exclusivamente de uno de ellos.
- El hot-reload no invoca `war:exploded`.
- `clean` solo puede ejecutarse con el servidor apagado; con el servidor encendido se debe usar compilación incremental sin `clean`.
- Se acepta crear `<workspace>/.mm43/` y agregarlo a `.gitignore`.
- No se autoriza parchear HotswapAgent/GlassFishPlugin. El error de loader obsoleto se mitigará clasificándolo y solicitando reinicio.
- `webappDir` no será usado para reemplazar el flujo de `AssetWatcher`; este ya cubre la sincronización de recursos de GlassFish.

---

## 2. Análisis consolidado

### 2.1 Flujo objetivo

```text
Guardar .java
  → AssetWatcher
  → HotReloadOrchestrator (cola/debounce/análisis)
  → Maven compile
  → sincronización incremental y atómica de WEB-INF/classes
  → HotswapAgent + observación de hotswap-agent.log (DCEVM)
     o JdwpClient (JVM estándar)
  → resultado por clase
  → redeploy solo ante fallo real/estructural no soportado
```

### 2.2 Hallazgos que determinan el orden

1. **RC-1 confirmada:** `syncDirectory` reescribe todos los `.class`, aunque no hayan cambiado. F0 es obligatoria antes de validar el agente.
2. **RC-2 respaldada por el log:** aparecen varios `WebappClassLoader` para la misma aplicación y `IllegalStateException: This web container has not yet been started`. Debe clasificarse como `stale-loader`, sin redeploy automático.
3. **Éxito parcial confirmado en E-1:** el log completo contiene `... reloaded classes [...] (autoHotswap)` y también `Fail to reload classes [...]`. Por tanto, el parser debe resolver por clase y considerar éxito si existe al menos un `reload-ok`, aunque otro loader falle.
4. **El canal de control del agente es el log:** no se debe conservar ni recrear el protocolo TCP del agente propio.
5. **La capacidad de JVM no se persiste:** se deriva de `AS_JAVA` y de `java -version`; el caso conocido del dueño es DCEVM parcheado en sitio.

### 2.3 Reglas operativas críticas

- No escribir un `.class` directamente sobre el destino: usar temporal en el mismo volumen y `renameSync`.
- No generar eventos del agente para clases cuyo contenido no cambió.
- No usar `war:exploded` en el camino de hot-reload.
- No ejecutar `clean` si el servidor está encendido.
- No disparar redeploy por `stale-loader` ni por `timeout`; notificar y ofrecer reiniciar servidor.
- Todas las rutas de propiedades deben normalizarse a `/`.
- Los argumentos de `-javaagent` deben ser pares `clave=valor`; no pueden contener `,` ni `=` en los valores.
- Mantener compatibilidad con clases internas/anónimas (`Foo$1.class`).

---

## 3. Matriz de fases

| Fase | Estado | Tareas | Evidencia requerida |
|---|---|---|---|
| F0 Sync incremental atómico | ◐ En curso | T-01, T-02 | T-01 implementada con pruebas compiladas pendientes de ejecución; T-02 implementada con typecheck/lint correctos; aceptación funcional pendiente por no crear pruebas ni ejecutar servidor |
| F1 Capacidades y settings | ◐ En curso | T-03, T-04 | Resolver/settings parciales; falta migración real y evidencia de detección |
| F2 Instalador | ◐ En curso | T-05, T-06 | Instalador inicial; faltan validación de jar y pruebas con asadmin |
| F3 Configuración | ◐ En curso | T-07, T-08 | Schema/store/servicio iniciales; faltan validaciones y round-trip probado |
| F4 Observador y sonda | ◐ En curso | T-09, T-10 | Parser inicial sin fixtures/tests; la sonda no está implementada |
| F5 Estrategias/orquestador MVP | ☐ Pendiente | T-11, T-12 | Ctrl+S → compile → sync → outcome |
| F6 Sidebar | ☐ Pendiente | T-13 | Vista solo para DCEVM y acciones pendientes |
| F7 JDWP | ☐ Pendiente | T-14 | Cuerpo de método en JVM estándar |
| F8 Limpieza | ☐ Pendiente | T-15 | Sin TCP/agente propio; typecheck y lint |
| F9 Pruebas/endurecimiento | ☐ Pendiente | T-16, T-17 | Matriz E2E y política stale-loader |

**Convención:** `☐ Pendiente`, `◐ En curso`, `✓ Completada`, `⚠ Bloqueada`, `— No aplica`.

---

## 4. Seguimiento detallado de tareas

### F0 — Sync incremental atómico

- ◐ **T-01** En curso: sync incremental implementado en `MavenManager`; conserva el wrapper booleano `buildExplodedIncremental` y añade `buildExplodedIncrementalDetailed` con `SyncResult`. Compara tamaño y SHA-256, escribe cambios a un temporal en el destino y renombra, elimina entradas que ya no existen en origen y reporta clases nuevas/modificadas y eliminadas con rutas/nombres que incluyen clases internas (`Foo$1`). Se añadieron cuatro pruebas; `compile-tests` pasa, pero no se ejecutó la suite.
  - [x] Comparación tamaño + SHA-256.
  - [x] Copia temporal y renombrado atómico.
  - [x] Borrado únicamente de archivos ausentes.
  - [x] Devolver `SyncResult.changed` y `SyncResult.removed`.
  - [x] Incluir clases internas/anónimas.
  - [ ] Ejecutar y pasar las pruebas funcionales de sync.
- ◐ **T-02** Implementación completada; queda aceptación funcional pendiente. `AgenteHotReloadManager` conserva `buildExplodedIncremental` (`compile` + sync; sin `war:exploded`). `MavenManager` consulta el estado real antes de elegir fases: `buildExploded` y `cleanCompile` omiten `clean` salvo con estado `stopped`; `cleanInstall` y `cleanPackage` se cancelan y advierten si el estado es distinto de `stopped`. `ServerManager.checkServerStatus` devuelve `unknown` cuando falla la consulta o no identifica el dominio, evitando habilitar `clean` por error. Typecheck pasó; lint pasó con 9 advertencias preexistentes. No se crearon ni ejecutaron pruebas, y no se hizo validación con servidor real.
  - [x] Confirmado en código: el camino hot-reload usa `compile` incremental + sync y no invoca `war:exploded`.
  - [x] `clean` protegido: solo se ejecuta tras confirmar el estado `stopped`.
  - [x] Advertencia visible y log cuando se omite `clean`; se cancelan flujos incompatibles (`cleanInstall`/`cleanPackage`).
  - [ ] Validación funcional en runtime con servidor encendido, apagado y consulta fallida.
- [ ] Pruebas F0: cambiar un método, repetir build sin cambios y probar borrado de `.class`.

### F1 — JVM y settings

- ◐ **T-03** En curso: existe `JvmCapabilityResolver` con detección, caché, evento y publicación de `mm43.jvmKind`; falta validar con el JDK DCEVM del dueño, pruebas y recalcular automáticamente al cambiar la configuración/`AS_JAVA`.
- ◐ **T-04** En curso: se añadieron settings nuevos y se marcaron algunos antiguos como deprecados. `getHotswapAgentJar()` solo hace fallback a `agentPath`; no escribe el valor nuevo ni implementa una migración one-shot. Verificar también `hotReloadPort` y `agentMode`.
- [ ] Verificar puerto JDWP desde `domain.xml` y detección `dcevm-alt`.

### F2 — Instalación y validación

- ◐ **T-05** En curso: existe instalador con `ProcessRunner`, creación de opciones, generación de properties y aviso de reinicio; faltan pruebas de idempotencia/Payara/GlassFish y validar correctamente el target/dominio. El argumento `domain` no se aplica en `list-jvm-options` ni en la eliminación/creación. También debe confirmarse el resultado de la opción `-javaagent` ante el escape real de asadmin.
- [ ] **T-06** Validar `Premain-Class` y detectar versión del jar. No está implementado en los cambios revisados.
- [ ] Verificar escape de `:` con E-5 antes de considerar F2 completa.
- [x] Generación inicial de `.mm43/hotswap-agent.properties` implementada en el instalador; falta ejecutarla y verificarla. El `.gitignore` no se modifica automáticamente, conforme a la decisión registrada.

### F3 — Configuración declarativa

- ◐ **T-07** En curso: existe `resources/hotswap-agent-schema.json`, pero no se añadió el generador indicado ni se verificó que contenga todas las propiedades/plugins de las fuentes requeridas.
- ◐ **T-08** En curso: existen store y servicio; el store conserva líneas/comentarios y escribe mediante temporal, pero no aplica la validación de `,`/`=` para args descrita por el contrato. No hay prueba round-trip. El estado pendiente se mantiene en memoria.
- [ ] Validar exclusión mutua `includedClassLoaderPatterns` / `excludedClassLoaderPatterns`.
- [ ] Mantener propiedades base obligatorias (`LOGFILE`, `append`, niveles de `PluginManager` y `Hotswapper`).

### F4 — Log y sonda

- ◐ **T-09** En curso: existe `HotswapLogObserver`, con lectura por offset, truncado, parseo y clasificación inicial. No se añadieron fixtures ni tests. La inspección encontró que el resultado puede resolverse tras el primer `settleMs` aunque no haya llegado un resultado y que la entrada final queda sin parsear hasta una cabecera posterior; revisar también la correlación temporal (`sinceMs`).
- [ ] Fixture: log completo de E-1, incluyendo stack traces, duplicados y ráfagas.
- [ ] Resolver por clase: `reloaded` > `failed` > `stale-loader` > `skipped` > `timeout`.
- [ ] Detectar truncado y procesar ráfagas por lotes.
- [ ] **T-10** Crear `HotswapAgentProbe` sin conexión TCP. No se encontró este archivo ni implementación equivalente.

### F5 — MVP

- [ ] **T-11** Implementar `HotswapAgentStrategy`, `NoopStrategy` y resolver.
- [ ] **T-12** Renombrar/refactorizar el orquestador y propagar `ChangedClass[]`.
- [ ] No recargar si `changed` está vacío.
- [ ] Fallback: fallo real según configuración; `stale-loader` solo reinicio; timeout solo aviso.

### F6 — UI

- [ ] **T-13** Crear `HotswapProvider`, comandos y contexto.
- [ ] Mostrar línea de estado Agente/JDWP/Ninguna en `ServerProvider`.
- [ ] Retirar sección plana antigua y separadores falsos.

### F7 — JVM estándar

- [ ] **T-14** Implementar `JdwpClient` y `JdwpStrategy`.
- [ ] Probar múltiples classloaders y detección de debugger ocupado.
- [ ] Confirmar si `customRequest('redefineClasses')` es viable antes de depender de él.

### F8/F9 — Limpieza y pruebas

- [ ] **T-15** Eliminar `HotReloadClient.ts`, `HotReloadAgent.java`, referencias TCP y código muerto verificado sin usos.
- [ ] **T-16** Añadir unitarias y E2E manuales.
- [ ] **T-17** Definir umbral de sugerencia de reinicio si E-2 confirma acumulación de loaders.

---

## 5. Experimentos y decisiones pendientes

| ID | Estado | Resultado / siguiente acción |
|---|---|---|
| E-1 | ✓ Parcialmente resuelto | El log completo demuestra éxito y fallo parcial en la misma ráfaga. Usarlo como fixture. |
| E-2 | ◐ Informado, falta fixture | El dueño indicó que la prueba limpia funciona. Documentar comandos, conteos de loaders y resultado tras redeploy. |
| E-3 | ☐ Pendiente | Capturar ciclo aislado con `Hotswapper=trace` y `PluginManager=debug`. |
| E-4 | ☐ Pendiente | Ejecutar matriz real de DCEVM: cuerpo, método/campo nuevo, clase interna y superclase. |
| E-5 | ☐ Pendiente | Verificar escape de `asadmin` en Payara 5 y GlassFish 4. |
| E-6 | ✓ Resuelto | Usar `C:\Java\hotswap-agent-2.0.3.jar`; el jar local antiguo no se usará. |

### Bloqueadores actuales

1. T-01 está implementada y los tests se compilan, pero no se ejecutaron; queda pendiente validar su aceptación funcional antes de marcarla completada.
2. T-02 tiene guardas implementadas en `MavenManager`: solo se permite `clean` tras confirmar `stopped`; `cleanCompile` usa `compile` sin clean en estados activos/desconocidos; `cleanInstall` y `cleanPackage` se cancelan y notifican. `ServerManager` informa `unknown` ante error de consulta. Falta validar estos casos con pruebas o runtime; no se añadieron tests por instrucción del dueño.
3. T-03/T-04 necesitan validación de runtime y una migración one-shot real de settings.
4. F2 no puede cerrarse sin validar el manifiesto del jar y ejecutar E-5 en Payara 5 y GlassFish 4.
5. F4/F5 no pueden cerrarse sin fixture/parser probado con E-1 y, preferentemente, E-3; aún no existe `HotswapAgentProbe` ni integración de estrategias.
6. Las capacidades estructurales de DCEVM no deben darse por garantizadas sin E-4.

---

## 6. Registro de cambios

| Fecha | Responsable | Cambio |
|---|---|---|
| 2026-11-04 | Dueño del repo | Confirmó jar 2.0.3, Payara 5/GlassFish 4, reglas de `clean`, `.mm43/` y no parchear GlassFishPlugin. |
| 2026-11-04 | Agente implementador | Analizó ambos documentos y creó esta guía. No modificó código. |
| 2026-11-05 | Agente revisor | Revisó los cambios preparados contra ambos documentos base. F0–F4 tienen trabajo parcial, sin criterios de aceptación completos; ejecutó `npm run check-types` y `npm run lint` (0 errores, 9 advertencias). Actualizó estado, bloqueadores y siguiente paso. |\n| 2026-11-05 | Agente implementador | Implementó T-01: sync incremental con comparación tamaño/SHA-256, escritura temporal + rename, reporte `SyncResult` y clases internas; añadió cuatro pruebas. `check-types`, `lint` y `compile-tests` pasan; no ejecutó la suite a petición del dueño. |
| 2026-11-05 | Agente implementador | Implementó T-02: guardas de `clean` en `MavenManager`, fallback a `compile` sin limpiar y advertencias; `ServerManager.checkServerStatus` usa `unknown` si la consulta falla/no reconoce el dominio. Ejecutó `npm run check-types` y `npm run lint` (0 errores, 9 advertencias); no creó ni ejecutó pruebas ni validó contra servidor real. Archivos: `src/modules/maven/MavenManager.ts`, `src/modules/server/ServerManager.ts`, este documento. |

---

## 7. Plantilla para la próxima actualización

```text
Fecha:
Fase/tarea:
Estado anterior → nuevo estado:
Archivos modificados:
Pruebas ejecutadas:
Resultado:
Riesgos o decisiones pendientes:
Siguiente paso:
```

---

## 8. Procedimiento de actualización

Cada vez que se implemente una tarea, actualizar este archivo en el mismo cambio o commit:

1. Cambiar el estado de la tarea y de la fase correspondiente.
2. Registrar los archivos modificados.
3. Anotar los comandos y pruebas ejecutadas.
4. Adjuntar o referenciar la evidencia relevante, especialmente logs y resultados E2E.
5. Actualizar la sección de bloqueadores y el siguiente paso.
6. Añadir una entrada en el registro de cambios.

No marcar una tarea como completada solo porque el código compila. Debe cumplirse también su criterio de aceptación y existir evidencia verificable.

### Criterios de estado

- **Pendiente:** no se ha iniciado o falta evidencia.
- **En curso:** hay cambios implementados, pero falta completar o probar la tarea.
- **Completada:** código, pruebas y aceptación verificados.
- **Bloqueada:** requiere una decisión, experimento o dependencia externa.
- **No aplica:** se descartó formalmente y se documentó la razón.

---

## 9. Orden de ejecución autorizado

### Próximo bloque: F0

1. [x] Revisar el flujo actual de `MavenManager` y sus consumidores.
2. Implementar `SyncResult` sin romper las llamadas existentes.
3. Hacer la comparación de contenido antes de copiar.
4. Escribir los `.class` modificados mediante temporal y renombrado atómico.
5. Devolver todas las clases cambiadas, incluidas internas y anónimas.
6. Ejecutar pruebas de cambio, no-cambio, borrado y concurrencia básica.
7. Confirmar que el hot-reload no usa `war:exploded`.
8. [x] Confirmar que `clean` se omite cuando el servidor está encendido (implementado en T-02; validación runtime pendiente).

### Después de F0

- F1 debe completarse antes de instalar o resolver estrategias.
- F2 debe completarse antes de probar el arranque real con HotswapAgent.
- F3 puede prepararse después de F2, pero F4 necesita conocer la ruta definitiva del log.
- F5 es el primer punto de integración funcional DCEVM.
- F6, F7, F8 y F9 no deben adelantarse de manera que oculten fallos de F0/F4.

---

## 10. Checklist de aceptación del MVP DCEVM

- [ ] La JVM del servidor se identifica como `dcevm`.
- [ ] El agente utilizado es `C:\Java\hotswap-agent-2.0.3.jar`.
- [ ] La opción `-javaagent` se instala mediante `asadmin` y sin duplicarse.
- [ ] El agente carga después de reiniciar el servidor.
- [ ] El log contiene los plugins descubiertos y la inicialización de la aplicación.
- [ ] Un cambio de método produce solo los `.class` modificados.
- [ ] La escritura de cada `.class` es atómica.
- [ ] Un build sin cambios no produce eventos del agente.
- [ ] El observador detecta `reloaded`, `failed`, `stale-loader`, `skipped-not-loaded` y `timeout`.
- [ ] Un `reload-ok` prevalece sobre un error stale de otro loader.
- [ ] `stale-loader` nunca dispara redeploy automático.
- [ ] Un fallo real puede aplicar la política `reloadFailureFallback`.
- [ ] Un cambio estructural no soportado solicita redeploy.
- [ ] El flujo completo Ctrl+S → compile → sync → resultado funciona sin el TCP antiguo.
- [ ] `npm run check-types` y `npm run lint` terminan correctamente.

---

## 11. Checklist de compatibilidad

### Payara 5

- [ ] Validar `asadmin list-jvm-options`.
- [ ] Validar instalación y eliminación de la opción del agente.
- [ ] Validar ruta de `WEB-INF/classes` observada por HotswapAgent.
- [ ] Validar reconocimiento del `WebappClassLoader`.
- [ ] Validar reinicio y redeploy por separado.

### GlassFish 4

- [ ] Repetir instalación idempotente.
- [ ] Confirmar escape de opciones JVM.
- [ ] Confirmar formato y ruta del log.
- [ ] Confirmar que el parser no dependa de un texto exclusivo de Payara 5.
- [ ] Confirmar clasificación de errores de loader detenido.

### JVM estándar

- [ ] El agente no se carga.
- [ ] El resolver selecciona JDWP para cambios de cuerpo de método.
- [ ] El cliente detecta si el puerto está ocupado.
- [ ] Cambios estructurales se derivan a redeploy según configuración.

---

## 12. Evidencia mínima por tarea

| Tipo de tarea | Evidencia mínima |
|---|---|
| Sincronización | Lista `changed/removed`, hashes o comparación verificable y ausencia de eventos en build sin cambios |
| Detección JVM | Salida de `java -version`, `AS_JAVA` utilizado y contexto `mm43.jvmKind` |
| Instalador | Salida antes/después de `list-jvm-options` y prueba de segunda instalación |
| Propiedades | Diff o prueba round-trip conservando comentarios y orden |
| Parser | Fixture, casos clasificados y resultado por clase |
| Estrategia | Log de una ejecución completa y resultado de fallback |
| UI | Capturas o descripción reproducible de estados y acciones |
| JDWP | Resultado con método modificado, cambio estructural y puerto ocupado |
| Limpieza | Búsqueda sin referencias obsoletas y typecheck/lint exitosos |

---

## 13. Historial de ejecuciones

| Fecha | Tarea/fase | Entorno | Resultado | Evidencia |
|---|---|---|---|---|
| 2026-11-05 | T-01 / F0 | MM43 (Windows) | `npm run check-types`, `npm run lint` y `npm run compile-tests` correctos; lint con 9 advertencias/0 errores. Suite funcional no ejecutada por indicación del dueño. | Tests de cambio, sync repetido, borrado, clases internas y origen ausente añadidos y compilados; ejecución pendiente. |
| 2026-11-05 | T-02 / F0 | MM43 (Windows) | `npm run check-types` correcto; `npm run lint` con 0 errores y las 9 advertencias existentes en archivos ajenos a T-02. No se añadieron pruebas ni se ejecutó validación runtime, según instrucción del dueño. | `MavenManager`: clean solo cuando el estado consultado es `stopped`; `cleanCompile` usa `compile` como alternativa; `cleanInstall`/`cleanPackage` se rechazan con advertencia en otros estados. `ServerManager`: fallo de consulta/no dominio reconocido produce `unknown`. |

---

## 14. Próxima acción

**T-02 está implementada en `src/modules/maven/MavenManager.ts` y `src/modules/server/ServerManager.ts`; `npm run check-types` pasa y `npm run lint` finaliza con 0 errores y 9 advertencias preexistentes. No se añadieron pruebas ni se ejecutó validación runtime, según instrucción del dueño. T-01 continúa con sus pruebas funcionales compiladas pero pendientes de ejecución.**

Siguiente paso: validar manualmente con servidor detenido, encendido y consulta de estado fallida que `clean` solo se ejecute tras confirmar `stopped`, y continuar F0 sin modificar el hot-reload incremental (`compile` + sync, sin `war:exploded`).


