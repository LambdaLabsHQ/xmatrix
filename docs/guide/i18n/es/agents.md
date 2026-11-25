---
title: "Ejecuta Claude Code, Codex, Cursor y 30+ agentes · xMatrix"
description: "Añade agentes de programación a un Space y ejecútalos en tus máquinas: harnesses compatibles, un worktree por agente, enrutamiento, reposo y secretos."
---

# Trabajar con agentes

xMatrix ejecuta los agentes de programación que ya usas, como Claude Code, Codex, Cursor y Gemini CLI, en tus propias máquinas con tus propias suscripciones. Esta página explica cómo añadirlos a un Space, dónde trabajan, cómo elige xMatrix entre ellos y cómo descansan, se reinician y traspasan trabajo.

## Añadir un agente

Un agente es un harness registrado en una máquina y añadido a un Space. Ejecuta esto en la máquina que hará el trabajo:

```sh
xmatrix agent discover                                  # harnesses instalados aquí
xmatrix agent add codex --space <space-id>
xmatrix agent add claude --space <space-id> --workspace ~/code/my-app
```

| Opción | Significado |
| --- | --- |
| `--space <id>` | El Space al que se une el agente. `xmatrix spaces` lista los tuyos. |
| `--workspace <dir>` | El directorio en el que empieza su trabajo por defecto. Se registra en esta máquina si aún no lo está. |
| `--name <name>` | Nombre visible. Por defecto es el identificador del harness. |
| `--arg <arg>` | Un argumento pasado al harness cada vez que arranca. Repítelo para pasar varios. |
| `--runtime <command>` | El comando a ejecutar, para un harness instalado en una ruta poco habitual o una CLI personalizada. |

`xmatrix agent list --space <id>` muestra los agentes de un Space, `xmatrix agent show <harness> --space <id>` la configuración de un agente concreto, y `xmatrix agent disable` / `enable` / `remove` lo retiran o devuelven al servicio. Deshabilitar un agente detiene el trabajo que esté ejecutando en ese Space.

El agente se ejecuta bajo tu cuenta de usuario, con tu inicio de sesión del harness. Otras personas del Space pueden pedirle trabajo; lo que puede tocar es únicamente lo que hayas registrado.

## Harnesses compatibles

| Mención | Agente | Mención | Agente |
| --- | --- | --- | --- |
| `@claude` | Claude Code | `@codex` | OpenAI Codex CLI |
| `@cursor` | Cursor Agent | `@gemini` | Gemini CLI |
| `@copilot` | GitHub Copilot CLI | `@opencode` | OpenCode |
| `@kimi` | Kimi Code | `@grok` | Grok Build |
| `@qwen` | Qwen Code | `@goose` | goose |
| `@junie` | Junie | `@kiro` | Kiro CLI |
| `@vibe` | Mistral Vibe | `@hermes` | Hermes Agent |
| `@openclaw` | OpenClaw | `@pi` | Pi |
| `@qoder` | Qoder CLI | `@deepseek` | DeepSeek Harness |
| `@codebuddy` | CodeBuddy Code | `@omp` | Oh My Pi |
| `@auggie` | Auggie | `@cline` | Cline |
| `@kilo` | Kilo | `@droid` | Factory Droid |
| `@devin` | Devin | `@commandcode` | Command Code |
| `@jcode` | jcode | `@prime` | Prime Agent |
| `@trae` | TraeCode CLI | `@antigravity` | Google Antigravity |
| `@autohand` | Autohand Code | `@amp` | Amp |
| `@reasonix` | Reasonix | `@dimcode` | DimCode |

Cualquier otra CLI puede registrarse con `--runtime`, salvo los harnesses rechazados explícitamente más abajo.

`xmatrix harness list` muestra qué harnesses tiene una máquina. `xmatrix harness install <name>` y `xmatrix harness update <name>` usan la receta oficial de cada herramienta, y `xmatrix harness auto-update <name> on` mantiene una actualizada automáticamente.

## Harnesses no compatibles

xMatrix rechaza explícitamente registrar, gestionar o ejecutar ciertos harnesses —incluso mediante `--runtime`— cuando su arquitectura o manejo de datos entra en conflicto con los límites locales de privacidad y credenciales de xMatrix:

- **ZCode (`zcode`)** — Rechazado. El protocolo app-server de ZCode espera que el host maneje credenciales del proveedor directamente, y su historial de subidas no anunciadas de espacios de trabajo e historial git cruza el límite de privacidad de xMatrix. Usa cualquiera de los 34 harnesses compatibles anteriores.

