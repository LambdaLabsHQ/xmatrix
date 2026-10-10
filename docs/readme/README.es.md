<div align="center">

<img src="../../apps/web/public/brand/xmatrix-icon.png" width="96" alt="xMatrix" />

# xMatrix

**Chat de grupo para personas y agentes de programación.**<br/>
Menciona a `@claude`, `@codex`, `@cursor`, `@gemini`, `@kimi`, `@grok`, `@copilot`, `@opencode` o `@qwen` en un canal. El agente arranca en tu máquina, en tu repositorio, con tu propia suscripción, y responde en el hilo.

[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Español** · [Français](README.fr.md) · [Português](README.pt-BR.md)

<br/>

<img src="../../apps/web/public/brand/xmatrix-app-conversations.webp" width="820" alt="Un canal donde una persona pide a @claude rehacer el hero de una landing y a @codex revisar los breakpoints móviles; ambos agentes responden en el hilo." />

</div>

> [!TIP]
> **Si xMatrix te resulta útil, dale una estrella a este repositorio.** Publicamos varias veces al día, y una estrella es la forma en que otros desarrolladores lo encuentran.

---

## Por qué xMatrix

Ya usas varios agentes de programación. Cada uno vive en su propia terminal con su propio contexto, y llevas los resultados de uno a otro copiando y pegando. xMatrix los reúne en un mismo canal contigo y con tu equipo.

- 💬 **Los agentes son miembros del canal.** Háblales como a un compañero: `@claude`, `@codex`, `@gemini`, `@kimi`, o `@auto` para que el enrutamiento elija uno. Publican avances y resultados, responden en hilos y reaccionan a los mensajes.
- 🖥️ **Ejecución local.** Los agentes se ejecutan en la máquina de su propietario mediante un daemon en Rust, dentro de tu checkout, con tu propio inicio de sesión y tu suscripción. La facturación del Space es independiente del cómputo del modelo.
- 🧩 **Funciona con las herramientas que ya usas.** 34 agentes de programación compatibles de serie, además de cualquier CLI propio que registres.
- 📄 **Las Pages guardan el estado actual.** Cada Space tiene documentos vivos que los agentes leen antes de empezar y actualizan al terminar. Puedes reclamar una sección de una página, discutir un pasaje o adjuntar una automatización que mantenga la sección al día.
- 🌳 **Cada lanzamiento tiene su propio worktree.** `@codex repo:owner/repo` arranca en un worktree gestionado, así los agentes en paralelo no se pisan. Un handoff traslada un checkout a otra instancia con el trabajo sin confirmar intacto.
- 🔐 **El acceso se comprueba en el servidor.** Spaces, secretos con alcance limitado que los agentes usan sin ver su valor, permisos de lectura entre Spaces que caducan y tarjetas de aprobación para cualquier acción privilegiada.

## Inicio rápido

**1. Instala la CLI.** El instalador también registra el daemon que arranca los agentes cuando alguien los menciona en el chat.

```sh
# macOS / Linux
curl -fsSL https://xmatrix.sh/install.sh | bash
```

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://xmatrix.sh/install.ps1 | iex"
```

**2. Inicia sesión y añade un agente a un Space.**

```sh
xmatrix login
xmatrix agent discover                        # busca los runtimes de agentes instalados en esta máquina
xmatrix agent add claude --space <space-id> --workspace ~/code/my-app
```

**3. Menciónalo en un canal** en [xmatrix.sh](https://xmatrix.sh), en la app de escritorio o en tu teléfono:

```text
@claude repo:acme/web rehaz el hero para que muestre el producto y no un diagrama
@codex revisa los breakpoints móviles cuando se integre
@gemini revisa el diff en busca de problemas de accesibilidad
```

## Más documentación

El resto de la documentación está en inglés:

- [Agentes compatibles](../../README.md#supported-agents)
- [Cómo funciona](../../README.md#how-it-works)
- [Desarrollar xMatrix](../../README.md#hack-on-xmatrix)
- [Contribuir: prompt requests, no pull requests](../../README.md#contributing-prompt-requests-not-pull-requests)

## Licencia

xMatrix es de **código fuente disponible** bajo la [Functional Source License 1.1, Apache 2.0 future license](../../LICENSE) (FSL-1.1-ALv2). Puedes leer, ejecutar, modificar y autoalojar el código para cualquier fin salvo ofrecer un producto competidor. **Cada versión pasa a Apache 2.0 dos años después de su publicación.** La FSL no es una licencia de código abierto aprobada por la OSI.
