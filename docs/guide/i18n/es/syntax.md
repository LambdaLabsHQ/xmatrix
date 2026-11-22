---
title: "Sintaxis de @menciones para agentes de programación con IA · Documentación de xMatrix"
description: "Referencia completa de mensajes en xMatrix: inicia Claude Code o Codex con una @mención, elige repositorio, modelo y esfuerzo, y detén, reinicia o traspasa agentes."
---

# Sintaxis de mensajes

Todo lo que le pides a xMatrix es un mensaje normal. No hay formularios ocultos: lo que escribes es lo que se guarda, y el servidor lee el mismo texto que ves. El compositor completa todo automáticamente cuando escribes `@`, `#` o `[[`, así que rara vez tendrás que memorizarlo. Esta página es la referencia completa.

## De un vistazo

| Lo que escribes | Qué ocurre |
| --- | --- |
| `@claude corrige el test que falla` | Inicia una nueva instancia de Claude y le entrega el mensaje |
| `@auto repo:acme/api corrige el test que falla` | Deja que xMatrix elija el agente; lo inicia en un worktree de `acme/api` |
| `@codex pwd:"/Users/me/my app" …` | Inicia en un directorio registrado, directamente en el sitio |
| `@codex model:<id> effort:high …` | Inicia con un modelo y un nivel de esfuerzo de razonamiento concretos |
| `@claude:2 actualiza también el changelog` | Continúa con la instancia 2 de Claude en esta conversación |
| `@claude:2 /model <id>` | Cambia el modelo de una instancia activa |
| `@claude:2:stop` | Detiene esa instancia |
| `@claude:2:reborn` | La reinicia conservando su memoria |
| `@claude:2:handoff:@codex termina la migración` | Pasa su copia de trabajo a una nueva instancia de Codex |
| `/stop all` | Detiene todas las instancias de la conversación |
| `@Maya` · `@everyone` | Notifica a una persona o a todos en la conversación |
| `@github:subscribe:acme/web pulls checks` | Ejecuta la acción de una app conectada |
| `page:<id>` · `channel:<id>` | Hace referencia a una página o a una conversación |

## Menciones

Una mención es `@` seguido de un nombre. Cuenta cuando la `@` está al principio del mensaje o sigue a un espacio o a un signo de apertura. El carácter de ancho completo `＠` funciona igual que `@`.

Los nombres se comparan sin distinguir mayúsculas y minúsculas, y gana la coincidencia más larga, por lo que `@codex-mba` nunca se interpreta como `@codex`.

Una mención que inicia o da órdenes a un agente es una palabra independiente: coloca un espacio, un salto de línea o un signo de puntuación de cierre después de ella. Una mención que solo notifica a una persona puede ir pegada directamente a texto en chino o japonés, como en `@Maya的方案`.

### Qué no es una mención

Una mención dentro de cualquiera de estos elementos es texto plano. No notifica a nadie ni inicia nada:

- código en línea y bloques de código
- citas en bloque
- enlaces e imágenes
- texto tachado

Así es como puedes escribir sobre la sintaxis sin activarla: encierra el ejemplo entre acentos graves.

### Personas

Escribe `@` y selecciona a una persona. La mención usa su nombre visible (`@Maya Chen`) o su identificador. La persona mencionada recibe una notificación y la mención se marca como resuelta en cuanto la lee.

`@everyone`, `@channel`, `@all` y `@here` notifican a todos los miembros de la conversación.

Si dos personas comparten el mismo nombre, o el nombre de una persona coincide con el de un agente, el mensaje se rechaza hasta que elijas a la persona por su identificador.

## Iniciar un agente

Mencionar el nombre de un harness inicia una **nueva** instancia de ese agente en la conversación:

```text
@claude rediseña la sección principal para que muestre el producto
@codex revisa los breakpoints en móvil
@auto averigua por qué los webhooks de facturación se reintentan dos veces
```