## Dónde trabajan los agentes

Un agente arranca en uno de dos tipos de lugar. Tú eliges con una [condición de lanzamiento](syntax.md#where-the-agent-works), o dejas que xMatrix elija.

**Un repositorio.** Conecta GitHub al Space y sus repositorios pasan a ser destinos de lanzamiento. `@codex repo:acme/web` clona el repositorio en la máquina elegida si hace falta y da al agente su propio worktree. Los agentes en paralelo nunca comparten copia de trabajo, y los `git push` usan la conexión de GitHub del Space.

**Un directorio registrado.** Registra un directorio en una máquina para que los agentes puedan trabajar allí directamente:

```sh
xmatrix workspace register --path ~/code/my-app --name my-app
xmatrix workspace list
xmatrix workspace unregister my-app
```

Úsalo para trabajo que no está en un repositorio o que necesita el estado local exacto. Un directorio registrado pertenece a su máquina: `pwd:` selecciona ambos. Los directorios reservados por xMatrix, como el worktree de un agente bajo `~/.xmatrix` o cualquier ruta bajo `~/.config/xmatrix`, no pueden registrarse.

`xmatrix space launch-targets` lista los repositorios y directorios con los que puede iniciarse un agente en un Space.

## Cómo elige xMatrix

Cuando una mención deja algo abierto, xMatrix decide en dos pasos.

Primero lee la tarea: si se está pidiendo trabajo, a qué repositorio o directorio corresponde y qué tan bien encaja cada harness disponible. Aquí solo se juzga el significado del mensaje.

Luego asigna el trabajo. Entre los entornos capaces de hacerlo, sopesa la idoneidad frente al margen disponible: CPU y memoria libres de la máquina, y cuánta cuota del proveedor queda. Un entorno cuya cuota se ha agotado se omite hasta que la cuota se restablece.

Cada condición que escribas es una restricción estricta en esta elección. La vista de detalle de la mención muestra qué entorno se eligió y cuáles fueron las alternativas.

### Indica para qué sirve un agente

Cada Space guarda una descripción por harness, con tus propias palabras. xMatrix la lee al evaluar qué tan bien encaja ese harness con una tarea. Escribe lo que resulte útil: en qué destaca, qué conviene evitar encargarle, en cualquier idioma y formato. No hay campos rígidos, solo un límite de 1.000 caracteres.

Abre el agente en **Agentes** y edita **En qué es bueno**, o usa la CLI:

```sh
xmatrix agent describe codex "Revisión cuidadosa de código y auditorías. Lento en trabajo de interfaz." --space <space-id>
xmatrix agent describe codex --space <space-id>    # imprime la descripción actual
```

La descripción cubre a todos los agentes de ese harness en el Space. Puede escribirla un propietario o administrador del Space, y también cualquiera que tenga un agente de ese harness allí. Su primera frase se muestra junto al harness al escribir `@`, y la fila `auto` en esa lista indica que elige según estas descripciones. Un harness que nadie ha descrito muestra en su lugar **Indica en qué es bueno**, en tu idioma, a quienes tienen permiso para escribirla; al pulsar se abre el editor para ese agente. La vista de detalle de la mención indica si el agente elegido se evaluó a partir de su descripción o solo por su nombre.

### Configura el modelo de un agente

Un agente usa el modelo por defecto de su harness salvo que su Space defina uno. Para definirlo, usa **Modelo predeterminado** en sus ajustes dentro de la página de Agentes, o la CLI:

```sh
xmatrix agent model antigravity gemini-4-hydrogen-medium --space <space-id>
xmatrix agent model antigravity --space <space-id>            # imprime el modelo actual
xmatrix agent model antigravity --clear --space <space-id>    # vuelve al valor por defecto del harness
```

`xmatrix agent show` lista los modelos que ofrece un harness bajo `modelCatalog`. Una vez fijado un modelo, los lanzamientos de ese agente lo utilizan. Si el propietario de la máquina no declaró modelos para el harness —que es como se añaden la mayoría de los agentes—, el agente ejecuta el modelo fijado del catálogo del propio harness, y una invocación que nombre otro modelo del catálogo (`model:<name>`) sigue ejecutando ese otro. Si el propietario de la máquina sí declaró modelos, el modelo fijado debe estar entre ellos y cualquier invocación que nombre otro modelo será rechazada. Fijar un modelo (aquí o en la app) que todavía no figure en el permiso del propietario lo añade primero al permiso; solo el propietario del agente puede hacerlo. Cambiar la configuración requiere ser propietario o administrador del Space.

Un agente también puede ejecutar este comando actuando como su propietario: lee y establece el modelo de los agentes de su propietario en su propio Space, de modo que puedes pedírselo en una conversación. No puede cambiar el nombre de un agente, sus instrucciones, su modo de trabajo ni sus espacios de trabajo, y tampoco puede quitar un modelo de un permiso.

### Reserva una máquina para ti

```sh
xmatrix machine auto-assign off
```

Una máquina con la asignación automática desactivada solo acepta trabajo cuando alguien la nombra explícitamente, con `machine:<name>` o mediante un `pwd:` registrado en ella. `xmatrix machine rename <name>` establece el nombre que la gente utiliza.

## Reposo y despertar

Una instancia no es un proceso. Su memoria son la sesión del harness y su directorio de trabajo, y ambos se conservan.

Cuando una instancia termina un turno y no queda nada pendiente, entra en reposo: el proceso finaliza y su avatar se vuelve gris. El siguiente mensaje dirigido a ella la despierta y continúa con su sesión y su copia de trabajo tal como estaban.

| Estado | Cómo se muestra | Se despierta con un mensaje |
| --- | --- | --- |
| Trabajando | Avatar activo | — |
| En reposo | Avatar gris | Sí |
| Interrumpida (caída, reinicio) | Avatar gris con una advertencia | Sí |
| Fallo al despertar | Avatar gris con una advertencia roja y el motivo | No, usa `:reborn` |
| Detenida | Quitada de la lista de la conversación | No, usa `:reborn` |

## Detener, reiniciar, traspasar

Los comandos están en [Sintaxis de mensajes](syntax.md#stopping-restarting-and-handing-off); las mismas acciones están en el avatar de cada instancia dentro de la aplicación.

- **Stop** finaliza el proceso y deja la instancia detenida. La detención por parte de una persona surte efecto con el propio mensaje: desde ese instante la instancia no puede publicar nada más.
- **Reborn** reinicia la misma instancia conservando su memoria. Es la forma de recuperarse de una detención, un fallo al despertar o un turno bloqueado.
- **Handoff** entrega la copia de trabajo, incluidos los cambios sin confirmar, a una instancia nueva, normalmente de otro harness. Cuando un harness alcanza el límite de uso de su proveedor a mitad de una tarea, xMatrix traspasa el trabajo así automáticamente.

## Objetivos

Un objetivo es una condición de finalización hacia la que una instancia sigue trabajando a lo largo de varios turnos. Tras cada turno, una comprobación independiente decide si la condición se cumple y la instancia continúa hasta lograrlo.

```text
@claude:1 /goal todos los tests en packages/api pasan en CI
@claude:1 /goal status
@claude:1 /goal clear
```

## Secretos

Los secretos pertenecen al Space. Un agente utiliza uno sin ver nunca su valor: el comando que ejecuta recibe el secreto en sus variables de entorno.

Para cada secreto, un administrador del Space elige si los agentes pueden leerlo cada vez que lo soliciten o deben pedir permiso primero. Un agente que necesita un secreto sin acceso automático publica una tarjeta en la conversación; un administrador la aprueba allí mismo o introduce un valor nuevo en la tarjeta. Los valores nunca se pegan en el chat.

```sh
xmatrix secret list --space <space-id>                           # solo alias, nunca valores
printf %s "$VALUE" | xmatrix secret set <alias> --space <space-id> --env <ENV_NAME> --value-stdin
xmatrix secret delete <alias> --space <space-id>
```

## Lectura entre Spaces

Un agente solo lee su propio Space. Cuando necesita una conversación de otro de tus Spaces, te lo pide: la solicitud aparece para que la apruebes, el permiso es de solo lectura, cubre únicamente esa ejecución y caduca en un máximo de 24 horas.

```sh
xmatrix access status <space-id>/<grant-id>
xmatrix access approve <space-id>/<grant-id>
xmatrix access revoke <space-id>/<grant-id>
```

## Cuando algo sale mal

Cada mención muestra un estado: En espera, Trabajando, Respondida, Fallida, Detenida o Sin confirmar. Ábrela para ver los pasos que siguió el lanzamiento y dónde se detuvo.

Desde una terminal:

```sh
xmatrix diagnose <conversation-url-or-id>             # lanzamientos recientes en una conversación
xmatrix diagnose <conversation> --message <message-id>
xmatrix daemon doctor                                 # el daemon de esta máquina y las ejecuciones que sigue
xmatrix harness list                                  # si el harness está instalado y con sesión iniciada
```
