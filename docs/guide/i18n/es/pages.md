---
title: "Páginas vivas y programas que las mantienen al día · xMatrix"
description: "Mantén al día la documentación de tus proyectos con Páginas de xMatrix: Markdown que editan personas y agentes, y programas Norn por horario o evento."
---

# Páginas

Las conversaciones avanzan rápido y cuesta releerlas más adelante. Las páginas son el lugar donde un Space guarda lo que es vigente hoy: estado actual, decisiones en vigor y trabajo pendiente. Las personas conversan; los agentes actualizan las páginas a medida que su trabajo avanza.

## El árbol de páginas

Cada Space tiene un único árbol de páginas. Organízalo por los temas en los que trabaja el Space, no por quién dijo qué. Una página es un documento Markdown y sus encabezados son sus secciones. Su primer encabezado de nivel superior (`# Nombre`) es su nombre, esté donde esté; renombrar una página reescribe ese encabezado.

En la aplicación, abre **Páginas**. La lista empieza por los cambios recientes y luego muestra el árbol completo. Desde una terminal:

```sh
xmatrix page tree
xmatrix page tree --summaries
xmatrix page search <words>
xmatrix page read <page-id>
xmatrix page create "Facturación" --under <parent-page-id>
xmatrix page rename <page-id> "Facturación y facturas"
xmatrix page move <page-id> --under <other-page-id>
xmatrix page delete <page-id>
```

`page tree --summaries` añade, debajo de cada página, la línea que resume su estado actual. `page search` encuentra las páginas que contienen todas las palabras de la consulta, indica la sección que la responde como `page:<id>#<section>` y muestra el texto alrededor de la coincidencia; las páginas que contienen las palabras exactamente tal como se escribieron aparecen primero. Empieza por ahí en un Space grande en lugar de leer páginas enteras hasta dar con la correcta.

## Leer y editar

Las personas editan una página juntas desde la app, con cursores en vivo. Los agentes editan mediante la CLI y sus cambios aparecen en el documento abierto en cuanto llegan. Nada queda bloqueado: cada sección muestra quién está en ella y qué agentes trabajan en sus conversaciones, y `xmatrix page read` informa de lo mismo a los agentes.

Una edición desde la CLI sustituye el Markdown de la página por una nueva versión de la revisión que se leyó:

```sh
xmatrix page read <page-id>                       # imprime la página y su revisión
xmatrix page edit <page-id> --base <revision> -f page.md
```

`--base` es la revisión que leíste, no la más reciente. xMatrix fusiona tu edición con lo que otros hayan escrito mientras tanto. Si ambos cambios se solapan, la edición se rechaza y recibes el texto actual para fusionar sobre él.

No hace falta leer una página larga entera para modificar una sola parte:

```sh
xmatrix page read <page-id> --outline             # sus encabezados, cada uno con su slug y tamaño
xmatrix page read <page-id> --section <slug>      # una sección, incluidos sus subencabezados
xmatrix page edit <page-id> --base <revision> --section <slug> -f section.md
```

Una edición por sección reescribe únicamente esa sección y deja intacto el resto de la página, incluidos los cambios hechos por otros en otras partes desde que leíste. El texto que entregas es la sección con su línea de encabezado. Lo que imprime `page read --section` puede volver a enviarse con `-f` tal cual: su cabecera identifica la sección, así que nunca se confunde con la página entera. Para añadir, eliminar o reordenar secciones, lee y edita la página completa.

`xmatrix page read <page-id> --since <revision>` imprime solo lo que cambió después de una revisión, y `xmatrix page history <page-id>` lista las revisiones.

Para ver quién escribió un fragmento en la app, coloca el puntero sobre su párrafo: el margen muestra quién lo escribió y cuándo. Selecciona un fragmento y una nota sobre él muestra lo mismo junto con la conversación en la que se redactó; al hacer clic se abre esa conversación al lado de la página, en el mensaje al que había llegado cuando se escribió el texto. El texto que aún se está escribiendo y no se ha guardado indica «escribiendo».

### Qué corresponde poner en una página

Una página refleja lo que es vigente hoy. Reescríbela en el sitio y elimina lo que ya terminó o quedó superado; no vayas añadiendo un registro cronológico. Las pruebas como hashes de commit, ids de ejecución y marcas temporales permanecen en el pull request y en la conversación, y la página enlaza a ellos. Escribe cada dato una sola vez y enlázalo desde otros sitios.

## Páginas y conversaciones

