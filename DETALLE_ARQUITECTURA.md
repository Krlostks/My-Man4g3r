# 🏗️ Guía Técnica de Arquitectura: MM43 Manager

Este documento detalla la estructura interna, los flujos de datos y la filosofía de diseño de la extensión **My M4nag3r (MM43)**, diseñada para facilitar el mantenimiento y la expansión del código.

## 📂 Estructura de Carpetas

```text
MM43/
├── src/
│   ├── Context.ts          # Punto de entrada (activación, registro de comandos y proveedores)
│   ├── config/             # Gestión de la configuración (settings.json)
│   │   ├── ConfigManager.ts
│   │   └── types.ts
│   ├── modules/            # Lógica de negocio segmentada por dominio
│   │   ├── maven/          # Ejecución de comandos Maven (build, install, package war, classpath)
│   │   ├── server/         # Control de Payara, Logs, Asset Watching, Deploy/Undeploy
│   │   ├── logger/         # Sistema unificado de logging y panel webview personalizado
│   │   └── hotreload/      # (Fase 3) Compilación incremental Java + TCP (AgenteHotReloadManager)
│   ├── ui/                 # Componentes de la interfaz de usuario
│   │   ├── ProjectsProvider.ts
│   │   ├── ServerProvider.ts
│   │   └── StatusBarManager.ts
│   └── test/               # Pruebas integradas
├── esbuild.js              # Script de empaquetado ultra-rápido (CJS)
├── package.json            # Definición de comandos, menús y settings
└── tsconfig.json           # Configuración de compilación TypeScript
```

---

## 🔄 Flujos Principales

### 1. Gestión de Comandos Maven
La clase `MavenComand` encapsula la ejecución de procesos de sistema, soportando comandos como `clean compile`, `clean install`, `clean package`, y generación de classpath.
*   **Aislamiento**: Cada comando corre en un proceso hijo (`spawn`).
*   **Exportación WAR**: Funcionalidad para exportar el artefacto resultante copiándolo a la ubicación elegida por el usuario.
*   **Validación**: Antes de ejecutar, se valida que la ruta del proyecto sea correcta.

### 2. Ciclo de Vida del Servidor (Payara)
`PayaraManager` interactúa con el ejecutable `asadmin`.
*   **Estado**: El estado del servidor (Running/Stopped/Starting) se mantiene en una variable reactiva que notifica a la UI (`StatusBar` y `Sidebar`).
*   **Gestión de Apps**: Capacidad de listar aplicaciones desplegadas y realizar `undeploy` interactuando con el `ServerProvider`.
*   **Logs**: `LogTailer` usa un watcher nativo de Node.js para detectar cambios en `server.log` y hacer "streaming" del contenido.

### 3. Sistema de Watchers (Hot-Reload)
Existen dos niveles de recarga en caliente:
*   **Assets (Web)**: Implementado en `AssetWatcher.ts`. Vigila archivos estáticos y XHTML, copiándolos directamente al autodeploy de Payara.
*   **Java (Clases)**: Seguirá la lógica del legacy `watcher.ps1` usando `AgenteHotReloadManager`.
    *   `chokidar` detecta el cambio en `.java`.
    *   `javac` compila el archivo usando el classpath extraído de `cp.txt`.
    *   Notificación vía Socket TCP (`net.Socket`) al agente de recarga.

### 4. Sistema de Logging (Nuevo)
Se implementó un sistema de registro robusto con interfaz gráfica propia.
*   `Logger.ts`: Abstracción global para registrar eventos por categorías (MAVEN, SERVER, WATCHER, etc.).
*   `LogWebviewProvider`: Un panel tipo Webview dentro de VS Code para mostrar los logs de la extensión de forma enriquecida y organizada, sustituyendo a la salida plana de un OutputChannel estándar.

---

## 🎨 Componentes de UI

*   **TreeDataProviders**: Se utilizan para crear las vistas del Sidebar. Cada "Nodo" del árbol puede tener comandos asociados (botones de play/trash). `ServerProvider` ahora es capaz de listar de forma dinámica las aplicaciones desplegadas.
*   **StatusBarManager**: Controla los iconos pequeños en la barra inferior. Es centralizado para asegurar que solo haya una instancia gestionando los indicadores.
*   **Webview Views**: Integración de vistas web personalizadas para experiencias de UI ricas (ej. Logs).

---

## ⚙️ Configuración (Settings)

La extensión utiliza el sistema nativo de `settings.json` de VS Code bajo el prefijo `mm43`.
*   `mm43.jdkPath`: Ruta al compilador Java.
*   `mm43.payaraPath`: Raíz del servidor.
*   `mm43.serverDomain`: Nombre del dominio (ej. `domain1`).
*   `mm43.projects`: Un array de objetos con el catálogo de proyectos a gestionar.

---

## 🛠️ Guía para el Programador

1.  **Añadir un nuevo comando**:
    *   Regístralo en `package.json` (sección `contributes.commands`).
    *   Añádelo al menú o sidebar en `package.json`.
    *   Regístralo en `src/Context.ts` dentro de la función `activate`.
2.  **Manejo de rutas**: Siempre usa el módulo `path` de Node.js para asegurar compatibilidad con diferentes separadores (`\` vs `/`).
3.  **Logs**: Usa la clase `Logger` (e.g., `Logger.info()`, `Logger.error()`) para asegurar que la salida se muestre correctamente en el Webview en lugar de un output channel básico.

---
> [!NOTE]
> Esta arquitectura está diseñada para ser **asíncrona** y **no bloqueante**. Nunca uses funciones `FileSync` o bucles pesados en el hilo principal de la extensión para evitar que VS Code se congele.
