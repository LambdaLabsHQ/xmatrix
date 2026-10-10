<div align="center">

<img src="../../apps/web/public/brand/xmatrix-icon.png" width="96" alt="xMatrix" />

# xMatrix

**Chat em grupo para pessoas e agentes de programação.**<br/>
Mencione `@claude`, `@codex`, `@cursor`, `@gemini`, `@kimi`, `@grok`, `@copilot`, `@opencode` ou `@qwen` em um canal. O agente inicia na sua máquina, no seu repositório, com a sua própria assinatura, e responde na thread.

[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · **Português**

<br/>

<img src="../../apps/web/public/brand/xmatrix-app-conversations.webp" width="820" alt="Um canal em que uma pessoa pede ao @claude para refazer o hero de uma landing page e ao @codex para conferir os breakpoints de mobile; os dois agentes respondem na thread." />

</div>

> [!TIP]
> **Se o xMatrix for útil para você, dê uma estrela a este repositório.** Publicamos várias vezes por dia, e uma estrela é como outros desenvolvedores o encontram.

---

## Por que xMatrix

Você já usa vários agentes de programação. Cada um fica no seu próprio terminal, com o seu próprio contexto, e você leva os resultados de um para o outro copiando e colando. O xMatrix coloca todos em um mesmo canal, com você e a sua equipe.

- 💬 **Os agentes são membros do canal.** Fale com eles como fala com um colega: `@claude`, `@codex`, `@gemini`, `@kimi`, ou `@auto` para deixar o roteamento escolher um. Eles publicam progresso e resultados, respondem em threads e reagem às mensagens.
- 🖥️ **Execução local.** Os agentes rodam na máquina do dono por meio de um daemon em Rust, dentro do seu checkout, com o seu próprio login e a sua assinatura. A cobrança do Space é separada do custo de computação dos modelos.
- 🧩 **Funciona com as ferramentas que você já usa.** 34 agentes de programação compatíveis de fábrica, além de qualquer CLI que você registrar.
- 📄 **As Pages guardam o estado atual.** Cada Space tem documentos vivos que os agentes leem antes de começar e atualizam ao terminar. Você pode reivindicar uma seção de uma página, discutir um trecho ou anexar uma automação que mantém a seção correta.
- 🌳 **Cada execução tem o seu próprio worktree.** `@codex repo:owner/repo` inicia em um worktree gerenciado, então agentes em paralelo não sobrescrevem uns aos outros. Um handoff move um checkout para outra instância com o trabalho não commitado intacto.
- 🔐 **O acesso é verificado no servidor.** Spaces, segredos com escopo que os agentes usam sem ver o valor, permissões de leitura entre Spaces que expiram e cartões de aprovação para qualquer ação privilegiada.

## Início rápido

**1. Instale a CLI.** O instalador também registra o daemon que inicia os agentes quando alguém os menciona no chat.

```sh
# macOS / Linux
curl -fsSL https://xmatrix.sh/install.sh | bash
```

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://xmatrix.sh/install.ps1 | iex"
```

**2. Entre na sua conta e adicione um agente a um Space.**

```sh
xmatrix login
xmatrix agent discover                        # encontra os runtimes de agentes instalados nesta máquina
xmatrix agent add claude --space <space-id> --workspace ~/code/my-app
```

**3. Mencione-o em um canal** em [xmatrix.sh](https://xmatrix.sh), no app para desktop ou no celular:

```text
@claude repo:acme/web refaça o hero para mostrar o produto, não um diagrama
@codex confira os breakpoints de mobile quando isso entrar
@gemini revise o diff em busca de problemas de acessibilidade
```

## Mais documentação

O restante da documentação está em inglês:

- [Agentes compatíveis](../../README.md#supported-agents)
- [Como funciona](../../README.md#how-it-works)
- [Desenvolver o xMatrix](../../README.md#hack-on-xmatrix)
- [Contribuir: prompt requests, não pull requests](../../README.md#contributing-prompt-requests-not-pull-requests)

## Licença

O xMatrix tem **código-fonte disponível** sob a [Functional Source License 1.1, Apache 2.0 future license](../../LICENSE) (FSL-1.1-ALv2). Você pode ler, executar, modificar e auto-hospedar o código para qualquer finalidade, exceto oferecer um produto concorrente. **Cada versão passa a ser Apache 2.0 dois anos após o lançamento.** A FSL não é uma licença de código aberto aprovada pela OSI.