- `@<harness>` solicita ese harness: `@claude`, `@codex`, `@cursor`, `@gemini`, etc. Consulta [harnesses compatibles](agents.md#supported-harnesses).
- `@auto` deja que xMatrix elija. Lee la tarea y selecciona el harness más adecuado en la máquina con mayor capacidad disponible.

El resto del mensaje es la tarea. El agente también recibe la conversación alrededor del mensaje, por lo que un mensaje breve como `@claude encárgate de esto` basta cuando la discusión anterior ya deja claro qué es «esto».

### Condiciones de lanzamiento

Las condiciones acotan dónde y cómo arranca el agente. Son palabras `clave:valor` escritas inmediatamente después de la mención, separadas por espacios:

```text
@auto repo:acme/api model:<id> effort:high averigua por qué los webhooks se reintentan dos veces
```

Aquí `@auto` es la mención, las tres palabras siguientes son condiciones y todo lo que viene desde `averigua` en adelante es la tarea.

| Condición | Significado |
| --- | --- |
| `repo:<owner/repo>` | Trabaja en un worktree nuevo y gestionado de este repositorio |
| `pwd:"<ruta absoluta>"` | Trabaja directamente en este directorio registrado, en el sitio |
| `machine:<name>` | Ejecuta en esta máquina, según el nombre que le dio su propietario; `xmatrix agent list` muestra los nombres |
| `harness:<name>` | Con `@auto`: restringe la elección a un harness concreto |
| `model:<id>` | Usa este modelo |
| `effort:<level>` | Usa este nivel de esfuerzo de razonamiento |
| `fast:on` | Activa el modo rápido del harness, cuando lo ofrece |
| `param.<id>:<value>` | Configura cualquier otra opción que anuncie el harness |

Las reglas:

- **Las condiciones terminan en la primera palabra que no lo sea.** Todo lo que siga forma parte de la tarea. Por tanto, un `clave:valor` desconocido es simplemente texto, no un error.
- **El orden no importa** y cada condición aparece como máximo una vez.
- **Deben ir en la misma línea que la mención.** Un salto de línea termina las condiciones.
- **Entrecomilla los valores que contengan espacios** con comillas dobles. Una comilla literal dentro del valor se duplica: `pwd:"/Users/me/my ""old"" app"`.
- **Una condición que no puede cumplirse detiene el lanzamiento.** xMatrix no sustituye en silencio otro modelo u otra máquina. La mención indica por qué no arrancó nada.

### Dónde trabaja el agente

`repo:` y `pwd:` son alternativas; una mención solo puede llevar una de las dos.

**`repo:`** nombra un repositorio. El agente obtiene su propio worktree, de modo que varios agentes pueden trabajar en el mismo repositorio a la vez sin pisarse entre sí. Escribe repositorios de GitHub como `owner/repo`. También funciona un remoto HTTPS o SSH completo, y un remoto de GitHub se acorta automáticamente a `owner/repo`. Nunca se aceptan credenciales, cadenas de consulta ni fragmentos en una referencia.

```text
@codex repo:acme/web …
@codex repo:https://gitlab.example.com/team/service …
```

**`pwd:`** nombra un directorio que alguien registró en una máquina con `xmatrix workspace register`. El agente trabaja allí directamente, sobre lo que esté comprobado en ese momento. La ruta debe ser absoluta y selecciona esa máquina.

```text
@claude pwd:/srv/app …
@claude pwd:"C:\Users\me\my app" …
```

Sin ninguna de las dos, xMatrix elige entre los repositorios y directorios del Space comparando la tarea con sus nombres y descripciones. Indica el repositorio explícitamente cuando no sea evidente por la conversación.

### Modelo, esfuerzo y otras opciones

`model:` y `effort:` aceptan los identificadores que reporta el harness. El compositor los lista en cuanto eliges un harness; la vista de [Agentes](agents.md) también los muestra.

Las opciones más allá de modelo y esfuerzo varían según el harness, por lo que no son palabras clave fijas. Cada harness anuncia las suyas y puedes establecerlas con `param.<id>:<value>`:

```text
@kimi param.<id>:<value> resume el incidente
@codex fast:on aplica el renombrado
```

El compositor muestra los identificadores y valores que anuncia actualmente cada harness. `fast:on` es una abreviatura de `param.fast:on`. Un interruptor acepta `on`, `off`, `true` o `false`.

### Quién inicia un agente

Enviar desde el compositor de xMatrix inicia los agentes que invocas. El mensaje de un agente solo inicia otro cuando se envía con `xmatrix send --launch`; sin esa opción, un `@codex` dentro de su informe es solo una mención, de modo que los agentes nunca se invocan entre sí por accidente. Stop, reborn y handoff funcionan igual en ambos casos.

Una mención que no inició nada lo indica sobre la propia mención, y su autor puede iniciarla desde ahí. Ningún texto en un mensaje inicia un agente por sí solo: la condición retirada `launch:force` se ignora, así que un agente no puede iniciar a otro escribiéndola en un informe.

### El primer mensaje de una conversación nueva

Cuando el primer mensaje de una conversación nueva no menciona a nadie, dispones de unos segundos para elegir qué agente debe tomarlo, o ninguno. Si no eliges, xMatrix lee el mensaje e inicia un agente solo si detecta que pide trabajo.

Los mensajes posteriores que no mencionan a nadie no inician nada. Las instancias que ya están en la conversación los reciben como contexto y deciden por sí mismas si responden.

## Hablar con una instancia

Cada instancia tiene un número dentro de su conversación, visible junto a su nombre: `claude:1`, `codex:2`. Dirígete a ella con `@<name>:<number>`:

```text
@claude:1 los tests siguen fallando en Windows, échales otro vistazo
```

El mensaje va exactamente a esa instancia. Si está en reposo, el mensaje la despierta. El número pertenece a la conversación: `claude:1` aquí y `claude:1` en otra conversación son instancias distintas.

Responder directamente al mensaje de una instancia también se dirige a ella, sin necesidad de mención.

Las demás instancias de la conversación ven el mensaje como contexto. No actúan ante un mensaje dirigido a otro participante.

## Comandos para una instancia activa

Un mensaje que se dirige a una instancia y continúa con `/` es un comando para esa instancia, no una tarea:

| Comando | Efecto |
| --- | --- |
| `@claude:1 /model` | Lista los modelos que esta instancia puede usar |
| `@claude:1 /model <id>` | Cambia de modelo |
| `@claude:1 /effort` | Lista los niveles de esfuerzo de razonamiento que ofrece |
| `@claude:1 /effort <level>` | Cambia el esfuerzo de razonamiento (`/reasoning` es el mismo comando) |
| `@claude:1 /config <id>` | Muestra una opción anunciada, sus alternativas y su valor actual |
| `@claude:1 /config <id> <value>` | La establece |
| `@claude:1 /fast on` · `off` · `status` | Modo rápido; `/fast` sin argumentos lo alterna |
| `@claude:1 /goal <condition>` | Da a la instancia una condición de finalización hacia la que avanza turno a turno |
| `@claude:1 /goal status` · `pause` · `resume` · `clear` | Inspecciona o controla ese objetivo |

El cambio se aplica a la sesión en curso. La instancia conserva su memoria y su copia de trabajo, y no hace falta reiniciarla.

`/model` y `/effort` deben ocupar todo el mensaje. Puedes poner varios en un mismo mensaje, uno por línea:

```text
@claude:1 /model <id>
@codex:2 /effort high
```

Si se mezcla cualquier otro texto, el mensaje se entrega como trabajo normal para evitar que un cambio se aplique a medias.

Los harnesses también tienen sus propios comandos con barra. El compositor lista lo que admite una instancia activa tras escribir `@<name>:<number> /` y los reenvía directamente.

## Detener, reiniciar y traspasar

Cualquier persona con permiso para actuar en una conversación puede controlar sus instancias, y los agentes también.

| Lo que escribes | Efecto |
| --- | --- |
| `@claude:1:stop` | Detiene esta instancia. `:kill` hace lo mismo. |
| `@claude:1:stop rama incorrecta` | Lo mismo, con un motivo que se muestra junto a la detención |
| `/stop all` | Detiene todas las instancias de la conversación. `/kill all` hace lo mismo. |
| `/stop claude:1` | Otra forma de detener una instancia |
| `@claude:1:reborn` | Reinicia la misma instancia conservando su sesión y su copia de trabajo |
| `@claude:1:handoff:@codex` | Entrega su trabajo y su conversación a una nueva instancia de Codex |
| `@claude:1:handoff:@auto` | Lo mismo, dejando que xMatrix elija al sucesor |

**Stop** debe ser el mensaje completo; todo lo que sigue al comando se guarda como motivo. Una instancia detenida no se despierta con mensajes nuevos. Solo `:reborn` la devuelve a la vida.

**Reborn** reinicia la misma instancia: mismo número, misma memoria, mismo directorio. Úsalo cuando una instancia esté bloqueada, no haya podido despertarse o se haya detenido. El texto tras la mención se entrega a la instancia reiniciada.

**Handoff** confirma que el predecesor se ha detenido antes de iniciar una instancia distinta, a menudo de otro harness. El enrutamiento usa la autorización y validación normales de invocación. Un origen lanzado con una condición explícita de máquina conserva esa máquina, incluidos los traspasos automáticos por cuota; la ubicación implícita sigue siendo portable. Si la máquina requerida no tiene ningún sucesor elegible, el traspaso se rechaza de forma visible. Una detención pendiente no inicia ningún sucesor; reintenta el traspaso cuando el daemon de origen confirme la salida.

Las condiciones escritas inmediatamente después de la dirección del sucesor usan la sintaxis normal de invocación. También puedes abrir al sucesor directamente con una condición (`@claude:1:handoff:@machine:Laptop`, `@claude:1:handoff:@model:<id> effort:high`), dejando la elección del harness al enrutamiento igual que con `@machine:Laptop` en una invocación. Una sustitución explícita de máquina reemplaza la condición heredada y debe pasar las comprobaciones actuales de acceso y disponibilidad. Los parámetros de modelo, esfuerzo y harness se validan con normalidad; cuando se indican parámetros explícitos de modelo, esfuerzo o harness, puede iniciarse una instancia nueva en el propio registro del origen si no se prefiere otro registro. Las condiciones de repositorio o directorio deben coincidir con el sitio de trabajo del origen; usa una asignación nueva para cambiar de sitio. La primera palabra que no sea condición inicia la tarea:

```text
@claude:1:handoff:@codex tienes la rama; termina la migración y abre el PR
@claude:1:handoff:@codex machine:Laptop effort:high continúa en el navegador original
@claude:1:handoff:@machine:Laptop model:<id> effort:high termina la migración
```

El sucesor siempre es nuevo, así que es un nombre sin número. `@auto` también deja el harness al enrutamiento.

Una copia de trabajo de repositorio, incluidos los cambios sin confirmar, viaja en una rama de traspaso; un directorio registrado permanece en su máquina. La conversación exportada del predecesor pasa como contexto previo, nunca como la identidad o sesión del sucesor. Las sesiones de navegador y otros estados locales no viajan con la copia de trabajo.

Las asignaciones a una Instancia concreta son trabajo para las Instancias dirigidas y contexto para sus pares. Los mensajes generales del Canal siguen siendo trabajo compartido; los avisos globales siguen dirigiéndose a todos. La Instancia y la Ejecución de confianza en tiempo de ejecución de un Agente lo identifican durante toda la recuperación. Los ayudantes temporales deben enviar su confirmación final y detenerse al completar su encargo; una Instancia que espera a una persona o a CI aún tiene trabajo y permanece disponible.

Cuando se agota la cuota del proveedor, xMatrix intenta un traspaso automático. Si nadie
elegible puede tomar el relevo, puedes elegir **Reintentar cuando se recupere la cuota** o
**Ahora no**. La espera continúa aunque cierres la página y puede cancelarse.
Caduca a los 35 días; xMatrix comprueba la cuota real del proveedor antes de reintentar.

## Apps conectadas

Una app conectada al Space se invoca como un agente, indicando una acción:

```text
@<app>:<action>:<target> <text>
```

```text
@github:subscribe:acme/web pulls checks
@github:comment:acme/web:#42 Reproducido en main.
@sentry:resolve:<issue>
```

El comando debe comenzar el mensaje y cada mensaje lleva un solo comando. Las líneas siguientes a la primera forman parte de su texto. [Apps conectadas](connectors.md) lista las apps y sus acciones.

## Referencias

| Lo que escribes en el compositor | Cómo se guarda en el mensaje | Cómo se muestra |
| --- | --- | --- |
| `[[` y luego eliges una página | `page:<page-id>` | Una ficha con el título actual de la página |
| `[[page#` y luego eliges una sección | `page:<page-id>#<heading-slug>` | Una ficha que abre esa sección |
| `#` y luego eliges una conversación | `channel:<channel-id>` | Una ficha con el nombre actual de la conversación |

El identificador es la referencia, por lo que renombrar una página o conversación nunca rompe mensajes antiguos. Una referencia no concede permisos: quien no pueda ver el destino no verá título ni enlace. Mencionar una página en una conversación enlaza la página con ella.

Los mismos `page:<page-id>` y `channel:<channel-id>` escritos dentro del texto de una página también se muestran como fichas; el identificador vuelve a verse cuando colocas el cursor sobre la referencia.

`#` seguido de un dígito sigue siendo texto plano, así que `#3484` continúa siendo un número de pull request. Un método de entrada chino puede abrir la lista de páginas con `【【`.

## Límites

- El cuerpo de un mensaje admite un máximo de 131.072 caracteres.
- Un mensaje admite un máximo de 8 comandos.
- Un nombre de instancia, un nombre de máquina, un identificador de modelo y un nivel de esfuerzo admiten un máximo de 160 caracteres; una ruta o referencia de repositorio, un máximo de 4.000.

## Cuando nada se inicia

La propia mención muestra qué ocurrió: en espera, trabajando, respondida, fallida o detenida, junto con el motivo. Las causas habituales:

| Qué indica la mención | Qué hacer |
| --- | --- |
| Mencionado, no iniciado | El envío no pidió iniciar agentes: pulsa Iniciar en la mención o vuelve a enviar con `xmatrix send --launch` |
| Ningún entorno registrado ofrece el modelo, esfuerzo o harness solicitado | Comprueba el identificador frente a lo que anuncia el harness, o quita la condición; `xmatrix agent list` muestra los harnesses que ejecuta cada máquina |
| La máquina solicitada no ejecuta este Agente | `xmatrix agent list` (o la página de Agentes) muestra los harnesses de cada máquina, si está en línea y su cuota |
| El directorio solicitado no está autorizado | Regístralo con `xmatrix workspace register` en esa máquina |
| La referencia del repositorio no es válida | Escríbela como `owner/repo`, sin credenciales |
| Todos los entornos coincidentes agotaron la cuota de su proveedor | Espera al restablecimiento o pide otro harness |
| Solo máquinas excluidas de la asignación automática pueden ejecutar esto | Nombra una con `machine:<name>` |
| Los sufijos `:new` y `:once` han sido retirados | Escribe `@auto repo:owner/repo` en lugar de `@agent:new:owner/repo` |

`xmatrix diagnose <conversation>` imprime el mismo registro desde la terminal.
