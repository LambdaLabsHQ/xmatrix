---
title: "Telemetría, diagnósticos y privacidad local — Documentación de xMatrix"
description: "Qué se queda en tu equipo, cómo funcionan las consultas opcionales de cuota y los diagnósticos del cliente, y cómo desactivarlos."
---

# Telemetría y privacidad local

xMatrix combina un Hub colaborativo alojado con un daemon local en Rust que corre en tus propias máquinas. Esta página detalla todos los diagnósticos y lecturas locales de los clientes y el daemon, y cómo desactivarlos.

## Qué se queda en tu máquina

Tu código fuente, historial de Git, carpetas de trabajo, historial del proveedor y credenciales locales de modelos permanecen en tus propios equipos. xMatrix nunca sube tus claves API ni tokens OAuth locales al Hub, ni lee archivos de otras herramientas para vincular identidades entre máquinas.

Para mantener estable un equipo conectado tras reinstalaciones bajo tu cuenta, el daemon deriva localmente un `machineId` aislado por propietario (`SHA-256` de tu ID de usuario y un identificador del sistema operativo); los identificadores de hardware sin procesar y las huellas sin aislar por cuenta nunca se envían al Hub.

## Consultas locales de cuota de proveedores

**En resumen:** para mostrar cuánta cuota les queda a las herramientas de IA que registraste, el daemon de xMatrix lee los archivos de inicio de sesión de esas herramientas en tu equipo (por ejemplo `~/.grok/auth.json`) y consulta directamente a cada proveedor. Codex, Claude Code y OpenCode son la excepción: xMatrix pregunta a la propia herramienta y no abre ninguno de sus archivos de inicio de sesión. A Codex, a través de la sesión en curso o de un `codex app-server` iniciado brevemente; a Claude Code, a través de la sesión en curso o de un `claude` iniciado brevemente (su solicitud `get_usage`, que no envía ningún prompt); y a OpenCode, a través de un `opencode serve` iniciado brevemente. Nada de lo que lee de esos archivos (token, id de cuenta, contenido o huella del archivo) se envía a xMatrix; el Hub solo recibe la respuesta de cuota normalizada. Un único interruptor detiene la lectura de archivos, las solicitudes a Codex, Claude Code y OpenCode, y las solicitudes al proveedor (consulta «Desactivar consultas locales de cuota» más abajo).

Cuando registras un agente compatible (Claude Code, Codex, Cursor, Grok, OpenCode, DeepSeek, Z.ai o Antigravity), xMatrix puede mostrar la cuota restante en `xmatrix agent list` y en la vista Agents, y permitir que `@auto` evite cuentas agotadas.

Para consultar la cuota restante directamente en tu proveedor sin ejecutar un turno LLM, el daemon local lee en memoria el almacén de credenciales de la herramienta registrada:

| Agente | Almacén local leído (solo en memoria) | Endpoint del proveedor consultado desde tu equipo |
| --- | --- | --- |
| Claude Code | Ninguno: la solicitud de control `get_usage` del propio Claude Code (la sesión en curso o un `claude` iniciado brevemente); no se envía ningún prompt | Lo gestiona Claude Code con su propio inicio de sesión |
| Codex | Ninguno: el método `account/rateLimits/read` del propio app-server de Codex (la sesión en curso o un `codex app-server` iniciado brevemente) | Lo gestiona Codex con su propio inicio de sesión |
| Cursor | `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`, llavero de macOS (`cursor-access-token`) o `auth.json` de Cursor | `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` |
| Grok Build | `GROK_CLI_OAUTH_TOKEN` o `~/.grok/auth.json` | `https://cli-chat-proxy.grok.com/v1/billing?format=credits` |
| OpenCode | Ninguno: `GET /api/experimental/usage/limits` de un `opencode serve` iniciado brevemente, que escucha solo en loopback con una contraseña de un solo uso. No se lee nada para un modelo que OpenCode envía a otro proveedor | Lo gestiona OpenCode con su propio inicio de sesión |
| DeepSeek | `DEEPSEEK_API_KEY` o archivo de credenciales en `$DSH_HOME` | `https://api.deepseek.com/user/balance` |
| Z.ai / Zhipu | `ZAI_API_KEY` / `ZHIPU_API_KEY` | `https://api.z.ai/api/monitor/usage/quota/limit` (o `open.bigmodel.cn`) |
| Antigravity | Ejecuta `agy -p "/usage" --output-format json` sin modificar | Gestionado por el propio `agy` |

**Límite estricto:**

- Las credenciales permanecen en la memoria del proceso local y se envían **únicamente** al endpoint de uso de ese proveedor.
- Las huellas SHA-256 locales se usan solo como clave de caché en memoria para detectar cambios de cuenta y **nunca se registran ni se envían a xMatrix**.
- Al Hub de xMatrix solo llegan datos normalizados de cuota (porcentaje restante, hora de reinicio, disponibilidad de la cuenta y saldo prepago si aplica).

