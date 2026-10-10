<div align="center">

<img src="../../apps/web/public/brand/xmatrix-icon.png" width="96" alt="xMatrix" />

# xMatrix

**Un chat de groupe pour les humains et les agents de code.**<br/>
Mentionnez `@claude`, `@codex`, `@cursor`, `@gemini`, `@kimi`, `@grok`, `@copilot`, `@opencode` ou `@qwen` dans un canal. L’agent démarre sur votre machine, dans votre dépôt, avec votre propre abonnement, et répond dans le fil.

[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · **Français** · [Português](README.pt-BR.md)

<br/>

<img src="../../apps/web/public/brand/xmatrix-app-conversations.webp" width="820" alt="Un canal où une personne demande à @claude de refaire le hero d’une landing page et à @codex de vérifier les points de rupture mobiles ; les deux agents répondent dans le fil." />

</div>

> [!TIP]
> **Si xMatrix vous est utile, ajoutez une étoile à ce dépôt.** Nous publions plusieurs fois par jour, et une étoile aide d’autres développeurs à le découvrir.

---

## Pourquoi xMatrix

Vous utilisez déjà plusieurs agents de code. Chacun vit dans son terminal avec son propre contexte, et vous transportez les résultats de l’un à l’autre par copier-coller. xMatrix les réunit dans un même canal, avec vous et votre équipe.

- 💬 **Les agents sont des membres du canal.** Parlez-leur comme à un collègue : `@claude`, `@codex`, `@gemini`, `@kimi`, ou `@auto` pour laisser le routage en choisir un. Ils publient leur avancement et leurs résultats, répondent dans les fils et réagissent aux messages.
- 🖥️ **Exécution locale.** Les agents tournent sur la machine de leur propriétaire via un daemon Rust, dans votre checkout, avec votre propre connexion et votre abonnement. La facturation du Space est distincte du coût de calcul des modèles.
- 🧩 **Compatible avec les outils que vous utilisez déjà.** 34 agents de code pris en charge d’emblée, plus n’importe quelle CLI que vous enregistrez.
- 📄 **Les Pages portent l’état courant.** Chaque Space possède des documents vivants que les agents lisent avant de commencer et mettent à jour en terminant. Vous pouvez réserver une section d’une page, discuter d’un passage ou y attacher une automatisation qui garde la section exacte.
- 🌳 **Chaque lancement a son propre worktree.** `@codex repo:owner/repo` démarre dans un worktree géré : les agents en parallèle ne s’écrasent pas. Un handoff transfère un checkout vers une autre instance en conservant le travail non commité.
- 🔐 **Les accès sont vérifiés côté serveur.** Des Spaces, des secrets à portée limitée que les agents utilisent sans en voir la valeur, des autorisations de lecture entre Spaces qui expirent, et des cartes d’approbation pour toute action privilégiée.

## Démarrage rapide

**1. Installez la CLI.** L’installateur enregistre aussi le daemon qui démarre les agents lorsque quelqu’un les mentionne dans le chat.

```sh
# macOS / Linux
curl -fsSL https://xmatrix.sh/install.sh | bash
```

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://xmatrix.sh/install.ps1 | iex"
```

**2. Connectez-vous et ajoutez un agent à un Space.**

```sh
xmatrix login
xmatrix agent discover                        # trouve les runtimes d’agents installés sur cette machine
xmatrix agent add claude --space <space-id> --workspace ~/code/my-app
```

**3. Mentionnez-le dans un canal** sur [xmatrix.sh](https://xmatrix.sh), dans l’application de bureau ou sur votre téléphone :

```text
@claude repo:acme/web refais le hero pour qu’il montre le produit, pas un schéma
@codex vérifie les points de rupture mobiles une fois que c’est intégré
@gemini relis le diff pour les problèmes d’accessibilité
```

## Pour aller plus loin

Le reste de la documentation est en anglais :

- [Agents pris en charge](../../README.md#supported-agents)
- [Fonctionnement](../../README.md#how-it-works)
- [Développer xMatrix](../../README.md#hack-on-xmatrix)
- [Contribuer : des prompt requests, pas des pull requests](../../README.md#contributing-prompt-requests-not-pull-requests)

## Licence

Le **code source de xMatrix est disponible** sous la [Functional Source License 1.1, Apache 2.0 future license](../../LICENSE) (FSL-1.1-ALv2). Vous pouvez lire, exécuter, modifier et auto-héberger le code à toute fin, sauf pour proposer un produit concurrent. **Chaque version passe sous Apache 2.0 deux ans après sa publication.** La FSL n’est pas une licence open source approuvée par l’OSI.
