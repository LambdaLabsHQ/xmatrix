---
title: "GitHub, Sentry, Linear y Slack para agentes de IA · Documentación de xMatrix"
description: "Trae eventos de GitHub, Sentry, Linear, Slack y 30 apps más a tus conversaciones, y permite que personas y agentes actúen sobre ellas con comandos de una línea."
---

# Apps conectadas

Una app conectada integra otro servicio en un Space en dos sentidos: sus eventos llegan a las conversaciones como mensajes, y personas y agentes actúan sobre él desde un mensaje.

Un administrador del Space conecta una app en la vista **Apps** de la aplicación. Algunas se conectan mediante el inicio de sesión del propio servicio; otras requieren una URL de webhook o un token de API. Las credenciales se guardan para el Space y no vuelven a mostrarse jamás.

## Forma del comando

```text
@<app>:<action>:<target> <text>
```

- `<app>` es el identificador de la app, como `github` o `sentry`.
- `<action>` es una de las acciones de la app, en minúsculas y con guiones bajos.
- `<target>` es aquello sobre lo que se aplica la acción: un repositorio, una incidencia, un proyecto. Una acción que no necesita destino usa `*`.
- `<text>` es lo que requiera la acción a continuación: el cuerpo de un comentario, un título, opciones o un objeto JSON.

El comando debe iniciar el mensaje y cada mensaje lleva un único comando. Las líneas siguientes a la primera forman parte de su texto. Escribe `@` y el nombre de la app para que el compositor te guíe por las acciones y sus destinos.

Cada comando deja un comprobante en la conversación con su resultado.

## Cambiar de cuenta, pausar y eliminar

La página de una app conectada ofrece opciones para gestionar su cuenta:

- **Cambiar cuenta** cambia la app a otra cuenta. En las apps con inicio de sesión abre la pantalla del proveedor con su selector de cuentas (Google siempre pregunta qué cuenta usar); la cuenta actual sigue conectada hasta que termina el nuevo inicio de sesión. En las apps con credenciales pegadas te lleva a la sección Credenciales, donde guardar los valores de otra cuenta reemplaza los anteriores en cuanto el proveedor los valida. Un administrador del Space también puede elegir **Usar un secreto guardado** en un campo: el Hub copia el valor actual de ese secreto del Space en la conexión y lo verifica sin mostrarlo; cada copia queda registrada en la auditoría de secretos.
- **Pausar** detiene los comandos y la entrega a canales conservando los datos de inicio de sesión. **Reanudar** vuelve a activarla con la misma cuenta, sin iniciar sesión de nuevo.
- **Eliminar** borra la conexión, sus credenciales guardadas y sus suscripciones de canales, previa confirmación.

Las apps de Google no se pueden pausar: xMatrix elimina la sesión de Google siempre que se detiene, así que en su lugar ofrecen **Cerrar sesión**. Las apps que admiten varias cuentas (GitHub, Gmail, Stripe, Cloudflare, X) añaden y quitan cada cuenta en esa misma lista.

## Eventos

Suscribir una conversación a una fuente publica allí los eventos de esa fuente:

```text
@github:subscribe:acme/web
@github:subscribe:acme/web pulls checks
@github:subscribe:acme/web:#42
@sentry:subscribe:web issue.created issue.regressed
@linear:subscribe:*
@github:unsubscribe:acme/web checks
```

Las palabras tras el destino seleccionan qué tipos de eventos se publican. Sin ellas se aplican los valores por defecto de la app, y `all` incluye todos los tipos.

Los tipos de GitHub son `issues`, `pulls`, `comments`, `reviews`, `commits`, `checks`, `status` y `releases`. `except:LOGIN` excluye la actividad de una cuenta concreta de GitHub: issues y pull requests que abrió y otros eventos que originó. `@github:subscribe:acme/web issues pulls except:octocat` publica los issues y pull requests de todos los demás; `@github:unsubscribe:acme/web except:octocat` retira esa excepción. Todo pull request abierto por un agente queda suscrito automáticamente a la conversación del agente, así que su resultado de CI, revisiones y fusión llegan donde se pidió el trabajo.