Una página y una conversación quedan enlazadas cuando una hace referencia a la otra. Las páginas enlazadas aparecen en la parte superior de la conversación como tarjetas vivas, y cualquier agente iniciado allí las lee antes de comenzar.

- En un mensaje, escribe `[[` y elige una página, o `[[page#` y elige una sección. El mensaje guarda `page:<page-id>` o `page:<page-id>#<heading-slug>`.
- Que un agente lea una página durante una ejecución la enlaza con esa conversación.
- `xmatrix page link <page-id> --block <heading-slug>` enlaza una de forma explícita, y `xmatrix page linked` lista a qué está enlazada una conversación.
- Para que los cambios de una página dejen de llegar a una conversación, pasa el cursor sobre su tarjeta en la parte superior de la conversación y elige **Desenlazar de esta conversación**, o ejecuta `xmatrix page unlink <page-id>`. Seguirá desenlazada aunque un agente lea o edite la página desde allí, hasta que alguien vuelva a enlazarla.

El slug de un encabezado es el encabezado en minúsculas, con los espacios convertidos en guiones y sin signos de puntuación, como en GitHub: `## Open work` es `open-work`.

### Discusiones

Selecciona un fragmento de una página e inicia una discusión: una conversación anclada a ese fragmento. Cuando llegue a una conclusión, escribe el resultado en la página y resuelve la discusión.

## Programas

El trabajo que se repite, espera a una fecha o arranca cuando ocurre algo se escribe dentro de la página como un programa: un bloque de código etiquetado con `norn run` y un nombre, dentro de la sección que mantiene al día. Los programas se escriben en [Norn](https://norn-lang.org), y guardar la página los pone en marcha. Puedes leerlos y modificarlos como cualquier otro texto de la página.

Un agente que mantiene una sección actualizada cada 12 horas:

````markdown
## Open work

```norn run triage
open Std
routine(~every=12h, ~from=2026-11-16T09:00Z, ~who=@auto(~repo="acme/web"),
  ~otherwise=@claude(~repo="acme/web"),
  "Read the issues opened since the last run and update this section")
```
````

Un recordatorio en una fecha concreta:

````markdown
```norn run renew-domain
after(2026-11-03T01:00Z)->wait
say(@alice, "Renew the domain this week")
```
````

Una ronda cada día y de inmediato cuando falla CI:

````markdown
```norn run build-watch
open Std
routine(~every=1d, ~from=2026-11-16T09:00Z, ~on=ciFailed("acme/web"),
  ~who=@auto(~repo="acme/web"), ~otherwise=@claude(~repo="acme/web"),
  "Check the build and fix what is broken")
```
````

Las horas están en UTC. `~from` indica cuándo se ejecuta la primera ronda y marca el ritmo de las siguientes, `~who` realiza el trabajo y `~otherwise` nombra a quién se vuelve a pedir la tarea si una ronda no termina con respuesta. `~on` añade una ronda cuando ocurre un evento, como `ciFailed("owner/repo")` o `prMerged("owner/repo")`. Un programa también puede preguntar a personas, esperar su respuesta con un plazo límite y pasar trabajo entre varios agentes. [Programas](programs.md) cubre el lenguaje, las solicitudes, los eventos y los límites.

### Cómo se ejecuta un programa

- Cada bloque tiene su propia conversación, enlazada a la página. Allí se publican sus solicitudes, respuestas y resultados.
- Debajo del bloque, la página muestra en qué punto está el programa: qué ha pedido y cómo terminó, a quién espera ahora y qué hará después. Un bloque que no puede ejecutarse tal como está escrito indica el motivo, y `xmatrix page edit` lo imprime.
- Un programa se ejecuta con la identidad y los permisos de la última persona que lo guardó; si lo guardó un agente, con los del propietario del agente.
- Edita el bloque para cambiar el programa; lo que ya se preguntó no se vuelve a preguntar. Elimina el bloque para detenerlo.

```sh
xmatrix page read <page-id>     # lista los programas de la página y el estado de cada uno
```

## Páginas públicas

Un propietario o administrador del Space puede publicar una página. Cualquier persona podrá leerla en su dirección pública sin iniciar sesión, y se actualizará en vivo mientras lee conforme los agentes la editen.

Solo puede publicarse una página que todos los miembros del Space puedan leer. Publicar una página no publica sus páginas hijas. Los agentes pueden editar una página pública, pero solo una persona puede publicarla o despublicarla.
