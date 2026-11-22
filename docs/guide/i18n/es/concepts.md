---
title: "Conceptos de xMatrix: Spaces, páginas, agentes e instancias"
description: "Las seis ideas sobre las que se construye xMatrix: Spaces, conversaciones, páginas vivas, agentes, instancias y máquinas, y cómo encajan entre sí."
---

# Conceptos

xMatrix se construye sobre seis ideas: un Space agrupa a las personas y agentes de un equipo, las conversaciones son el lugar donde se solicita el trabajo, las páginas registran lo que es vigente hoy y los agentes se ejecutan como instancias en máquinas que sus propietarios controlan.

## Space

Un Space es un equipo: sus personas, sus agentes, sus conversaciones, sus páginas, sus secretos y sus apps conectadas. El acceso se decide por Space, en el servidor. Puedes pertenecer a varios Spaces; nada cruza entre ellos a menos que alguien lo autorice.

## Conversación

Una conversación (un canal) es donde se discute el trabajo y se asignan tareas a los agentes. Puede ser pública para todo el Space o privada para sus miembros. Los mensajes usan Markdown, pueden llevar archivos adjuntos y admiten respuestas en hilo.

Las conversaciones son el espacio de trabajo, no el registro definitivo. Lo que un equipo ha decidido vive en las páginas.

Un propietario o administrador del Space puede elegir **Eliminar canal…** en las acciones
o detalles de una conversación. Detén primero a sus Agentes, luego escribe su nombre y confirma.
El acceso termina de inmediato; sus mensajes, adjuntos y programaciones se limpian automáticamente.
Las Páginas enlazadas se conservan. La eliminación de la cuenta es una acción aparte en **Configuración → Cuenta**.

## Página

Una página es un documento vivo del Space: estado actual, decisiones vigentes y trabajo pendiente, organizados en un árbol. Los agentes leen las páginas enlazadas a su conversación antes de empezar y las actualizan al terminar. Personas y agentes editan el mismo documento al mismo tiempo.

Las secciones de una página son sus encabezados. Una sección puede enlazarse a una conversación, debatirse y mantenerse vigente mediante un [programa](programs.md): un bloque de la página que ejecuta agentes según un horario, en una fecha concreta o cuando ocurre un evento, coordinándolos con personas. Consulta [Páginas](pages.md).

## Agente

Un agente es un harness (una herramienta de programación como Claude Code o Codex) registrado por una persona en una máquina. Esa terna constituye su identidad. El directorio en el que trabaja no forma parte de su identidad, de modo que un mismo agente puede trabajar en muchos repositorios.

En un mensaje te diriges a un agente por el nombre de su harness: `@claude`, `@codex`. Si varias personas del Space han registrado Codex, `@codex` sigue significando «un Codex» y xMatrix elige qué registro ejecuta el trabajo.

## Instancia

Una instancia es un agente trabajando en una conversación concreta. Tiene un número local a esa conversación: `claude:1`, `claude:2`, `codex:1`. Una instancia conserva su sesión y su copia de trabajo entre mensajes, de modo que `@claude:1` continúa exactamente donde lo dejó.

Una instancia no es un proceso. Cuando no tiene nada pendiente, entra en reposo: el proceso finaliza y el siguiente mensaje dirigido a ella la despierta con su memoria intacta. Consulta [cómo descansan las instancias](agents.md#sleep-and-wake).

## Máquina

Una máquina es un equipo que ejecuta el daemon de xMatrix. El daemon recibe solicitudes de lanzamiento, prepara el directorio de trabajo, inicia el harness y reporta el estado de vuelta. Los agentes se ejecutan localmente en máquinas controladas por sus propietarios, con las credenciales del propietario para el harness.

Cada máquina tiene un nombre elegido por su propietario. Ese nombre es la forma de pedirla explícitamente: `machine:studio`.
