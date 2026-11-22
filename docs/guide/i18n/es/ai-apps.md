---
title: "Usa xMatrix en ChatGPT, Grok o Cursor mediante MCP · Documentación de xMatrix"
description: "Conecta ChatGPT, Grok, Cursor u otra aplicación de IA compatible con MCP para leer y actualizar tus páginas y conversaciones de xMatrix."
---

# Conectar una app de IA externa

Usa tus páginas y conversaciones de xMatrix desde ChatGPT, Grok, Cursor, Codex
u otro cliente compatible con MCP remoto y OAuth. La URL del servidor es:

```text
https://xmatrix-hub.xmatrix.sh/mcp
```

En tu app de IA, añade un servidor MCP remoto o conector personalizado con esta URL.
Inicia sesión en xMatrix cuando se te solicite, revisa la app y los permisos pedidos,
y aprueba la conexión. ChatGPT llama a esto plugins MCP personalizados; Grok
utiliza conectores personalizados. Los ajustes exactos dependen del cliente y del plan.
El registro oficial de MCP lo lista como `io.github.LambdaLabsHQ/xmatrix`.

La app conectada tiene el mismo acceso que tú en xMatrix. El permiso de lectura le permite
encontrar tus Spaces, buscar y leer páginas, y leer conversaciones. Un permiso de escritura
también le permite crear o editar páginas y enviar mensajes en tu nombre. Un mensaje
que mencione a un Agente puede pedirle a ese Agente que actúe.
El historial de páginas y las cabeceras de mensajes muestran el nombre registrado de la aplicación
externa junto a tu autoría. Ese nombre lo proporciona la propia aplicación.

Prueba con «Busca mi hoja de ruta y resume sus decisiones» o «Muéstrame la wiki de mi proyecto».
Los clientes compatibles con MCP Apps pueden mostrar una tarjeta de página con su revisión actual,
vista previa del texto y un botón para abrir el origen en xMatrix. Otros clientes reciben
los mismos datos de la página y el enlace de origen como texto.

Para desconectarla, abre tu perfil de xMatrix, elige **Apps de IA** y elimina
la app. No podrá renovar su acceso tras eliminarla; su último token de acceso
puede seguir siendo válido hasta 15 minutos. Los datos ya enviados al proveedor quedan
sujetos a los términos y la configuración de privacidad de ese proveedor.
