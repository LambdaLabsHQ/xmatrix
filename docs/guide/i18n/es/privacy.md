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

**En resumen:** para mostrar cuánta cuota les queda a las herramientas de IA que registraste, el daemon de xMatrix lee los archivos de inicio de sesión de esas herramientas en tu equipo (por ejemplo `~/.grok/auth.json`) y consulta directamente a cada proveedor. Codex es la excepción: xMatrix pregunta al propio Codex, a través de la sesión de Codex en curso o de un `codex app-server` iniciado brevemente, y no abre ningún archivo de inicio de sesión de Codex. Nada de lo que lee de esos archivos (token, id de cuenta, contenido o huella del archivo) se envía a xMatrix; el Hub solo recibe la respuesta de cuota normalizada. Un único interruptor detiene la lectura de archivos, las solicitudes al app-server de Codex y las solicitudes al proveedor (consulta «Desactivar consultas locales de cuota» más abajo).

Cuando registras un agente compatible (Claude Code, Codex, Cursor, Grok, OpenCode, DeepSeek, Z.ai o Antigravity), xMatrix puede mostrar la cuota restante en `xmatrix agent list` y en la vista Agents, y permitir que `@auto` evite cuentas agotadas.

Para consultar la cuota restante directamente en tu proveedor sin ejecutar un turno LLM, el daemon local lee en memoria el almacén de credenciales de la herramienta registrada:

| Agente | Almacén local leído (solo en memoria) | Endpoint del proveedor consultado desde tu equipo |
| --- | --- | --- |
| Claude Code | Llavero de macOS (`Claude Code-credentials`) o `~/.claude/.credentials.json` | `https://api.anthropic.com/api/oauth/usage` |
| Codex | Ninguno: el método `account/rateLimits/read` del propio app-server de Codex (la sesión en curso o un `codex app-server` iniciado brevemente) | Lo gestiona Codex con su propio inicio de sesión |
| Cursor | `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`, llavero de macOS (`cursor-access-token`) o `auth.json` de Cursor | `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` |
| Grok Build | `GROK_CLI_OAUTH_TOKEN` o `~/.grok/auth.json` | `https://cli-chat-proxy.grok.com/v1/billing?format=credits` |
| OpenCode | `OPENCODE_API_KEY` o `auth.json` de OpenCode | `https://opencode.ai/zen/go/v1/usage` o `wham/usage` de ChatGPT |
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

Para desactivar solo Antigravity, define `XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE=1`. Al desactivarlas, xMatrix no lee almacenes locales de credenciales, no inicia `codex app-server` ni pregunta a una sesión de Codex, ni consulta endpoints de uso en ninguna ruta.

## Diagnósticos del cliente e informes de errores

xMatrix no usa cookies publicitarias, rastreo entre sitios, grabación de sesiones ni SDKs de analítica de comportamiento de terceros (como PostHog, Google Analytics o Cloudflare Web Analytics).

Los diagnósticos opcionales del cliente y los informes de fallos del navegador están **desactivados por defecto en las apps y la CLI estables**; los valores por defecto de la beta se describen en la tabla. Las páginas de marketing, documentación y legales sin sesión nunca cargan Sentry. Qué se envía cuando los diagnósticos están activados:

- **Informes de errores y fallos (Sentry):** solo dentro de la app con sesión iniciada, se envían la clase del error, su código si lo tiene y las ubicaciones de código de su pila. Nunca se envían el mensaje del error, breadcrumbs, URL, cookies, cabeceras, cuerpos de petición ni datos del usuario. Las compilaciones locales o autoalojadas sin DSN no envían nada. (Los errores del Hub en el servidor se siguen informando desde el servidor para operar el servicio alojado; ver más abajo.)
- **Diagnósticos propios (xMatrix Hub → Cloudflare Analytics Engine):** envían tiempos de arranque (`/api/observable/startup-timing`), conteo de pasos de onboarding (`/api/observable/onboarding-step`), fallos de inicio del daemon de escritorio (`/api/observable/desktop-daemon-failure`) y muestras de reconexión CLI (`/api/observable/client-metrics`). Los identificadores se seudonimizan en el servidor con HMAC-SHA-256 con clave.

### Qué puede contener un evento de diagnóstico

