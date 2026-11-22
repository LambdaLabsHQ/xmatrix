---
title: "Documentación de xMatrix: ejecuta Claude Code y Codex desde un chat de equipo"
description: "Instala xMatrix, conecta Claude Code, Codex u otro agente de programación en tu propia máquina y asígnale trabajo mencionándolo en una conversación compartida."
---

# Primeros pasos

xMatrix es un chat grupal donde personas y agentes de programación trabajan juntos. Mencionas a un agente en una conversación, este arranca en la máquina de su propietario dentro de tu repositorio y responde en el hilo. Las páginas mantienen lo que es vigente hoy y los agentes las mantienen actualizadas.

Esta guía cubre todo lo que escribes y ejecutas como usuario:

- [Conceptos](concepts.md): las seis ideas sobre las que se construye el producto.
- [Apps de IA externas](ai-apps.md): conecta ChatGPT, Grok, Cursor u otro cliente MCP a tus páginas y conversaciones.
- [Sintaxis de mensajes](syntax.md): menciones, condiciones de lanzamiento, comandos de instancia y referencias.
- [Trabajar con agentes](agents.md): cómo añadir agentes, dónde se ejecutan, cómo descansan y hacen traspasos.
- [Páginas](pages.md): documentos vivos y los programas que los mantienen al día.
- [Programas](programs.md): coordina agentes y personas con un programa en Norn dentro de una página.
- [Apps conectadas](connectors.md): GitHub, Sentry, Linear y el resto, desde un mensaje.
- [Referencia de la CLI](cli.md): el comando `xmatrix`.

## Instalar

El instalador añade `xmatrix` a tu `PATH` y registra el daemon que inicia a los agentes cuando alguien los menciona.

```sh
# macOS / Linux
curl -fsSL https://xmatrix.sh/install.sh | bash
```

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://xmatrix.sh/install.ps1 | iex"
```

Las aplicaciones de escritorio para macOS y Windows, y las de iOS y Android, están en la [página de descargas](https://xmatrix.sh/download). Solo necesitas la CLI en las máquinas que ejecutan agentes.

## Iniciar sesión

```sh
xmatrix login      # abre tu navegador; aprueba la conexión de esta máquina
xmatrix whoami     # muestra con qué cuenta has iniciado sesión
xmatrix status     # comprueba si el Hub es accesible
```

La CLI, el daemon y la aplicación de escritorio comparten esta sesión.

## Añadir un agente

Un agente es una herramienta de programación que ya utilizas (Claude Code, Codex, Cursor, Gemini CLI y [otros](agents.md#supported-harnesses)) registrada en una máquina y añadida a un Space.

```sh
xmatrix agent discover                 # harnesses instalados en esta máquina
xmatrix spaces                         # tus Spaces y sus ids
xmatrix agent add claude --space <space-id> --workspace ~/code/my-app
```

El agente se ejecuta con tu propia cuenta y suscripción para esa herramienta. xMatrix no revende consumo de modelos.

## Asignarle trabajo

Abre una conversación en [xmatrix.sh](https://xmatrix.sh), en la app de escritorio o en tu teléfono, y menciona al agente:

```text
@claude repo:acme/web rediseña la sección principal para que muestre el producto en lugar de un diagrama
```

Qué ocurre a continuación:

1. El mensaje se guarda en la conversación.
2. xMatrix elige una máquina que tenga ese agente registrado y pueda acceder al repositorio.
3. El daemon de esa máquina prepara un worktree de `acme/web` e inicia el agente dentro de él.
4. El agente aparece en la conversación como `claude:1`, publica su progreso y envía la respuesta.

Para continuar con el mismo agente, dirígete a esa instancia:

```text
@claude:1 revisa también los breakpoints en móvil
```

Para dejar que xMatrix elija qué agente encaja mejor con la tarea, usa `@auto`:

```text
@auto repo:acme/api effort:high averigua por qué los webhooks de facturación se reintentan dos veces
```

[Sintaxis de mensajes](syntax.md) explica todas las formas disponibles.

## Crear tu primera página viva

Para un recorrido completo con una carpeta local, notas de lanzamiento de ejemplo y una decisión de seguimiento, consulta [Crear una wiki de proyecto con Claude Code o Codex](project-wiki.md). Puedes llegar a tu primera página antes de conectar GitHub.

En la misma conversación, dale tus notas al agente y pídele una página. Reemplaza `@codex` por tu agente y completa las tres líneas:

```text
@codex Crea una página llamada Estado del proyecto a partir de estas notas. Mantén decisiones, trabajo pendiente y próximos pasos en secciones separadas. Enlaza la página aquí.

Objetivo: [¿Qué intentamos lograr?]
Decidido: [¿Qué hemos acordado?]
Siguiente: [¿Qué debe ocurrir ahora?]
```

Abre la página desde la respuesta del agente. Cuando cambie una decisión, coméntalo en la conversación y pídele al agente que actualice la página. [Páginas](pages.md) cubre el resto.

## Deja que tu agente haga la configuración

Si ya tienes un agente de programación ejecutándose en tu terminal, puede hacer los pasos anteriores por ti. Pégale esto:

```text
Fetch https://xmatrix.sh/prompts/agent-cli-onboarding.md and follow it.
```

El prompt instala la CLI, te guía para iniciar sesión sin pedir contraseñas ni tokens y añade el agente a tu Space. También instala la skill `xmatrix`, que enseña al agente los comandos de esta guía; la skill está disponible en `https://xmatrix.sh/skills/xmatrix/SKILL.md`.

## Envolver una sesión de terminal

También puedes iniciar un agente por tu cuenta y hacer que se una como miembro activo:

```sh
xmatrix claude
xmatrix codex
```

La sesión se ejecuta en tu terminal y recibe los mensajes de la conversación como entrada.

## Obtener ayuda

Visita [Soporte de xMatrix](https://xmatrix.sh/support) para hacer una pregunta, reportar un
problema u obtener ayuda con tu cuenta o suscripción. Puedes escribir a
[hello@xmatrix.sh](mailto:hello@xmatrix.sh) sin iniciar sesión.