Un evento también puede iniciar un agente: un [programa](programs.md#events-from-connected-apps) en una página queda a la espera de recibirlo.

## GitHub

GitHub es además lo que hace posible `repo:`: conectarlo ofrece los repositorios del Space como destinos de lanzamiento y permite a los agentes hacer `push` con la conexión del Space.

| Comando | Efecto |
| --- | --- |
| `@github:subscribe:OWNER/REPO [kinds]` | Publica aquí eventos del repositorio |
| `@github:subscribe:OWNER/REPO:#42` | Sigue un issue o pull request concreto |
| `@github:unsubscribe:OWNER/REPO [kinds]` | Detiene la suscripción |
| `@github:comment:OWNER/REPO:#42 <body>` | Comenta en un issue o pull request |
| `@github:create_issue:OWNER/REPO <title>` | Crea un issue; las líneas siguientes forman el cuerpo |
| `@github:close_issue:OWNER/REPO:#42` | Cierra un issue o pull request |
| `@github:reopen_issue:OWNER/REPO:#42` | Lo reabre |
| `@github:review:OWNER/REPO:#42 approve <body>` | Revisa: `approve`, `request_changes` o `comment` |
| `@github:merge:OWNER/REPO:#42 squash` | Fusiona: `merge`, `squash` o `rebase` |
| `@github:rerun_failed_jobs:OWNER/REPO:RUN_ID` | Reejecuta los trabajos fallidos de una ejecución de workflow |
| `@github:dispatch_workflow:OWNER/REPO:WORKFLOW.yml:REF {…}` | Ejecuta un workflow en una referencia, con entradas JSON opcionales |

## Otras apps

Las acciones de cada app figuran en su panel dentro de **Apps** y en el compositor. Las disponibles hoy:

| App | Id | Eventos | Acciones |
| --- | --- | --- | --- |
| GitLab | `gitlab` | Merge requests, pushes, pipelines, issues, comentarios, releases | `read_issue`, `read_merge_request`, `comment`, `merge`, `retry_pipeline` |
| Bitbucket | `bitbucket` | Pull requests, comentarios, pushes, builds | `read_pull_request`, `comment` |
| Sentry | `sentry` | Incidencias nuevas, regresiones, resueltas, asignadas, ignoradas, alertas, comentarios | `read_issue`, `list_issues`, `resolve`, `unresolve`, `ignore` |
| Linear | `linear` | Issues, comentarios, proyectos | `read_issue`, `comment`, `create_issue` |
| Jira | `jira` | Issues, comentarios | `read_issue`, `comment`, `transition` |
| PagerDuty | `pagerduty` | Activados, reconocidos, resueltos, actualizaciones | `read_incident`, `acknowledge`, `resolve`, `note` |
| Opsgenie | `opsgenie` | Creados, reconocidos, cerrados, actualizaciones | |
| Grafana | `grafana` | Activas, resueltas | |
| Vercel | `vercel` | Despliegue iniciado, exitoso, fallido | `redeploy` |
| Netlify | `netlify` | Despliegue iniciado, exitoso, fallido | |
| Cloudflare | `cloudflare` | Alerta disparada, resuelta | `query_logs`, `list_deployments`, `rollback` |
| Google Cloud | `gcp` | Incidente de monitorización disparado, resuelto | Proyectos, Cloud Run, logs, métricas, costes, APIs |
| CircleCI | `circleci` | Fallido, exitoso | |
| Buildkite | `buildkite` | Fallido, aprobado | |
| Stripe | `stripe` | Pagos fallidos, disputas y cambios de suscripción. Conecta con Stripe o recibe cada evento de un objeto desde un webhook que crees | |
| Google Docs, Drive & Sheets | `google` | | `read_doc`, `create_doc`, `append_doc`, `read_sheet`, `update_sheet`, `create_sheet`, `list_files` |
| Google Search Console | `googlesearchconsole` | | `query`, `inspect_url`, sitemaps, propiedades, verificación |
| Google Calendar | `googlecalendar` | | `list_calendars`, `list_events`, `get_event`, `freebusy`, `create_event`, `update_event`, `delete_event` (las escrituras piden aprobación por defecto; [guía](https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/connectors/google-calendar.md)) |
| Google Analytics | `googleanalytics` | | `list_properties`, `report` |
| Google Ads | `googleads` | | `list_accounts`, `read_account`, `query`, `validate_mutations`; `mutate`, `set_campaign_status` (piden aprobación por defecto) |
| Google Play Console | `googleplay` | | `list_apps`, `tracks`, `release`, `base_plans`, `base_plan`, `api_operations`, `api_schema`, `api_read`, `api_plan`, `api_write`, `api_upload` |
| Google Business Profile | `googlebusinessprofile` | | `list_accounts`, `list_locations`, `performance`, `reviews`, `reply_review` |
| Google AdSense | `googleadsense` | | `list_accounts`, `list_sites`, `list_adunits`, `report`, `list_payments`, `list_alerts`, `list_policy_issues` |
| PageSpeed Insights | `pagespeed` | | `audit`, `field` |
| Bing Webmaster Tools | `bingwebmaster` | | `list_sites`, `traffic`, `queries`, `pages`, `crawl_stats`, `submit_urls`, `submit_sitemap`, `indexnow` |
| Yandex Webmaster | `yandexwebmaster` | | `list_hosts`, `summary`, `queries`, `recrawl` |
| Gmail | `gmail` | | `search`, `read`; `send`, `reply` (piden la aprobación de un administrador del Space cada vez por defecto). Varios buzones, cada uno usado solo por el miembro o Agente al que pertenece |
| X | `x` | | `accounts`, `read_post`, `timeline`, `media_status`; `post`, `upload_video`, `quote` (piden aprobación por defecto). Selección explícita de cuenta; citar publicaciones requiere acceso a X Enterprise API |
| Notion | `notion` | | `read_page`, `append`, `create_page` |
| Slack | `slack` | Mensajes, reacciones | `post` |
| App Store Connect | `appstoreconnect` | Estado de versión, subida de build, revisión y feedback de TestFlight | `list_apps`, `status`, `builds`, `read_version`, `reviews`, `sales`, `review_messages`, `review_attachments`, `review_attachment`, `review_draft`, `edit_review_draft`, `send_review_draft`, `api_operations`, `api_schema`, `api_read`, `api_plan`, `api_write`, `web_session`, `create_app`, `privacy`, `set_privacy`, `read_app`, `create_version`, `set_metadata`, `set_build`, `submit`, `cancel_submission`, `subscriptions`, `submit_subscriptions`, `in_app_purchases`, `submit_in_app_purchases`, `release`, `pause_phased_release`, `resume_phased_release`, `complete_phased_release`, `reply_review`, `set_app_info`, `set_age_rating`, `set_price`, `set_availability`, `set_review_contact`, `upload_build`, `upload_screenshot`, `commit_upload`, `read_upload`, `delete_upload`, `build_uploads`, `screenshot_specs`, `screenshots`, `set_screenshots`, `declare_encryption`, `signing`, `register_bundle_id`, `enable_capability`, `create_certificate`, `read_certificate`, `create_profile`, `read_profile`, `testflight`, `feedback`, `crash_log`, `add_to_group`, `submit_beta_review`, `set_test_notes` |
| Discord | `discord` | | `post` |
| Telegram | `telegram` | Mensajes | `send` |
| Feishu / Lark | `feishu` | Mensajes | `send` |
| Microsoft Teams | `teams` | Mensajes | `post` |
| Google Chat | `googlechat` | Mensajes | `post` |
| DingTalk | `dingtalk` | | `post`, `read`, `send` |
| WeCom | `wecom` | Mensajes | `post`, `send` |
| Webhook | `webhook` | Cualquier entrega JSON firmada | |
| OpenConnector | `openconnector` | | `search`, `run`: acciones de tu propio entorno de ejecución OpenConnector |

Algunos ejemplos:

```text
@sentry:read_issue:WEB-1A2
@sentry:list_issues:* firstRelease:xmatrix-v1.2.3
@linear:create_issue:ENG El inicio de sesión falla en Safari
@gitlab:comment:group/project!5 Se ve bien.
@cloudflare:query_logs:api-worker 30 error
@google:create_doc:new Notas de lanzamiento
@slack:post:C0123456789 Despliegue completado.
```

## Créditos de X

En Pro, las acciones de pago de X consumen del saldo de créditos del Space, ya sea que las ejecute un Agente o que una persona las ejecute o apruebe.

| Acción | Créditos |
| --- | --- |
| Publicación de solo texto | 30 |
| Publicación con URL, cita o contenido multimedia | 400 |
| Leer publicaciones o un timeline | 10 por publicación devuelta |
| Consulta de perfil, incluidos Conectar y Comprobar | 20 por perfil |
| Subida de contenido multimedia o consulta de estado | 30 |

Listar cuentas, las solicitudes de aprobación y la renovación de tokens son gratuitas. Una llamada rechazada por X, o que falle antes de llegar a X, se reembolsa. Las tarifas de contenido multimedia y de publicaciones con URL, cita o multimedia pueden cambiar una vez confirmados los cargos propios de X.

## Gestionar Google Ads

Conecta Google Ads en **Apps**, elige el ID de cliente anunciante en Credenciales
y ejecuta Comprobar. Esta conexión de Google es independiente de Analytics, Search Console
y Drive. Ninguna lectura o mutación puede apuntar a otro anunciante.

```text
@googleads:read_account:1234567890
@googleads:query:1234567890 SELECT campaign.id, campaign.name, campaign.status, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_7_DAYS LIMIT 50
@googleads:set_campaign_status:1234567890/987654321 {"status":"PAUSED"}
```

`validate_mutations` verifica los cambios publicitarios propuestos sin aplicarlos.
`mutate` crea o actualiza presupuestos, campañas, creatividades y segmentación conjuntamente;
las campañas nuevas deben crearse en pausa. Tanto `mutate` como los cambios de estado de campaña piden por defecto
la aprobación de un administrador del Space en cada solicitud. Para activar una campaña, indica explícitamente
su divisa y su presupuesto diario medio actual esperado en micros enteros:

```text
@googleads:set_campaign_status:1234567890/987654321 {"status":"ENABLED","currencyCode":"USD","expectedDailyBudgetMicros":"1000000"}
```

Un millón de micros equivale a una unidad de la divisa de la cuenta. Los presupuestos diarios medios
no son topes rígidos de gasto; Google puede gastar por encima de la media en un día concreto. La revisión
y publicación de anuncios nativos es asíncrona. Consulta antes de repetir cualquier escritura cuyo
resultado no se haya confirmado. La configuración completa y el contrato estable de aceptación
están en la [documentación del conector de Google Ads](https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/connectors/google-ads.md).

## Publicar una app en el App Store

Con App Store Connect conectado, un agente puede llevar una compilación desde la subida hasta la tienda y contarte cómo fue la revisión. Conéctalo en **Apps** con una clave de API de App Store Connect (Usuarios y acceso → Integraciones): el Key ID, el Issuer ID y el contenido del archivo `.p8`. La clave necesita el rol App Manager.

```text
@appstoreconnect:subscribe:com.example.app
@appstoreconnect:create_version:com.example.app 1.2.0
@appstoreconnect:set_metadata:com.example.app 1.2.0 {"locale":"en-US","whatsNew":"Faster sync and two crash fixes."}
@appstoreconnect:set_build:com.example.app 1.2.0 412
@appstoreconnect:submit:com.example.app 1.2.0
@appstoreconnect:release:com.example.app 1.2.0
```

- `subscribe` registra por ti el webhook de la app en Apple. A partir de entonces la conversación se entera cuando termina de procesarse una compilación y cada vez que la versión cambia de estado: en espera de revisión, en revisión, rechazada, aprobada, publicada. Un [programa](programs.md#events-from-connected-apps) puede esperar estos eventos para que un agente atienda un rechazo.
- `create_version` crea la siguiente versión con lanzamiento manual; añade `release=after_approval` para que Apple la publique en cuanto se apruebe. Los datos de contacto y de inicio de sesión para App Review se heredan de la versión anterior sin aparecer en la conversación.
- `set_build` toma el número de compilación que subiste una vez que Apple la ha procesado. El agente que compiló la app puede subirla sin tener ninguna clave de Apple en su máquina: consulta [Subir archivos](#uploading-files) más abajo.
- `submit` envía la versión a App Review. Si Apple la rechaza porque falta algún campo de la ficha, el comprobante indica qué falta.
- `release` publica una versión aprobada que esperaba lanzamiento manual. Añade `phased` para desplegarla gradualmente durante 7 días; `pause_phased_release` pausa ese despliegue, `resume_phased_release` lo reanuda y `complete_phased_release` la publica para todos. Una vez lanzada, la publicación no se puede deshacer. Un administrador del Space puede impedir escrituras fijando el permiso de App Store Connect en Solo lectura.

`@appstoreconnect:status:com.example.app` muestra el estado de cada versión, y `reviews` y `reply_review` gestionan las reseñas de usuarios. Una versión para otra plataforma se escribe `macos/1.2.0`, `tvos/1.2.0` o `visionos/1.2.0`.

Una app nueva empieza creando su registro. Una vez registrado el bundle ID (`register_bundle_id`, más abajo) y guardada la sesión web por un administrador del Space en Credenciales, `create_app` crea el registro con su primera versión y `set_privacy` completa Privacidad de la app y la publica; `privacy` lee las respuestas guardadas. La API de Apple no ofrece ninguna de las dos operaciones, así que ambas pasan por el sitio web de App Store Connect usando esa sesión:

```text
@appstoreconnect:create_app:com.example.app {"name":"Example","sku":"EXAMPLE","locale":"en-US","version":"1.0","platform":"ios"}
@appstoreconnect:set_privacy:com.example.app {"data":[{"category":"EMAIL_ADDRESS","purposes":["APP_FUNCTIONALITY"],"linked":true,"tracking":false}]}
```

`set_privacy` reemplaza todas las respuestas anteriores de la app; `{"data":[]}` declara que la app no recopila ningún dato. Al igual que la clasificación por edades, estas respuestas son tus declaraciones ante Apple, así que complétalas según lo que la app hace realmente.

A continuación el registro necesita unos pocos datos una sola vez antes del primer envío. `@appstoreconnect:read_app:com.example.app` indica cuáles faltan todavía, y un agente puede rellenar la mayoría:

```text
@appstoreconnect:set_app_info:com.example.app {"locale":"en-US","name":"Example","subtitle":"Ship faster","privacyPolicyUrl":"https://example.com/privacy","primaryCategory":"PRODUCTIVITY"}
@appstoreconnect:set_app_info:com.example.app {"contentRightsDeclaration":"DOES_NOT_USE_THIRD_PARTY_CONTENT"}
@appstoreconnect:set_age_rating:com.example.app {"gambling":false,"userGeneratedContent":true,"violenceRealistic":"NONE"}
@appstoreconnect:set_price:com.example.app free
@appstoreconnect:set_availability:com.example.app all
@appstoreconnect:set_review_contact:com.example.app 1.0.0 {"contactFirstName":"Ada","contactLastName":"Lovelace","contactEmail":"ada@example.com","contactPhone":"+1 555 0100"}
```

Las respuestas de clasificación por edades son tus declaraciones ante Apple sobre la app, así que no se rellena nada automáticamente: responde cada pregunta del cuestionario, y `read_app` mostrará como `null` las que falten.

### Responder a App Review

`review_messages` lee el hilo de revisión más reciente, incluidos sus IDs de hilo y mensaje y los metadatos de los adjuntos. Añade un ID de hilo para leer un hilo anterior, y un ID de mensaje para su texto completo. Con la sesión web guardada, `review_attachments` lista los archivos y `review_attachment` devuelve una URL firmada de descarga con caducidad; descarga ese archivo sin cookies de Apple ni clave de API.

`review_draft` lee una respuesta sin enviar y su resumen criptográfico (digest) actual. `edit_review_draft` crea un borrador o actualiza/elimina un borrador indicado usando su digest. `send_review_draft` envía exactamente ese borrador y verifica el mensaje resultante en Apple. Los borradores permanecen sin enviar hasta esa acción separada; enviar una respuesta no vuelve a enviar la app a revisión. Inspecciona el hilo antes de reintentar un envío incierto. Consulta el [flujo de revisión](https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/connectors/app-store-connect-review.md) para ver los argumentos y límites de los comandos.

### Subir archivos

Una compilación o una captura de pantalla llega a Apple en tres pasos, y el archivo nunca pasa por xMatrix:

```text
@appstoreconnect:upload_build:com.example.app 1.2.0 412 Example.ipa 48211034
@appstoreconnect:commit_upload:<upload id> build
@appstoreconnect:build_uploads:com.example.app 412
```

1. `upload_build` reserva la subida. Indícale la versión y el número de compilación contenidos en el archivo, el nombre del archivo y su tamaño exacto en bytes. El comprobante lista una o más partes: método, URL, rango de bytes y cabeceras.
2. El agente de la máquina que tiene el archivo envía los bytes de cada parte a su URL con esas cabeceras. Las URL pertenecen a Apple, caducan y solo sirven para ese archivo.
3. `commit_upload` avisa a Apple de que el archivo está completo. Entonces Apple procesa la compilación; una conversación suscrita recibe aviso al terminar y `build_uploads` muestra los errores que haya encontrado Apple.

Las capturas funcionan igual y luego se colocan en la ficha:

```text
@appstoreconnect:screenshot_specs:* iphone
@appstoreconnect:upload_screenshot:com.example.app home-6.9.png 1482113
@appstoreconnect:commit_upload:<image id> image
@appstoreconnect:set_screenshots:com.example.app 1.2.0 {"locale":"en-US","group":"<group>","images":["<image id>","<image id>"]}
```

`screenshot_specs` lista los grupos de ubicación de Apple, uno por familia de dispositivos, con los tamaños exactos en píxeles que acepta cada uno. `set_screenshots` hace que ese idioma y grupo muestren exactamente las imágenes indicadas, en ese orden; una misma imagen puede reutilizarse en varios idiomas. `screenshots` muestra lo que tiene actualmente una versión.

Si Apple pregunta por cumplimiento de exportación, respóndelo para la compilación con `@appstoreconnect:declare_encryption:com.example.app 1.2.0 412 exempt`.

### Firmar en una máquina sin Apple ID

Un agente en un Mac limpio o un runner de CI puede configurar la firma del App Store mediante el conector. La clave privada se genera en esa máquina y nunca sale de ella; solo viaja la solicitud de firma:

```text
@appstoreconnect:signing:com.example.app
@appstoreconnect:register_bundle_id:com.example.app Example App
@appstoreconnect:create_certificate:distribution -----BEGIN CERTIFICATE REQUEST----- …
@appstoreconnect:read_certificate:<certificate id>
@appstoreconnect:create_profile:com.example.app <certificate id>
@appstoreconnect:read_profile:<profile id>
```

`signing` muestra lo que ya existe. Un equipo solo dispone de unos pocos certificados de distribución, así que crea uno nuevo únicamente cuando ninguna máquina conserve la clave de uno existente. `enable_capability` activa capacidades como `PUSH_NOTIFICATIONS` para el bundle ID; crea el perfil después.

### TestFlight

```text
@appstoreconnect:testflight:com.example.app
@appstoreconnect:add_to_group:com.example.app 1.2.0 412 Early Access
@appstoreconnect:set_test_notes:com.example.app 1.2.0 412 en-US Try the new sync.
@appstoreconnect:submit_beta_review:com.example.app 1.2.0 412
@appstoreconnect:feedback:com.example.app
@appstoreconnect:crash_log:<feedback id>
```

Suscribe la conversación incluyendo `feedback` entre sus tipos y un agente podrá atender lo que reporten los testers: `feedback` lista sus comentarios con dispositivo, sistema operativo y compilación, y `feedback:… crashes` junto con `crash_log` devuelve el registro de fallo asociado a un reporte.

### Cuando App Review rechaza una versión

La conversación recibe el aviso del rechazo. `@appstoreconnect:review_messages:com.example.app` lee los motivos y el texto del revisor usando la sesión web guardada. En la app de xMatrix, Iniciar sesión en App Store Connect abre la página oficial de Apple y guarda la sesión. `review_attachments` lista los archivos vinculados y `review_attachment` devuelve una URL de descarga con caducidad que se obtiene sin credenciales. Lee `review_draft`, crea una respuesta sin enviar con `edit_review_draft` y luego envía exactamente su ID y su digest con `send_review_draft`. Enviar una respuesta no reenvía la app. Una vez solucionado el problema, `submit` devuelve el mismo envío a revisión; `cancel_submission` seguido de `submit` inicia uno nuevo.

Las primeras suscripciones de una app se revisan junto con una versión. `subscriptions` las lista con su estado de revisión; `submit_subscriptions` coloca todas las que están listas (o los IDs de producto indicados) en el borrador de envío a revisión como versión de suscripción, y el siguiente `submit` de una versión las envía juntas. Las compras integradas de pago único (consumibles como paquetes de créditos, no consumibles y suscripciones no renovables) van aparte: `in_app_purchases` las lista con su tipo y estado de revisión, y `submit_in_app_purchases` coloca todas las listas (o los IDs indicados) en el borrador de envío como versión de compra integrada, para que el siguiente `submit` las envíe con la versión de la app.

Apple reserva el inicio de sesión, los acuerdos, los datos bancarios/fiscales y las credenciales privadas de la cuenta de revisión para el titular de la cuenta. La sesión web guardada permite crear registros de App, completar Privacidad de la app y responder revisiones.

### Otros recursos de App Store Connect

`api_operations:* <resource>` busca en la API oficial fijada, y
`api_schema:<operation or schema>` muestra los parámetros exactos. `api_read` cubre
otros recursos, incluidos configuración de suscripciones/compras integradas, testers y
grupos de TestFlight, precios/ofertas, notificaciones, activos, dispositivos, permisos de equipo e
informes. Usa lecturas privadas para resultados personales o financieros. Para escrituras,
`api_plan` valida la solicitud prevista y devuelve un digest sin modificar nada en
Apple; `api_write` ejecuta exactamente esa solicitud tras comprobar su digest y el
estado actual del destino. Ninguna acción acepta secretos de inicio de sesión. Una escritura incierta
debe inspeccionarse antes de reintentarse, especialmente al crear un recurso nuevo.

## Agentes y apps

Un agente actúa mediante un mensaje visible en la conversación, con las mismas acciones
y reglas que una persona al escribir el comando. `xmatrix connector list` muestra las
apps conectadas y sus comandos; `xmatrix send <channel-id> "<command>"`
publica uno. Su resultado responde a ese mensaje. No tienes que configurar nada
en el agente.

Las búsquedas y lecturas de Gmail publican el contenido del correo en el comprobante de la conversación, y
el historial de ejecuciones guarda un extracto acotado. Toda persona que pueda leer la
conversación podrá leer ese contenido. Busca con
`@gmail:search:* is:unread newer_than:1h`, o coloca una dirección de buzón conectada
en lugar de `*`. No existe un conector MCP ni resultados de correo visibles solo para quien llama.

No uses estas acciones para recuperar códigos de inicio de sesión ni credenciales que deban
quedar fuera de los mensajes. No existe ninguna acción de transferencia de Gmail a secretos del Space.
Para un inicio de sesión manual autorizado, un agente puede solicitar
`xmatrix request secret-add <fresh-alias> --env QA_LOGIN_CODE --reason "QA login"`;
un administrador del Space introduce el código en la tarjeta de solicitud, nunca en el chat. Luego el agente
usa `xmatrix secret exec --secret <fresh-alias>=QA_LOGIN_CODE -- <login-command>`
para inyectarlo en un proceso que no lo imprime ni lo incluye en capturas de pantalla,
trazas o registros de peticiones. Esta entrada manual de secreto no verifica la entrega de correo
del conector ni el inicio de sesión automático. Guardar un valor después de haber leído un comprobante
en el Canal no borra su divulgación previa.

## Limitar una acción

Los envíos y respuestas de Gmail usan **Preguntar** por defecto. Cada solicitud aparece en
**Aprobaciones pendientes** de la conversación con su remitente, destinatario, asunto y
cuerpo. Un administrador del Space elige **Permitir una vez** o **Rechazar**. Aprobar un correo
no aprueba el siguiente; no se envía nada mientras la solicitud espera.

En Apps → Gmail → Permisos, elige **Solo lectura**, **Preguntar primero** o
**Lectura y escritura**. Un único ajuste se aplica a toda la conexión en todas las
conversaciones: las lecturas funcionan en los tres modos, Preguntar deja en espera cada cambio
y Lectura y escritura ejecuta los cambios directamente. No existen reglas por Canal ni
ajustes por acción individual. Calendar usa Lectura y escritura por defecto; Gmail, Google Ads,
X y Linear usan Preguntar primero por defecto. GitHub admite Solo lectura o Lectura y escritura.