### Desactivar consultas locales de cuota

Desactívalas desde **Desktop Settings → Legal and privacy → Local provider quota probes**, o mediante CLI / variable de entorno:

```sh
xmatrix config quotaProbes off
# O mediante variable de entorno (tiene prioridad)
export XMATRIX_DISABLE_QUOTA_PROBES=1
```

Para desactivar solo Antigravity, define `XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE=1`. Al desactivarlas, xMatrix no lee almacenes locales de credenciales, no inicia `codex app-server`, `claude` ni `opencode serve`, ni pregunta a una sesión de Codex o Claude Code, ni consulta endpoints de uso en ninguna ruta.

## Diagnósticos del cliente e informes de errores

xMatrix no usa cookies publicitarias, rastreo entre sitios, grabación de sesiones ni SDKs de analítica de comportamiento de terceros (como PostHog, Google Analytics o Cloudflare Web Analytics).

**Los diagnósticos opcionales del cliente y los informes de fallos del navegador están desactivados por defecto en todas las regiones (opt-in explícito).** Las páginas públicas de marketing, documentación y avisos legales nunca cargan Sentry. Solo se envían si decides activarlos (o si haces clic en **Send failure report** en una tarjeta de fallo de inicio del daemon):

- **Informes de errores y fallos (Sentry):** solo cuando un usuario con sesión iniciada los activa, se envían la clase del error, su código si lo tiene y las ubicaciones de código de su pila. Nunca se envían el mensaje del error, breadcrumbs, URL, cookies, cabeceras, cuerpos de petición ni datos del usuario. Las compilaciones locales o autoalojadas sin DSN no envían nada. (Los errores del Hub en el servidor se siguen informando desde el servidor para operar el servicio alojado; ver más abajo.)
- **Diagnósticos propios (xMatrix Hub → Cloudflare Analytics Engine):** solo cuando están activados, envían tiempos de arranque (`/api/observable/startup-timing`), conteo de pasos de onboarding (`/api/observable/onboarding-step`), fallos de inicio del daemon de escritorio (`/api/observable/desktop-daemon-failure`) y muestras de reconexión CLI (`/api/observable/client-metrics`). Los identificadores se seudonimizan en el servidor con HMAC-SHA-256 con clave.

### Qué puede contener un evento de diagnóstico

Cada evento de diagnóstico tiene un conjunto declarado de campos, que se comprueba cuando el cliente lo crea y otra vez cuando el Hub lo recibe. Un campo solo puede contener un valor fijo de una lista, un número, true o false, una versión, un identificador opaco o un código corto como `websocket_connect_failed` (minúsculas, dígitos, `_` y `-`). Un evento con cualquier otro campo, o con un valor fuera de su campo, se rechaza entero en lugar de recortarse, así que el texto que escribes no tiene campo por el que viajar. Los errores se informan por su clase y su código, nunca por su mensaje.

Solo dos caminos llevan texto:

- **Send failure report en una tarjeta de fallo de inicio del escritorio:** las últimas líneas de la CLI, que la App de escritorio censura antes en tu equipo (directorio personal, direcciones de correo, parámetros de consulta URL y cualquier cosa con forma de token o clave). La tarjeta te muestra esas líneas antes de enviarlas y solo se envían al pulsar el botón; el informe automático enviado con los diagnósticos activados solo lleva la etapa del fallo, el código de salida, la plataforma y la versión de la App.
- **Informes de errores del Hub en el servidor:** el propio mensaje de error del servidor, sin valores entrecomillados, direcciones de correo, parámetros de consulta URL, rutas del directorio personal ni cadenas con forma de token. Los datos registrados junto al error solo se informan cuando son números, true/false o identificadores opacos.

### Activar o desactivar diagnósticos e informes de errores

- **Web, escritorio, iOS y Android:** abre **Settings → Legal and privacy** y cambia **Send diagnostics and crash reports** (desactivado por defecto). En escritorio, este interruptor también actualiza `telemetry` en el daemon local.
- **CLI y daemon:** desactivados por defecto; actívalos con `xmatrix config telemetry on` o `XMATRIX_TELEMETRY=1`, y desactívalos con `xmatrix config telemetry off`, `XMATRIX_TELEMETRY=0` o `DO_NOT_TRACK=1`.

## Documentos legales

- [Política de privacidad (EN)](/privacy)
- [Aviso de cookies y almacenamiento local (EN)](/cookies)
- [Subprocesadores (EN)](/subprocessors)
- [Términos de servicio (EN)](/terms)