Cada evento de diagnóstico tiene un conjunto declarado de campos, que se comprueba cuando el cliente lo crea y otra vez cuando el Hub lo recibe. Un campo solo puede contener un valor fijo de una lista, un número, true o false, una versión, un identificador opaco o un código corto como `websocket_connect_failed` (minúsculas, dígitos, `_` y `-`). Un evento con cualquier otro campo, o con un valor fuera de su campo, se rechaza entero en lugar de recortarse, así que el texto que escribes no tiene campo por el que viajar. Los errores se informan por su clase y su código, nunca por su mensaje.

Solo dos caminos llevan texto:

- **Send failure report en una tarjeta de fallo de inicio del escritorio:** las últimas líneas de la CLI, que la App de escritorio censura antes en tu equipo (directorio personal, direcciones de correo, parámetros de consulta URL y cualquier cosa con forma de token o clave). La tarjeta te muestra esas líneas antes de enviarlas y solo se envían al pulsar el botón; el informe automático enviado con los diagnósticos activados solo lleva la etapa del fallo, el código de salida, la plataforma y la versión de la App.
- **Informes de errores del Hub en el servidor:** el propio mensaje de error del servidor, sin valores entrecomillados, direcciones de correo, parámetros de consulta URL, rutas del directorio personal ni cadenas con forma de token. Los datos registrados junto al error solo se informan cuando son números, true/false o identificadores opacos.

### Valores por defecto: beta y estable

| | Apps y CLI estables | Apps y CLI beta |
| --- | --- | --- |
| Los activaste | Se envían | Se envían |
| Los desactivaste, o Do Not Track, Global Privacy Control o `XMATRIX_TELEMETRY=0` | No se envían | No se envían |
| Sin elección; país de registro **y** país actual fuera de la UE, el EEE, el Reino Unido y Suiza | No se envían | Se envían, tras un aviso de una línea con enlace para desactivarlos |
| Sin elección; alguno de los dos países en la UE, el EEE, el Reino Unido o Suiza, o desconocido | No se envían | No se envían; se ofrece la casilla sin marcar **Send diagnostics to help improve the beta** |

Las filas se aplican en orden: una activación explícita se respeta aunque Do Not Track o Global Privacy Control estén activos. Solo marcar esa casilla o cambiar el interruptor en Ajustes (o `xmatrix config telemetry on|off`) cuenta como elección. Cerrar el aviso no es una elección, y xMatrix nunca cambia tu ajuste por ti.

**Cómo se decide la región.** Tus clientes no tienen una ubicación fiable propia (la zona horaria y el idioma son ajustes), así que se la indica el Hub:

- **Región de registro.** Al crear tu cuenta, el Hub registra, a partir del país que Cloudflare indica para esa solicitud, si es un país que exige consentimiento previo. Solo se guarda esa categoría, nunca el país ni tu dirección IP, y ninguna solicitud posterior la cambia. Las cuentas anteriores la obtienen la primera vez que usan una versión beta. Se elimina con tu cuenta.
- **Región actual.** Antes de cada envío, el cliente usa la respuesta del Hub para su conexión actual, con un máximo de 10 minutos; si es más antigua, vuelve a preguntar con una pequeña solicitud que no lleva diagnósticos. Si la consulta falla, agota el tiempo o el país es desconocido, no se envía nada. Así, al entrar en un país que exige consentimiento, el envío por defecto se detiene en 10 minutos como máximo.

### Activar o desactivar diagnósticos e informes de errores

- **Web, escritorio, iOS y Android:** abre **Settings → Legal and privacy** y cambia **Send diagnostics and crash reports**. Tu elección se guarda en tu cuenta y todos los clientes la siguen. En escritorio, este interruptor también actualiza el ajuste `telemetry` del daemon local.
- **CLI y daemon:** desactivados por defecto; actívalos con `xmatrix config telemetry on` o `XMATRIX_TELEMETRY=1`, y desactívalos con `xmatrix config telemetry off`, `XMATRIX_TELEMETRY=0` o `DO_NOT_TRACK=1`.
- **CLI y daemon:** actívalos con `xmatrix config telemetry on` o `XMATRIX_TELEMETRY=1`, y desactívalos con `xmatrix config telemetry off`, `XMATRIX_TELEMETRY=0` o `DO_NOT_TRACK=1`. `xmatrix config telemetry on|off` también guarda la elección en tu cuenta.

## Documentos legales

- [Política de privacidad (EN)](/privacy)
- [Aviso de cookies y almacenamiento local (EN)](/cookies)
- [Subprocesadores (EN)](/subprocessors)
- [Términos de servicio (EN)](/terms)
