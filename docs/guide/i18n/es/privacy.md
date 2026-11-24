---
title: "Telemetría, diagnósticos y privacidad local — Documentación de xMatrix"
description: "Qué se queda en tu equipo, cómo funcionan las consultas opcionales de cuota y los diagnósticos del cliente, y cómo desactivarlos."
---

# Telemetría y privacidad local

xMatrix combina un Hub colaborativo alojado con un daemon local en Rust que corre en tus propias máquinas. Esta página detalla todos los diagnósticos y lecturas locales de los clientes y el daemon, y cómo desactivarlos.

## Qué se queda en tu máquina

Tu código fuente, historial de Git, carpetas de trabajo, historial del proveedor y credenciales locales de modelos permanecen en tus propios equipos. xMatrix nunca sube tus claves API ni tokens OAuth locales al Hub, ni lee archivos de otras herramientas para vincular identidades entre máquinas.

## Consultas locales de cuota de proveedores

Cuando registras un agente compatible (Claude Code, Codex, Cursor, Grok, OpenCode, DeepSeek, Z.ai o Antigravity), xMatrix puede mostrar la cuota restante en `xmatrix agent list` y en la vista Agents, y permitir que `@auto` evite cuentas agotadas.

Para consultar la cuota restante directamente en tu proveedor sin ejecutar un turno LLM, el daemon local lee en memoria el almacén de credenciales de la herramienta registrada:

| Agente | Almacén local leído (solo en memoria) | Endpoint del proveedor consultado desde tu equipo |
| --- | --- | --- |
| Claude Code | Llavero de macOS (`Claude Code-credentials`) o `~/.claude/.credentials.json` | `https://api.anthropic.com/api/oauth/usage` |
| Codex | `$CODEX_HOME/auth.json` o `~/.codex/auth.json` | `https://chatgpt.com/backend-api/wham/usage` |
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

```sh
xmatrix config quotaProbes off
# O mediante variable de entorno (tiene prioridad)
export XMATRIX_DISABLE_QUOTA_PROBES=1
```

Para desactivar solo Antigravity, define `XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE=1`. Al desactivarlas, xMatrix no lee almacenes locales de credenciales ni consulta endpoints de uso.

## Diagnósticos del cliente e informes de errores

xMatrix no usa cookies publicitarias, rastreo entre sitios, grabación de sesiones ni SDKs de analítica de comportamiento de terceros (como PostHog, Google Analytics o Cloudflare Web Analytics).

Por defecto, los clientes con sesión iniciada envían diagnósticos operativos acotados para corregir fallos y regresiones de rendimiento:

- **Informes de errores y fallos (Sentry):** sin información de usuario, cookies, cabeceras/cuerpos HTTP, parámetros de consulta URL ni breadcrumbs de consola, y con textos entrecomillados censurados. Las compilaciones locales o autoalojadas sin DSN no envían nada.
- **Diagnósticos propios (xMatrix Hub → Cloudflare Analytics Engine):** tiempos de arranque (`/api/observable/startup-timing`), conteo de pasos de onboarding (`/api/observable/onboarding-step`), fallos de inicio del daemon de escritorio (`/api/observable/desktop-daemon-failure`) y muestras de reconexión CLI (`/api/observable/client-metrics`). Los identificadores se seudonimizan en el servidor con HMAC-SHA-256 con clave; nunca incluyen contenido de mensajes ni comandos.

### Desactivar diagnósticos e informes de errores

- **Web, escritorio, iOS y Android:** abre **Settings → Legal and privacy** y desactiva **Send diagnostics and crash reports**.
- **Señales del navegador:** xMatrix respeta automáticamente **Do Not Track (`DNT: 1`)** y **Global Privacy Control (GPC)** salvo que los reactives explícitamente en Settings.
- **CLI y daemon:** ejecuta `xmatrix config telemetry off`, o define `XMATRIX_TELEMETRY=0` o `DO_NOT_TRACK=1`.

## Documentos legales

- [Política de privacidad (EN)](/privacy)
- [Aviso de cookies y almacenamiento local (EN)](/cookies)
- [Subprocesadores (EN)](/subprocessors)
- [Términos de servicio (EN)](/terms)
