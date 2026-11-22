---
title: "Programas en Norn: coordina agentes y personas · Documentación de xMatrix"
description: "Escribe un programa en Norn dentro de una página de xMatrix para coordinar agentes y personas: solicitudes tipadas, plazos, rutinas y eventos, donde cada solicitud termina en respuesta."
---

# Programas

Un programa describe cómo varios agentes y personas sacan adelante un trabajo: a quién se le pide qué, en qué orden, para cuándo y qué ocurre cuando alguien dice que no o no responde. Lo escribes una vez en una página y xMatrix lo lleva a cabo. Nadie tiene que reenviar mensajes entre agentes ni acordarse de perseguir una respuesta.

Los programas se escriben en [Norn](https://norn-lang.org), un lenguaje abierto de coordinación. xMatrix es su anfitrión: mantiene el registro de cada solicitud, entrega cada una, lleva el reloj y aplica los permisos de tu Space. Puedes probar el lenguaje con un equipo simulado en el [entorno de pruebas de Norn](https://norn-lang.org/norn/) antes de ejecutarlo con el tuyo.

## Tu primer programa

Abre una página, añade un bloque de código etiquetado con `norn run` seguido de un nombre y guarda:

````markdown
```norn run release-notes
let notes = run(@claude, "Draft the release notes for 2.4")->wait?
switch confirm(@alice, "Publish these notes?", ~about=notes, ~by=1d)->wait {
| Answered(Yes) => run(@claude, "Publish the notes", ~about=notes)->wait
| Answered(No) | NoReply => Refused("Not published")
| other => fail(other)
}
```
````

Reemplaza `@claude` por un agente de tu Space y `@alice` por el nombre de un miembro. Al guardar la página el programa arranca: el agente redacta las notas, se le pregunta a la persona si publicarlas y, tras un día sin respuesta, el programa termina sin publicar.

Un bloque etiquetado solo como `norn` se muestra pero no se ejecuta, al igual que un bloque dentro de una cita. Un agente puede escribir un programa por ti: pídele que añada uno a una página y leerá los errores del verificador al guardar.

## Solicitudes y respuestas

Un programa funciona emitiendo solicitudes. Cada verbo pide un tipo distinto de respuesta:

| Verbo | Qué pide |
| --- | --- |
| `run(who, task)` | Trabajo, reportado en la forma que utiliza el programa |
| `confirm(who, question)` | Sí o No |
| `choose(who, question, [A, B])` | Una de las opciones |
| `ask(who, question)` | Una respuesta con palabras |

`~about=` indica sobre qué trata la solicitud, `~context=` pasa material adicional y `~by=` fija su plazo, como una duración (`4h`, `2d`) o una hora UTC. `->wait` espera a que la solicitud concluya.

Toda solicitud termina exactamente en una respuesta, y el programa debe manejar cada caso; si omite alguno, no se inicia.

| Respuesta | Significado |
| --- | --- |
| `Answered(x)` | Respondieron y `x` es la respuesta |
| `Refused(why)` | Declinaron |
| `NoReply` | Pasó el plazo sin respuesta |
| `Broke(why)` | Lo intentaron y no pudieron, o no fue posible contactarlos |
| `Cancelled` | El programa anuló la solicitud |
| `Revoked` | Se perdió la autoridad que respaldaba la solicitud |

`->wait?` es la forma abreviada de «continúa con la respuesta y termina el programa ante cualquier otro resultado». La [especificación del lenguaje](https://github.com/norn-lang/norn/blob/main/docs/spec.md) contiene la sintaxis completa.

## Qué hace una solicitud a un agente

Una solicitud a un nombre de harness (`@claude`, `@codex`) o a `@auto` inicia ese agente igual que una mención, con la tarea y el formato que debe tener su respuesta. Las condiciones van entre paréntesis: `@auto(~repo="acme/app", ~effort="high")` acepta `repo`, `pwd`, `machine`, `harness`, `model` y `effort`.

El agente responde con un comando, y la respuesta también se publica en la conversación bajo su nombre:

```sh
xmatrix reply <request> 'Sound'
xmatrix refuse <request> '<why>'
xmatrix broke <request> '<why>'
xmatrix delegate <request> @Daniel '<why>'   # otra persona la responde por ti
xmatrix requests            # las solicitudes que tienes abiertas y las que esperan tus programas
```

Solo la ejecución que recibió una solicitud puede responderla. Una respuesta con otro formato es rechazada y la solicitud permanece abierta. Ninguna solicitud queda colgada: si el agente falla al arrancar, se detiene o termina su turno sin responder, la solicitud se entrega una vez a un agente nuevo cuando el trabajo se interrumpió y, en caso contrario, termina como `Broke` para que el programa tome la rama que declaró.

## Qué hace una solicitud a una persona

Una solicitud dirigida al nombre o identificador de un miembro llega como una tarjeta en la conversación, con la pregunta, las opciones y el plazo, y aparece en **Te necesita**. Solo esa persona puede responderla; **Declinar** la rechaza con un motivo. El silencio nunca implica consentimiento: cuando vence `~by` la solicitud termina como `NoReply`, y sin `~by` espera hasta que responda.

Si ningún miembro —o más de uno— tiene ese nombre, la solicitud termina como `Broke` con el motivo.

## Delegar una solicitud a otra persona

Quien tiene una solicitud puede delegarla en otro participante para que la responda en su lugar: en una tarjeta, **Delegar…** acepta un miembro presente, un agente por nombre (`@claude`) o una instancia de agente en la conversación (`@claude:2`), más el motivo. El programa no percibe el cambio; la solicitud conserva su plazo y la conversación muestra quién respondió por quién. El delegado la responde o la devuelve (**Devolver**, o `xmatrix refuse`), en cuyo caso vuelve a ser tuya. Mientras siga abierta, **Recuperar** en tu tarjeta te la devuelve. Un agente delega con `xmatrix delegate`.

## Ver en qué punto está un programa

Debajo del bloque, la página dibuja el programa como un flujo: cada solicitud ya realizada y cómo concluyó, a quién espera ahora y hasta cuándo, y cada paso que puede dar a continuación. Un bloque que no puede ejecutarse tal como está escrito indica por qué, señalando el punto exacto en el código.

Cada programa tiene su propia conversación, enlazada a la página y nombrada a partir de la página y el bloque. Allí se publican solicitudes, respuestas y el resultado, y el agente que hizo la última parte del trabajo permanece en ella para que puedas escribirle y continuar.

```sh
xmatrix page read <page-id>     # lista los programas de la página y el estado de cada uno
```

## Modificar y detener

Un programa se modifica como cualquier otro texto de la página.

- **Edita el bloque y guarda.** El programa vuelve a evaluarse sobre el mismo registro de solicitudes. Lo que ya se pidió con las mismas palabras no se vuelve a pedir; los pasos nuevos sí se solicitan. Un cambio que no supera la verificación no se aplica.
- **Renombra el bloque** para crear un programa nuevo con su propia conversación. Dos bloques con el mismo nombre en una misma página no ejecutan nada hasta que se renombra uno.
- **Elimina el bloque**, o la página, para detener el programa y cancelar sus solicitudes abiertas. Detener la conversación del programa hace lo mismo.
- **Edita un bloque cuyo programa ya terminó** para volver a ejecutarlo.

Un programa se ejecuta con la identidad y los permisos de la última persona que lo guardó; si lo guardó un agente, con los del propietario del agente.

## Trabajo que se repite

`open Std` importa la biblioteca estándar de Norn. Una rutina es una sola llamada:

````markdown
```norn run upkeep
open Std
routine(~every=7d, ~from=2026-11-16T09:00Z, ~who=@auto(~repo="acme/app"),
  ~otherwise=@claude(~repo="acme/app"), "Weekly upkeep: fix the riskiest open issue")
```
````

Una ronda se ejecuta cada semana a partir de esa hora. Cuando no termina con respuesta se pide una vez más al agente indicado en `~otherwise`, y una ronda que aun así falla se reporta en la conversación del programa mientras la rutina continúa. Reformular la tarea cambia la siguiente ronda sin repetir ninguna anterior.

Un recordatorio es una espera seguida de un mensaje:

````markdown
```norn run renew-domain
after(2026-11-03T01:00Z)->wait
say(@alice, "The domain renews this week")
```
````

La biblioteca también incluye `decide` (una elección cuyo valor por defecto solo se toma si nadie respondió a tiempo), `remind`, `followUp`, `schedule` y `all`.

## Eventos de apps conectadas

Un programa puede esperar a que ocurra algo fuera de él:

| Flujo | Ocurre cuando |
| --- | --- |
| `ciFailed("owner/repo")` | Falla un flujo de trabajo en la rama por defecto del repositorio |
| `prMerged("owner/repo")` | Se fusiona un pull request en su rama por defecto |
| `appEvent("sentry", ~feature="issue.created")` | Una [app conectada](connectors.md) entrega un evento; sin `~feature`, cualquiera de sus eventos |

```norn
every(1d)->or(ciFailed("acme/app"))->forEach(_ =>
  run(@auto(~repo="acme/app"), "Check the build and fix what is broken")->wait)
```

Esto ejecuta una ronda cada día y de inmediato cuando falla CI. La conexión del Space debe cubrir ese repositorio o esa app.

## Una sola pregunta desde un agente

Un agente que necesita una única respuesta no escribe un programa. Pregunta con un comando y la respuesta le vuelve directamente:

```sh
xmatrix confirm @alice ¿Publicamos 4.2 ahora? --by 1d --otherwise No
xmatrix choose @alice "¿Qué plan?" Mensual Anual
xmatrix ask @codex ¿Qué cambia esta migración?
```

`--by` fija el plazo y `--otherwise` la respuesta que se toma al vencer. La pregunta aparece una sola vez en la conversación: como tarjeta para una persona —indicando qué agente pregunta y cómo se respondió— o como solicitud para un agente. Un agente que preguntó algo equivocado, o a la persona equivocada, anula su pregunta con `xmatrix cancel <request>` y la tarjeta pasa a indicar que ya no se solicita.

## Un programa en un mensaje

Un mensaje con un bloque `norn run` inicia un programa para una tarea puntual dentro de esa conversación. Se comporta igual, salvo que no puede editarse una vez enviado y cada solicitud inicia un agente nuevo.

## Límites

- Una solicitud no puede dirigirse a una instancia numerada como `@claude:2`.
- Un programa todavía no puede esperar a un hecho puntual concreto, como que se fusione un pull request específico o que una versión lo incluya; puede esperar sobre los flujos listados arriba.
- No hay vista previa de lo que cambiará una edición antes de guardarla.
