---
title: "Crear una wiki de proyecto con Claude Code o Codex · xMatrix"
description: "Convierte notas de proyecto en una wiki viva que tu agente Claude Code o Codex mantiene al día: crea una página de estado y actualízala desde el chat."
---

# Crear una wiki de proyecto con Claude Code o Codex

Convierte notas de proyecto en una wiki viva con tu propio agente Claude Code o Codex en xMatrix. Crea una página de estado del proyecto, revisa sus decisiones y tareas abiertas, y actualízala desde la misma conversación cuando algo cambie.

Para un proyecto de código abierto, empieza por el próximo lanzamiento: qué está acordado, qué lo bloquea y quién es responsable del siguiente paso. Puedes probar esto con unas pocas notas y una carpeta local antes de conectar GitHub o invitar a nadie.

## Antes de empezar

Necesitas un equipo con Claude Code o Codex instalado y con sesión iniciada, además de una cuenta en xMatrix. Los agentes usan tu cuenta existente de esa herramienta y se ejecutan en tu equipo; mantenlo conectado mientras trabajan. La aplicación web es el lugar donde conversas y lees las Páginas.

Sigue [Instalar e iniciar sesión](index.md#install) si todavía no has conectado este equipo. Abre tu Space en la [aplicación web](https://xmatrix.sh/app).

## Asigna una carpeta al agente

Para esta primera página basta con una carpeta vacía. Estos comandos crean una en macOS o Linux y añaden Codex a tu Space:

```sh
mkdir -p ~/xmatrix/project-wiki
xmatrix spaces
xmatrix agent add codex --space <space-id> --workspace ~/xmatrix/project-wiki
```

Reemplaza `<space-id>` por el id del Space que abriste. Para Claude Code, reemplaza `codex` por `claude`. En Windows, crea una carpeta como `C:\xmatrix\project-wiki` y usa esa ruta para `--workspace`.

Obtén la ruta completa de la carpeta con `echo "$HOME/xmatrix/project-wiki"` en macOS o Linux, o `Resolve-Path C:\xmatrix\project-wiki` en PowerShell. Usa esa ruta en el mensaje siguiente, incluidas las comillas. [Trabajar con agentes](agents.md) explica el registro y las herramientas compatibles.

## Pide la primera página

Crea una conversación en tu Space. Pega el mensaje de abajo reemplazando la ruta y las notas de ejemplo con los datos reales de tu proyecto. Usa `@claude` si añadiste Claude Code.

```text
@codex pwd:"/full/path/to/project-wiki"
Crea una página llamada Estado del lanzamiento a partir de estas notas.
Usa secciones para Objetivo, Decisiones, Trabajo pendiente y Próximos pasos.
Deja marcados como desconocidos los responsables o fechas que no se conozcan.
Trabaja a partir de estas notas y enlaza la página aquí cuando esté lista.

Objetivo: Publicar la próxima versión con una guía de instalación utilizable.
Decidido: Soportar primero macOS y Windows. Linux sigue abierto.
Trabajo pendiente: Comprobar las instrucciones de Windows.
El responsable y la fecha de lanzamiento no están decididos.
Siguiente: Pedir a un mantenedor que pruebe una instalación limpia en Windows.
```

La carpeta indica dónde se ejecuta el agente. Tus notas aportan el contenido; esta tarea no necesita acceso a un repositorio. En Windows los mensajes usan la misma sintaxis `pwd:` con tu ruta completa de Windows.

Espera la respuesta del agente y abre el enlace de la página, o busca **Estado del lanzamiento** en **Páginas**. Verifica que la página separe las decisiones de las preguntas abiertas y mantenga desconocidos los responsables y fechas que falten. Corrige en la conversación cualquier detalle que no haya quedado bien.

Si ningún agente responde, ejecuta `xmatrix status` y `xmatrix agent list --space <space-id>` en tu equipo. Confirma que el agente esté habilitado y que su herramienta de programación tenga la sesión iniciada. Los detalles de invocación de la conversación muestran un arranque fallido; [configuración de agentes](agents.md) cubre las comprobaciones siguientes.

## Cambia una decisión y observa cómo se actualiza la página

Responde a la instancia que contestó. Por ejemplo, si apareció como `codex:1`, envía:

```text
@codex:1 La instalación en Windows ya ha sido comprobada.
Actualiza Estado del lanzamiento: elimina ese punto pendiente.
Haz que el próximo paso sea elegir una fecha de lanzamiento.
Deja la fecha como desconocida hasta que la acordemos.
```

Usa el nombre y el número reales de tu conversación. Vuelve a abrir la misma página y verifica que el punto pendiente anterior haya desaparecido y que el próximo paso haya cambiado. Ese es el resultado útil: una sola página vigente a la que puedes volver, en lugar de releer todo el hilo para reconstruir el plan.

## Úsalo para trabajo real del proyecto

Introduce la siguiente decisión, resumen de incidencia o nota de versión mediante la conversación y pídele al agente que actualice la página existente. Dale acceso a la carpeta real de tu proyecto cuando necesite inspeccionar código. Si quieres que lea issues o pull requests de GitHub, conecta primero [GitHub](connectors.md#github) al Space e indica el repositorio en la tarea.

Mantén cada dato en un solo lugar. Añade páginas hijas cuando el proyecto lo necesite y enlázalas desde Estado del lanzamiento. [Páginas](pages.md) explica el árbol de páginas, la edición concurrente y las actualizaciones programadas.

Las páginas permanecen privadas hasta que un propietario o administrador del Space decida publicar alguna. Revisa su contenido y sus permisos antes de compartirla fuera del equipo; crear esta wiki no la publica.
