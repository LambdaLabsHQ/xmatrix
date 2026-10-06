# xMatrix Relay V2：完备系统、最小存储与迁移方案

日期：2026-07-18

状态：规范性架构候选，等待实现收敛、代码审阅与生产验收；不代表生产 migration 已启动。
三类产品 WebSocket transport 完成独立替换前，旧 RelayRoom 仍被硬门保留。

适用范围：当前规模至数千活跃主体；达到技术红线时迁往专用数据库基础设施

本文同时追求两个不可互相替代的目标：

1. **系统完备**：权威提交、实时连接、不可变内容、客户端查询、权限撤销、容量、恢复和
   migration 都有闭合的失败语义；
2. **存储最小**：一个业务事实只有一个权威表示，完备性来自少量正交数据原语的组合，
   不来自为每个业务名词、消息类型、状态或迁移步骤增加表、枚举和副本。

“表少”本身不是目标；没有重复事实、没有平行 authority、没有无界派生状态，才是目标。
需要独立唯一约束、关系约束、热点查询或安全隔离的事实可以使用专表；低频、稀疏和未来
可扩展的记录使用 domain-owned 开放 envelope。新增消息或控制类型不得要求 SQL migration。

## 一、最终架构决策

xMatrix Relay 只保留一个权威提交点，并把数据放到与其生命周期匹配的 Cloudflare
存储中：

```text
Authenticated product clients
┌───────────────────────────────────────────────────────────────┐
│ User Local Replica（每个用户/客户端 profile 一份）             │
│ - Web：IndexedDB/OPFS adapter + Web Worker search index        │
│ - Desktop/CLI：daemon-owned SQLite + FTS5                     │
│ - 完整授权 searchable text / local search / follow-up read model│
│ - 不包含 Relay authority 内部表，也不包含附件 binary                │
└──────────────────────────┬────────────────────────────────────┘
              typed command│   ▲ authorized snapshot/change
                           ▼   │
                        Hub Worker ◀────────────── R2
                  auth / validation / routing    - referenced payload authority
                           │                     - attachments / large bodies
                 ┌─────────┴──────────┐          - history/projection segments
                 ▼                    ▼
          Relay Runtime DO       Relay authority DO
          - hibernating WS       - commit/current state authority
          - presence             - domain commands
          - subscriptions        - sequence / version
          - bounded memory       - intents / jobs / PITR
                 │                    │
                 └──── commit 后 ─────┘
                       realtime delta

Projection pipeline
Relay authority outbox/job -> Cloudflare Queue -> Export Worker -> private R2
                                  checksum/result -> Core manifest finalize

Management host additionally owns one exact-run overlay
- Space-wide read-only Markdown renderer
- follow-up extraction checkpoints

Each client profile additionally owns one bounded media cache
- attachment/media lazy download
- byte/count/age cap + LRU

Each Agent host owns its session trace source
- local bounded trace store for the exact Agent instance/session
- authenticated on-demand stream; Hub is only a transient relay/cache

Analytics Engine
- capacity / growth / latency / errors / sampled telemetry
```

现有 `AUTH_DB`（D1）继续只负责认证；Relay current state、历史投影和全文搜索均不进入
D1。一个新的 SQLite-backed `RelayAuthority` Durable Object 是
唯一事务提交、current state 与 manifest authority；被 Core manifest 引用的不可变 R2
对象是附件、大正文和历史 payload 的权威内容存储。`RelayRuntime` 只负责实时连接，
Analytics Engine 保存监控和采样 telemetry。每个提供产品搜索的登录客户端都
保存一份按用户授权过滤、可删除、可重建的 Local Replica；Channel、message、Agent、
machine、workspace 和 Follow-up 的搜索与历史定位从本地读取，不进入 Durable Object
查询路径。管理 Agent 所在 daemon 只额外保存
一个与 exact live management run 绑定的 Space-wide overlay，用于只读 Markdown 和候选
抽取。Agent trajectory/trace 是 session 级短期数据：exact Agent 宿主机的有界本地 trace
是该 session 的唯一 canonical authority/source，Hub 只做有界临时中继/缓存，不把 trace payload
写入 Core 或 R2。这些本地数据都不参与 Relay 业务权威提交。

当前只运行一个 Runtime cell；Relay authority 是唯一 commit/current-state/manifest authority，
其已提交 manifest 引用的 R2 payload 属于同一权威数据集。

本文所说的“每台机器复制”有一个精确边界：复制单位不是物理机器，也不是 Relay authority
物理数据库，而是一个已经认证的 client profile 的**完整授权搜索投影**。这里的“完整”
指当前授权、服务端产品 retention 范围内、截至固定 manifest head 的全部 searchable text
与必要读取元数据；不包括 Relay authority 内部表、凭据、job、幂等记录、PITR 内部状态、
operational telemetry 和附件 binary。`clientProfileId` 只是本地 namespace，不是安全
身份；每次同步和 mutation 的身份仍来自 Hub 签发并验证的会话或 run principal。

普通用户获得数据库式 `User Local Replica`；只有 exact configured management run 获得
Space-wide filesystem overlay。两者都不是云端 authority，也不能互相扩大权限。

### 1.1 一份事实与允许的复制

每个 datum 必须在设计时归入且只归入以下一种 canonical 类别：

| 类别 | Canonical 位置 | 允许的其他表示 |
| --- | --- | --- |
| 关系与 current state | Relay authority | R2/Local Replica 中的可重建 projection |
| 大正文与 binary | Core manifest 引用的 immutable R2 object | 有界 hot source、授权本地副本或 media cache |
| 实时状态 | Relay Runtime memory/hibernation attachment | 带 TTL 的客户端显示状态 |
| 搜索与读模型 | User Local Replica | 可删除 postings；不建立第二份 canonical body |
| 管理推理状态 | exact-run Management Overlay | 可删除 checkpoint；不得写回 authority |
| Agent trajectory/trace | exact authenticated Agent 宿主机的有界 session trace | Hub 仅可有界临时中继/缓存；随 session/instance 终止或过期清除，不进入 Core/R2 |
| telemetry | Analytics Engine | 有界进程内采样；Relay authority 中为 0 rows/0 bytes |
| migration technical state | 隔离的临时 journal 与封存 artifact | journal 按核验/PITR 窗口清理；最终证据按审计 retention 封存；产品路径不得依赖 |

复制只有三种合法理由：跨事务的短暂安全重叠、从 authority 可验证重建的投影、经授权为
产品查询或显式离线能力建立的可重建本地副本。每份复制都必须声明 owner、重建来源、删除条件、最大 rows/bytes/age
和唯一 GC owner；否则它就是冗余。

系统状态分为两类，不能混用：

- **闭合基础设施状态**：authority phase、lease、outbox operation、projection build、R2
  upload/GC、authorization gate 等安全 reducer。它们可以有穷尽的转移图并 fail closed；
- **开放业务语义**：message/control/provider 的 `kind`、业务 `status` 和 extension payload。
  它们使用 namespaced、versioned envelope，不使用数据库枚举、全局 union 或中央白名单。
  已注册 namespace 下未知的 kind/schema version 可以按 descriptor policy 保真存储并保持 inert；
  未知 namespace 只能由 migration/admin 审计路径有界读取，完成归类或证明为可保留的非产品数据前
  仍属于 unknown storage family，并阻断 cutover。

## 二、为什么这是最小完备解

### 2.1 每个组件只承担一个不可替代的职责

| 组件 | 唯一职责 | 允许的持久状态 |
| --- | --- | --- |
| Hub Worker | 鉴权、输入校验、路由 | 无 |
| Relay Runtime DO | WebSocket 协调与实时投递 | 仅 hibernation attachment |
| Relay authority DO | 权威事务与有序状态机 | current state、manifest、热 payload、server delivery/read cursor、Intent、任务 |
| R2 | manifest 引用的权威内容存储 | body、attachment、history/projection segment |
| Agent Host Trace Store | exact instance/session 的 trace 来源与按需读取 | 宿主机本地有界 trace；按本地 session retention 清理 |
| Projection Export Worker / Queue consumer | 执行有界压缩、R2 I/O 与 snapshot/segment 构建 | 无；任务结果必须回 Core 提交 |
| Analytics Engine | 显式产品诊断事件；不参与容量维护 | 有界诊断事件 |
| AUTH_DB（D1） | 用户认证 | 认证域数据 |
| User Local Replica | 普通用户本地查询面 | 授权消息、搜索索引、Follow-up 读模型、同步游标 |
| Local Media Cache | 本机附件/媒体加速 | content-addressed、可淘汰 binary 与 cache index |
| Management Overlay | 管理 Agent 的特权本地阅读与推理 | Space-wide 只读镜像、抽取 checkpoint |

系统只有一个提交序列：Relay authority SQLite transaction。命令直接引用的附件或大正文先
PUT/校验 R2，再由 Core 提交引用；post-commit history/projection export 则由同一事务写入
durable outbox，Core 保留 hot source 并重试，直到 R2 object 校验和 manifest 提交完成。
Runtime、Analytics Engine、local replica 和 management overlay 的失败不能改变业务事实。
Core 删除 hot payload 后，R2 object 与 Core manifest 共同构成权威内容；此时 R2 可用性或
完整性异常属于权威数据故障，必须由 checksum、版本保留和恢复流程处理。
Projection Export Worker 只能领取 Core 已提交的有界 job、写入不可变 R2 object，再让
Core 原子提交结果 manifest；它不能直接改变任何业务事实。

### 2.2 权威、运行时和 telemetry 是不同类型

```text
DomainCurrentState -> Relay authority
RuntimeState     -> Relay Runtime memory / attachment
ReferencedPayload -> R2 + Core manifest
AgentSessionTrace -> exact authenticated Agent host local store
TelemetrySample  -> Analytics Engine
SearchProjection -> User Local Replica
FollowUpReadModel -> User Local Replica
MediaCache       -> Local Media Cache
InferenceCache   -> Management Overlay
```

这些类型不共享持久化 union，也不允许通过通用事件回调互相转换。Agent trace 不因为可在
产品 UI 中查看就成为 Relay authority：Hub 的 relay/cache 只在 session/instance 存活期内有界
存在，终止或过期即清除；历史读取必须向记录该 exact instance 的已认证宿主机按需请求。
宿主机离线、未认证或已按本地 retention 清除时明确返回 unavailable，不回退到 stale Hub cache，
也不制造 R2 archive。`ObservabilityEvent` 没有写入 Relay authority 的接口；未知 observability
类型默认不持久化。

### 2.3 容量事故沉淀出的长期不变量

`spmgmtevent:`、presence、network sample、quota/goal/waiting、broadcast/RPC 诊断和 Agent trace
payload 等 session/运行数据在 Relay authority 中的目标占用为 **0 bytes**。Agent trace 的可见性
与授权 metadata 可以是独立的有界安全状态，但它们不得复制 trace payload，也不得承诺宿主机
离线后的历史可用性。Management current state 与 Follow-up
authoritative current state/command validation 存在权威表，需要审计的用户动作写入有界
typed ledger；普通读从 User Local Replica 完成。每个用户客户端的搜索索引和 Follow-up
读模型保存在 User Local Replica，抽取 checkpoint 与候选推理只保存在 Management
Overlay。

具体 commit 的实现状态、事故行数和修复进度属于生成式 convergence evidence，不进入长期
规范；迁移门只读取绑定 exact git SHA/schema digest 的 artifact。任何版本只要仍把 ephemeral
事件持久化到 management projection，就必须先止血并通过回归测试，再启动架构迁移。

### 2.4 已验证的客户端架构原则

Telegram 与 Slack 的公开实现共同证明了“云端权威、客户端本地状态、实时增量、媒体缓存”
应当分层，但两者都把普通全文搜索放在服务端。xMatrix 采用相同的分层原则，同时因为
产品要求普通用户完成完整本地搜索，主动把 searchable-text 工作集扩大为完整授权投影：

| 系统 | 云端权威 | 普通消息搜索 | 客户端历史 | 同步与恢复 | 媒体 |
| --- | --- | --- | --- | --- | --- |
| Telegram | Telegram Cloud | 服务端 | 可显式存在 holes 的稀疏 cache | `pts/qts/seq`、difference、过旧重建 | 懒加载、可清理 cache |
| Slack | Slack Cloud | 服务端 | lazy-loaded working set | WebSocket 实时更新、API 重取；内部补洞协议未公开 | 懒加载 cache |
| xMatrix | Relay authority + manifest 引用的 R2 | 完整授权投影本地搜索 | 完整 searchable-text replica | `changeSeq`、R2 gap recovery、scope rebuild | R2 权威、本地有界 cache |

由此得到四条实现约束：

1. 云端 authority 不因本地副本存在而改变；
2. 本地数据必须可以安全删除并从云端重建；
3. WebSocket 只降低延迟，snapshot、连续水位和 gap recovery 才是可靠性边界；
4. User Local Replica、UI hot cache 与 media cache 必须分开，不能把同步 `localStorage`
   当作消息数据库。

## 三、Relay authority 数据模型

### 3.1 原生 SQLite 上的最小正交原语

V2 禁止的是隐藏、无预算、无法声明不变量的通用 KV authority；它不否定稳定 key 与完整
structured value 的演进能力。权威数据分为两个平面：

- **关系不变量平面**：需要唯一约束、关联、排序、权限过滤、热点条件查询或跨对象原子
  不变量的字段，使用明确列和关系表；
- **可演进内容平面**：低频、稀疏、未来可扩展的 message/control/domain record，使用有
  namespace、schema version、canonical encoding 和硬字节上限的完整 envelope。

两者是互补关系。不能为了减少表数把 ACL、sequence 或唯一键塞进不可查询 JSON；也不能
为了获得静态类型，把每个 subtype、可选字段或未来业务状态拆成永久表和数据库枚举。

Relay authority 只使用以下逻辑原语：

| 原语 | 保存什么 | 不保存什么 |
| --- | --- | --- |
| 强约束 current state | 需要独立关系/唯一约束和热点查询的 canonical fields | 同义 JSON、历史 snapshot、UI preview |
| Domain-owned open envelope | 低频 current state、可扩展 message/control payload | 全局 domain union、中央 kind/status 白名单 |
| Ordered head/cursor | Channel sequence、message identity、ACK、单调 scope/root head | 重复正文、永久 replay log |
| Immutable object + live ref | R2 object metadata 与当前权威 owner/root reference | 按 consumer/device 复制的 object descriptor |
| Bounded outbox/redaction | 尚未发布的普通变化；独立安全边界中的不可丢删除控制 | 永久事件总账、完整大正文副本 |
| Bounded work/lease | export、archive、GC、retry、reservation、rebuild checkpoint | 每次重试新增的日志行 |
| Domain-owned bounded ledger | 必须审计的 transition/action | observability、全文 snapshot、无限历史 |
| Idempotency/metering | 重试窗口结果与同步维护的 logical usage | 业务内容副本、每分钟 telemetry 历史 |

下面只是待双向 inventory 验证的候选物理布局，不是表数 KPI、schema budget 或切换证据。
同一逻辑原语可在访问边界相同时复用 mechanics，也必须在安全边界、生命周期或故障语义不同
时拆分。最终唯一事实是从 `sqlite_schema` 生成并经 table-admission 审核的 artifact：

```text
system
  _sql_schema_migrations
  monotonic_counters
  authority_state

identity, access and execution
  spaces, space_members, space_invites, channels, channel_access
  roles, workspaces, runs, instances, scheduled_tasks, scheduled_task_occurrences
  machine_daemons

product current state
  app_connector_connections, app_source_relations
  management_work_items, secret_refs

ordered messages
  message_heads, hot_message_payloads, message_reactions
  delivery_cursors, attention

evolvable state, intent and audit
  extension_records, extension_index_entries, extension_index_heads
  # Shared Memory is the registered xmatrix.shared-memory namespace, not a second current table
  domain_intents*, ledger_entries
  # * logical family; physical sharing requires a proven identical security boundary

immutable content graph
  content_objects, content_refs, content_closure_heads

projection and work
  projection_scopes, projection_changes, projection_redactions
  projection_principals, projection_grants
  jobs

cross-cutting bounded state
  idempotency_keys, storage_usage

migration only
  _migration_run, _migration_rows, _migration_edges, _migration_proofs
  # temporary; not part of steady state
```

这是一组职责，不是要求每行恰好对应一张表。只有访问边界、生命周期和查询形状相同的
domain 才能共享物理 record/ledger mechanics；各 domain 仍拥有自己的 repository、codec、
权限检查和 transition，不定义跨 Human/Agent Instance/Machine Daemon 的持久化 union 或公共
serializer。安全敏感数据需要独立访问边界时必须分表。反过来，不能仅因 TypeScript 出现一个
新 interface、legacy 出现一个 prefix 或协议增加一个 kind 就建表。

`monotonic_counters` 只保存 namespace-owned current counter/head，不保存历史；Channel sequence、
Core commit sequence 和 per-channel instance ordinal 可以复用其机械结构，但各 domain command
仍拥有 key 和递增规则。Intent 是需要 TTL/lease/approval 的逻辑原语，不是强制所有 domain
共用的万能表；只有 principal、claim 条件、敏感字段、生命周期、查询形状和 side-effect eligibility
都相同时才可共享物理 mechanics。Blob upload、daemon control、Human approval、OAuth/credential
session 默认属于不同安全分区；generic intent 永不保存 token/ciphertext，只能引用独立 secret ref。
开放业务 kind/status 与唯一闭合 `dispatch_state` 分列，lease owner/until、attempt 与 backoff 是
该 reducer 的附属字段。`ledger_entries` 是 domain-owned、按 stream ordinal 有界保留的审计原语。

Machine Daemon command 在 `CORE_ACTIVE` 只使用 `domain_intents_daemon_control`：Human owner 只能
issue，绑定 owner+machine+host 的短期 Machine principal 才能按创建顺序 claim/complete；一次
claim 最多 5 条，并返回 `leaseOwner + leaseGeneration + entityVersion`。完成必须原样提交三者，
旧 lease、过期 lease、另一台机器以及没有 lease owner 证明的 legacy `leased` 行全部 fail closed。
crash lease 由有界 reap 转回带指数 backoff 的 queued 状态，达到 maxAttempts 后 terminal，TTL
到期则 expired。command kind 由 daemon-control domain 的局部 reviewed handler registry 管理，
不是数据库枚举或全系统消息枚举。payload 禁止 secret material；audit 只保存 principal/target、
outcome 与 payload digest，不复制完整 command。`machine_daemon_commands` 在验证/PITR 窗口内可
非空保留，但只是 `LEGACY_ACTIVE` shadow，`CORE_ACTIVE` 不读、不写、不删除它。

普通 projection outbox 与安全删除控制有不同故障语义，物理上分别使用 `projection_changes` 和
`projection_redactions`。前者可 coalesce/reset/backpressure；后者只保存仍有权 scope 内的
recall/retention hard-delete/redaction/purge。Authorization revoke 的唯一 owner 是
principal/grant current state 与 epoch，不再复制成 redaction row。安全路径不依赖 ordinary row
insert、index 或 quota；同一 SQLite 的整体不可用仍统一 fail closed。两表使用独立 monotonic sequence、usage counter 和
rows/bytes/age budget；安全写从预留 control capacity 分配，并可在细粒度记录触限时原子折叠成
`projection_scopes.purge_epoch` 的固定大小 marker。

当前实现的真实 schema 必须从 `sqlite_schema` 枚举，不能信任手写 table constant。设计收敛
artifact 要对现有表做双向差集并证明每张表迁入上述唯一职责；同一事实的旧表在 shadow copy
验证后删除，不能为了兼容让两张表同时声称 current authority。

开放 envelope 的最小契约是：

```text
namespace, id, scope_id,
kind, schema_version, codec_id, entity_version, change_seq,
field_presence, business_status?,
record_digest, record_encoded_bytes,
canonical_residual_payload | payload_ref_id,
created_at, updated_at, expires_at?
```

- `kind` 和 `business_status` 是有界开放字符串，不得进入数据库 `CHECK ... IN (...)`、全局
  TypeScript union 或中央白名单；新增 namespaced kind/status 不得要求 Core schema migration；
- 已知 kind 仍由 domain command 执行逐类型 payload、权限和状态转换校验；未知 kind 可以在
  编码、大小、引用和授权约束内保真 round-trip，但没有注册 handler 时保持 inert，不能执行、
  不能获得权限，也不能被猜成 `pending`、`delivered` 等默认业务状态；
- canonical **record** 必须表达 envelope 承诺的完整 structured value，但物理上由强约束列与
  只含未抽取字段的 residual payload 共同组成，不把相同字段再存进原始 JSON。确定性重组后的
  canonical encoding 必须匹配 `record_digest`；`field_presence` 区分 optional field absent 与
  explicit null，不允许仅靠 SQL NULL 猜测。Migration 必须从 source record 重组完整 canonical
  fact set：message-owned reply/quote/app metadata/unknown fields 留在 message logical record，
  reaction 与 attachment/content ref 进入各自 fact；二者都不能丢失或重复；
- 只为已经存在的 query shape 建 `(namespace, scope, kind, sort key)` 等索引。不能为所有开放
  status 建全局索引，也不能同时保存一份原始 JSON 和一组同义列。

Message 把开放业务语义与闭合存储位置分开：`message_kind` 和完整 message-owned open envelope 保持
开放；`payload_storage_state` 可以是由 message repository 独占的闭合状态机，因为它决定
hot-inline、R2 segment、redacted 等 reachability 和删除安全。`message_heads` 只保存 message
identity、Channel sequence、author、entity version、`body_hash`、`record_digest`、recall/delete、
search rank 和当前 payload reference；`hot_message_payloads` 保存尚未安全迁出 Core 的完整
bounded `message_payload_bundle = { body, sender_snapshot, message_residual }`。其中 residual 只含
未抽取的 message-owned reply/quote、app/rich metadata 与未知字段，绝不重复
body 或 sender snapshot；历史 label/email、agent name、
instance/channel-instance、goal、git branch、model、effort、status chips、workspace 和 avatar 不能从
current sender catalog 反推。需要独立并发、唯一约束或已知查询的 related fact 才进入独立
extension record 或专表；一旦分离，就不得继续复制在 message payload bundle。不是每种可选能力都
需要一张表。

Message 只保存稳定 `reply_to_message_id`；只有产品原记录明确存在的 immutable quote snapshot
才作为 message-owned residual 保留，运行时 hydrated reply context 不复制。Mention target 可以是
immutable message metadata，但 `mentionReadStatuses` 是 per-user mutable current state，必须映射到
`attention`/delivery facts 并独立参与 source fact-set digest，不能进入 message `record_digest`、
archive bundle 或 projection message row。

一个 legacy message source record 可以映射为一个 canonical fact set：一个 message aggregate、
零到多条 reaction fact 和零到多条 attachment/content ref。Reaction 因独立 actor/message 复合
唯一约束保留关系表；annotation 进入 extension/ledger，attachment descriptor 进入
`content_refs`，因此这些独立事实不得再复制进 message payload bundle。
`raw_source_record_digest` 在任何字段抽取前对原 key/value 计算；
`canonical_fact_set_digest` 对按稳定顺序重组的目标 facts 计算。独立 verifier 必须从目标 facts 与
approved transform proof 反向重组 source logical value并再次得到 raw digest；message
`record_digest` 只覆盖 message columns + payload bundle。附件 binary 只在 R2，fact set 只保存
immutable ref，但 binary→ref 映射必须出现在 transform proof。

Annotation 的唯一 canonical owner 是 registered `xmatrix.annotation` extension namespace：
`scope_kind=channel`，固定 envelope kind 为 `xmatrix.annotation.record`，而产品的 annotation
namespace、`target.kind` 和 payload 都是有界开放值，不进入 SQL/协议枚举。已知 target 只校验其
结构和引用，未知 target 保真但 inert。Annotation mutation、message CAS、extension change head、
projection outbox 和 idempotency 必须在同一事务提交；CORE_ACTIVE 不得回读
`message_annotations`。旧表只作为冻结的 LEGACY_ACTIVE/PITR shadow 保留，且
`xmem.canonical.v1` 继续由 Channel curator 独占写删。

Control 同样分开：开放 `kind/business_status/payload` 表达产品语义；唯一闭合机械字段
`dispatch_state` 表达 dispatcher 的 pending/leased/terminal 状态，lease owner/until、attempt 和
backoff 只是受该 reducer 约束的附属列。不能让一个通用 `status` 同时承担业务语义和 lease
状态，也不能把任意 legacy control family 塞进一个
只接受固定 transition graph 的 operational intent 表。authority phase、projection build、
job lease、R2 upload/GC、ACL/grant 和 secret approval 等闭集归属于各自安全 reducer，不扩散成
全局业务枚举。

Management 只保留一份 authoritative work-item current state 和一条有界 ledger。Transition、
action、verification 与 compensation 可以是同一 domain ledger 的不同开放 event kind；只有
确有不同安全边界、保留期或查询约束时才分表。普通读取使用 Local Replica，不在 Core 再保存
完整 management snapshot。Work-item residual payload 不得再次嵌入已经抽取的 id、scope、state、
version、evidence 或 transitions；current columns + residual payload + ledger 是完整 canonical
表示。

Immutable R2 metadata 使用一份 object catalog 和 live refs；history payload、attachment、
projection root/segment 都复用同一 content-addressed object 原语。对象内的完整 Merkle 目录留在
R2，属于内容 authority；Core `content_refs` 中的 parent→child edges 是可重建、但 GC 删除前必须
完整的 safety index，不是第二份内容 payload/目录 authority。Closure edge 带 generation；
`content_closure_heads` 为每个 retained root set 保存唯一 published generation、root-set digest、
edge count/bytes/digest，并可登记一个有 TTL 的 candidate/job。

Worker 分页提交每个 reachable manifest node 的 parent→direct-child edges（不是只展开 root 第一层），
并与 candidate generation、未变化 retained-root set、目录 digest 和全部 child checksum 绑定；
partial pages 只写 candidate generation。Core 逐页验满 edge count/bytes/closure digest
后，只有 current retained-root-set digest 仍匹配时才 CAS published head；crash candidate 被忽略并
按 rows/bytes/age/lease reaper 清理，已发布 generation 不由 candidate reaper 删除。GC 只读取
published generation，并在 nomination→lease→external-delete authorization 以及删除后 finalize 的每个
Core CAS 边界重新核对 not-before、live upload hold、current root-set digest 与 published head/closure；
任一不一致就停止删除并重建。active/delete-authorized/reconciling lease 与新 object/ref、candidate
closure publish 互斥。外部删除授权过期时不能直接重发删除：先进入 reconciling，由 Worker 用精确
size/checksum/ETag 做 R2 HEAD；对象仍在则回到 pending 并重新取得完整授权，对象已缺失才在再次核对
canonical closure 后完成 catalog/job CAS。R2 LIST 或 Worker 自报“不可达”都不是删除 authority。
Projection build checkpoint 属于有 TTL 的 Core job；R2 staging 只承载 immutable bytes，不能
单独成为 job/cursor authority。

新增物理表必须同时回答以下问题，否则不得进入 schema：

1. 它保存的唯一 canonical 事实是什么；
2. 哪个已存在的查询、唯一约束、原子边界或安全隔离无法由现有原语表达；
3. owner、最大 rows/bytes/age、清理条件和 GC owner 是什么；
4. 为什么它不是另一张表的同义 current state、可重建 projection 或 migration 临时状态；
5. 新增未来 kind/status 为什么不能只扩展 versioned envelope。

长期 schema 还遵守：

- 所有可变 aggregate 都有 `version`，更新使用条件写实现 CAS；
- `message_heads` 以 `(channel_id, sequence)` 为主顺序，并对 `message_id` 建唯一约束；归档只
  删除已由 R2 引用覆盖的 hot payload，不删除仍需 mutation/evidence 的 head；
- `space_members`、`channel_access` 使用独立行，不把成员数组嵌入 Space value；
- sequence、instance ordinal 和其他单调计数器使用明确 counter/head 原语；不能伪装成
  migration audit 或 control intent。Cursor 使用单调 `MAX(acked_sequence)` 合并，重复 ACK
  不产生历史；
- 读取使用 keyset pagination，不使用全表加载和大 OFFSET；
- 每个二级索引必须对应已知查询并计入写放大预算；
- schema migration 在 constructor 中通过 `_sql_schema_migrations` 快速执行；constructor 不
  扫描业务表、不访问 R2、不执行网络请求；
- 实现必须生成 table-to-primitive inventory。migration/session/copy/verification 临时表不算
  产品模型，核验与 PITR 保留窗口结束后必须清理；产品请求不得查询它们。

#### 3.1.1 当前实现收敛门

候选布局尚未完成“现有表 → canonical fact → 候选 primitive”与反向“每个产品不变量 →
唯一物理 owner”的全量证明，因此不能宣称它已经覆盖全部能力，也不能用手写 table constant
代替事实。每次实现都必须从 `sqlite_schema` 生成 exact inventory；artifact 逐表记录 schema
digest、canonical fact、查询/唯一/原子/安全理由、owner、权限路径、rows/bytes/age budget、
retention、清理责任和目标去向。Profile creation、trace access、secret grant/approval、Space
action claim、Role、connector execution、OAuth session 等安全域必须逐项出现，不能因候选列表
未点名就被塞进 generic envelope 或 generic intent。

收敛不能通过直接删表完成。实施必须先完成 shadow copy、双向 count/bytes/digest、引用和行为
验证，再删除重复或临时表示。重点包括：

- 两套 sequence allocator 收敛为 `monotonic_counters`；
- Space ownership 只由 `space_members(role=owner)` 表达并以 partial unique index 保证每个 Space
  最多一个 owner，activation invariant 再证明每个 Space 恰好一个 owner；`spaces` 不再
  并列保存可读的第二份 owner authority，API 与 projection 中的 owner 字段从 membership
  投影。迁移中可暂时保留明确命名的 `legacy_owner_user_id_shadow` 作 source digest/PITR
  对照；它不接受 CORE_ACTIVE 业务读写，新建 Space 只写空 sentinel，并在核验和
  PITR 保留窗口结束后删除；
- control/approval/claim/session current rows 使用开放业务字段与闭合 dispatch state 分离的
  domain intent mechanics；不同安全边界不得强制共表，审计变化进入 domain-owned ledger；
- attachment/archive/projection 的重复 object metadata 收敛为 `content_objects/content_refs`，
  一个 scope 的 current root 只能由 `projection_scopes.current_root_ref` 声明；
- management current columns、residual payload、ledger 各保存不同事实，删除 transitions-in-payload
  和完整 Space snapshot；
- connector 产品 current state 只保存 connection 与 source relation；Channel binding 仅从 active relation
  的存在性推导，不再维护无 source identity 的 binding row；connection `channel_ids` 保留为独立的
  Channel action allowlist，既不创建 binding，也不能被读取为 subscription/bound 状态。迁移时无法归入
  exact direct subscription 的历史 `envrel:` 只允许进入下文已登记、store-only、无 handler 的
  `xmatrix.environment-relation` 封存 namespace；它不是第三套 connector current state。所有历史
  `appchbind:` 必须逐列无损写入 `app_connector_channel_bindings` compatibility shadow，并纳入两轮
  count/bytes/digest 和引用不变量；source relation 的存在不能单独授权丢弃，因为 Core 无法在同一
  sealed corpus 中独立闭合跨记录证明。
  该 shadow 的 hard ceiling 是 freeze-point corpus，没有新 writer、产品读取、Runtime handler、
  projection、export 或 fallback；保留它只为迁移核验/PITR，不能把它解释成 subscription 或第三套
  connector current authority；
- Agent trace 不建立 Core hot tail、migration chunks、owner ref 或 R2 trace segment。exact
  authenticated Agent 宿主机的本地 session trace 是唯一来源；Hub 只能在 session/instance
  存活期内做有界临时中继/缓存，并在终止或过期时清除。历史读取向记录该 exact instance 的宿主机
  按需请求；宿主机离线、未认证或本地 retention 已结束时明确 unavailable。迁移只对已逐前缀审查的
  trace family 记录 source rows/logical bytes/ordered digest 与 approved-discard 结果，不 hydrate、分块或
  复制 payload 到 Core/R2；因此超大历史 trace payload 不受 Core mapped-row/archive 上限阻断，
  但仍受通用 source inventory 单页有界和摘要完整性约束；
- migration entity rows 只保存 key/version/digest/bytes，不在目标业务行之外再次复制完整
  canonical payload；完整源证据进入隔离 artifact；
- `secret_refs`（当前物理兼容名为 `secret_catalog`）只保存 owner-scoped opaque
  `authority_ref`、`authority_version`、记录版本和有界展示 metadata；secret ciphertext/token 不进入
  Relay authority、migration journal 或 extension payload。可用值由独立的 owner-sharded
  `RelaySecretAuthority` Durable Object 加密保存，必须使用专用 `XMATRIX_SECRET_CATALOG_KEY`；Core
  通过不可伪造的内部 binding 按 exact ref/version 读取。legacy AES-GCM envelope 迁移时先在外部
  authority 幂等解密重加密，再原子提交 Core metadata+copy checkpoint；中断只产生可由同一 source
  proof 收养的外部 orphan，绝不能先丢弃 legacy ciphertext。已有非空 Core ciphertext catalog 在未完成
  evacuation 时必须 fail closed，schema upgrade 回滚并保留原库。

在该 inventory 和收敛证据完成前，可以运行只读 inventory/dry-run，但不得把当前 schema 描述为
最终精简设计，也不得执行生产 authority cutover。

### 3.2 一等可扩展存储

可扩展存储不是“任意 JSON 垃圾桶”，而是受 authority、namespace、版本、配额和索引规则
约束的长期能力。开放 envelope 是所有可演进 domain record 可复用的**编码契约**：message
aggregate 和 control intent 在各自 canonical row 内嵌这套契约；`extension_records` 只承载没有
专属关系 aggregate 的低频开放事实。任何 fact 只能选择 domain row 或 `extension_records`
其中一个 canonical owner，禁止双写。新增 kind/status/optional field 不需要 SQL migration；
新增独立唯一约束、热点 join、权限边界或生命周期时才需要新关系表。

`extension_records` 是规范性必备 primitive；新增 registered namespace/kind/schema version 不得新增
SQL 表。Derived index 不是默认配置：只有 descriptor 给出真实、受预算约束的 query shape，且扫描
canonical rows 不能满足其 SLO 时，才创建下面两张可重建 index 表。Head 只是 index 的原子发布标记，
不是第四份业务状态：

```text
extension_records                  # canonical
  namespace, record_id
  scope_kind, scope_id
  kind, schema_version, codec_id, entity_version, change_seq
  field_presence, business_status?
  inline_payload | immutable_payload_ref_id
  record_digest, record_encoded_bytes
  created_at, updated_at, expires_at?, deleted_at?

extension_index_entries            # derived and rebuildable
  namespace, index_name, index_version
  scope_kind, scope_id, generation, entry_type, encoded_key
  record_id, entity_version, tombstoned

extension_index_heads              # derived publication marker
  namespace, index_name, scope_kind, scope_id
  published_index_version, published_generation, applied_source_change_head,
  row_count, logical_bytes, index_accumulator, index_digest
  version, updated_at
```

Candidate generation 的 lease、固定 start head、applied head、rows/bytes/accumulator 与 retry checkpoint
复用有界 `jobs` primitive；candidate entries 以 generation 隔离。Finalize 先独立复算固定
`source_change_head` 的 count/bytes/digest，再以 expected published head/version 做 CAS；失败或 lease
过期时只清 candidate generation。这样没有 candidate head 与 published head 混读，也不为每个 index
增加一张状态表。

`extension_records` 可以由访问边界和生命周期相同的 domain 共享同一套物理 mechanics，但每个
namespace 仍由独立 repository/codec/command handler 拥有。`namespace` 使用稳定、可归属的
名字，例如 `xmatrix.annotation` 或 `provider.github.metadata`；数据库不维护可穷尽
namespace/kind/status 枚举。Message、reaction、attachment、control 或 ACL 已有 canonical owner
时不得再写一份 extension record。物理复用不产生跨 domain union，也不允许一个 handler 读取
另一 namespace。

Namespace 是 1–128 bytes 的 lowercase ASCII owner path；`kind` 与 `business_status` 是 NFC、
无控制字符、各不超过 128 UTF-8 bytes 的开放字符串。限制只约束编码和容量，不列举允许值。
Record ID、scope ID 和 payload 也有 descriptor hard limit，所有长度在 allocation 前验证。每个
namespace/scope 的 `change_seq` 从共享 monotonic-counter mechanics 分配，只表示该 partition 的 canonical
record 变化顺序；它不是第二个业务时间线。`scope_id` 只是 partition/reference，不是 ACL authority；
每次 read/write/project 都必须重新读取 Space membership、Channel access 或该 domain 的 canonical grant。

每个已注册 extension descriptor 明确声明：

- owner domain、允许的 principal 与 scope kind；
- 当前 schema version、可读取的历史版本和 canonical encoding；
- `unknown_kind_policy = store-only | opaque-readable`，默认为 `store-only`；
- inline 最大 bytes、是否允许 immutable R2 payload ref、每 scope/namespace 的 rows/bytes/age
  上限与 TTL；
- envelope validator、known-kind payload validator、unknown-kind opaque-preservation validator，
  以及已知 business status 的 command transition；
- 需要的声明式 secondary indexes、index version、key encoder 和 rebuild 策略；
- 每 record 的最大 index entries/bytes、每 index 的总 rows/bytes，以及 rebuild generation/head
  的完整性标记；
- projection、redaction、retention 和删除规则。

Descriptor 是 server-owned code/config，不是客户端上传的 schema，也不授予权限。普通客户端
只能调用 typed domain command；不能直接选择 namespace、写任意 record、注册 index、执行
SQL 或扫描其他 scope。

Unknown 处理严格分层：

- **registered namespace + unknown kind**：在既有 ACL、scope、codec 和 quota 内保真保存，保持
  inert。默认 `store-only`；只有经过隐私审查的 message-like namespace 才能选择
  `opaque-readable`，且只能返回长度有界、转义后的 opaque representation，不能解释 HTML、
  URL、action、provider metadata 或未声明 searchable field。Control、secret 和 authority
  namespace 永远是 `store-only`；
- **registered namespace + unsupported schema version**：原 bytes、version、presence 和 digest
  保真，但不得 parse/re-encode/index/project/execute；只有 descriptor 已明确证明该版本可安全
  opaque-read 时例外；
- **unknown namespace**：只能进入 migration `_migration_rows` 或隔离的加密审计 artifact，普通
  产品 read/projection/index/execute 全部不可达。Quarantine 必须声明 security classification、
  owner、hard rows/bytes/age、retention/删除决定和唯一 GC owner，不能无界长期驻留。完成 owner、
  scope、authority 与 retention 分类，或经审查证明为非产品 inert 数据并转成明确 retention 类别
  之前，它仍计入 unknown storage family 并阻断 cutover。

Canonical codec 不能等同于 `JSON.stringify`。Legacy structured-clone value 使用
`canonical-clone-cbor-v1`：确定性 type tag 保留 absent、explicit `undefined`、array hole、`null`、
boolean、string、有限数、`NaN`/`±Infinity`/`-0`、BigInt、Date、ArrayBuffer/typed array、array、
plain object 与 null-prototype object；object key 按规范 clone-string bytes 排序。Map、Set、Error、
RegExp、symbol/function 和循环引用在 v1 不受支持，遇到时必须隔离并阻断相关 authority family，
直到增加经过审查的 versioned codec；不得静默删字段或 JSON 化。新产品协议可以声明另一种
确定性 codec，但迁移必须保留 source codec id 并做这些边界值的 round-trip 测试。

`canonical-clone-cbor-v1` 的 byte layout 是规范而非实现建议：使用 RFC 8949 deterministic CBOR，
禁止 indefinite length，整数/length 使用最短编码；本协议只使用下列 application tags，其他 tag
一律拒绝。Clone string（包括 object key）用 tag 60011 + exact UTF-16BE code-unit bytes，因而保留
lone surrogate 且不做 Unicode normalization；object key 按这段 bytes 排序。

| Tag | Logical value | Payload |
| ---: | --- | --- |
| native | null / false / true | CBOR simple value；Number 不得用 native integer/float |
| 60000 | `undefined` | empty byte string |
| 60001 | array hole | empty byte string；只能出现在 tag 60009 |
| 60002 | JS Number | 8-byte IEEE-754 binary64 big-endian；NaN 固定 `7ff8000000000000`，保留 `-0`/infinity |
| 60003 | BigInt | `[sign: 0|1, minimal_unsigned_magnitude_bytes]`；零为 sign 0 + empty bytes，无前导零 |
| 60004 | Date | `[valid: bool, epoch_millis_int64?]`；invalid Date 为 `[false]` |
| 60005 | ArrayBuffer | exact backing bytes |
| 60006 | TypedArray/DataView | `[subtype_u8, byte_offset_u64, element_or_byte_length_u64, exact_backing_bytes]`；subtype 固定为 DataView=0、Int8=1、Uint8=2、Uint8Clamped=3、Int16=4、Uint16=5、Int32=6、Uint32=7、Float32=8、Float64=9、BigInt64=10、BigUint64=11 |
| 60007 | plain object | `[prototype: 0=Object, 1=null, sorted_entries]`；entry 为 `[tag60011_key, value]` |
| 60008 | field presence | 按稳定 field id 排序的 `[field_id_u32, state]`；state 0=absent、1=explicit logical null、2=present-value |
| 60009 | array | `[declared_length_u64, slots]`；slots 数等于 length，每项为 value 或 tag 60001 hole |
| 60010 | logical record | descriptor 定义字段 id 的 sorted `[field_id_u32, value]`，其中必须包含 tag 60008 presence |
| 60011 | clone string | exact UTF-16BE code-unit bytes |

Typed backing bytes、offset 和 length 都参与 digest，decoder 必须校验 alignment/range；endianness
不由宿主推断。V1 codec 本身只接受 tree。对经逐 family 审查、历史 structured clone 中确有重复
plain-object/array identity 的无环 DAG，migration adapter 可以先使用
`relay-v2-legacy-structured-clone-graph-v1`：按 canonical field/index 顺序保存一份去别名 tree 和显式
alias path 表，再以 `relay-v2-legacy-structured-clone-graph-v1+canonical-clone-cbor-v1` 编码；恢复时必须
先验证每个 alias copy 与 canonical subtree 的 bytes 完全相同，再重建共享 identity。该 envelope 是
一次性 source-proof/backlog codec，不增加业务 schema、消息 kind 枚举或长期 target table；cycle、重复
Date/view/backing-buffer identity 和未经审查的 family 仍隔离并阻断。Descriptor 的 stable field-id
registry、application tag 表和 typed subtype 表都进入 schema/codec digest。TypeScript、Rust 与 Browser
实现必须共享 golden byte vectors；任何一端产生不同 bytes/digest 都阻断发布与 migration。

这里有一个严格限定的历史 JSON-wire 投影，而不是第二套 graph 业务 codec：`spmgmtwork:`、非
idempotency 的 `spmgmtaction:`、`spmgmtdelivery:`、`spmgmtcase:`、`spmgmtmemory:`、
`spmgmtplaybook:`，以及 `space-management:reorg-execution:`、`reorg-rollback:`、
`trust-tier-approval:`、`trust-tier-downgrade:`、`trust-action-undo:` 的 JSON 字段，历史产品 reader
都在 JSON 边界后观察数据，因而无法观察无环 plain-object/array DAG 的 shared identity。Migration
仍先用上述 graph envelope 封存完整 structured-clone source、alias path 和 `undefined` leaf，并由独立
source proof 重建原始 graph/digest；随后才允许命名的
`management_ledger-json-wire-dealias-undefined-omission` transform 把每个 alias 展开为独立 JSON value
tree，并省略 object property 的显式 `undefined`。该例外不改变 source codec，不增加 target schema，
也不能扩展到 Date/binary/cycle、array `undefined`/hole、accessor、非有限数、idempotency key 或其他
family；这些值仍阻断 migration。

`field_presence` 是 canonical logical record 的一部分，显式区分 absent、SQL NULL 与 payload
中的 null/undefined。`record_digest = SHA-256(codec_id || 0x00 || canonical logical record bytes)`；
`record_encoded_bytes` 是同一 logical bytes 的长度。Logical record 包含 namespace/id/scope、
kind/schema/entity version、presence、业务字段、抽取的强约束 domain columns 与 residual payload；
不包含 inline/R2 存放位置、压缩方式、lease/attempt 或其他机械 metadata。`body_hash`、R2 object
content hash 与压缩后 object bytes 各有独立口径，不能冒充 `record_digest/record_encoded_bytes`。

Extension payload 禁止保存 bearer token、provider credential、daemon credential 或可直接使用的
secret ciphertext；只能保存经独立 secret boundary 管理的 opaque ref/version。Namespace、object
key、content hash 或 descriptor name 都不是 capability。

基础查询只支持 exact ID、当前授权 scope 的 keyset list 和到期清理。可选
`extension_index_entries` 只保存 canonical record 的紧凑派生 key，不复制 payload；普通 record
update/tombstone 必须在同一 transaction 删除旧 entries 并写入 published generation，以及正在
rebuild 的唯一 active candidate generation，同时递增 namespace/scope canonical source change head，
推进两个 generation 的 `applied_source_change_head`、rows/bytes 与 accumulator。
其物理主键至少覆盖
`(namespace, index_name, index_version, scope_kind, scope_id, generation, entry_type, encoded_key,
record_id)`。
每个 generation/record 必须另有一个不参与 query 的 reserved `version_marker` entry，即使该 record
没有 index key 或已 tombstone；它保存最新 entity version。Scanner 只有在 incoming version 不低于
marker 时才能原子替换 keys/marker，因此 delete 后的零 key 状态也不会被迟到旧 scan 复活。发布时
marker count/digest 还必须与 fixed-head canonical eligible-record count/digest 一致。
Rebuild 先在唯一 active Core job 注册 candidate generation、lease、start head 与 accumulator；
`extension_index_heads` 始终只描述 published generation。此后的每个 record mutation
在同一事务 dual-maintain published 与 candidate。Scanner keyset 分页读取 canonical current rows，
按 entity version 条件替换该 record 的 candidate entries，不能用较旧 scan 覆盖较新 mutation；
替换与 aggregate delta 在同一事务。完成全量 scan 后读取 canonical source head，证明 candidate
`applied_source_change_head` 相等且所有 `<= head` mutation 已 dual-write，再核对 rows/bytes/accumulator，
并原子 CAS
`extension_index_heads` 到
`(published_index_version, published_generation, applied_source_change_head, row_count, logical_bytes,
index_accumulator, index_digest)`。旧 generation 在 reader lease 结束后
有界清理。未完成时查询继续读旧 published generation，若没有可证明完整的旧 generation 则只能
fallback 到有界 canonical scan 或明确 unavailable，不能把 partial candidate 当完整结果。
Candidate cursor/digest/lease 使用唯一 active Core job row，不能再为每个 index 创建状态表。

`index_accumulator_v1` 是可增删的 256-bit commitment：每个唯一 entry 贡献
`SHA-256("extension-index-entry-v1" || canonical_entry_bytes)`，generation accumulator 对所有贡献
逐 bit XOR，`index_digest = SHA-256(accumulator || row_count_u64 || logical_bytes_u64)`。Entry hash
包含完整主键、entity version 与 encoded key；insert/delete/update 在同一事务 add/remove 贡献，
因此普通 mutation 后 marker 不会陈旧。发布/验收另做按主键排序的独立 ordered digest；两者任一
不一致都重建/fail closed。
它不能承担 ACL、资金/secret、全局唯一性、sequence 或 side-effect eligibility；extension 一旦需要
独立 foreign key、跨对象唯一约束、热点 join 或无法接受 index rebuild，就晋升为明确关系表。

写入遵守 compare-and-swap：相同 `(namespace, record_id, expected_entity_version)` 才能更新；
canonical digest 覆盖完整 logical record。未知字段和未知开放 kind/status 必须 round-trip；
缺失字段保持 absent/null，不能由存储层猜默认业务状态。Schema upgrade 使用 versioned、
确定性 codec，旧版本在升级 job 完成前保持可读；禁止在 constructor 中全表重写。

Record ID 由 namespace command 派生或服务端分配并永不复用。Product delete/TTL/retention 先用 CAS 把行变为
只含 identity/version/digest/deleted_at 的 bounded tombstone，在同一事务删除 index entries、释放
content ref 并推进 redaction；覆盖最长 replay/client lease/PITR 窗口后才物理删除 tombstone。
旧 update 因 expected version 不匹配不能复活已删 record。

`codec_id`（例如 `canonical-clone-cbor-v1`）与业务 `schema_version` 是正交版本：升级业务 schema 不
隐式改 codec，升级 codec 也不能在没有逐字节 proof 时重写未知旧 payload。`record_digest` 对抽取的
强约束列、field presence 与 residual 重组后的完整 logical record 计算，不包含 inline/R2 的物理位置；
相同 logical record 在 inline 与 immutable ref 之间移动时 digest 不变。Payload 只有一个 canonical
表示：小 payload inline；超过上限时先通过 5.1 的安全协议写 immutable
R2 object，再让 record 提交 payload ref。Record commit 必须在同一 Core transaction 创建对应
`content_refs`；update、TTL expiry、tombstone 或 product delete 必须同事务替换/释放旧 ref，并推进
必要的 projection safety state。Principal/scope authorization revoke 只推进 grant/epoch 与本地
purge，不删除仍被其他授权主体共享的 canonical record/ref。不得同时长期保存 inline 与 R2 两份正文，也不得先释放 ref 再
提交新 owner version。
R2 content hash/checksum 只由统一 `content_objects/content_refs` 持有，extension row 不复制。
`extension_index_entries`、Local Replica 和 R2 projection 都是派生表示，不改变这条规则。Index 不得
提供 ACL、uniqueness、sequence 或 side-effect eligibility；需要这些不变量时必须建立对应 domain
canonical relation，而不是升级 extension index 的 authority。

可扩展存储的容量是总预算的一部分，不得绕过 `storage_usage`、25% authority headroom、record
hard limit 或 namespace quota。大量 telemetry、presence、网络 sample 和未注册高频事件即使
“能放进 envelope”也仍禁止持久化；可扩展不等于无界。

### 3.3 只暴露原子业务命令

业务代码不获得通用 KV 或任意事务 DSL，只调用表达完整不变量的命令：

```ts
interface RelayAuthority {
  appendMessage(command: AppendMessage): Promise<CommittedMessage>;
  acknowledgeMessage(command: AcknowledgeMessage): Promise<DeliveryCursor>;
  createChannel(command: CreateChannel): Promise<Channel>;
  updateAgentProfile(command: UpdateAgentProfile): Promise<AgentProfile>;
  applyAgentControl(command: ApplyAgentControl): Promise<AgentControlRecord>;
}
```

可扩展存储的机械 repository 不是公开 command surface。每个 domain command 先完成自身
authentication、authorization、payload validation 和已知 transition，再在同一 transaction
调用 namespace-bound repository；不存在允许调用者绕过 domain 规则的 `putAnyRecord()`。

每个命令在一个同步 SQLite 事务中完成：

```text
读取 commandId 幂等结果
→ 检查权限、版本和业务前置条件
→ 写业务事实、sequence/cursor/intents
→ 写必要 job 与 storage_usage 增量
→ 保存幂等结果
→ commit
→ 返回 committed event
→ Runtime best-effort fan-out
```

提交前失败时没有可见业务效果；提交后投递失败时，客户端按稳定 message ID 和
Channel sequence 补洞。广播不是第二次提交。

## 四、存储与保留契约

### 4.1 三层硬预算

每类数据同时执行：

1. 单条最大 encoded bytes；
2. 数据集 row、age、logical bytes 上限；
3. 整库 physical `databaseSize` 和增长率红线。

`storage_usage(category, rows, logical_bytes)` 在同一业务事务中增减。`databaseSize`、
逻辑字节、写入放大、增长率和 archive lag 每分钟发送到 Analytics Engine，不写回
同一数据库形成新的观测负担。

`projection_changes` 作为与权威状态共库的 ordinary 恢复队列，初始硬上限为
100,000 rows、128 MiB logical bytes 或最老未发布记录 15 分钟。达到任一上限时不再累积细粒度派生事件，处理方式见 5.3 的
`base_reset_required` 状态机。只要 hot source 仍在预算内，ACK、ACL、revoke、recall、
delete 等不增加 payload 的权威命令继续提交；如果 R2 长期不可用并使 message hot payload、
attachment intent 或物理余量达到硬限，只对继续增加正文/binary 的命令返回可重试的
storage-backpressure 错误。恢复期 capture/export backlog 达到硬限时，所有会继续扩大
projection backlog 的非安全 mutation——包括 message create/edit、reaction、Follow-up、
catalog/metadata 变化——都可以收到可重试 backpressure，直到 exporter 追平；ACK、ACL、
revoke、retention hard-delete、recall/delete 和释放容量命令通过 entitlement/redaction
控制路径始终保持可用。

`jobs` 同样是事故边界：初始上限为 10,000 rows、32 MiB logical bytes 和 1 小时最老未完成
age。每个 `(kind, scope, epoch/range)` 最多一个 active job；重试只原地更新 lease、attempt
和 capped backoff，绝不新增一行。触限后 scheduler 只续租/合并现有任务并进入 degraded
告警，不能用 Queue 重投制造第二条无界日志。

权限撤销由 entitlement current state 直接推进；retention hard-delete 等 scope-content
删除使用独立 `projection_redactions`，只保存 ID/version，不与 ordinary outbox 共用表、索引或
usage budget。Tombstone 在进入 published base 且覆盖最长 local lease 后删除；如果 redaction
rows/bytes 触限，则使用预留 control capacity 合并为一个递增的 scope-wide purge epoch，客户端必须清空
整个 scope 并等待新 base，不能丢弃删除语义。Purge epoch 递增必须在同一事务中标记
clean-base rebuild required。

所有可增长类别必须在 server-owned `storage_budget_policy` code/config 中有显式配置；它不是
新的业务表，缺配置即拒绝启用，
不能退化为无上限。以下是初始 reference ceiling，生产只能在审查容量证据后修改：

| 类别 | Rows | Logical bytes | Max age / generation | 触限行为 |
| --- | ---: | ---: | --- | --- |
| `projection_changes` | 100,000 | 128 MiB | 15 分钟 | coalesce 后进入 base reset；扩大 backlog 的写 backpressure |
| `projection_redactions` | 100,000 | 32 MiB | 覆盖最长 client lease 后清理 | 折叠为 scope purge epoch；安全写继续 |
| Jobs / candidate checkpoints | 10,000 | 32 MiB | active 1 小时；terminal 按类型 TTL | 原地重试/合并，不新增 job |
| Domain intents（每个安全分区） | 50,000 | 64 MiB | active 有 TTL；terminal 最长 30 天 | 拒绝新 allocation；cancel/release 继续 |
| Hot domain ledger | 500,000 | 512 MiB | 最长 30 天 | 封装 immutable segment 后清热层 |
| `content_objects` + canonical owner refs | 1,000,000 | 256 MiB | live/retained ref 存在时不按 age 清理 | 拒绝新 binary；删除/release 继续 |
| Content closure safety index | 2,000,000 | 512 MiB | 1 published + 1 candidate；candidate 24 小时 | 停止 GC delete、reap candidate、重建 closure |
| Extension canonical（每 namespace） | descriptor ≤ 100,000 | descriptor ≤ 128 MiB | descriptor ≤ 180 天或显式 product retention | 拒绝该 namespace 新写 |
| Extension index（每 index/scope） | 1,000,000 | 256 MiB | 最多 1 published + 1 candidate；candidate 24 小时 | reap candidate；保留 published |
| Hub transient trace relay/cache（non-authoritative） | 每 Runtime cell 100,000 | 每 Runtime cell 64 MiB；Core 0 bytes | `min(session/instance lifetime, 24 小时)` | 终止/过期立即清除；触限停止缓存或显式 backpressure，绝不写 Core/R2 |

Agent trajectory/trace 的产品可见性不等于 Hub 存储权威或永久 retention。Hub cache 触限、
session/instance 终止或 TTL 到期时必须清除；需要历史时只向 exact authenticated Agent 宿主机
按需读取。宿主机不可达或已清理时返回明确 unavailable，不能用 stale cache、静默截断后的“完整”
结果或 R2 归档伪造可用性。

安全路径另有不可借用的 `control_reserve_bytes = max(64 MiB, platform_limit * 1%)`，用于 ACL、
revoke、redaction、purge marker、cancel 和 capacity release；普通/extension/job allocation 不能
消耗它。细粒度 safety rows 接近 ceiling 时必须在仍有 reserve 时提前折叠，不能等写满后才尝试。

“25% authority headroom”必须分开证明：Core physical capacity 使用同一 Core 数据库的 live
`databaseSize/platform_limit <= 75%`；Core sustainable write throughput 使用最坏生产形态下
`2× future peak <= 75% × verified_sustainable_write_rate`。Legacy DO、Core DO、R2 和本地存储
分别报告，R2 bytes 不进入 Core capacity 分母，R2/Queue throughput 也不能冒充 Core 写吞吐余量。

Core 只为当前授权 principal 暴露一个 typed、keyset-paginated redaction control read：输入
`scopeId/redactionEpoch/afterHead/limit`，输出连续的
`{ redactionSeq, entityKind, entityId, entityVersion, operation }` 与 next head，不返回正文、
历史页或通用 SQL。`afterHead < redactionFloor` 时返回 scope purge/rebuild required；每页受
rows/encoded-bytes/rate limit 约束并可按同一 cursor 幂等重试。

### 4.2 初始数据策略

| 数据集 | Relay authority 热层 | 后续位置/清理 |
| --- | --- | --- |
| Space、ACL、Profile、Role、Workspace | 权威 current state；单记录有大小上限 | 随业务对象生命周期 |
| Message head | 全生命周期最小权威 metadata | 产品删除后按 tombstone/审计策略清理 |
| Message hot payload | canonical message record inline 最大 160 KiB；migration typed copy row 中 payload bundle 超过 32 KiB 即走 referenced path；每 Channel hard cap 200 条/8 MiB，132 条触发并回落至受保护的 100 条；`retain_until` 是 7 天软归档资格而非分钟扫描或删除 SLA；全局 1 GiB | 发布并验证 R2 segment 后只删 payload 热行；仅 migration 可把最大 1,125 KiB（1,152,000 bytes）的历史 canonical record 封存为 immutable object/ref |
| Cursor / Attention | 当前游标和未读项 | ACK 后确定性删除已读派生项 |
| Shared Memory | 每 value 64 KiB、每 workspace 10,000 keys/64 MiB、全局 512 MiB | 读写路径按 TTL 判定失效并机会式回收；不占用 Relay authority alarm |
| Active Run / domain intent | 活跃状态；按安全分区隔离 | terminal 后 24 小时至 30 天内归档或删除，按数据类型决定 |
| Agent trajectory/trace | trace payload 在 Core/R2 为 0 rows/0 bytes；Hub 仅有界临时中继/cache | exact 宿主机本地 session trace 为来源；Hub 随 session/instance 终止或过期清除，历史按需取，宿主机离线则 unavailable |
| Extension canonical record | descriptor 限定的 inline residual payload 或 immutable R2 ref | 按 registered namespace retention/TTL；unknown namespace 不进入产品表 |
| Extension derived index | 仅紧凑 key/ref，受 entries/bytes/generation 上限 | descriptor version 变化时可删除重建 |
| Management ledger | 活跃 work/action current state | terminal 记录验证归档后清热层 |
| Search index / Follow-up read projection | 0 | User Local Replica，可随时删除重建 |
| Attachment / media local cache | 0 | Local Media Cache，按 byte/count/age/LRU 淘汰 |
| Extraction checkpoint / candidate inference | 0 | Management Overlay，可随时删除重建 |
| Idempotency / Job | 重试窗口内有界保留；active job 具有唯一键 | 完成确认后按 TTL 和字节清理 |
| `spmgmtevent:` / `obs:` / presence | 0 | live delivery / Analytics Engine |
| Attachment upload intent | `domain_intents_upload` 只保存 bounded hash/size/final-key/expiry；同事务写 content-graph live hold | commit 后转 terminal 并释放 hold，按 bounded retention 清理；过期 intent 原子转 expired、释放 hold 并写 reachability GC job |

用户可见历史的产品保留期不由热层决定。普通客户端的 timeline、search、history-around
和 Follow-up payload 只从 Local Replica 或 R2 projection 读取；Core 热 payload 只服务
command validation、Agent delivery/replay、projection export 和归档。

### 4.3 整库水位

新 Core 的容量目标：

| 状态 | 条件 | 动作 |
| --- | --- | --- |
| Green | physical `databaseSize <= 2 GB` | 正常运行 |
| Yellow | `2–4 GB` 或 90 天预测达到 4 GB | 加速归档，执行恢复演练 |
| Red | `>= 4 GB` 或 90 天预测达到 6 GB | 启动外部数据库 migration |
| Exit | 达到 6 GB 前 | 完成外部数据库切换 |

V2 生产 cutover 时必须满足 `databaseSize <= 4 GB` 且按真实增长率预测 90 天内小于
6 GB。技术红线优先于用户、Space 或 Channel 数量。

## 五、R2 协议

### 5.1 附件和大 payload

R2 binding 具有强一致性，但 R2 与 SQLite 之间没有跨产品事务。安全协议使用 Core 先记
intent、R2 后写 final immutable object、Core 最后提交引用：

```text
Core upload_intent -> R2 objects/<content-hash>
                   -> Core content_objects + content_refs commit
```

1. Relay authority 先在独立 upload security domain 的 intent mechanics 创建有 TTL、单条大小上限的
   `blob-upload` intent，固定
   scope、content hash、encoded size 与 server-derived final immutable key；
2. 授权 gateway 只允许向该 final key 执行条件 PUT，并校验 size 与 checksum；同一 hash 的
   已有对象必须逐项匹配；
3. Relay authority 在一个 transaction 中重新校验 intent 和对应 live upload hold，对 `content_objects` 执行
   insert-or-exact-match（任何已有 metadata 冲突都 fail closed，绝不覆盖 immutable catalog）、
   拒绝 active/reconciling GC delete authority，提交业务 owner 到 object 的 `content_refs`，将 intent
   转为 terminal 并释放 hold；
4. 过期未提交 intent 合并为有界 GC job；只有 object 没有任何 live `content_refs`、当前/
   retained root 或其他 live intent 时才允许删除；
5. 产品删除先在 Core 同一 transaction 解除引用并写 tombstone/唯一 pending GC job；调用方要求的
   更晚 not-before 必须取 max 后持久化，不能只出现在响应里。经过 PITR/客户端恢复窗口后再做相同的
   reachability GC；解除引用时间、not-before 和 retry checkpoint 保存在唯一 active GC job/
   retention ref，不增加第二套 object catalog。Core claim 先以 current root-set digest、published
   closure、live hold 和 not-before 授予有时限的 external-delete authority；Worker 只按 Core 返回的
   exact size/checksum 与现场 ETag 条件删除，再以 expected job version finalize。删除之后 finalize
   失败或 lease 过期必须进入 HEAD reconciliation，不能把旧授权当成可重放删除许可。

`CORE_ACTIVE` 的 create/read/commit/expiry/status 和 message-owned immutable payload release 只读取
`domain_intents_upload` 与 content graph；`blob_refs`、`blob_upload_intents`、`r2_gc_candidates` 只保留为
`LEGACY_ACTIVE`/PITR shadow。即使 shadow 非空或被投毒，也不得影响 canonical 行为、alarm 或 status，
且在 PITR 保留窗口关闭前不 drop。

需要 resumable 临时块时可以使用独立 `staging/<intentId>/` prefix，并在提交前合成为 final
key；bucket lifecycle 只允许清理该 staging prefix 或 incomplete multipart upload，永远不
按 age 删除 `objects/<content-hash>`。任何中间失败最多留下由 intent 可追踪的孤儿，不产生
悬空权威引用。

PITR 可能把 Core 恢复到 upload intent 创建之前，因此低频 GC 可以用 R2 强一致的 bounded
prefix `LIST` 发现没有 intent 的孤儿；LIST 只用于候选发现，删除决定仍必须交回 Core，对账
当前 canonical owner refs、published closure generation/head、live intents、committed/retained
roots、GC not-before 和完整安全窗口。目录由 Worker 展开时，Core 只接受 3.1 定义的完整
candidate closure proof，并以未变化 root-set digest 做 CAS；partial candidate 永不进入 GC 视图。
GC 绝不把“某次 LIST 未看到引用”当成 authority。

R2 bucket 始终保持 private。Object key、ETag 或 content hash 都不是 bearer capability；
Browser/daemon 读取必须经过短期、scope-bound 的授权入口。客户端缓存只以不可变 content
hash 为键，不能把临时下载 URL 持久化为业务引用。

### 5.2 Channel 冷历史

一个 base history segment 覆盖不可变的连续 timeline sequence 范围，目标压缩大小为
1–8 MiB；不为每条 message 创建一个 R2 object。1 MiB 是合并效率目标而不是进度门槛：
当一个有界 source page 已满，或其 canonical message record bytes 已达到 1 MiB 时，即使内容
高度可压缩，也允许提交更小的压缩对象，避免热层因永远达不到压缩下限而无法归档。

Segment record 保存 message aggregate 的完整 canonical payload bundle：body、immutable sent-time
sender snapshot，以及只含未抽取 reply/quote、app/rich metadata 和未知字段的
residual；reaction 与 attachment/content ref 是独立 canonical facts，只保存其稳定 ref，不复制进
bundle。每条 archive record 同时携带 `body_hash` 与 `record_digest`，前者验证用户可见正文，
后者验证强约束 columns 加完整 payload bundle 的 logical record。

```text
select committed range
→ encode + compress
→ PUT content-addressed R2 object
→ verify checksum
→ Core transaction:
     insert-or-exact-match content object + history-range ref
     CAS message_heads payload refs from expected versions/digests
     delete only the exactly covered hot payload rows
     update storage_usage
```

在 content object/ref、每条 message payload-ref CAS、`body_hash` 和 `record_digest` 全部提交前
禁止删除任何 payload 热行；`message_heads` 继续保留。相同 range/source-fact-set digest/object
checksum 的重试返回同一结果，任一 metadata 冲突都 fail closed。

`CORE_ACTIVE` 以 `content_objects` 中的 immutable Channel history object 和
`content_refs` 中的 typed contiguous-range owner ref 作为唯一 segment/tail/manifest authority。
Range ref 的 manifest key 使用固定宽度单调序号，descriptor 保存 Channel、`sequence_from/to`、
source digest 和 archive format version；scheduler、claim、finalize/replay 与 projection archive
source 均从这组 canonical facts 推导。`archive_segments` 仅为 `LEGACY_ACTIVE`/PITR shadow；非空、
重叠或被投毒的旧行不得影响 canonical range、R2 key、message payload ref 或 activation blocker，
并且在验证和 PITR 窗口关闭前不 drop。Private Worker 必须先 PUT-if-absent，再用 HEAD 核对精确
size/checksum，Core 才接受同一事务 finalize。

冷归档不能取消历史 message edit。Hot payload 仍在 Core 时由 message command 直接重组完整
bundle；只有 archive ref 的 message 使用有界 `message-rewrite` domain intent：

1. Core 先验证 principal、scope、typed patch、idempotency key、expected entity version、当前
   payload ref、`body_hash` 与 `record_digest`，再持久化只允许这次 patch 的 rewrite intent；客户端
   不能上传一份“完整旧 envelope”作为替代；
2. 内部 Worker 领取 intent，读取精确 archive record，验证 object/range/index/body/record digest，
   用同一 canonical codec 重组完整 payload bundle，只修改 typed patch 点名的字段并 byte-preserve
   其余 unknown/residual 字段；reaction/content-ref 等独立 facts 只能走各自 command；
3. Worker 写新的 immutable object/ref candidate，并提交 old/new digest、codec id、patch digest、
   encoded bytes 与 server-side HEAD 证据。Core 重新核对 intent 与 expected head 未变化后，在一个
   transaction 中推进 entity version、`body_hash/record_digest`、payload/content ref、storage usage
   和 `projection_changes`；任一不一致都拒绝 finalize，candidate 只成为可 GC orphan；
4. 旧 object 继续覆盖 PITR/client lease，后续 history compaction 才合并版本。Worker 是受限的
   canonical codec 执行器，不拥有 authorization、version 或 ref authority；跨语言 golden vectors
   与故障注入必须证明未点名字段保持逐 byte 不变。

### 5.3 客户端 Projection segments

普通客户端不读取 Core 中的历史或 Follow-up payload。每个会影响本地查询面的 Core
事务都在同一 transaction 写入 bounded ordinary `projection_changes`：

```text
visibility_scope_id, change_seq,
snapshot_epoch,
entity_kind, entity_id, entity_version,
operation(upsert | tombstone), bounded_hot_source_ref
```

表内唯一顺序键为 `(visibility_scope_id, change_seq)`。安全删除使用独立
`projection_redactions(visibility_scope_id, redaction_seq, ...)`；两套 sequence 不混用。

Core scheduler 按固定 encoded bytes、记录数和时间窗口为 outbox range 创建有界 export
job；Projection Export Worker 分页领取该 range，封装为连续、不可变、带 checksum 的 R2
change segment，再由 Core transaction 把该 immutable object/ref 接入当前 scope root，并更新
`projection_scopes.current_root_ref/published_change_head`。这是唯一 current-root authority；
wire protocol 可使用 camelCase 别名，但存储模型不再引入 `publishedRoot` 或另一份 manifest head。
Segment/object metadata 复用统一 content object 原语，不另建一套
按 projection subtype 分裂的 object catalog。DO alarm 不压缩正文、不读取大对象，也不执行
R2 I/O。只有
manifest 已提交且 PITR/R2 保留窗口允许时，才能清理对应 outbox 和 hot payload。Outbox
不复制完整大正文；它只引用同一 transaction 已提交、在 export 完成前不可回收的 bounded
hot source。

当前实现沿用既有 `projection_scope_heads` 作为上述 scope head，不再新增同义 schema：
`published_root` 必须与 `content_refs(root_set_id = projection:<scope>, generation = 0,
ref_id = current-root)` 指向同一个 `content_objects` manifest。Payload、segment 和 manifest 只登记
一次 immutable object；segment/manifest 的 direct-child count/bytes/digest 写入 object commitment，
完整递归边只存在于 candidate/published generation。Candidate 未经 scope-head、stable current-root ref
和 `content_closure_heads` 同事务 CAS 前不可见；替换下来的 root 仅以有到期 job 的 retained ref
覆盖 PITR 窗口，到期后触发同一 base-reset/published-generation 路径重建 closure。R2 manifest 本身
永久保存 chunks、coverage 与 Merkle 目录事实，Core 不复制这些目录字段。六张旧 projection metadata
表只作为 `LEGACY_ACTIVE`/PITR poison-inert shadow 保留，不是 `CORE_ACTIVE` fallback 或 activation
blocker。

Outbox 是有界 replay window，不是永久事件总账。当 row、bytes、age 或整库余量触及硬限
时，Core 在同一事务中把该 scope 切入 reset mode：

```text
mark scope.base_reset_required = 1
set scope.pending_build_epoch = published_snapshot_epoch + 1
coalesce the unpublished granular tail into one dirty marker
```

Reset 开始时绝不推进 `published_snapshot_epoch` 或替换
`projection_scopes.current_root_ref`。R2 不可用期间，
后续变化仍然提交到权威 current state，并只合并到这个 dirty marker；旧 root 对仍有权
且 root 已覆盖当前 redaction head 的客户端保持可读但 freshness 为 stale；否则停止签发
该 root 的新 ticket。客户端不会因为内部 `base_reset_required` 提前删除最后一份完整
generation。ACL/revoke 仍直接推进受影响用户的
`authorizationEpoch/grantVersion`；retention hard-delete 直接推进 scope redaction head 或
purge epoch。两类安全控制都不依赖 outbox 或 rebuild 及时发布。

R2 恢复后的 rebuild 使用有限 cutover：

1. Core transaction 固定 `build_start_change_seq = S` 与 current purge epoch，开启一条新的
   bounded capture tail；
2. Exporter 分页读取 Core current state 与已提交 R2 archive/history root，以确定性编码构建
   candidate base。跨批次 cursor、chunk hash、candidate ref 与 expected heads 始终保存在
   bounded Core job；R2 staging manifest 只承载其引用的 immutable bytes，不能替代 checkpoint
   authority。重复 Worker 从同一 Core checkpoint 继续并产生相同 hash；
3. 扫描期间 `S + 1` 之后的所有 ordinary projection mutation 进入 capture tail，并被 Worker
   持续封装到 immutable R2 segment；Core 只保留尚未确认导出的有界窗口，不把整个 rebuild
   tail 压在 SQLite 中；
4. Base 扫描完成后，Core transaction 同时固定 `cutoverHead = H`、
   `cutoverRedactionHead = R` 与 purge epoch。Exporter 验证 candidate base 加连续
   `S + 1..H` tail 能按 entity version/tombstone 幂等收敛到 H，再应用所有 `<= R` 的 typed
   redaction，证明已删除实体与 excerpt 不在 candidate 中，并提交声明 `(H, R, purgeEpoch)`
   coverage 的 root/checksum；
5. Core 以 expected current root/epoch 做 CAS，一次 transaction 原子切换
   `projection_scopes.current_root_ref`、`published_snapshot_epoch`、`published_change_head` 和
   root redaction coverage，
   同时验证 purge epoch 未变化，随后清除 reset state；`H + 1` 之后的普通变化成为新 root
   上的正常 delta，`R + 1` 之后的删除继续通过 redaction control stream 生效。

归档正文 bootstrap 不引入第二条导出协议。Core 只从当前 message head、精确
`payload_ref` 与统一 content object/history-range ref 生成 metadata-only source descriptor，不执行
R2 I/O；分页同时限制行数、claim bytes、唯一 archive object 数、压缩总字节，并按允许的最大
canonical message payload bundle（包括 body、sender snapshot、reply/quote、rich metadata 与
unknown fields）及其最坏 codec/JSON transport 放大预留 payload-pack 空间。Worker 按 object 分组，只做一次
HEAD/GET/解压，逐层校验 committed size、checksum、规范 object key、Channel/sequence range、
record index、message/version/search rank、object content hash、`body_hash` 与 `record_digest`，
再把完整 payload bundle 送入原有 canonical payload pack、segment、manifest 和 expected-version CAS
finalize。对象缺失、元数据漂移、
超界解压、记录不一致或 checksum 不符都保持旧 root 并 fail closed。

任何单次 DO 请求只领取固定 rows/bytes，不持有跨请求事务，也不全量加载 scope。R2 再次
中断时保留 checkpoint 并恢复，不通过反复作废 candidate 制造饥饿；若 mutation 长期快于
export 或 capture backlog 达到硬限，则按 4.1 对所有扩大 projection backlog 的非安全
mutation backpressure；hot source 达到硬限时同时拒绝新增正文/binary。客户端只在 CAS
成功、manifest 发布新 epoch 后重建该 scope。这样既不静默跳过 delta，也不会让 projection
故障再次耗尽权威数据库。安全控制本身永不被 backpressure；若 redaction/purge epoch 持续
变化得快于 clean-base 构建，scope 保持安全的 unavailable、继续应用 control stream，待
固定 R 可覆盖后再恢复 bootstrap，不以暴露已删除内容换取可用性。

R2 projection 包含：

- message create/edit/recall/delete 的完整 message payload bundle、reaction snapshot 和 thread summary 的 upsert 或
  tombstone；
- Follow-up current-state upsert/tombstone；
- Space、Channel、Role、Agent Profile、machine、workspace、app connection/source relation 的授权
  catalog 变化；
- descriptor 明确标记为 client-projectable 的 registered extension record；segment 保留
  namespace/kind/schema version/field presence/record digest。Known kind 使用 per-kind policy；
  unknown kind/schema version 只按 namespace `unknown_kind_policy` 导出，unknown namespace 不导出；
- history base segment、projection change segment 与 compaction watermark。

Projection wire `entity_kind` 只区分具有不同 apply/delete/authorization mechanics 的结构类别，
不是 message/provider/business kind 的闭合集。开放事实统一使用一个结构类
`extension_record`，实际 namespace/kind/schema version 留在 envelope；因此新增业务 kind 不改
projection schema。只有新增了不同安全或删除语义的 canonical aggregate，才经协议版本升级增加
结构类。

Message searchable text 不建立第二套长期云端正文。Base manifest 尽量直接复用已提交的
content-addressed archive/history segment；change segment 只携带尚未进入新 base 的有界
upsert/tombstone。Compaction 提交新 base 后，旧 change object 依照 PITR/客户端恢复窗口
回收，使正文存储只有常数级版本与迁移重叠。

每条 projection record 在 Core 提交时绑定一个明确的 `visibilityScopeId`。一个 R2 segment
只包含同一 visibility scope 的记录，segment 边界由 bytes/count/time 决定。Message 使用
Channel access scope；Follow-up 固定使用
`{ kind: "evidence_channel_acl", channelId: evidenceChannelId }`，Human 必须同时是 Space
member 且当前可访问 evidence Channel。一个 Follow-up 只允许一个 primary evidence
Channel。Owner-only machine/workspace 使用 owner scope。云端每个 authoritative
visibility scope 的内容只存一份；同一 owner 的多个客户端共享其 owner-private scope，
不按 consumer/device 复制。
Exact configured management run 的 overlay 单独获得该 Space 全部 active、non-archived
Channel 的只读 scope；`managementVisibility` 只在 headless observation、候选抽取和
management action evidence 层检查，不能缩窄 filesystem mirror。

Relay authority 保持一个 commit/current-state/manifest authority；`visibilityScopeId` 定义 R2
授权封包与逻辑 projection stream。每个 stream 始终按相同 encoded bytes/count 上限生成
segment；低流量 stream 等待达到最小封包量，只有到最大等待时间才 seal，避免按纯时间
生成大量微型 object。
Runtime 的连接扩展继续只按 `connectionId` rendezvous hash，R2 segment 继续只按 encoded
bytes/count/time 切段。必须持续预算 `active scopes × seals/day`、bootstrap GET 数和总下载
字节。

Fresh bootstrap 先应用 base snapshot/history segments，再按 scope revision 应用后续 change
segments。Runtime delta 可以让在线客户端领先于 R2 published head；断线客户端只从 R2
补 gap，并等待 export watermark 到达固定 head。这样普通 search、scroll、search-result
open 和 Follow-up list 都不会读取 Core payload。

Projection compaction 生成新的不可变 base、在 Core 原子切换 manifest，再延迟删除旧段。
增量 manifest 的硬上限是 10,000 个 child；当一次 delta finalize 使 child 数达到 9,999
时，Core 在发布新 root 的同一事务内设置 `base_reset_required` 并预留下一个 snapshot
epoch。显式 projection recovery/export 路径直接复用既有 base-reset job 生成短链，不引入第二套 compactor。调度器也会
在派发 delta 前检查 current root；升级前已经排队且会生成第 10,001 个 child 的旧 job 会被
原子取消并转入相同 base reset，因此容量上限是恢复触发器而不是永久失败点。
旧段与 tombstone 的保留必须覆盖 Core PITR 窗口；恢复演练同时验证 Core manifest 和全部
R2 reachable objects，避免 PITR 恢复出已被 GC 的引用。

Core 不永久保存所有历史 segment descriptor。R2 保存 content-addressed Merkle 分层 manifest，
Core 只保存每个 scope 的 current root、snapshot epoch、change heads、replay floor、有界 tail
以及 `content_refs` closure head。GC 从已提交 root/parent→child closure 做 reachability，不依赖
R2 `LIST` 推断 authority；对象解除引用后的
保留时间必须覆盖 Core PITR、最长 ticket TTL 与安全余量。

## 六、后台任务

Relay authority 的 `jobs` 表负责本地、短时、可重入的工作状态，但不拥有 Durable Object alarm。
Relay authority 唯一的 alarm 只属于用户 Automation：其时间必须精确等于所有 enabled Automation 中最早的
`next_run_at`，任务新增、编辑、暂停、恢复和删除都可把它向前或向后校准；没有 enabled Automation 时
必须删除 alarm。job、lease、TTL、GC、trace grant、projection recovery 与 cold history 都不能
创建或缩短这个 alarm。

Channel 冷历史由消息提交路径按 Channel 的 `132 → 100` 高低水位触发。越过高水位只创建
一个带固定 sequence range 的 active job，并释放最老的 32 条；任务飞行期间的新消息不会被
吸进该 range。finalize 在同一事务释放 active latch，且仅当余下热尾仍达到 132 条、触及 hard
rows/bytes bound，或已经形成另一个 age-eligible 1 MiB batch 时创建一个同 Channel 后继。没有
这类独立年龄批次时，并发写入后的稳定热尾可以落在 100–131 区间，而不会对区间内每条新消息
逐条归档。创建任务的 append 路径直接投递 Queue，finalize 直接投递同 Channel 后继；精确 Queue
claim 只机会式回收自己的过期 lease，发送失败则由后续同 Channel append 重试。调度、领取、完成
都不扫描其他 Channel，Worker 不再配置分钟 Cron；硬容量恢复只加速同一个任务，不另造逐消息归档。

Automation alarm 内部只执行 Automation 的有界工作：

- 校验并物化到期的 user-cadence slot；
- 在同一次 user-cadence wake 中处理 occurrence lease/retry/timeout；
- prior occurrence 尚未结束时跳过重叠执行，并把 `next_run_at` 合并到第一个未来固定节拍。

History sealing、projection export/compaction、terminal ledger archive 和 R2 GC 的压缩、
大对象读取与网络 I/O 由无状态 Projection Export Worker 执行。相关业务、恢复或 finalize
路径把 opaque job reference 直接投递到 Cloudflare Queue；Worker 按 job ID 向 Core 领取有界输入、写不可变 R2
object，再调用 Core 以 checksum、expected version 和 idempotency key 原子提交结果。Queue
消息和 Worker 都不能直接修改 authority。

Automation alarm 与 Queue 都按至少一次语义设计，所有 handler 必须按 occurrence/job ID 幂等。
Core 每次调用同时受到 job 数、输入字节和 CPU 时间预算约束；Queue/Worker 不可用时 job 仍保留
在 Core，Queue 自身或同一业务对象的后续事件按 capped backoff 重试，projection ordinary lane
仍受硬熔断保护。Queue payload 只包含 bounded job ref；系统不再用全局 alarm 扫描 `jobs` 表作为
DLQ、retention 到期或 producer `send()` 失败的兜底，失败必须由对应 producer/Queue 路径显式可见并重试。

## 七、Relay Runtime

Runtime 使用 Cloudflare WebSocket Hibernation API：

- attachment 只包含恢复连接所需的 bounded identity/session metadata；
- presence、subscription、ACK aggregation、rate limit 和 dedup ring 全部有 TTL/byte cap；
- constructor 只恢复 WebSocket attachments；
- 先收到 Core committed event，再向 socket 投递；
- ACK 按时间窗或序列增量合并后单调提交 Core；
- 高频状态采用 last-write-wins，并按 50–100 ms 或 10–100 个逻辑事件批帧；
- Runtime 重启只导致重连和 sequence replay，不丢业务事实。

当前部署一个 Runtime cell。实际流量持续接近 250 events/s、handler/queue p99 恶化或
出现 overload 时，按不可变 `connectionId` 使用带 epoch 的 rendezvous hash 扩展到
少量 cells。一次 committed event best-effort 发送到配置中的 cells，各 cell 只向本地
订阅者投递；失败由 gap replay 修复。

Core 权威写持续接近 100–150 transactions/s、进入容量 Red，或产品需要跨区域写入 HA
时，直接执行外部数据库 migration。

## 八、客户端本地查询面

### 8.1 目标与边界

Durable Object 只承担必须串行化的权威事务，不承担产品查询工作负载。普通用户完成
首次同步后，以下读操作全部走本机：

- 跨 Space 的 Channel、message、Agent、machine、workspace 和 Follow-up 搜索；
- 打开搜索结果、读取结果前后的消息、最近历史和 Follow-up 列表；
- 中文、英文、代码片段匹配以及 sender、时间、Channel 等组合过滤。

远端路径只处理登录/重连对账、缺失 segment 下载和 typed mutation。这样搜索频率、
结果数和本地机器数都不会转化为 Relay authority QPS；Core 不建立全文索引，也不保存逐设备
游标。

Local Replica 遵守五条不变量：

1. Relay authority 与 R2 保存唯一云端权威数据集，能够重建任意本地 replica；
2. 本地写入只是投影事务，绝不成为业务事实或权限依据；
3. 搜索结果使用稳定的 `(kind, entityId)`；message 额外携带
   `channelId/messageId/timelineSequence`，不暴露本地路径作为业务 ID；
4. 所有 mutation 都重新经过 Hub 鉴权、版本和 evidence 校验；
5. 授权集合缩小时，先 purge 本地正文、索引和 Follow-up，再允许该 generation 查询。

因此 DO 的网络与串行事务延迟只出现在真正需要共识的操作中。搜索、历史浏览和侧边栏
读取不等待 DO。

客户端本地状态严格分为三层：

| 层 | 内容 | 完整性与清理 |
| --- | --- | --- |
| User Local Replica | retention 范围内全部授权 searchable text、必要 metadata、FTS、Follow-up | 产品查询数据；只有完整落盘并核验固定 head 后才能标记 complete；可整库重建 |
| UI Hot Cache | 当前 Channel、最近窗口、渲染状态 | 有界内存/临时 cache；可随时淘汰，不影响搜索完整性 |
| Local Media Cache | 附件、图片、视频、富渲染 payload | lazy download；按 byte/count/age/LRU 淘汰 |

Routine “clear cache” 默认只清 UI 与 media；重建搜索索引是独立操作；logout/换账号/撤权
才执行对应授权域的 replica purge。完整 generation 的 searchable text 不允许因普通容量
策略被静默回收，否则必须把 search state 降为 `partial`，不能继续宣称完整搜索。

### 8.2 Replica 数量、三类本地状态与权限作用域

Local Replica 的身份是：

```text
ReplicaKey = (hubOrigin, userId, clientProfileId)
ReplicaSchemaGeneration = projectionSchema
EntitlementHead = (authorizationEpoch, entitlementDigest)
ScopeGrant = (visibilityScopeId, grantVersion)
ScopeContentGeneration = (visibilityScopeId, snapshotEpoch)
```

每个提供产品搜索的登录客户端 profile 拥有一份用户级投影。同一物理机器上的不同
账号、Hub origin 和浏览器 profile 必须隔离；同一
桌面客户端的多个窗口共享 daemon 中的一份 replica，同一 Web profile 的多个 tab 共享
一个 origin-local replica。`clientProfileId` 仅用于 namespace 与进程协调；它不能替代
Hub principal、device session、authorization epoch 或 per-user/scope grant version。
Projection schema 不兼容才需要整库重建；entitlement 变化先对 manifest 做 scope diff，
只 purge/rebuild 被删除、重新授予或 content generation 变化的 scope，不能因为一个
Channel 撤权复制整库。

| 客户端 | 本地实现 | writer 与 reader |
| --- | --- | --- |
| Web / PWA | IndexedDB/OPFS storage adapter；Web Worker 维护索引 | 一个被选举的 tab/worker 写；UI 异步查询 |
| Desktop | registered workspace 之外的 daemon-owned SQLite + FTS5 | daemon 唯一写；renderer 走受限本地 RPC |
| Human CLI | 复用当前用户的 daemon replica | CLI 走受限本地 RPC，不获得数据库路径 |

用户级 replica 以 profile-scoped 单一 namespace 覆盖该用户当前可见的全部 Space、
Channel、message、Agent Profile、machine、workspace 和 Follow-up。授权完全来自 Hub
entitlement manifest。普通 Agent 子进程不能读取用户全库；其本地查询 capability 仍只
覆盖 Hub 为该 exact run 授权的读 scope。按当前产品规则，这可以包含 birth Space 内
Owner 或 Agent 当前有权读取的 Channel list/history，但不能扩展到其他 Space、owner-private
machine/workspace 或未授权 Follow-up；mutation、订阅和 realtime delivery 仍绑定 active
Channel。

Management Agent 使用相同的投影引擎，但增加一个独立的：

```text
ManagementScope = (spaceId, managementRunId, authorizationEpoch)
```

该 overlay 只存在于 exact live management run 所在主机，提供 Space-wide 只读 Markdown
renderer 和 Follow-up 候选抽取 checkpoint。它不扩张 User Local Replica 的权限，也不向
普通 Agent 暴露数据库、目录或查询 capability；run 停止、替换或失权后整代删除。

Management Filesystem Overlay 固定物化到 `.xmatrix-management/<spaceId>/`，按 Channel
层级生成目录，直接内容文件只有 `CHANNEL.md` 与 `messages.md`。隐藏 metadata 保存
Channel ID、per-channel cursor、projection version 与路径映射；projection version 不兼容
时先重置 cursor 并完整 backfill，再恢复增量。不得生成 TREE、UPDATED、NEIGHBORHOOD、
ATTENTION 或 by-id 旁路视图。`managementVisibility` 只限制主动观察、候选抽取与 action
evidence，不能缩窄 overlay 中 active、non-archived Channel 的正文范围。

### 8.3 统一逻辑模型

浏览器与 daemon 使用同一投影协议和逻辑 schema，物理存储分别由 adapter 实现：

```text
replica_meta
  hub_origin, user_id, client_profile_id,
  authorization_epoch, entitlement_digest, schema_version,
  catalog_revision, catalog_complete, search_state,
  lease_expires_at, last_reconciled_at

spaces / roles / machines / workspaces / app_connections / app_source_relations
  stable_id, visibility_scope_id, entity_version,
  catalog_revision, search_rank_seq, searchable_metadata, updated_at

channels
  channel_id, space_id, parent_channel_id, name, topic, summary,
  visibility_scope_id, grant_version, snapshot_epoch,
  history_floor, history_tail, change_head, archive_epoch,
  search_rank_seq, last_message_id

senders
  sender_id, kind, current_label, entity_version

user_channel_state
  channel_id, server_read_sequence, attention_version, attention_summary

messages
  local_doc_id, message_id, channel_id, visibility_scope_id, grant_version,
  timeline_sequence, search_rank_seq, entity_version,
  sender_id, message_kind, payload_schema_version,
  field_presence, sender_snapshot, sender_snapshot_digest,
  sent_at, edited_at, recalled_at,
  body, message_residual, body_hash, record_digest

followups
  work_item_id, visibility_scope_id, grant_version,
  version, search_rank_seq, effective_state, title, owner, due_at,
  evidence_channel_id, evidence_message_id, evidence_sequence,
  evidence_hash, updated_at

extension_records
  namespace, record_id, visibility_scope_id, grant_version,
  kind, schema_version, codec_id, entity_version, change_seq,
  field_presence, business_status,
  inline_payload | immutable_payload_ref_id,
  record_digest, record_encoded_bytes, updated_at

extension_index_entries
  namespace, index_name, index_version, visibility_scope_id,
  generation, entry_type, encoded_key, record_id, entity_version, tombstoned

extension_index_heads
  namespace, index_name, visibility_scope_id,
  published_index_version, published_generation, applied_source_change_head,
  row_count, logical_bytes, index_accumulator, index_digest

sync_state
  visibility_scope_id, grant_version, snapshot_epoch,
  applied_change_seq, next_expected_change_seq, exported_change_head,
  replay_floor, redaction_epoch, applied_redaction_head, redaction_floor,
  applied_archive_epoch, gap_from, gap_to

access_gates
  visibility_scope_id, authorization_epoch, grant_version,
  queryable, closed_reason, target_redaction_head

scope_coverage
  visibility_scope_id, fixed_change_head, searchable_text_complete,
  history_floor, history_tail, indexed_through_change_seq,
  applied_redaction_head, verified_at

tombstones
  visibility_scope_id, entity_kind, entity_id, entity_version,
  change_seq, redaction_seq

search_index
  adapter-owned index over authorized product entities and filter columns

media_blobs
  content_hash, transform_version, local_ref, encoded_bytes,
  state, reservation_id, last_accessed_at

media_refs
  content_hash, transform_version, visibility_scope_id, grant_version,
  source_kind, source_id, pinned_until

storage_registry / quota_reservations
  artifact_id, owner, purpose, class, generation,
  rebuildable, created_at, expires_at,
  reserved_bytes, actual_bytes, content_hash, state

recent_observability
  bounded in-memory live buffer; never part of persisted replica, cloud authority or bootstrap
```

Local Replica 只接收 descriptor 明确标记为 client-projectable 且当前 principal 有权读取的
extension。未知 namespace 不下发。Known kind 使用 per-kind policy；unknown kind/schema version
默认 `store-only`，只有 namespace 的 `unknown_kind_policy=opaque-readable` 时才下发有界、转义、
不可解释的 opaque bytes，且不进入未声明的搜索字段、不生成 URL/action、不触发客户端执行。
Extension canonical record、派生 index、grant version、tombstone 和 applied head 在一个本地
transaction 中更新；candidate generation 不与 published generation 混读，未达到固定 source
head 时继续读旧完整 generation 或报告 partial/unavailable。本地 rebuild 也先注册 candidate，
随后每个 incoming update/delete 同事务 dual-maintain candidate entries、source head、rows/bytes 和
accumulator；只有 candidate `applied_source_change_head` 等于固定 canonical head 且 digest 复算一致才 CAS。

`messages` 对 `(channel_id, timeline_sequence)` 和 `message_id` 分别唯一。原 timeline
sequence 只表达消息顺序；每个 visibility scope 内，create/edit/recall/delete/reaction、
Follow-up 和 catalog mutation 另推进单调 `changeSeq`。这是必要的，因为编辑旧消息不会
自然产生新的 timeline sequence。ACL/membership/revoke 直接推进受影响用户的
`authorizationEpoch` 和对应 `grantVersion`，通过 entitlement manifest 差集触发 purge，
不依赖已撤权用户继续消费内容流。其他仍有权用户的 grant 不变，共享 R2 segment 也不因
ACL 名单变化而重新编码。
Core 只保存 scope `changeHead`、`exportedChangeHead` 和有界 outbox；连续、不可变、带
checksum 的 change segments 发布到 R2。Channel ID 只作为消息增量校验与 ACL 过滤键。

本地 schema 不重复持久化可由 canonical row 确定性得到的 preview、snippet 或 Follow-up
evidence excerpt；Channel preview 通过 `last_message_id` 读取，Follow-up evidence 通过
`evidence_message_id` 读取，hard-delete 后显示 `evidence_unavailable`。Postings 只保存紧凑
`local_doc_id`，不重复长业务 ID。`senders` catalog 只表示 current sender；发送时的 label/email、
agent name、instance/channel-instance、goal、git branch、model、effort、status chips、workspace
和 avatar snapshot 是 message logical record 的不可变部分，不能从 current catalog 反推。
物理 adapter 可以把 inline `sender_snapshot` 替换为 profile 内 immutable、digest-keyed dictionary
row `{ snapshot_digest, canonical_bytes, ref_count }`，此时 message 只存 dictionary ref，不再保存
第二份 snapshot bytes。最后一个 message ref 消失且 reader generation/lease 结束后才 GC；dictionary
entry 不可原地更新。每条 message 的 `sender_snapshot_digest` 必须绑定完整 sent-time snapshot，
不能由 current sender catalog 替代。
上面的 `searchable_metadata` 表示 versioned typed fields，不允许同时保存一份
原始 JSON blob 和同义 filter columns；`messages.message_residual` 与
`extension_records.inline_payload` 同样只保存未抽取字段；`message_residual` 永不重复已分列的
body 或 sender snapshot。Canonical digest 对确定性重组后的
完整 record 计算。重复的长 catalog string 使用 profile 内 dictionary ID。

每个 searchable entity 的 projection record 还携带全局唯一、单调 `searchRankSeq`，由 Core
已有 commit sequence 加 transaction ordinal 确定，不增加第二个排序 authority。Message 在
create 后保持该值，edit 不伪装成新消息；Follow-up 和 catalog entity 按 schema 明确选择
created 或 latest-version sequence。Desktop 的 FTS rowid/local `local_doc_id` 与 Web posting
key 使用同一个 64-bit order-preserving 编码，因此 candidate stream 能按最终 recency 次序
seek；legacy backfill 按 `(authoritative time, stable entity ID)` 一次性生成并固化映射。

完整性按 scope 记录，而不是一个容易误导的全库 boolean。跨 scope 搜索必须随结果返回
coverage；只有全部当前授权 scope 都核验到本次固定 head，replica 才能报告全局
`complete`。普通 content delta 在当前 scope generation 内原子增量更新；只有 projection
schema 不兼容才切换整个 replica generation；grant version 或 snapshot epoch 变化只切换
对应 scope generation，不能每次更新复制整库。

搜索 adapter 使用一个统一、versioned 的 hybrid term generator：CJK 正文每个 Unicode scalar
产生一个 term，连续 Latin/code 片段产生去重的 trigram，长度不足 3 的完整 lexical term 产生
一个 short term；field kind 编入 term namespace，非 text filter 不进入 term stream。SQLite
只把该临时 encoded stream 作为写入输入送入 FTS5 `content=''`、`detail='none'`、
`columnsize=0` 的单一 contentless candidate index，FTS 表不保存 stream 或原文。Web 在 Worker
内按同一规则维护只引用紧凑 `local_doc_id` 的一套持久 postings。两端共享 normalization、term
generator 与 golden corpus，
禁止在 React/main thread 线性扫描或 stringify 整库。少于三个 Unicode 字符的查询必须
带明确 scope、结果上限和时间预算。

Management Overlay 在独立 namespace 中增加：

```text
extraction_checkpoints(channel_id, scanned_change_seq, extractor_version)
render_dirty(channel_id, target_change_seq)
```

Markdown 由已提交的本地行确定性生成，使用 temporary file + rename 发布；文件修改永远
不反向同步。

### 8.4 Cloud 同步协议

同步以授权集合、稳定 ID、entity version 与 `changeSeq` 为准，不以客户端时间戳为准：

1. 登录、重连或本地 lease 续期只读取窄的、分页 `ProjectionManifest`。它包含
   projection schema、`authorizationEpoch`、`entitlementDigest`、catalog current/exported
   revision、授权 `visibilityScopeId` 集合，以及当前用户在各 scope 的 grant version、snapshot
   epoch、base root、replay floor、history floor/tail、current/exported change head、archive
   epoch、redaction epoch/head/floor、root-covered redaction head、estimated text/index/media
   bytes、segment manifest root，以及只影响 freshness 的 optional pending-build status。
   对客户端有效的 epoch/root 永远是 published 值；它不含 last-message body、history page
   或 Follow-up row；
2. Manifest 同时内联 bounded `user_channel_state`，用于对账服务端 Human read cursor 与
   attention version。这是每用户业务状态，不进入共享 R2 Channel segment，也不是
   Local Replica 的逐设备 sync cursor；
3. `authorizationEpoch` 变化时先获取 manifest diff；对被删除或 `grantVersion` 变化的
   scope 进入 authorization barrier：先提交 8.9 的 fixed-size durable access gate，关闭该
   scope reader、取消下载，拒绝所有旧 `(scopeId, grantVersion, authorizationEpoch)` realtime
   envelope 与 import transaction；再按预留的 rows/bytes/page budget 从 current/retained
   generations 分批删除 messages、FTS/postings、Follow-up、cursor 与对应 media refs，最后
   执行 adapter 支持的 WAL checkpoint、secure-delete 或 compaction。物理 media blob 只有在
   最后一个有效 ref/pin 消失后删除。安全不依赖大删除 transaction 或底层页被法证擦除：
   gate 提交后旧 reader 已不可达且任何产品 query/FTS 都不能返回被撤权内容；清理与新 head
   对账完成前 gate 不开放。若 gate 无法提交则关闭整个 replica，不能继续查询。整 profile
   logout/delete 再通过销毁 Desktop/daemon replica encryption key 实现整库密码学删除，Web
   仍是 origin store 的 best-effort 清除。单个 Channel 撤权只 purge 对应本地 scope，不触发
   全库复制；
   在线客户端收到 typed authority/redaction/purge control 时，必须先在本地单 writer 中提交
   对应 gate closure，再尝试 manifest/R2 refresh；即使新 root 尚未发布、refresh 返回
   `client_projection_not_ready`，旧数据也已经不可查询，不能等本地 lease 自然过期；
   每次 query lease 还必须先对账 redaction head：客户端通过 4.1 的 typed redaction control
   read 按 `afterHead` 分页取得连续 ID/version tombstone；每个有固定 write-amplification 上限
   的本地 batch 原子删除正文、index、media ref 与 Follow-up evidence ref 后才推进连续
   `appliedRedactionHead`。重复 seq 幂等忽略，出现 gap 就从当前连续 head 重取，永不跨洞；
   本地 head 低于 redaction floor 或 purge epoch 改变时先关闭 scope gate，再分批清空，直到
   覆盖当前 redaction head 的 published base 可重建前保持 unavailable。这样 R2 reset 不能
   延迟已联网客户端的删除屏障。授权与 redaction barrier 均完成后，剩余 scope 才恢复
   queryable；
4. 首次 bootstrap 先做 quota preflight，再固定 entitlement digest、各 scope snapshot epoch
   和 change head。Web 必须成功获得 persistent storage 且预计容量足够，Desktop 必须预留
   database + FTS + compaction 空间；不足时明确报告 `unavailable/partial`，禁止静默截断为
   最近历史。最近 segment 可以先用于 UI，但 search coverage 必须标记 partial；
5. 只有 head 不一致的 scope 才分页获取分层 manifest。客户端支持断点续传、总并发和
   in-flight bytes 上限，先应用 base snapshot/history，再按 `changeSeq` 应用 change
   segments。每个下载 segment 在一个本地事务中完成校验、导入、索引和 cursor 推进，
   commit 后立即删除临时 segment 文件，避免长期保存两份正文；
6. R2 读取经过私有 Worker gateway，使用 Hub 在本次 ACL 对账后签发的短期 capability，
   绑定 user、device session、`visibilityScopeId`、grant version、authorization epoch、
   redaction head、manifest root 或 exact blob hash、允许 range、总 bytes/requests 与 expiry。
   Hub 只为已经覆盖当前 redaction head 的 root 签发新 ticket；hard-delete 后的旧 root 即使
   仍为 PITR 保留也不能获得新 capability，fresh bootstrap 在安全新 root finalize 前明确
   unavailable。Segment 请求携带 object hash 及其在已签 root 下的 inclusion proof；Gateway
   验签时不逐 segment 回查 Core，但必须校验 proof、immutable key、range/budget 与 R2
   size/checksum metadata；客户端在 import 前校验完整 object 或 manifest 声明的 chunk
   checksum。在线 revoke/hard-delete 立即拒绝不再有效的新 ticket 并本地 purge，已签 ticket
   最迟在短 TTL 到期；
7. Core 提交后，Runtime 通过现有用户 WebSocket fan-out 发送已鉴权 delta。客户端严格按
   连续前缀应用：

   ```text
   incoming.changeSeq == applied + 1  -> 原子应用正文、索引、Follow-up，再推进 applied
   incoming.changeSeq <= applied      -> 幂等重复，忽略
   incoming.changeSeq > applied + 1   -> 不跨洞推进；放入有界 pending buffer 并记录 gap
   ```

   Pending buffer 超过 count/bytes/wait 上限时立即从 R2 补
   `[applied + 1, incoming - 1]`；对外可见的 `appliedChangeSeq` 永远只表示连续前缀；
8. Runtime delta 负责低延迟，R2 projection 负责恢复。Core `changeHead` 领先
   `exportedChangeHead` 时显示 `syncing` 并等待 `projection_published` hint/退避式 manifest
   对账，不回退读取 Core payload。Gap 低于 replay floor、published snapshot epoch/root
   改变、segment 404 或 checksum/version 不符时刷新 manifest，并从当前 published root
   重建该 scope；如果 fresh manifest 仍引用缺失或校验失败的 object，则这是云端 authority
   integrity 故障，scope 必须 unavailable 并告警，不能把无限重试称作重建成功。Pending
   build 只把 freshness 标为 stale/syncing，不触发提前切换；新 root 尚未 finalize 时，
   客户端至多重建并保留最后 published head 的完整 generation，不能猜测、跳过或把洞后的
   数据声明为完整；
9. 每个 scope 到达固定 change head 与 redaction head、searchable text count/digest 与 manifest
   核对成功后，才标记该 scope complete。只有所有当前授权 scope complete，跨 scope 搜索
   才报告全局 complete；否则查询结果必须携带 `indexing/partial/stale` coverage 与最后
   对账时间；
10. logout、账号切换、origin 变化、device/session revoke 和 lease 过期执行与 revoke
    相同的 reader close + purge。

Core 只保存服务端 Human read/delivery state，不保存 Local Replica 的逐客户端 sync cursor。
云端 projection 按 authoritative visibility scope 存一份；同一用户的多个客户端共享云端
内容，只各自保存本地 cursor。同步由登录、重连、gap、export hint 和实时 delta 驱动，
不做按设备、Channel 的周期轮询。R2 ticket 只由 Browser sync worker 或 daemon 持有，
绝不注入普通 Agent 或 management child；exact management run 停止时 daemon 取消其同步、
关闭 reader 并清除 overlay。

每用户 `authorizationEpoch` 表示其 entitlement manifest 代际；`grantVersion` 表示该用户
对一个 scope 的授权 incarnation。共享 R2 segment 只携带 scope、snapshot epoch 与内容
version，不因 ACL 名单变化而重写；R2 import transaction 从 ticket context 写入当前
grant version，Runtime delta 则携带当前 authorization/grant envelope。每个本地 Follow-up
row 和 media ref 都保存相同证据，旧授权的迟到数据永远不能重新写回已 purge 的
scope。

### 8.5 本地查询契约

统一 adapter 至少暴露：

```ts
interface LocalQueryProjection {
  search(query: LocalSearchQuery): Promise<LocalSearchPage>;
  getAround(channelId: string, sequence: number, radius: number): Promise<MessageWindow>;
  listFollowUps(query: FollowUpQuery): Promise<FollowUpPage>;
  getFreshness(): Promise<ProjectionFreshness>;
}
```

`search` 接受 query、Channel scope、时间范围、sender、message/Follow-up 类型和 keyset
cursor，返回：

```text
kind, entityId, score, snippet,
channelId?, messageId?, timelineSequence?,
entityVersion, indexedThroughRevision, lastReconciledAt,
coverage(complete | indexing | partial | stale),
execution(proven | budget_exhausted), resultState(final | provisional)
```

`unavailable` 是 projection 级状态：本地 store 尚未建立、已损坏或容量预检失败时，
`search/getAround/listFollowUps` 明确返回不可用错误，`getFreshness` 返回原因与恢复进度，
不能以空结果伪装为完整查询。

#### 8.5.1 准确性契约

搜索准确性包含四个彼此独立的条件：授权正确、语料完整、匹配语义正确和排序稳定。任何
一个条件不满足都不能把结果标记为完整：

1. 查询开始时固定一个 local query lease：`authorizationEpoch`、`entitlementDigest`，以及
   每个 scope 的 `grantVersion/snapshotEpoch/appliedChangeSeq/appliedRedactionHead`。搜索在
   同一个本地 read snapshot 中完成；lease 在返回前失效则丢弃结果并重试，不能返回跨权限
   或跨 generation 的混合页；
2. message/Follow-up 原始正文只持久化一份，同时作为显示与 evidence 的来源。Indexer 在
   写 postings 时流式生成 versioned normalized token/gram，query verifier 只对 bounded
   candidate 临时生成 normalized view；不得再持久化一份完整 `normalizedSearchText`。
   Normalization 至少固定 Unicode NFC、case-fold、换行与空白规则；全半角、标点和代码
   符号 alias 只能作为查询扩展，不能修改原文。Snippet 对最终 page 临时计算 offset map
   回到原始正文，`normalizerVersion` 变化触发受影响 postings 重建；
3. 一个 delta 的 document row、structured filter columns、全部 postings、tombstone 与
   `appliedChangeSeq/appliedRedactionHead` 在一个本地事务中提交。Edit 先删除旧 postings 再
   写新版本；单 entity recall/delete 同一事务删除正文与 postings。Scope revoke/redaction
   先提交 8.9 的小型 access gate 关闭读取，再按固定预算分批物理清理。任一步失败都不能让
   搜索看到“新正文 + 旧索引”、相反状态或已关闭 scope；
4. `coverage` 只描述本地授权语料是否覆盖固定 head；当前 page/no-result 的全局排序是否已有
   单调 stream 或候选耗尽证明另用 `execution(proven | budget_exhausted)` 表示。`hasMore` 只
   描述一个 proven final result set 是否还有下一页。超时或短查询受限时不得用“0 results”或
   `coverage=complete` 暗示没有其他匹配；预算耗尽只能返回明确的 provisional preview 与
   query-job resume token，不能签发 final keyset cursor、exact total 或稳定 top-page 承诺。

测试中的 reference matcher 直接对 canonical documents 按同一 normalizer version 临时生成
normalized view，并执行有界线性匹配。Desktop 与 Web 的索引结果必须与 reference matcher
的稳定 ID 集合一致；这条等价性保证召回正确，而不是假定 FTS 或自定义 Web index 天然正确。

#### 8.5.2 索引与两阶段执行

索引只保存指向同一 document row 的 postings，不复制第二份完整正文。物理上只有一套
full-body candidate postings，加上必要的 structured B-tree：

| 索引 | 负责的查询 | 实现约束 |
| --- | --- | --- |
| Structured B-tree | scope、Channel、sender、kind、时间、状态、稳定 ID | 先按选择性缩小候选；组合索引只为真实 query shape 建立 |
| Primary hybrid postings | CJK phrase/substring、Latin/code `>=3` substring、完整 lexical/短词、mention/hashtag 与显式 searchable metadata | 8.3 的单一 field-tagged term stream；每个 document 内 term 去重，最后由 canonical body 精确验证 |

CJK 查询用 scalar-term intersection 高召回，Latin/code `>=3` substring 用 trigram intersection，
phrase 顺序、token boundary、field 和真实 substring 都由 verifier 判断。`AI`、`Go` 等不足
3 字符的完整 lexical term 进入同一 primary postings，不另建 short-term index。两字符
Latin/code 任意子串不是一个完整 term 时必须带 scope/time/result budget，以 canonical scan
完成并在耗尽前保持 provisional；系统不为这个低选择性边界复制第二套 full-body index。

只有真正参与 text recall 的 normalized field 才进入 postings；scope、time、version、数字
ID 和其他只参与 filter/return 的列留在 structured table/B-tree，在 FTS 中必须省略或标记
`UNINDEXED`。同一 document 内重复 term 先去重再写 posting，不能用多个等价 tokenizer 把
同一个规范化字符重复物化。任何第二套 materialized tokenizer/index 默认关闭，必须同时
提交 reference-recall 增益、独立 byte/write-amplification 预算和 8.9 全部 corpus 的物理
基准，且仍受同一个 `Q_profile` 约束。

一个 Unicode 字符的 message-body 全局搜索既高噪声又会产生巨大 posting。它只允许带明确
Channel/scope、时间范围、page limit 和执行预算；预算耗尽返回
`execution=budget_exhausted`、provisional preview 和 query-job resume token，不返回 final
cursor。稳定 ID、sender、Channel 等单字符 metadata 仍可走精确 B-tree/term index。系统
不能为了响应单字符查询而在 UI 线程线性扫描全库。

每次查询都执行同一条两阶段 pipeline：

```text
validate query lease and coverage
→ parse query AST and normalize terms
→ open candidate streams by descending match tier, field priority and search-rank key
→ k-way merge stream heads; fetch canonical candidates and construct bounded normalized views
→ evaluate the complete query AST and each candidate's highest tier exactly
→ emit only when all stream heads prove no unseen candidate can outrank the next result
→ build snippets for the final page and return a keyset cursor
```

倒排索引只负责高召回候选生成。Quoted phrase、全部 token、prefix、substring、sender/time
filter 等最终语义必须在 candidate document 上精确验证，因此 gram collision、tokenizer
边界或 query expansion 不能直接产生最终匹配。Planner 每次只取 bounded candidate batch，
每个 tier/field posting stream 必须按与最终排序一致的 `(searchRankSeq, stableEntityId)` 单调输出，
再做 bounded k-way merge。Verifier 为同一 entity 计算最高 match tier；在低 tier stream 再次
遇到它时直接跳过，因此不需要保存无界 seen set。只要所有更高 tier 已耗尽、当前 stream head
不高于已选 page boundary，就得到“未扫描结果不可能前插”的排序证明，无需扫描全部历史。
不能提供这种单调性证明的 adapter 必须耗尽候选后才能发布 final page。仅仅填满一页、固定
截断前 K 个或 query budget 到期都不能证明全局排序；这时可以显示 provisional preview，
但不能生成 final cursor。

#### 8.5.3 排序与分页

默认排序先比较离散 match tier，再比较同 tier 的量化相关度：

```text
exact whole-field / quoted phrase
> all exact lexical terms
> explicit prefix
> verified substring
> explicitly enabled fuzzy or semantic expansion
```

同 tier 内只按 versioned `fieldPriority`、`searchRankSeq` 和 `stableEntityId` 排序；Match
strength 已由离散 tier 表达，弱匹配永远不能靠 recency 提升到更高 tier。第一版不引入
occurrence/BM25 等必须看完未知候选才确定的分数。Core-derived `searchRankSeq` 让两端 postings
天然按同一顺序 seek，相同 generation、query AST 和 ranking version 因而得到相同结果。
Ranking version 进入 cursor；版本变化使旧 cursor 失效并从第一页重查。

分页使用 `(matchTier, fieldPriority, searchRankSeq, entityId)` keyset，不使用 OFFSET。Cursor 同时绑定
query hash、query lease、ranking version 和 coverage head，不能跨 query、权限或索引代际
复用。Snippet 与 highlight 只为最终 page 生成；点击结果后由
`getAround(channelId, timelineSequence)` 通过唯一 B-tree 读取本地窗口，不重新执行全文
搜索。

Fuzzy、拼写纠错或未来的本地 embedding/semantic search 只能作为显式的低 tier additive
expansion：它们可以补充和重排自己的候选，但不能删除 lexical exact match、绕过精确验证、
扩大授权 scope 或改变 complete/partial 判断。第一版的正确性路径不依赖 LLM、embedding
服务或远端搜索。

#### 8.5.4 性能预算与降级

搜索始终在 Web Worker 或 daemon 中执行，UI main thread 只发送 query 和渲染一页结果。
Adapter 使用 prepared query plan、bounded postings intersection、增量 index transaction
和按 head 失效的 bounded query cache；禁止 query-time 全库 stringify、全文解压或远端 DO
fallback。一个标记 complete 的 generation 必须保留服务端 retention 范围内全部授权
searchable text 与必要 metadata，不允许回收正文后继续声称完整。R2 按需读取只用于附件、
富渲染 payload 或显式媒体内容。

在验收标准定义的参考硬件、浏览器和 `10^4/10^5/10^6` message 容量层级上，20 条 warm
first page 的初始发布门槛为：

| 操作 | Desktop/daemon | Web Worker |
| --- | ---: | ---: |
| 普通 lexical/CJK phrase/`>=3` Latin-code substring search p95 | `<= 50 ms` | `<= 100 ms` |
| 普通 search p99 | `<= 150 ms` | `<= 300 ms` |
| `getAround` p95 | `<= 20 ms` | `<= 50 ms` |

这些是受支持设备矩阵的 launch gate，不是对任意低性能设备的虚假承诺。超过 query budget
时按固定顺序降级：停止 fuzzy/semantic expansion、延后 snippet/highlight、缩小本页数量并
返回 provisional preview 与 resume token；只有候选耗尽或 score bound 已被证明后才替换为
final page/cursor。绝不能跳过 authorization/redaction barrier、删除授权 scope、跳过精确
验证、降低同步水位，或把 `budget_exhausted` 标成无匹配/稳定 top page。某个平台无法在已
声明容量层级同时满足完整性和预算时，该层级报告 partial/unavailable 或不列入支持矩阵。

截至 `origin/main@c8561a8a`，普通用户搜索已经完全在客户端执行，但语料只来自内存和
`localStorage`：最多 80 个 Channel、每个 120 条、缓存 7 天。Hub 也已经把新消息 fan-out
给所有当前有权的 Human WebSocket，而 `channel-replica.ts` 已具备按 Channel 合并 delta、
检测 gap 和处理 edit/delete 的 reducer 骨架。Migration 直接把这条现有产品路径升级为
完整、增量、可验证的 replica。

旧 `localStorage` history cache 只作为迁移输入：新 adapter 首次启动可导入并去重，成功
后删除旧 key。Steady state 禁止把 message history 写回 `localStorage`；之后每条 delta
只在 Worker/daemon 中执行增量数据库事务，不在 UI main thread 反复序列化、压缩或扫描
整个消息缓存。这一边界同时吸收 Slack 从 LocalStorage message cache 迁出的公开经验。

### 8.6 Follow-up 读写契约

Follow-up 的权威 current state 仍是 Relay authority 中的 `management_work_items`。所有有权
普通用户的 Local Replica 都保存可见 Follow-up 读模型，因此 workspace sidebar、筛选和
搜索不再以 60/120 秒频率轮询管理 snapshot。

`resolve/reopen/reassign/reschedule` 始终在线调用 typed Hub command，携带 expected
version、idempotency key 和 evidence。Hub 重新检查 ACL 与 source ref，Core 原子提交后，
committed result 通过命令响应和 Runtime delta 更新本地投影。本地不能自行改变 effective
state。

候选推理只发生在 Management Overlay：

```text
授权消息 delta 进入 Management Overlay
→ 按 content hash + extractor version 增量评估
→ 生成带稳定 evidence ref 的候选
→ 调用 typed proposeFollowUp command
→ Core 校验权限、证据、幂等键和前置版本并提交
→ committed Follow-up fan-out 到所有有权用户的 Local Replica
```

Overlay mirror 保持该 Space 全部 active、non-archived Channel 的只读正文；候选抽取和
management action evidence 只处理 Hub 当前判定为 management-visible 的 Channel。
Follow-up 对 Human 的可见性继续逐条使用 primary evidence Channel ACL；可见性与状态
transition authority 分离，viewer 只读，写入者还必须满足可写 Space role。

每个本地 Follow-up row 携带 `visibilityScopeId/grantVersion`。Primary evidence Channel
改变时，Core 必须在同一权威 transaction 中向旧 scope 写 tombstone、向新 scope 写更高
entity version 的 upsert；客户端以 entity version + distinct scope key 合并，旧 scope 迟到的
tombstone 不能删除已经迁移到新 scope 的版本。

Evidence message 因产品 retention 或用户 hard-delete 被永久删除时，默认同步清除本地与
云端 projection 中的 `evidence_excerpt`，只保留稳定 source ref、content hash、删除原因与
有界 transition audit，并把仍活跃 work item 标为 `evidence_unavailable`。只有另行批准的
合规保留策略才能继续保存原文摘录；Follow-up 不能默默延长消息 retention。

候选重算、overlay 重建或 Runtime delta 重放不会重复创建任务；Core 的幂等 command 和
稳定 evidence 约束负责去重。提醒时间与 retry 由对应产品事件或显式 Queue job 驱动，不借用
Automation alarm。

### 8.7 Local Media Cache

附件、图片、音视频和其他 binary 的云端内容 authority 始终是 Core manifest 引用的 R2
object。Local Media Cache 只在打开、预览、显式离线固定或后台小规模预取时下载：

- Desktop/CLI 由 daemon 管理 profile 内 content-addressed 文件 cache；Web 使用
  OPFS/Cache Storage；相同 content hash 的原件只保存一次，缩略图和转码版本以
  `(contentHash, transformVersion)` 去重。不同账号/profile 不做物理去重，避免引用计数、
  撤权和存在性侧信道跨越隔离边界；
- Replica 数据库把物理 `media_blobs` 与授权 `media_refs` 分开；同一 blob 可以被多个
  scope/message/pin 引用，撤权只删除对应 ref，最后一个有效 ref/pin 消失后才删除物理文件。
  数据库不把同一 binary 再复制进 SQLite/IndexedDB；
- 默认不全量下载附件原件，只在打开、预览或用户明确离线固定时读取；后台预取只有独立的
  小额 byte/in-flight budget，不能把历史同步变成媒体全量同步；
- 同时执行 byte、object count、age 和 LRU 上限。Pinned/offline 内容使用独立、用户可见的
  hard quota，但它与普通媒体、transform 和 partial bytes 的总和仍受 profile 总 quota；
  不能通过提高 pinned quota 越过 profile/device emergency reserve。每次 download/transform
  根据 R2 metadata 和最大输出尺寸原子预留 bytes；长度缺失、实际流量或输出超过 reservation
  就中止并删除 partial，同一 hash 的并发请求合并为一个 writer。单个 unpinned blob 预计会
  占用超过 `mediaQuota / 4` 时只流式读取而不保留；用户显式 pin 也必须先取得 pinned/profile
  reservation。普通清 media cache 不影响 searchable-text replica；
- metadata catalog 本身也必须有硬上限，不能假设 byte quota 会约束大量微小引用。Web 与
  共享协议当前最多保留 `100,000` 个 `media_blobs`、`500,000` 个 `media_refs`，且单个
  content-addressed blob 最多 `10,000` 个 refs；新引用达到上限后拒绝保留或退化为
  stream-only，已存在的幂等引用仍可读取和清理。Desktop 继续执行更严格的每 profile/device
  Registry 上限；
- media ref 必须带 scope/grant version；撤权、logout、换账号与 retention hard-delete
  清除对应 refs，最后一个 ref/pin 消失时清除 binary、thumbnail、preview 和索引；周期性
  mark-and-sweep 以 canonical refs/pins 校正 crash 后的引用计数，refcount 不能成为孤儿保留的
  唯一依据；
- 将来若支持附件 OCR/文本提取，提取文本属于 User Local Replica 的授权 searchable text，
  其完整性和删除语义不依赖 binary cache 是否仍存在。

### 8.8 安全、容量与降级

- Web 数据按 origin 与用户 profile 隔离，只承诺浏览器/OS 提供的 profile protection 与
  best-effort purge，不宣称法证级远程擦除；Desktop/daemon 的 replica 位于所有 registered
  workspace 之外，在 Unix 使用目录 `0700`、数据库 `0600`，Windows 使用 owner-only DACL，
  并使用由 Keychain、DPAPI/Credential Manager 或同等级 OS credential store 持有密钥的
  page-level encryption；replica 不保存 bearer token、daemon credential 或 secret；
- Web 多 tab 使用 Web Locks/SharedWorker 选举单 writer，并通过 BroadcastChannel 通知
  reader；Desktop/CLI 只有 daemon writer，避免多进程争用和重复索引；
- 客户端请求持久存储并监控 quota、index bytes、同步 lag 和预计 bootstrap bytes。空间
  不足且 entitlement 未缩小时，停止发布新 generation，保留最近一份完整 generation 并
  明确报告 stale；若从未成功建立完整 generation，则报告 unavailable/partial，不能退化
  为未标注的近期搜索。发生 revoke 时先关闭 8.9 access gate，再从所有 generation 分批
  purge 对应 scope；
- 允许离线搜索时，只在签名 local lease 未过期时开放 replica，并显示最后对账时间。
  已下载到用户控制设备的数据无法在设备离线时远程抹除；在线 revoke、下次对账、logout
  与换账号必须 purge。丢失设备时认证域撤销该 device session 并拒绝签发新 capability；
- 普通 Agent 永远拿不到用户级数据库路径或 encryption key。Replica 位于 sandbox 和
  registered workspace 之外，只由 daemon 打开；本地 RPC 使用 daemon 签发、绑定 run 的
  principal，daemon 对 Human、ordinary run 和 management run 分别执行用户全集、run
  grant 和 exact ManagementScope 授权，不能仅依赖“没有告诉子进程路径”。Encryption
  解决静态数据保护，不会隔离共享同一 OS principal 的未沙箱子进程；Desktop 只有在 launcher
  能强制 child 无法打开 replica/key store/daemon control socket，或 daemon 使用独立 OS
  identity/container 时，才允许 Human replica 与 ordinary Agent 共存。该边界无法验证时，
  Agent launch 必须 fail closed；
- replica 可以整库删除重建。本地正文、索引、checkpoint 和 Markdown 不反向延长服务端
  retention；R2 hard-delete 通过 tombstone、segment compaction 和旧对象 GC 传播到所有
  adapter。R2 始终 private，短期 capability 的最长有效期就是撤权后仍可发起云端下载的
  最大窗口。

### 8.9 本地存储放大与生命周期

完整、离线、精确的本地搜索存在不可消除的下界：客户端至少要保存一份当前授权且仍在
服务端 retention 内的 searchable corpus，其空间复杂度必然是 `O(C_v)`。`C_v` 不是可任意
挑选的 body bytes，而是按 versioned canonical encoding 对固定 manifest head 下全部本地
searchable entities 重新编码得到的字节和，包括 message body，Follow-up 自有 title/state，
Space/Channel/Profile/machine/workspace 的 searchable metadata，以及查询、过滤、定位和渲染
必需的稳定 ID、scope、version、time 与 type 字段。可从别的 canonical row 确定性得到的
preview、snippet 和 evidence excerpt 不重复计入。Manifest 估算与 adapter 本地复算必须使用
同一个 encoding version，并以 count/digest 对账。

本设计不承诺与历史长度无关的固定空间；它承诺单份语料、受测的常数放大、物理总配额、
可解释的分类和没有无界临时副本。若产品选择无限服务端 retention，本地完整搜索就必然线性
增长；达到设备支持上限时只能明确报告 partial/unavailable，或由产品另行改变服务端
retention，不能静默截断近期历史后继续声称完整。

每个 `(hubOrigin, userId, clientProfileId)` namespace 只有一个 writer 和一份 User Local
Replica。同一 Desktop daemon 的窗口、CLI 会话和 ordinary Agent scoped RPC 共用它；同一
浏览器 profile 的 tab 通过单 writer 共用它。不得按 Space、Channel、workspace、Run、窗口
或 Agent 再复制数据库。不同账号/profile 保持物理隔离，不能为节省少量空间建立跨身份
dedup store。

容量模型同时约束逻辑结构、稳态物理占用和操作峰值：

```text
L_search = canonical rows + structured indexes + candidate postings
P_search = checkpoint 后 search DB/index store 的实际物理字节（包含 freelist/allocated slack）
T_peak   = WAL/SHM + temp + partial download + candidate/retiring generation + dirty overlay temp
P_profile = P_search + media physical bytes + overlay physical bytes + T_peak

P_profile + R_profile <= Q_profile
P_all_profiles + R_all_profiles <= Q_app_on_device_or_origin
R_all_profiles + E_device <= free_bytes_now
```

`Q_profile` 是 app 为该 profile 配置的物理总 hard quota，`E_device` 是 app 永不占用的设备/
origin emergency reserve；`Q_app_on_device_or_origin` 是所有 xMatrix profile 合计可占用的 app
hard quota，`free_bytes_now` 是本次 reservation 临界区内重新读取的 OS 可用空间或
`navigator.storage.estimate().quota - usage`。已有 physical bytes 只进入 `P`，尚未落盘的
承诺只进入 `R`，不能重复计算或漏算。`mediaQuota/pinnedQuota/overlayQuota/walQuota/tempQuota`
是 `Q_profile` 内的分类上限，不能各自通过却合计越过 profile/app 总上限。

Desktop 用实际 database、WAL、blob、overlay 和 temp 文件大小执法；Web 用隔离 profile 的
versioned logical ledger、保守 write-amplification reservation 与 origin 总量共同执法，
不能把无法取得单个 IndexedDB store 的精确物理值解释为无限额度。所有 profile 的 reservation
通过同一个 device/origin-wide 原子 coordinator：Desktop 由 daemon 串行化，Web 由
SharedWorker/Web Lock 串行化；临界区同时核验上面三条不变量，不能让两个各自通过预检的
profile 并发消耗同一份 emergency reserve。

User Local Replica 的完整 search namespace 只保存一份 canonical body；不持久化 normalized
body、snippet、完整 R2 segment、搜索结果页或第二套 full-body tokenizer。Desktop 把临时
normalized stream 写入 8.3 定义的 contentless candidate postings；Web postings 也只保存
紧凑 document ID 和必要的压缩 posting 信息。短语、substring、ranking 和 snippet 都从
bounded candidate 的 canonical body 计算。Management Filesystem Overlay 是另一个明确授权、
独立计费的派生层，不属于这条“单份 search corpus”断言。Schema 测试必须证明 User Local
Replica 中每种 searchable body 只有一个持久 source column，R2 segment 在 import
transaction commit/rollback 后都被立即删除。

Canonical body 可以使用 versioned adaptive field codec：只在编码后连同 header 确实更小时
保存压缩表示，否则保存原文；同一 row 不能同时保留两种表示。Verifier 和 `getAround` 只在
内存中解码 bounded candidate/page，并受独立 decoded-byte cache 上限；codec 的 CPU 延迟和
物理节省必须一起进入 8.5.4/8.9 基准，不能为了压缩率破坏搜索 SLO。

初始发布把常数放大变成硬门槛，而不是事后观测：

```text
launch target: P_search <= 32 MiB + 3.0 * C_v
hard ceiling:  P_search <= 64 MiB + 4.0 * C_v
```

这是需要由实现和 corpus 证明的发布 envelope，不是对任意输入天然成立的数学假设。公式
使用 checkpoint 后的实际 `P_search`，而不是只统计 row value；媒体与 Management Overlay
另受分类及 profile 总 quota。基准必须覆盖生产分布以及高熵短消息、极短 CJK、大量唯一或
重复 trigram、超长正文、高基数 filter/ID、edit/delete churn 和 `10^4/10^5/10^6` message
层级。超过 target 必须定位 posting、metadata、engine overhead 或碎片来源；超过 hard
ceiling 的 adapter/容量层级不得发布为 complete，不能靠扩大默认磁盘配额掩盖。

每个 adapter 持续维护一份不写回 Relay authority 的本地 storage ledger：

```text
canonicalDocumentBytes, postingBytes, metadataBytes,
mediaBytes, pinnedMediaBytes, overlayBytes,
walBytes, tempBytes, candidateOrRetiringBytes,
reusableFreePageBytes, orphanBytes,
outstandingReservedBytes, physicalOnDiskBytes
```

设置页显示“可搜索文本、搜索索引、媒体、Management Overlay、临时/可回收”实际字节、
可复用但尚未归还 OS/quota 的字节、实际已归还字节和预计增长。产品操作必须语义明确：
`Clear Unpinned Media Cache` 只清普通媒体，`Remove Offline Downloads` 删除 pinned 内容，
`Rebuild Search Index` 保留 canonical rows、只重建 postings 并显示 indexing/unavailable，
`Remove All Local Data` 停止 active management run 后删除该 profile 的 replica、sync state、
media 和 overlay。不能提供一个含义不明的“清缓存”，也不能把 SQLite reusable pages 报成
已经返还给操作系统的空间。

媒体是独立且最容易失控的层，因此执行 8.7 的 profile 内 content-hash 去重、multi-ref、
lazy download 与 byte/count/age hard cap。原件、thumbnail、transform、pinned 和 partial
分别计费；任何 download/transform 必须先原子取得 category 与 profile 双重 reservation，
结束后按实际字节结算。错误 Content-Length、未知长度、输出膨胀、并发相同 hash 与 crash
都不能越过 reservation；binary 永远在有界 blob/file cache。媒体回收不能改变搜索
coverage。

所有 app-owned database、index、blob、thumbnail、overlay、generation、partial 和 temp 都
进入统一 Storage Registry，至少登记 `profile/owner/purpose/class/rebuildable/createdAt/expiresAt`
与 `reservedBytes/actualBytes/contentHash/generation`。只有 canonical current generation
和明确 pinned 的用户内容允许无 TTL；cache、thumbnail、staging、partial、candidate、WAL
和 temp 都必须有 quota、到期/收敛条件及唯一 GC owner。业务代码不能在 registry 外创建
永久目录；启动、升级后和周期扫描发现的未登记 artifact 一律按 orphan 隔离并删除。

临时和代际空间执行以下约束：

1. 普通 delta 原地事务更新 current generation；每个 import/index transaction 都有最大
   input bytes、row count、预计新增 page 和 WAL bytes，并在开始前原子预留。只在 projection
   schema、snapshot 或 grant 边界变化时重建必要范围，不能为每批同步复制整库；
2. Candidate rebuild 按 `64 MiB + 4C_v(candidate)` hard ceiling，而不是历史平均 estimate，
   再加 max WAL/temp 后预留全部峰值。Build 期间持续采样实际 physical high-water；达到
   reservation warning 就停止输入，触线前 abort 并回收 candidate，current 不受影响。普通
   delta、download、transform、compaction 和 overlay render 使用相同 reservation coordinator；
3. 稳态只留一个 current generation，另一个 slot 只能处于 candidate 或 retiring。CAS 发布后
   旧 generation 先标记 retiring、拒绝新 reader；等待有上限的 query lease/refcount 排空，
   超时取消旧查询后由 reaper 删除。Continuation 不持有跨页 database transaction；generation
   或 ranking version 已变化就使 cursor 失效。空间不足以双份构建时，关闭 reader、删除可
   重建旧副本并以 unavailable 状态单份重建，不能把磁盘写满来换取无缝切换；
4. R2 response 流式校验和导入，只允许 bounded download buffer；不把压缩 segment 留作本地
   备份。App 自己不创建 replica backup、snapshot 或带时间戳的数据库副本，并尽可能把该
   rebuildable namespace 标记为 OS backup-excluded；
5. 新建 SQLite replica 从建库时启用 incremental free-page reclamation 和 bounded automatic
   checkpoint；`journal_size_limit` 只控制 checkpoint 后保留量，不能冒充运行时上限。Quota
   coordinator 直接监控 WAL/SHM physical bytes；单 transaction 预留保证不会一步跨过 hard
   threshold，WAL 达 warning 时暂停普通 projection write、取消过期 reader 并执行 bounded
   RESTART/TRUNCATE checkpoint，仍不收敛则保持 current stale 或进入 unavailable，不能继续
   增长。Web adapter 在 generation 退休后删除对应 object store。后台只做有预算的 index
   merge/optimize，free pages 优先复用并按阈值渐进归还 OS/quota；只有 physical/logical
   amplification 越界且预检有足够 headroom 时才执行重写式 compact，禁止事故压力下执行
   无界全库 `VACUUM`；
6. 每个 temp file、partial download、candidate/retiring generation 和 overlay render 都带
   owner、created-at、reserved bytes 与 lease，并分别受绝对 hard cap。Commit、rollback、
   crash restart 和 run stop 都运行同一个 reaper；过期对象不得等用户手工“清缓存”才消失；
7. `Q_profile` 内永久预留
   `max(20% * Q_profile, maxPurgeBatchWriteAmp, maxControlCheckpointBytes)`，且不侵占
   `E_device`。进入 warning 后固定执行：冻结新预取、pin、transform、candidate 和其他可选
   allocation；回收过期 partial/temp/candidate/retiring；淘汰未固定媒体；若仍不足则停止普通
   delta、保留 current 并标记 stale。安全 purge、logout、删除和 authorization gate 永远优先；
   必须重建安全边界但无双份空间时关闭 reader、删除受影响旧副本并单份 unavailable 重建。

撤权、redaction 和 logout 不以一个可能产生巨大 WAL 的全量删除 transaction 作为读屏障。
每个 scope 有一个预分配、固定大小的 durable access gate；先关闭 gate、取消 reader 和迟到
writer，任何 query 都在 gate 后失败，然后按固定 rows/bytes 和已预留最大 write amplification
分批删除 document、postings、media refs 与旧 generation。清理完成且新授权 head 对账后才
重新开放。若连 gate 都不能持久提交，daemon/browser 必须立即关闭整个 profile replica；
Desktop 销毁或隔离 encryption key，Web 删除/隔离 store 并要求在线重建，绝不能在旧数据
仍可查询的情况下等待磁盘空间。

Management Filesystem Overlay 只为当前 exact configured management run 生成一份 current
view。每个 Channel 只有一个 `CHANNEL.md` 和一个 `messages.md`，不保留 alternate view、旧
generation、运行备份或全 Space render snapshot；一次原子 rename 最多临时复制当前 dirty
Channel 文件。`overlayQuota` 同时限制 current overlay、单个 dirty file、render temp 和
profile 总物理占用；启动和每次 render 都先取得 bytes reservation，空间不足时 management
run 明确 unavailable，不能生成截断 mirror。

每个 temp/render manifest 绑定 `managementRunId + overlayGeneration`。Stop、replace、revoke
先在 daemon 单 writer coordinator 中递增 generation、关闭 reader 并取消 renderer，再清理
目录；rename 也只能在同一个串行临界区内重新验证 run/generation 仍是 current 后执行，旧
renderer 因此不能在清理后把文件写回来。Run TTL 到期后由同一 reaper 删除整个 overlay。
其 current、temp、实际返还和可回收字节单独展示，不能混进“搜索索引”或“媒体缓存”。

这使云端存储复杂度保持为 `O(unique content)`，而不是 `O(users × devices × content)`；
每台客户端为自身可搜索数据支付本地空间。搜索吞吐和延迟由本机决定，DO 只承担稳定、
低频、必须一致的提交与同步边界。

## 九、从 RelayRoom/default 迁移到 V2

### 9.1 权威状态机

```text
LEGACY_ACTIVE → WRITE_FROZEN → [projection authority seeded] → CORE_ACTIVE → LEGACY_RETIRED
```

- `LEGACY_ACTIVE`：旧 DO 是唯一权威源；允许 snapshot 和增量复制；
- `WRITE_FROZEN`：短暂停止新权威写，追平增量并做最终验证；
- `[projection authority seeded]`：不是新的写权威 phase，而是激活前必须完成的持久门槛；
  entitlement 只从已复制 Core ACL 推导，所有授权 scope 均已有可安全发布的 base/current root；
- `CORE_ACTIVE`：新 Core 是唯一 commit/current-state/manifest authority，已引用 R2 payload
  是权威内容，旧 DO 永久只读；
- `LEGACY_RETIRED`：核验窗口结束并审批后清空旧对象。

切换前可以取消 migration，包括已经进入 `WRITE_FROZEN`、但尚无任何 `CORE_ACTIVE` 历史的
窗口。取消是独立审批的受保护操作：必须以原 freeze 的 exact admission fence id/request id/
`frozenLegacyCommitSeq`、当前 authority version 和唯一 request id 对 Core 做 CAS；Core 先原子回到
`LEGACY_ACTIVE` 并持久化审批证据，RelayRoom 再删除同一 fence、恢复 admission。两步之间失败只会
保持“Core 已是 legacy authority、旧 admission 仍关闭”的安全冻结状态，使用同一请求可幂等续跑；
不得先开放旧写。取消不删除 Core shadow、projection seed、R2 object 或核验证据，旧 checkpoint 与
freeze evidence 作废，下一次迁移必须从全新 dry-run 开始。新 Core 一旦进入过 `CORE_ACTIVE`，即使
尚未接受第一条生产写，也绝不把旧 DO 恢复成可写主库；软件回滚必须继续使用 Core/R2 权威数据，
数据恢复使用 Core PITR + 对应 R2 retained immutable reachable-object set，或执行向前修复。

### 9.2 实施步骤

Legacy mapper 是一次性 anti-corruption layer，不是 schema 生成器。以下规则先于具体步骤：

- prefix、字段名、source sequence 和历史默认值只能存在于 migration adapter；发现一个新 key
  不得直接增加目标表、业务状态或长期 repository；
- **unknown storage family/namespace** 与 **registered open family 内的 unknown
  kind/schema version/status** 不同。前者无法判断 authority/retention，在归类前始终阻断 cutover；
  后者按 namespace ACL、descriptor policy 和完整 envelope 保真迁移，保持 inert，不要求 SQL
  migration；
- clone value 必须使用 3.2 的 versioned `canonical-clone-cbor-v1`，覆盖完整 structured value 和
  `field_presence`；禁止通过 JSON 转换。仅当逐 family 审查发现 legacy structured clone 的重复
  plain-object/array identity 时，先使用 3.2 的可逆 graph envelope，并把其 format 与组合 encoding
  纳入 proof/manifest/transform 名称；不得把 graph identity 展开后冒充原始 tree。Domain mapper 运行
  前，通用 source walker 先对完整 `{ storage_family, raw_key, raw_value }`（或该可逆 graph envelope）
  计算 `raw_source_record_digest`，并生成 type-tagged leaf-path
  manifest。Mapper 可以把一个 source record 规范化为 message aggregate、reaction facts、content
  refs 等有序 canonical fact set，但必须为每个 source leaf 提交恰好一次的 target path 或 approved
  transform/discard proof。独立 verifier 不调用 mapper，使用目标 facts 与封存的 transform manifest
  反向重组 source logical value，要求 `reconstructed_source_digest == raw_source_record_digest`；
  binary→content-ref、时间/ID 规范化和可重建 index omission 等合法变化必须有命名、版本化、逐字段
  proof，不能用 mapper 自己对残缺输出再哈希。每个 target fact 另核对自身 `record_digest`；
- 多个 legacy prefix 若映射到同一 canonical identity，只有 canonical fact-set digest 完全相同
  才能幂等去重；不一致立即阻断。只有经审查的 legacy semantics 与封存 precedence artifact
  才能选择优先级，禁止 last-write-wins、prefix 顺序或时间猜测；
- 历史 Channel timeline 的 `chm:<channel>:*`、`chs:<channel>:*` 与 `chmi:<channel>:*` 只能通过命名、
  版本化的 migration-only convergence transform 收敛。每个 Channel 先完整枚举三组 row，对全量
  source key/raw source digest 生成 canonical group seal，再复用产品 reader 的 exact comparator：仅当两边都有
  不同 numeric sequence 时按 sequence，否则按 `sentAt`、再按 `messageId` 的 code-unit 顺序；最后对
  logical winner 赋予 `1..N` dense positive canonical sequence。`chmi` 保留的 original sequence 只用于证明
  padded `chs` key/index 指向，不得与 dense sequence 混同。
- 重复 message identity 只有一个封闭例外：同一 Channel/message 恰有一条 `chm` 和一条 `chs`，
  exact product merge 选择被真实 `chmi` raw value/digest 指向的 `chs` 为唯一 winner，winner/loser 的
  attachment descriptor canonical-clone digest 完全相同。Planner 按 source key 产生 winner/shadow disposition，
  winner 独占正常 message/content authority；每个 loser 独立映射为 `xmatrix.channel-message-duplicate-shadow`
  的 store-only inert `extension_records` fact，scope 是 canonical message，并引用 winner `message_heads` 及完全一致的
  attachment `content_refs`。Shadow 用 source-key-only stable id 保存 loser 的完整 canonical-clone raw value、
  versioned resolution rule、winner raw digest、complete Channel/duplicate group seal 和真实 index proof；独立 verifier 必须从
  inert target 精确重建当前 loser source digest。`winnerRawValue` 只是 RelayRoom 内部 mapper proof input，不写入
  shadow payload。该 namespace 只在 production evidence catalog 中注册为 `productReadable=false`/`store-only-inert`，
  没有 product/Runtime descriptor、handler、projection、index、execution 或 new writer，也不能被重解释为第二条消息。
  Loser 禁止 staging/携带 R2 evidence；R2 reachability 只来自 descriptor 完全一致且已验证的 winner refs。
  任何其他 duplicate cardinality、winner、identity、comparator、attachment/R2 descriptor、`chmi`/padded sequence、
  group/member/source digest、reference、source reconstruction 或 final canonical row/wire cap 不一致都立即阻断。完整 timeline
  超过 reviewed bound、rank 非安全正整数、plan/copy 漂移、winner R2 证据缺失也失败关闭；该例外不能成为
  runtime sequence allocator，不能改写另一 family，不能泛化为 last-write-wins 或 prefix/time 猜测；
- 缺失 status 保持 absent/null，禁止猜成 `pending`、`delivered` 等；legacy control 只有匹配
  已知闭合 dispatcher reducer 时才能进入其机械状态表，否则进入对应 domain envelope 或
  quarantine，不得制造“看似合法但运行时不可执行”的 intent；
- Exact `spi:<32-lower-hex-token>` 复用现有 `space_invites`，把 URL bearer token 单向 SHA-256
  为唯一 `token_hash`，保留 Space reference、open role、创建者、创建/过期时间与 active redemption
  authority；source key/token 与 hash 必须由 target-bound inverse proof 绑定，不能丢弃 token、复制明文到
  canonical payload/extension，或新建平行 invite 表。重复 legacy invite 在切换后收敛为 Core 的单次兑换；
  raw `spi` 只可短暂存在于 admin+TLS migration 内存流或 mode-`0600` 私有 checkpoint，禁止进入日志和
  official evidence artifact；
- Exact `spawnintent:` 仅当 domain mapper 的 exact 原因为 `legacy expiresAt is not a timestamp`，且用
  repaired expiry 重跑证明其余字段可映射时，才把 missing/undefined/null/invalid expiry 的完整原始
  canonical clone 写入独立 `xmatrix.legacy-control-quarantine`。它只允许一个
  `spawn-intent-missing-or-invalid-expiry.v1` inert fact，绝不产生 daemon intent，也没有产品/Runtime
  descriptor、handler、projection、index、execution 或新 writer；其他失败原因和 `stopintent:` 继续阻断；
- 历史 Channel metadata 由 object literal 经 structured clone 持久化，可能保留 optional object
  field 的显式 `undefined`，但其全部产品/API reader 始终走 JSON wire 并观察为 absent。Channel
  migration 可以使用命名、版本化 transform 仅省略这些 object-field `undefined`；array slot、Date、
  binary、非有限数、共享 identity、cycle、accessor 和其他 structured-clone-only 值继续阻断，不得
  借此把任意 clone value 偷渡进 JSON column；
- 已逐前缀审查的 `wsp:`、`runstate:`、`schtask:`、`rolepkg:` whole-record JSON column 遵守同一
  历史 JSON wire 语义：只省略 plain object 中显式 `undefined` 的字段，source leaf manifest 仍逐叶
  封存并由命名 inverse transform 重建；array 中的 `undefined`/hole、Date、binary、非有限数、共享
  identity、cycle、accessor 及其他 prefix 继续失败关闭。`rolepkg.version` 的历史含义是 semantic
  version；string 值原样进入 `semantic_version`，Core entity version 使用稳定 `updatedAt` fallback，
  不把开放的产品版本字符串强制改造成整数或枚举；
- 历史 management ledger 的 JSON-wire 字段使用 3.2 限定的命名去别名 transform。只允许
  `spmgmtwork:`、非 idempotency `spmgmtaction:`、`spmgmtdelivery:`、`spmgmtcase:`、
  `spmgmtmemory:`、`spmgmtplaybook:` 与五个已列名 `space-management:` prefix：source proof 必须
  先以 graph envelope 封存并重建 shared identity/完整 raw digest，target 再按历史 JSON 语义把无环
  plain-object/array alias 展开成独立 value tree，并省略 object property `undefined`。`result.run.hostName`、
  `result.run.error`、`result.channel.messageCount` 和 correction case `sourceActionId` 的显式
  `undefined` 都属于这个已审查语义；Date/binary/cycle、array `undefined`/hole、accessor、非有限数、
  其他 structured-clone-only 值和任何未列名 prefix 继续失败关闭；
- Historical Channel message 的 canonical logical record inline 上限为 160 KiB。Migration mapper
  对 payload bundle 超过 32 KiB 或 inline `record-too-large` 的记录转入专用 referenced path，才可接纳
  最大 1,125 KiB（1,152,000 bytes）的同一完整 canonical record；它
  不能截断 body/sender snapshot/residual，也不能扩大普通 message write 上限。Migration/Export Worker
  必须把 exact payload bundle 封装成版本化 message-archive immutable object，按 SHA-256 写入
  `objects/<checksum>` 并 HEAD 核验 bytes/checksum；source evidence 必须绑定 field presence、body hash、
  record digest、payload-bundle digest、object/ref identity 和 R2 verification。Core 只在 evidence 完整时
  写 `message_heads(payload_kind=immutable-object)`、一个 `content_objects` 和一个 message-owned
  `content_refs`，且不得再写 `hot_message_payloads` 第二份 bundle。产品 hydration 由有界 private R2/
  Export Worker 在授权后核对 committed object metadata、checksum、record identity/digest，再用专用
  1,125 KiB decoder 重组 payload；Core 不 GET R2。Record 缺失、未验证、超过 1,125 KiB、compact
  source-proof wire 超过 1,500,000 bytes、digest 不一致或 caller
  未提供 exact `messagePayload` evidence 都阻断 inventory/copy；
- `envrel:` 先尝试 exact direct subscription mapping：只有完整 connection id、Channel subject 和已审查
  subscription predicate/marker 才能进入 `app_source_relations`。其余历史 relation 只能进入已登记的
  migration-only `xmatrix.environment-relation` namespace，固定 kind
  `xmatrix.environment-relation.record`、`scope_kind=space`、store-only、inert、无 product/Runtime handler、
  projection、index、execute 或新 writer；它不是 Channel binding、subscription 或第三套 connector
  current state。Envelope 提取 id/Space/version/timestamps 后必须 type-preserving round-trip 全部 residual，
  key/record id 必须相等，Space ref 必须存在，并使用 inventory/copy 共用的 source key 512 bytes、
  target/ref id 200 bytes 上限，以及 shape depth 32、shape fields 2,048；任何 credential-like
  field/value、accessor/symbol、无界 shape 或 identity/reference
  分歧都失败关闭。Rows/bytes 的 hard ceiling 是 freeze point 封存的 exact migrated corpus，之后永不增长；
  migration cleanup owner 在 verification/PITR retention 结束并取得显式人工 resolution/retention 决定后
  做 bounded cleanup，不能让该 namespace 演变成永久 connector API；
- 历史 `cha:` chunk group 只有在 key 从 0 连续、每个字符串 chunk 完整封存，且 exact owner
  message/index 原始证明显示
  所有 owner row 都未按 attachment ID 或 `storageKeyPrefix` 引用该 group 时，才可生成 approved-discard
  审计事实。证明必须封存全部 chunk、全部匹配 owner rows、真实 index、精确 descriptor ID/prefix 集合
 及其摘要；可识别的 data URL 另核对严格 base64 与 decoded digest，历史 opaque 字符串只记录 exact
  code-unit/UTF-8 bytes 和逐 chunk proof，不得猜 MIME 或制造 binary 语义。该路径只写 `migration_log`，
  不得制造 `content_objects/content_refs`、写 R2、删除 legacy chunk 或改变 message 事实。冲突/歧义
  owner、悬空 index、同 prefix 别名、缺号或超限 chunk 一律阻断；
- 冻结语料中若仍由 owner 引用的 `cha:` group 恰好只有一个空字符串 chunk，则不得把空字符串解释为
  零字节文件，更不得按 descriptor 的正数 `size` 补零或伪造 R2 对象。唯一兼容路径要求：owner 必须是
  一个由 `chmi:` 精确索引的 `chs:` row；message 只能含一个与 group identity、MIME、时间、正数 size、
  `storageChunks=1`、`storageKeyPrefix` 完全一致的八字段 attachment descriptor；chunk/owner/index 都有独立
  source proof，且 Core 重新验证 source reconstruction、完整 evidence digest 与“无 attachment content
  authority”约束。迁移在现有 `xmatrix.legacy-compatibility-quarantine` 中分别保存 group evidence 和 message
  descriptor evidence，message 的其他 canonical facts 正常迁移，但不生成该 attachment 的
  `content_objects/content_refs`、不暴露 R2 port、不执行 R2 HEAD/PUT，也不删除或改写旧数据。该规则只覆盖
  已审计的历史空-chunk writer artifact，不新增表、列、业务枚举或通用 malformed-attachment fallback；
- 对仍由 exact owner descriptor 引用的历史 `cha:` group，descriptor 的 `byteLength` 只在与全部连续
  chunk 的严格 data-URL/base64 解码结果一致时直接沿用。若历史 declared size 已陈旧但 MIME、prefix、
  chunk count/order、owner identity 和 payload 编码均完整无歧义，迁移必须使用命名、版本化的
  `relay-v2-legacy-stale-declared-size-convergence-v1`：证据同时封存 legacy declared bytes、actual decoded
  bytes、actual SHA-256 和 exact member proofs，canonical object/ref 的 bytes 与 content-addressed identity
  只取实际完整解码结果。Owner message mapper 必须逐字段验证 evidence 中 declared→actual 的 sealed transform
  后才生成使用 actual bytes 的 `content_ref`；没有 transform 时 evidence bytes 仍须与 descriptor 严格相等。
  禁止按 declared size 截断、补零、静默忽略差异或改写 legacy descriptor/chunk；
  transform 缺失、被篡改、超限或无法严格解码时继续阻断；
- 对带 legacy `objectKey` 的 object-backed attachment，canonical R2 identity 只能由已核验的 lowercase
  SHA-256 导出：`object_id=sha256:<checksum>`、`storage_key=objects/<checksum>`。Legacy HEAD 必须先
  匹配 durable byte length；缺少可信 SHA-256 metadata 时，只能对 ETag-pinned GET 做 bounded-memory
  streaming digest，源对象在校验或 copy 期间变化就失败关闭。Canonical target 已存在时 HEAD 必须同时
  匹配 bytes/checksum 才是 `verified-existing`；dry-run target 缺失只能是 `planned-upload`，execution
  只能从已校验且 ETag 未变的 source 流式写入 content-addressed key，再经 HEAD 核验为
  `uploaded-and-verified`。完整 evidence 在 RelayRoom 内封存 source key、canonical object/ref、checksum、
  bytes、mode、write/verification flags 和整体 digest，不得进入 inventory/source response。若 message
  descriptor 同时保存 `url`、`accessToken`、`objectKey`，compact proof 只保留这三个 canonical-clone
  value digest，并与 exact attachment id、owner message、canonical object/ref 绑定；source reconstruction
  只有逐叶摘要全部相等时才可丢弃这些旧 locator，raw URL/token/key 不进入 Core、checkpoint 或 result。
  同 key 不同 bytes/hash、缺失或篡改 locator binding、结构占位、LIST 或 operator 断言都阻断；
- 对只有 durable `contentHash`、没有 legacy `objectKey`/chunk manifest 的 attachment，该 hash 已声明
  canonical object identity，而不是上传计划。唯一允许的路径是 HEAD-only、`mode=read-only-verify`：
  `object_id=sha256:<contentHash>`、`storage_key=objects/<contentHash>`、checksum 必须等于 lowercase
  SHA-256，HEAD 的 exact bytes/checksum 必须与 durable descriptor 一致。成功 evidence 固定为
  `preexisting=true`、`writeAttempted=false`、`verifiedAfterOperation=true`、`outcome=verified-existing`，
  并绑定 attachment、owner ref、content hash、bytes 与 evidence digest。对象缺失或不一致在 dry-run 和
  execution 都立即阻断；该 path 不暴露 PUT，不能降级为 `planned-upload`，也不能由另一 bucket、LIST、
  placeholder 或 operator assertion 补造对象；
- 对既无 `objectKey`、`contentHash`、chunk manifest，又仍在 message descriptor 内完整保存 canonical
  base64 `data:` URL 的历史 attachment，只允许走 migration-only inline path。Decoded payload 硬上限为
  1 MiB；MIME header 与 canonical base64 必须严格一致。正常情况下 durable declared size 与实际 decoded
  bytes 相等；若唯一差异是陈旧 declared size，只能复用命名的
  `relay-v2-legacy-stale-declared-size-convergence-v1`，在 mapper/R2 evidence 中同时封存 legacy declared
  bytes、actual decoded bytes 与 actual SHA-256，且绝不截断、补零或改写 source。完整 bytes 的 SHA-256
  唯一决定 `objects/<checksum>`、canonical object 和 message-owned ref；source proof/
  R2 evidence 同时绑定完整 data-URL digest、attachment/message identity、bytes、checksum、mode 和 outcome。
  Inventory/dry-run 只可 HEAD，缺失对象只能报告 `planned-upload`；execution 才可写入 exact decoded bytes，
  且写后必须重新 HEAD 校验。Raw data URL 不进入 Core，也不扩大普通 attachment API；编码、MIME、size、
  checksum、identity、上限或已存在对象任一不一致都继续阻断，其中 size 只有上述完整命名 transform
  且其 legacy/actual/hash binding 全部一致时才不视为不一致；
- 对只有历史签名 URL、没有 inline bytes 或其他 durable locator 的 attachment，不引入通用 URL 存储或
  fetch adapter。Migration-only resolver 只接受精确的生产旧域名、canonical
  `/api/channels/<channel>/attachments/<attachment>?token=<64 位 lowercase hex>`，禁止 userinfo、port、
  fragment、redirect、重复/额外 query 和任意外域。Token 仅用于本地读取 exact nine-field `chao:` record；
  record 必须同时绑定 URL path channel、owner message、attachment、name、canonical MIME、size、timestamp、
  token 与 canonical legacy R2 object key。跨 Channel 只接受命名的
  `historical-thread-parent-object-binding-v1`：当前
  Channel 的 `parentChannelId` 等于 legacy object Channel，`metadata.kind=thread` 且
  `threadRootMessageId=owner message`；否则只能 same-channel。Worker 直接对绑定的 legacy R2 key 做
  HEAD/ETag-pinned GET/digest，绝不 HTTP fetch URL 或调用产品 download handler；dry-run 不写，execution
  只可 conditional PUT 到 `objects/<sha256>` 并 post-HEAD。Legacy R2 的 MIME metadata 若存在必须与
  chao/descriptor 一致；历史 metadata 缺失时，evidence 明确封存 chao-descriptor fallback，canonical target
  仍写入该 exact MIME。独立 evidence format 只保留 URL/token/chao/
  legacy key/channel relation 的摘要；compact proof 进一步绑定 exact canonical-clone URL source leaf、
  attachment id、owner message、canonical object 与 message-owned ref，raw URL/token/key 不进入 Core。
  独立 `chao:` row 的九个 locator/owner-cache 字段只有在 object proof 同时绑定 exact raw source-record
  digest 与 leaf-manifest digest 时才可丢弃；无关的 contentHash/R2 proof 不具备该 transform authority。
  Standalone `chao:` capability rows 按固定 3-hex、不可授权的 lexical prefix 分桶枚举；每个桶最多 8 条且
  整桶跨 list page/copy page 原子处理，Core source identity 只保留该 prefix 与 raw key 的 SHA-256。
  Raw token、raw `chao:` key、legacy object key 和 full audit evidence 都不得进入 source response、Core batch、
  checkpoint 或 last result。生产 source sequence 9,054 的只读 census 为 1,439 条、1,242 个桶、最大桶 4 条；
  若桶超限或发现旧 raw-capability checkpoint，必须 fail closed 并开启新的 copy generation。
  任何 locator 混合、record shape、relation、MIME/size/timestamp/identity、R2 bytes、digest 或 operation tuple
  不一致都 fail closed，且该兼容路径不扩大普通 attachment API；
- 为避免每发现一种 corpus 变体就重启整次 preflight，可以运行独立的 admin-only、read-only
  compatibility scan：成功且 schema-valid 的 page 中，兼容行继续计数，异常行按 HMAC key ref、family、
  classification、logical bytes 和稳定 error code 进入可恢复的链式摘要报告，cursor 每页原子 checkpoint。
  快速 census 只验证结构化 descriptor 与 domain mapper 兼容性；对 object-backed attachment 使用明确标记的
  临时 structural evidence，跳过 R2 HEAD/GET，并逐页累计 `deferredDeepCheckEntryCount` 与 family。临时 evidence
  不得离开 RelayRoom、进入 copy batch 或冒充 object/reachability proof；正式 inventory、execution copy 与
  acceptance 10/15 仍逐对象核对 exact bytes/checksum/reachability。这样 discovery 不会被大对象串行 checksum
  拖住，同时也不会把未做的深度核验伪装成通过；
  DO reset、5xx、超时、截断 JSON 和 cursor loop 属于 collection error，不得伪装成 corpus 异常；重试耗尽
  只能产出 partial artifact。该 best-effort 报告不复制数据、不改变 authority、不授权 migration/cutover/
  deletion；正式 inventory/copy/verification 仍要求 unknown/unsupported 为零，集中修复后从 checkpoint 重跑；
- 当在线 compatibility page 无法保真表达 structured-clone corpus 时，只允许使用独立的 privileged raw
  snapshot export。公开入口固定为 admin-only `POST /api/admin/relay-raw-snapshot`，内部 RelayRoom 入口为
  `POST /internal/admin/relay-raw-snapshot`；operator client 只接受 TLS、拒绝 redirect，gateway 将 body
  限制在 8 KiB，request 必须是 `application/json` 且 exact shape 为
  `{ cursor?: string, limit?: 1..1000, maxBytes?: 262144..16777216 }`。
  Handler 只能对 `DurableObjectStorage.list` 做有界只读分页，不调用 mapper/R2，也不写 storage、cursor、
  authority、delete 或 cutover state；全部响应（包括错误）必须 `private, no-store`。成功响应固定为
  `application/vnd.xmatrix.raw-snapshot-page;version=2`：`XMRSNP02` magic、big-endian uint32 canonical-JSON
  header length、header，以及逐条 uint32 length-prefixed `canonical-clone-cbor-v1` frame。Header 绑定 request/
  response cursor hash、row/record/exception count、logical bytes、ordered digest、binding digest，以及 page 前后
  `DurableObjectStorage` 原始 bookmark、bookmark hash、lexical order 和
  `migration:relay-v2-source-sequence`。Cloudflare PITR bookmark 是可按普通字符串比较的单调点位，且只读
  observation 也可能推进它；因此同页 `before <= after` 且 source sequence 不变才是 `pageStable=true`，
  bookmark 回退或 source sequence 漂移才置为 false，不能把 bookmark 必须相等误当成稳定性条件。record frame
  保存 exact key/keyRef、value encoding/value/logical bytes/raw digest，只有已审查的 structured-clone graph
  fallback 可保留共享 identity。无法保真或单 row 超过 page byte cap 必须输出 exception frame，使
  `snapshotComplete=false`，不能静默跳过。
  本地 `scripts/download-relay-raw-snapshot.mjs` 必须在新建 `0700` 目录内以 `0600` 保存每个 raw page、
  manifest、resume state 和 completion
  marker，逐页复算 framing、cursor continuity、ordered/binding/chunk/chain digest；只有终页 complete 且
  exception 为零才可发布 COMPLETE。中断续传可选 `--transport-endpoint`，仅用于把实际 fetch 转到同一已部署
  Worker 的 custom domain；source endpoint 与 transport endpoint 都必须是无 credentials/query/fragment 的
  HTTPS URL，二者解析后的 pathname 必须完全相同，并继续拒绝 redirect。artifact 的 `sourceId` 与 resume
  compatibility 始终只由 `--endpoint` 计算，transport endpoint 不得写入 manifest、resume state、chunk、marker
  或 compatibility output，因此既有 artifact 可在不改变身份与已提交 chunk 的前提下续传。该 artifact 含完整
  原始 key/value，按敏感生产数据处理：禁止写日志、
  上传 CI、进入普通工作区或充当 acceptance 1/9/10/15/official production evidence。它只授权离线本地
  compatibility 分析，不复制、不删除、不切换；downloader 逐页保存并复核原始 bookmark 的 lexical range，
  要求后一页 `before >=` 前一页 `after` 且全部 page 共享同一 source sequence。合法的 provider bookmark
  advancement 记录为 `advanced` 而不误报业务写；任一 bookmark regression 或 source sequence 变化使整体
  `snapshotStable=false` 且只能发布 INCOMPLETE。修复后必须重新对 live
  RelayRoom 运行独立的 full inventory/count/bytes/ordered-digest verification，并从正式 checkpoint 完成
  copy/R2/verification gate，
  raw snapshot 自身不能替代该 live 复核。唯一窄化例外是上文六个 exact reviewed 高容量 discard prefix
  （`obs:`、四个 trace prefix 与 `spmgmtevent:`）：逐前缀 rows/logical bytes/ordered digest 可以由完整、
  写冻结且 source-sequence-bound 的 raw snapshot 在本地派生，也可以由专用的
  admin-only `POST /api/admin/relay-v2/migration/reviewed-discard-aggregate` 在 RelayRoom 内直接派生，
  从而不为这六个 prefix 重下整份多 GB raw corpus。后者只在 Core 为 exact `WRITE_FROZEN`、durable
  admission fence 仍关闭、无 pending/in-flight legacy mutation 且 fence sequence 等于当前 source sequence
  时运行；每页最多 1,000 rows、16 MiB logical bytes 与 4 MiB redacted commitments，并在页前后重新核对
  authority/fence/sequence 和单调 provider bookmark。它复用 raw snapshot 的 exact value encoding/raw digest、
  domain-separated SHA-256 key ref 与 logical-byte 定义，把每条 redacted commitment 按 storage order 纳入
  pagination-independent SHA-256 chain；任何 exception frame 都 fail closed。
  分页只返回由独立 server-only `RELAY_V2_REVIEWED_DISCARD_RESUME_SECRET` 加密的 `rdagg1` AES-GCM
  authenticated-encrypted resume token；该 secret 不得等于或发给持有 `XMATRIX_ADMIN_TOKEN` 的 operator，
  raw continuation key 仅存在于密文中；
  response 和 error 都不得返回 raw key/value/cursor，handler 不写 storage/R2、不删除、不切换 authority。
  只有 terminal `complete=true` 的六前缀 sealed report 才能补全在线 exact-range skip 明确未声称的统计；
  它不能替代其他 authority family、unknown=0、R2 reachability、Core count/digest 或 PITR 验证；
- `aginstseq`、`agchseq:*` 等单调计数器保持 exact numeric value 并进入
  `monotonic_counters`（收敛前可进入保真 extension record）；它们不是 migration audit，也不是
  delivered intent。Reconnect block 只保存 exact scope、expiry 和原 payload，business status
  缺失时保持 absent；
- 不可逆 authority phase/fence 是长期安全状态。Operator session、copy cursor、source sequence、
  per-entity digest、pending reference 和 verification page 属于隔离临时 journal，product runtime
  不得读取，核验与 PITR 保留窗口结束后清理；最终 inventory/count/bytes/digest/reachability/
  drill artifact 依审计 retention 封存，不能随 journal 一起删除；
- migration 前必须生成 source-family → canonical fact → target primitive → retention 的映射，
  以及现有 target table → 3.1 primitive 的反向 inventory；不能把 `migration_log` 当作未知旧记录
  的长期收容表。
- 已逐前缀审查的 `obs_trace:`、`obs_trace_instance:`、`obs_trace_instance_v2:` 和
  `obs_trace_quarantine:` 全部归类为 `ephemeral`，不是 authority、unknown 或可恢复的产品历史。
  在线 inventory/copy 可以对每个 exact prefix 读取并封存一条真实 sample，再把 opaque cursor 精确推进
  到该 prefix 的最小 lexical end（分别为把末尾 `:` 替换为 `;`）；descriptor 必须绑定 prefix、end、
  sample source/fact proof、source commit sequence 和前后 page/copy chain，不能越过相邻 namespace，
  也不能把这一条 sample 冒充整个 prefix 的精确数量。写冻结后必须在同一 source sequence 上通过完整
  raw snapshot 或上述 frozen server aggregate 生成逐 prefix rows、logical bytes、ordered digest 和
  approved-discard totals 的脱敏 artifact；该 artifact 与在线 cursor-chain proof 共同作为
  activation/retirement 证据。Trace
  payload 不得映射为 Core fact、migration chunk、extension record、content ref 或 R2 object。Mapper
  不需要 hydrate 或解析完整 trace payload，单条 trace 超过 Core row/archive ceiling 也不得阻断
  migration；sample 的通用 source walker/proof 与冻结快照的 framing/cursor/digest 完整性仍必须通过。
  任何不在该 exact reviewed set 内的 trace-related prefix 继续按 unknown 阻断；非 trace quarantine
  仍按各自已审查规则分类，不能借用本例外。
- 已逐前缀审查的 `obs:` 和 `spmgmtevent:` 复用同一 exact lexical range 机制，但分别保持
  `ephemeral/observability` 与 `rebuildable/management_projection` 分类。每个 prefix 的一条真实 sample
  只证明 cursor 从 prefix 内部推进到最小 lexical end；它不能外推 rows/bytes/digest。写冻结后的完整
  source-sequence-bound raw snapshot 或上述 frozen server aggregate 必须为两者生成独立脱敏 aggregate，
  且两者都不得产生 Core business fact、content ref 或 R2 payload。相邻 prefix 和所有 authority family
  继续逐条复制与核验。

1. 合并 P0 止血，证明 `spmgmtevent` 新增为零；
2. 完成旧库 prefix inventory，分类 authority、rebuildable、ephemeral 和 unknown storage
   family；对已注册开放 family 另外记录 unknown kind/status 的 count/bytes/digest；
3. 为现有行为建立 typed repository 与原子 command contract tests；
4. 创建全新的 `RelayAuthority`、`RelayRuntime` namespaces 和满足 3.1 table-admission inventory 的
   Core SQL schema；migration-only 表与产品 schema 分组并声明清理点；
5. 旧库分页导出完整权威 current state envelope、规定热尾和必要 ledger；reviewed session trace
   只进入 ephemeral inventory/discard evidence，不进入该权威导出；
6. 冷历史、完整 message payload bundle、大 payload 和审计先写 R2，再导入经过验证的 refs/root；
   Agent trace 不属于这些 R2 历史或大 payload；
7. 旧库在每次权威事务中追加单调 `commit_seq` mutation log。它必须预先设置 rows/bytes/age
   ceiling、usage counter 和 freeze threshold；接近 ceiling 时提前进入 `WRITE_FROZEN` 或中止
   migration，不能让 catch-up log 把 legacy 库写满；
8. Core 按 entity version 幂等 upsert，delete 使用 tombstone；
9. 对每个 canonical 数据集和每张关系表核对 count、logical bytes、ordered digest、唯一约束
   和引用完整性；开放 envelope 还核对 codec、schema version、field presence、unknown-field
   round-trip 与 record digest；逐 source record 核对 raw/reconstructed source digest、leaf-path
   coverage 和 approved transform proof；
10. 把 Follow-up 导入 authoritative work-item current state 与一条有界 management ledger，
    校验证据引用和版本，不导入重复 snapshot；
11. 实现 ProjectionManifest、R2 history/change segments、`changeSeq`、稳定 `searchRankSeq`、
    grant version、snapshot epoch、删除语义和 `base_reset_required` 熔断；
12. 部署 Queue + Projection Export Worker，验证 R2 故障、重复投递和 Core finalize 失败时
    outbox/job 仍有界且分别保留至少 25% Core physical capacity 与 sustainable write-throughput
    余量；
13. 构建 Web 与 Desktop User Local Replica，对每个 projectable Space/Channel/Role/Profile/
    machine/workspace/app relation/message/Follow-up/registered extension kind 和 scope 做
    count/range/digest 验证；同时构建 exact-run Management Overlay 与 Local Media Cache，并在 schema
    与 storage ledger 中落实单份正文、search amplification、media quota 和 transient reaper；
14. 先以 shadow read 运行，导入并删除旧 `localStorage` history key，对同一用户的本地
    搜索、历史、Follow-up 与云端授权样本做 count/digest 对账，同时在生产形态 corpus 上
    记录每一类 logical/physical bytes 与 rebuild 峰值；
15. 短暂停写，追平最后 commit sequence，连续完成两轮不变量校验，并封存一个 freeze-point
    evidence manifest：exact source snapshot/last `commit_seq`、tool git SHA、codec/schema/inventory/
    descriptor-registry/approved-transform-manifest digest、Core commit/head、逐表 count/bytes/digest、retained root-set digest
    和 R2 closure digest；
16. 在 `WRITE_FROZEN` 窗口按 principal 持久 cursor 分页生成初始 entitlement：从已迁入 Core
    的 Space members、workspace-only owners、channels 与 channel access 推导
    `projection_principals/projection_grants`；Admin 请求不能携带或覆盖 ACL。必须实际完成而非只
    排队每个 active grant 的 base build，逐项验证 `current_root_ref` 已覆盖固定 content/change/
    redaction/purge head，再封存绑定第 15 步 freeze point 的 post-seed artifact：principal/grant/
    root count 与 digest、逐 grant coverage、seed cursor complete 和 readiness digest。Seed 完成后
    必须对最终 `sqlite_schema`、所有 Core 表的 rows/canonical bytes/ordered digest、最终 root set/
    closure/reachability 做全量复算；也可使用逐 seed transaction 的可验证增量 proof，但必须能从
    第 15 步 artifact 独立重放到同一最终 digest，不能只核对新 grant 表。Artifact
    还必须绑定 provider-confirmed production Core recoverable point/PITR range，以及覆盖其全部
    live/retained closure 的 R2 root-set digest 与 GC hold/not-before；hold 必须延伸到该 Core recovery
    window 末尾加安全余量。任一 active grant 不安全、Core point 不在可恢复窗口或 R2 hold 不完整
    都不得激活。此时另外封存唯一的激活前容量事实
    `relay_v2_cutover_candidate_footprint_report_v1`：它按严格时间顺序绑定互不相同的
    `before`、`shadow_peak`、`post_seed` snapshot。`before` 与 `shadow_peak` 必须绑定同一个
    非负 `LEGACY_ACTIVE` authority version（初始化的 version `0` 合法），`post_seed` 必须恰为
    下一 version、仍是 `WRITE_FROZEN` 并绑定同一 `frozenLegacyCommitSeq`；采集器不得为制造正
    version 而执行 freeze/cancel 或其他 authority mutation。标准 A11 观测链遵守同一规则：所有
    `LEGACY_ACTIVE` sample version 不变，唯一最终 `WRITE_FROZEN` sample 恰好加一。
    `post_seed` 必须完整计入尚未清理的
    migration journal、WAL/temp、R2 staging/orphan 等临时物理字节；Core long-lived、migration
    temporary 与 WAL/temp 的合计 physical bytes 必须 `<= 4 GB`，Legacy/Core/R2/local 每项在
    三个时间点都分别保留至少 25% capacity 和 verified sustainable write-throughput headroom。
    该 artifact 必须与第 9、10、11、12、15 项的 post-seed table inventory、Core-authoritative R2
    closure、容量曲线、峰值负载矩阵和 provider-confirmed PITR/GC hold 逐项一致。它只是全部激活条件
    中的一个 prerequisite，
    `eligible` 不能单独授权 `CORE_ACTIVE`、删除或 retirement。汇总这些新语义的完整生产切换门禁
    报告必须精确为 `artifactVersion: 3`；operator 与 Core 对旧版、缺失或未知版本一律 fail closed；
17. Authority-phase CAS 是唯一原子切换边界，并以 expected final readiness digest、Core commit/
    schema/root-set heads 做条件写；post-seed artifact 后任何漂移都使 CAS 失败并重新验证。CAS 前
    先证明所有 ingress/controller 代码已经部署，
    且每次产品请求都读取同一个 durable phase 选路；外部 route 变更和 socket close 不进入事务。
    CAS 成功后 Core 成为唯一写权，legacy handler 对任何新写永久拒绝；旧 WebSocket 关闭与客户端
    reconnect 是 post-commit、幂等、可重试 drain，失败也不能退回 `WRITE_FROZEN` 或重新开放旧写；
18. 保持 `CORE_ACTIVE`，旧对象只读并进入核验窗口；
19. 代表性用户的 Local Replica 从 Core/R2 完整重建并达到 manifest head；Management
    Overlay 达到 exact run 的当前授权 generation，搜索准确性、延迟和放大率均通过发布门槛；
20. PITR/核验 retention 结束后，先部署不再创建/引用 `_migration_*`、且永久关闭对应 operator
    path 的 schema/code version；验证旧版进程已排空、产品/operator query 计数为零，再由受保护
    schema migration drop 临时表并确认 constructor 不会重建，随后在 `CORE_ACTIVE` 下重新测量并
    封存真正的 steady-state Core/R2 artifact。True steady 必须证明临时存储已清理、核验/PITR
    窗口和恢复约束已满足，只用于最终 migration before/after 比较与 legacy retirement；它在时间上
    必然晚于 authority CAS，绝不能作为激活输入、激活阻断条件或 final readiness digest 的组成。
    `retire_legacy` 必须重新校验该 exact sealed report，并将其中现有
    `postSeedToSteadyContinuity` contract 的 post-seed snapshot、Core identity 与
    `activationEvidenceSha256` 逐项绑定到 durable activation evidence；continuity 还必须证明
    `CORE_ACTIVE` change journal 完整、retained facts 已核验、verification/PITR window 已关闭、
    protected cleanup 已完成，且 Core migration temporary 与 R2 staging/orphan physical bytes
    均为零。Migration/environment/source revision、report SHA-256 和独立审批必须完全一致；
    任一布尔声明都不能替代这些 exact artifact digest 与 continuity facts。
    主 cutover 流程到 `CORE_ACTIVE + legacy read-only` 为止；旧对象
    `deleteAll()` 只允许在 9.3 的独立 retirement runbook 中执行。

Snapshot、mutation apply、R2 copy 和验证都使用有界 batch、持久 cursor 和 request ID，
可以在超时或响应不确定时安全重试。任何 unknown storage family、canonical field loss、
引用错误或 digest mismatch 都阻断 cutover；registered open family 内的 unknown kind/status
只要保真、inert、受权且计入 digest，不属于 unknown storage family。Unknown namespace 的
quarantine 不能用来把 unknown 计数伪装为零。

唯一允许作为 authority-audit 保留的历史 quarantine 例外是已经逐前缀评审的 `agentprofile-invalid:v1:` 与
`legacyagentquarantine:v1:`：它们不是可恢复的 Agent Profile，也不是可推断的业务对象，而是
Agent 迁移产生的 authority audit。迁移必须把每条记录的完整 `canonical-clone-cbor-v1` 原值、
原始 key、来源前缀类型以及 source/fact/reconstruction digest 原样封存在现有
`extension_records` 的 `xmatrix.legacy-quarantine` namespace；`business_status` 固定缺席，
namespace 没有产品读取、Runtime handler、projection、index 或 side effect，且任何代码都不得把
它提升为正常 Agent/Profile。因为该 exact family 已有封闭 mapper 和无副作用目标，它计入已知
authority-audit family 而不计入 unknown；其他 authority quarantine 前缀和未知 namespace 仍按
unknown 阻断，不能套用此例外。该例外的 capacity 只能等于 freeze point 封存的
exact migrated corpus count/bytes/digest；namespace 不提供新 writer、update 或 import API，迁移后 rows/
bytes 必须单调不增。每条记录由 migration cleanup owner 持有，保留到 verification/PITR 窗口结束及
显式人工 resolution/审计-retention 决定；允许的 terminal action 只有继续封存或 bounded cleanup，
不得自动提升、重解释或把 `expires_at=null` 当作无界永久增长许可。

上述两个 Agent Profile 前缀限制不包含 control intent。`xmatrix.legacy-control-quarantine` 是另一个
封闭例外，只覆盖 exact `spawnintent:` 的 missing-or-invalid expiry 条件与 exact inverse proof；容量上限
等于 freeze-point 封存 corpus，迁移后只允许在 verification/PITR 与人工处理结束后有界清理，不能增长、
读取为产品事实或被任何 dispatcher 执行。

`obs_trace_quarantine:` 不进入上述 `xmatrix.legacy-quarantine` authority-audit namespace；它与
`obs_trace:`、`obs_trace_instance:`、`obs_trace_instance_v2:` 一样，是已经逐前缀审查的 session-trace
`ephemeral` family。它们仍必须进入 source rows/bytes/ordered-digest 与 approved-discard 证据，但 payload
不复制到 Core/R2，超大 trace 也不形成 migration blocker。该例外只覆盖这四个 exact prefix；其他
trace-related namespace 仍为 unknown，非 trace quarantine 只能使用其自身已审查分类。

### 9.3 Cloudflare 部署契约

Cloudflare 资源先部署、后导数、最后切路由。以当前 `wrangler.toml` 的 `v1/v2` 为基线，
下一次 Durable Object migration 增加全新 SQLite classes，概念配置为：

```toml
[durable_objects]
bindings = [
  { name = "RELAY_ROOM", class_name = "RelayRoom" },
  { name = "DEVICE_AUTH", class_name = "DeviceAuthBroker" },
  { name = "RELAY_CORE", class_name = "RelayAuthority" },
  { name = "RELAY_RUNTIME", class_name = "RelayRuntime" }
]

[[migrations]]
tag = "v3"
new_sqlite_classes = ["RelayAuthority", "RelayRuntime"]
```

实际变更同时增加 private R2 binding、`RELAY_EXPORT_QUEUE` producer/consumer 和最小权限的
download gateway；正式 tag 以合并时已有 migration 序列为准。DO class migration 只创建
namespace，不负责搬数据。`RelayCore/default` 与 `RelayRuntime/cell-0` 首次部署时没有生产
路由；schema 使用 constructor 内同步、快速、幂等的 `_sql_schema_migrations` 建立，constructor
不在 `blockConcurrencyWhile` 中发起 R2、Queue 或其他网络 I/O。

Cloudflare Durable Object migration 是原子部署，不能用 gradual deployment 做生产 canary；
同一份 migration/config 必须先在资源级完全隔离的环境完整部署和回滚演练，再一次性进入生产。
该隔离环境可以位于同一个 Cloudflare 生产账户，但账户相同不能作为资源复用的理由：必须使用独立的
standalone Wrangler 配置、无任何生产 route/custom domain 的独立 Worker，以及独立命名的 Durable
Object namespace/class、D1、private R2 bucket、Queue/DLQ、Analytics dataset 和独立值 secrets。
不得使用 `[env.*]` 继承顶层 binding，不得绑定、读取或写入任何生产 D1、R2、Queue、Durable Object
namespace 或复制生产 secret；部署前必须审查 resolved binding/resource inventory 并证明生产路由集合为
空。隔离环境完成部署、迁移、回滚、Core PITR 和 R2 retained-object/reachability 演练后，只能生成进入
独立生产验收门禁的证据，不能自动授权生产部署、切换或删除。最终
`deleted_classes` migration 会删除该 class 的全部对象和数据，因此只能在旧 binding、代码
引用、核验窗口与恢复审批全部关闭后执行；Human、Agent Instance 与 Machine Daemon 三条
生产 WebSocket handshake 也必须已经完成独立审查的 transport cutover，且路由审计证明没有
任何生产请求仍会命中 `RELAY_ROOM`。

生产冷迁移期间，immutable-tag Production Release 完成 exact-SHA 部署和 custom-domain health 后，必须在发送任何 migration
request 前运行受审查的 `Hub Cold Isolation` workflow。该 workflow 不接受 account/service/hostname/origin
参数，只能绑定一个成功的 `Hub Deploy` run：它将 exact `xmatrix-hub` workers.dev origin 设为 enabled、将
preview URL 设为 disabled 并读回确认，只在账户 inventory 中该服务至多存在一个且 hostname 精确为
`xmatrix-hub.xmatrix.sh` 时删除该 binding，再读回证明该服务 custom domain 数为零，并从 workers.dev origin
执行有界、无凭据的 HTTP 200 JSON health。任何额外/未知 domain、state mismatch 或 health failure 都阻断
迁移；artifact 还必须绑定 deployed revision、deploy run 与 tooling revision。该流程不读取、复制、删除或
切换 Relay 数据/authority，重复运行在 domain 已不存在时保持幂等；只有 artifact 通过后才能原样重放既有
`0600` checkpoint 的 pending request。

资源部署顺序固定为：

1. 发布新 class/binding/Queue consumer，但业务仍只写 `RelayRoom/default`；
2. 执行 snapshot + `commit_seq` catch-up，shadow 验证 Core/R2 与 Local Replica；
3. 进入 `WRITE_FROZEN`，完成 final/post-seed evidence 后只对 durable authority phase 做 CAS。
   三条产品 WebSocket controller 与所有 command/read ingress 已预先部署，并在每次请求读取该
   phase：`LEGACY_ACTIVE`/`WRITE_FROZEN` 只允许 RelayRoom 的既定行为，`CORE_ACTIVE`/
   `LEGACY_RETIRED` 只进入 Runtime 的 Human、Agent Instance、Machine Daemon controller。
   CAS 后 RelayRoom 永久拒绝新写；关闭旧 socket 是幂等 drain 而非原子事务的一部分。Runtime
   错误直接失败关闭，不能回退或向 `RelayRoom` 原样转发；
4. 核验窗口内保留 `RelayRoom` binding 与 class，旧产品 authority 只读不写；
5. 三条 transport 的代码替换已经完成；`retire_legacy` 仍只允许在 Core 已接受生产写且核验窗口
   已关闭后执行，并要求有界审批号。生产操作门还必须先验证三条独立 route 的外部 telemetry、
   零 `RelayRoom` 命中和封存 artifact；reducer 成功不等于删除授权。随后完成 `deleteAll()` 与
   数据审计，另一个独立 deployment 才移除 binding，并以新的 `deleted_classes` migration 退休
   `RelayRoom` class。

Transport 替换保留三个独立产品端点及各自认证/协议，不把它们折叠进
`/ws/relay-v2-runtime`。后者只是 Web/Desktop Local Replica 的一次性票据协调 socket，不能作为
Human、Agent Instance 或 Machine Daemon 任一产品连接已迁移的证据。新 Runtime 必须真正组合
三套 domain controller 与 Core ports；把旧 controller 帧不透明转发给 Runtime 同样不满足门槛。

`RELAY_V2_MIGRATION_ENABLED` 只控制受保护的迁移操作面，不参与产品数据面选路。产品数据面
只服从持久化 authority phase：Core 尚未激活时，projection、private R2、upload/ref 与定时产品维护全部失败
关闭；Core 激活后，即使该操作开关为 `false`，Human 的 manifest、redaction、Local Replica
Runtime session、R2 读取、附件上传、Queue export、cold-history archive 与 reachability GC 仍必须
可用。每次私有 Queue delivery 仍须重新 claim 精确 Core durable job。客户端只有在用户级 readiness 同时证明 seed
完成、entitlement catalog 已导出、全部 active scope 都有覆盖当前 change/redaction/purge head 的
安全 current root 后，才从 legacy read path 切到本地副本。

任何一步失败都不能复用 migration tag、重命名旧 class 或让两个 authority 同时接受写入。
Queue、R2 与 gateway 可以独立回滚；`CORE_ACTIVE` 之后的数据层回滚只能继续使用 Core/R2
authority 并向前修复。

## 十、验收标准

只有以下条件全部成立才允许生产切换：

生产 source inventory 与 raw digest 必须绑定 9.2 第 15 步的 freeze point；激活前 Core 逐表
size/count/digest 与 R2 reachability 必须绑定第 16 步 `WRITE_FROZEN` post-seed state，并有可验证
proof 把二者串联。Authority CAS 必须以包含 cutover-candidate digest 的 final readiness digest
未变化为条件，但不得要求只有 `CORE_ACTIVE` 后才能产生的 true steady。True steady 只在
`CORE_ACTIVE` 核验/PITR 清理后生成，用于最终前后比较和 retirement。PITR drill 与 synthetic load 属于资源隔离证据：它们绑定同一
tool git SHA、schema/codec/object-format 版本和各自内部一致的 drill dataset，不绑定、不读取也不
复用生产资源或 secret，不能伪称来自生产 snapshot。CI smoke 只证明代码路径可执行和基本回归
未破坏，不能冒充生产规模、生产数据、恢复能力或 production cutover 验收；CI artifact 不得
使用 `production passed` 或等价表述。

1. 旧库 Key family inventory 中 unknown storage family/namespace 为零；未逐前缀评审且没有
   exact inert mapper 的 quarantine 不得从该计数扣除。只有上文两个 Agent quarantine 前缀可作为
   `xmatrix.legacy-quarantine` 已知 authority-audit family，且必须逐条通过原值 round-trip、无
   business status、无产品/Runtime handler 和 source/fact digest 重建证明。Registered open family 内的 unknown kind/schema version/status 有独立
   count/bytes/digest，能完整 round-trip 且保持 inert；另行核对 exact `spi:` 的 hash-bound 可查询/可兑换
   `space_invites`，以及 exact `spawnintent:` missing-or-invalid expiry 只产生不可执行的 control quarantine；
2. 全部 observability 类型有穷尽分类，ephemeral 压测不会增加 Core rows/bytes；`obs:`、四个 exact reviewed
   trace prefix（包括 `obs_trace_quarantine:`）与 rebuildable `spmgmtevent:` 分别具有 source rows/bytes/ordered-digest 与
   approved-discard totals，除临时审计 evidence 外不产生 target fact，trace payload 在 Core/R2 的
   long-lived rows/bytes 为零，且超大 trace 不阻断 migration；若在线迁移采用 exact lexical range
   skip，每个 prefix 还必须有一条真实 sample 的 source/fact proof、range end 与 cursor-chain seal，精确
   totals 必须来自同一冻结 source sequence 的完整 raw snapshot 派生 aggregate，不能用 sample 外推；
3. `spmgmtevent` 在新架构中没有表、repository 或写入口；
4. Runtime 没有业务 storage binding，constructor 不做全量数据加载；
5. 现有事务不变量全部映射到一个 Core 原子 command，并通过逐语句故障注入；
6. message ID 唯一，`channel_id + sequence` 唯一且连续；每条 legacy source record 到有序
   canonical fact set 的组合 digest 一致，并由 mapper-independent verifier 证明
   `raw_source_record_digest == reconstructed_source_digest`、全部 source leaf 恰好映射一次或命中
   approved transform proof。Message aggregate 逐字段保留 body、完整 `from`/
   immutable sender snapshot、reply/quote、app/rich metadata、model/effort/status chips 与
   unknown fields；reaction、attachment/content ref 和 per-user `mentionReadStatuses`/attention
   作为独立 facts 核对且不在
   message payload bundle 重复。Projection `searchRankSeq` 全局唯一、与 Core commit/ordinal 或获批
   legacy backfill 映射一致；
7. cursor 不超过已提交 sequence，重复 ACK 和 replay 幂等；
8. ACL、membership、Profile name 以及已知闭合基础设施 reducer 的状态机在迁移前后完全一致；
   开放 message/control/extension 的 namespaced kind、schema version、business status、unknown
   fields、absent/null/undefined/array-hole 与 numeric edge semantics 完整 round-trip，任意新
   kind/status 不需要 SQL migration；未知 handler/unsupported schema fail closed，存储层不
   合成默认状态或 JSON 化 clone value；
9. Exact `sqlite_schema` expected inventory、逐表 rows/canonical logical bytes/ordered digest 和
   全库 physical size 在 `WRITE_FROZEN` final post-seed state 一致，并由 source freeze artifact + seed proof 可独立
   重放；table-to-primitive artifact 证明没有同义 current state、完整 payload
   副本或被产品路径依赖的 migration-only 表。多个 source prefix 映射同一 identity 时只允许
   equal fact-set digest 去重，否则阻断。Extension canonical/index 分别核对，partial candidate
   不得报告 complete；
10. 所有 live/retained `content_refs` root 及其 transitive closure 全部通过
    size/checksum/reachability 验证；分页 proof 的 candidate/published generation、root-set CAS、
    crash/reap 和逐层 parent→child 完整性通过故障注入，GC 永不读取 partial candidate；R2 LIST
    不替代 Core closure authority；另覆盖 delete-authorized 后 crash 的 R2 HEAD reconciliation、
    新 PUT/ref 与 delete lease 竞态、exact R2 metadata/ETag mismatch，以及投毒 legacy candidate；
11. 激活前 cutover-candidate 的 post-seed Core physical bytes（含所有未清理 migration/WAL/temp
    bytes）`<= 4 GB`，90 天容量预测小于 6 GB；激活后 true steady 另行复测，不能回填或替代
    post-seed 门槛；
12. 以未来数千主体的两倍峰值执行可重复负载矩阵，记录 Core/Runtime p99、errors、overload、
    outbox/job/export backlog、写入利用率和物理/logical bytes；overload 与不可解释 errors 为零，
    backlog 在预算内收敛，并分别证明至少 25% Core physical capacity headroom 与 verified
    sustainable write-throughput headroom；
13. 故障注入证明“Core 已提交、fan-out 前 Runtime 重启”不会丢失或重复创建消息；
14. Automation alarm、archive 和 GC 重复执行不会重复投递、重复删除、越界删除或产生悬空引用；
15. Production post-seed artifact 在 `WRITE_FROZEN` 先证明 cutover Core point 位于 provider-confirmed PITR range，且
    对应 R2 root set/closure 有覆盖整个 recovery window 加安全余量的 GC hold/not-before。另在
    资源隔离环境使用其自身一致的 drill snapshot/Core backup 与 retained R2 object set，按与生产
    相同的 tool git SHA、schema/codec/object-format 完成 PITR + 全量
    size/checksum/reachability 恢复演练并封存报告。Drill fixture manifest 必须非空并覆盖每张
    long-lived table、全部 codec/schema generation、每种 owner/root、多层 closure、共享 multi-ref、
    revoke/tombstone、GC not-before、inline/R2 extension 和 candidate crash；同时声明最小 rows/
    objects/depth/bytes，不能用微型 happy-path 冒充。Drill 不得读取或绑定生产
    DO/R2/D1/Queue/secret；
16. 旧对象在核验窗口内保持只读，部署回滚不会重新启用 legacy writes；
17. Web 与 Desktop 在 `10^4/10^5/10^6` messages、不同 Channel 分布、至少 10,000 个活跃
    Follow-up，并覆盖发布时生产 p99 授权 searchable-text bytes 的 2 倍数据矩阵上记录
    database/FTS/compaction 峰值、bootstrap 时间和 query p95；每个受支持浏览器只有在其已
    通过的容量层级内才可宣称 complete。每个 projectable Space/Channel/Role/Profile/machine/
    workspace/app relation/message/Follow-up/registered extension kind 和 scope 的
    count/range/digest 均须一致。Fresh bootstrap、gap recovery、history scroll、
    search click 和 Follow-up list/read 只允许读取 Core ACL/manifest/redaction metadata 与
    R2 payload，不调用 Core history/Follow-up payload query；
18. message edit/recall/delete、Channel archive/revoke、history floor 前移和丢失 Runtime
    delta 都通过 `changeSeq`/manifest 收敛到 Hub 状态；离线错过 revoke 后，下一次查询前
    完成正文、索引和 Follow-up purge；
19. 中文、英文和代码搜索与授权历史的 count/digest 抽样一致，返回稳定 source ref、
    timeline sequence 和 freshness；
20. 删除或损坏 Web store、daemon SQLite 或 Management Overlay 后可以从 Core/R2 重建，
    期间不改变任何服务端状态；
21. 本地伪造 Follow-up、篡改 version、复用 idempotency key、普通 Agent 查询用户全库或
    失效 management run 的 mutation/query 全部被拒绝；普通 Agent 直接打开 replica、key
    store 或 daemon control socket 也失败，无法证明进程隔离的平台在 launch 前 fail closed；
22. 100 个并发客户端持续搜索、滚动历史和刷新 Follow-up 时，Core search、history
    payload read 和 Follow-up list/read QPS 均为零；reconnect、gap recovery 和 bootstrap
    的 ACL/manifest/redaction metadata 负载满足 Core 预算，R2 segment 负载满足对象/带宽
    预算，Core 不产生 per-device 持久行；
23. logout、换账号、origin 变化、authorization epoch 更新和 lease 过期都按测试矩阵清除
    或隔离旧 generation，不发生跨用户、跨 run、跨权限读取；
24. 对重复、乱序、跨洞 delta 分别验证幂等、连续 applied head 和 R2 补洞；replay floor
    前移或 published snapshot epoch 变化只重建受影响 scope，不跳过 gap。旧 manifest 的
    404/checksum/version 错误通过刷新 root 恢复；fresh published root 仍损坏时明确进入
    authority-integrity unavailable/alert，而不是伪装成功；
25. 强制 R2/Queue/Exporter 长时间失败，证明 projection ordinary lane 与 jobs 都不超过各自
    rows/bytes/age 上限，reset 期间 published root/epoch 不提前改变；恢复后在持续 mutation
    下完成覆盖 `(changeHead, redactionHead, purgeEpoch)` 的 base + 连续 capture tail 有限
    cutover，客户端只在 CAS finalize 后切换且没有 gap。Capture backlog 触限时所有扩大
    projection 的非安全 mutation 都受到可重试 backpressure，hot payload 触限时新增正文/
    binary 同样受限；ACL、revoke、retention hard-delete、recall/delete 和释放容量命令继续
    成功，并分别保留至少 25% Core physical capacity headroom 与 verified sustainable
    write-throughput headroom；
26. Steady state 中 message history 不写 `localStorage`，UI main thread 不做整库 stringify、
    压缩、扫描或索引；删除 IndexedDB/OPFS/daemon SQLite 后能够完整重建；
27. Complete generation 的 searchable text 不因 LRU/TTL 回收；媒体 cache 的 byte/count/age
    淘汰不影响搜索 count/digest。撤权后旧 reader 与对应 media ref 不可达，FTS/snippet 和旧
    generation 不再被任何产品 query 返回；binary/thumbnail 只有仍存在其他有效 ref/pin 时
    才可物理保留。Adapter 执行 checkpoint/secure-delete/compaction 的 best-effort 清理，
    Desktop/daemon 整 profile 删除通过销毁 encryption key 验证密码学删除，Web 明确只承诺
    origin store best-effort 清除；
28. Web quota/persistence 不足、browser store 部分被驱逐和 Desktop 磁盘不足都明确返回
    unavailable/partial/stale，不把近期子集标记为完整；
29. R2 bucket 不公开，过期、错误 user/device-session/scope/grant-version/redaction-head/
    root/hash/range 的 capability 全部被 gateway 拒绝；hard-delete 后旧 root 不再签新 ticket，
    object key、ETag 和 content hash 单独不能下载任何私有 payload；
30. Follow-up evidence scope 迁移产生旧 scope tombstone + 新 scope 高版本 upsert，迟到事件
    不会越权或误删；evidence hard-delete 按 retention 清除 excerpt 并传播
    `evidence_unavailable`；
31. 在 upload intent 创建、R2 PUT、校验、Core ref commit 和 GC 的每个边界注入失败，证明
    不产生悬空权威引用；staging lifecycle 永远不能删除 `objects/<content-hash>`，被引用
    final object 在 PITR/恢复窗口内保持可达，无引用 intent orphan 可重复安全回收；
32. 在 R2 reset 期间执行 revoke 与 retention hard-delete，证明 authorization/redaction head
    在 query lease 前生效；typed redaction read 的分页、重复、gap、floor 前移均只推进连续
    head。Redaction 控制集触限时 scope-wide purge epoch 原子启动 clean-base rebuild，使对应
    scope unavailable 并清空本地内容；candidate root 必须过滤至 cutover redaction head，
    不丢 tombstone、不等待新 base 才隐藏已删除内容；
33. 对中文、英文、代码、Unicode、phrase、substring、短词、edit/delete 与组合 filter 运行
    reference matcher 等价测试。Web 与 Desktop 在相同 query lease 下返回相同稳定 ID 集合、
    match tier 和 `searchRankSeq` deterministic order；对每个 tier/field stream 注入晚到但
    更高排序的候选，证明 bounded merge 不会提前发布。候选尚未耗尽且没有 proven bound 时，即使已经
    填满一页也只能返回 `budget_exhausted + provisional preview + resume token`，不得签发
    final cursor。候选耗尽后的 keyset 分页不丢不重。性能矩阵满足 8.5.4 的 p95/p99 门槛，
    降级不能跳过授权、redaction、精确验证或全局排序证明；
34. 在第 17 项全部容量层级以及高熵短消息、极短 CJK、唯一/重复 trigram、超长正文、高基数
    filter/ID 和高 churn corpus 上，以 versioned canonical encoding 独立复算 `C_v`，并按
    storage ledger 核对 logical/physical bytes。Checkpoint 后
    `P_search <= 32 MiB + 3C_v` target，任何宣称 complete 的 adapter 必须低于
    `64 MiB + 4C_v` hard ceiling；User Local Replica schema/disk 检查证明没有 normalized
    body、snippet、完整 segment 或第二套 full-body index 的持久副本；
35. 重复和并发打开相同附件、thumbnail/transform 及多个 scope 引用，证明 profile 内
    content-hash blob 去重和 multi-ref revoke 正确；全量 bootstrap 不下载媒体原件。对错误/
    缺失 Content-Length、transform 输出膨胀、reservation 后 kill/restart 注入故障，断言
    `unpinned + pinned + thumbnail + transform + partial <= mediaQuota` 且总物理占用不越过
    `Q_profile`，所有未落盘 reservation 与 `E_device` 不超过实时 free bytes。最后一个 ref/pin
    消失后 binary 收敛，搜索 coverage 不变；
36. 在 segment import、index rebuild、WAL checkpoint、candidate CAS、overlay rename 和
    compaction 的每个边界杀进程。重启 reaper 删除所有过期 partial/temp/candidate/旧
    generation，app 不留下 replica backup，稳态只剩一个 current generation；长 reader 被
    有界取消，free pages 可复用并渐进归还。全过程持续断言
    `P_profile + R_profile <= Q_profile`、device/origin 聚合 app quota、各 category hard cap，
    以及 `R_all_profiles + E_device <= free_bytes_now`，不能只验证最终收敛；
37. Management Overlay 在任意时刻只有 exact configured run 的一个 current view，每个
    Channel 只有 `CHANNEL.md/messages.md`。用超过单文件/overlay quota 的巨大 Channel 验证
    run 明确 unavailable；在 render check 与 rename 之间 stop/replace/revoke，旧
    `managementRunId + overlayGeneration` writer 不能复活路径。Lease expiry 后 current/temp
    全部删除，且全过程不越过 overlay/profile quota；
38. 模拟 browser quota 驱逐与 Desktop warning/critical 磁盘水位，验证固定降级顺序为停止
    新可选 allocation/candidate、回收过期 artifact、淘汰未固定媒体、停止普通 delta 并标记
    stale，最后在安全边界要求下单份 unavailable 重建；searchable text 不被静默 LRU。
    `Clear Unpinned Media Cache`、`Remove Offline Downloads`、`Rebuild Search Index` 和
    `Remove All Local Data` 的实际删除范围与设置页分类完全一致；
39. 在磁盘接近 hard quota 时 revoke 最大 scope：fixed-size access gate 必须先成功关闭旧
    reader，随后每个 purge batch 的 WAL/page high-water 都不越过预留。Gate 提交失败时整个
    profile 立即 unavailable/隔离，重启和离线 query 也不能重新打开旧授权数据；purge、logout
    和删除不被普通写或媒体 reservation 饿死；
40. 启动、升级、crash 和周期 GC 时扫描 Storage Registry；未登记文件、过期 lease、第三个
    generation、遗留 `.part`、旧 transform 和无 owner temp 全部被隔离并删除。只有 canonical
    current generation 与显式 pinned 内容可以没有 TTL，registry 汇总与实际 filesystem/
    origin usage 的差异必须低于发布阈值；
41. 在同一 Desktop volume 和 Web origin 并发运行多个 profile 的 index rebuild、media
    download/transform 与 Management Overlay render；device/origin-wide coordinator 必须原子
    拒绝至少一个会越界的 reservation，并在全过程保持
    `P_all_profiles + R_all_profiles <= Q_app_on_device_or_origin` 与
    `R_all_profiles + E_device <= free_bytes_now`。单 profile 的成功预检不能绕过聚合上限。Web
    验收必须在每个受支持真实浏览器中使用真实 IndexedDB 与 Web Locks（无原生 API 时运行产品的
    真实 fallback），启动多个独立 profile/context 并行为断言 aggregate rejection、上述两个 quota
    invariant、crash lease reap 和 control-purge 抢占；source inspection/regex、mock DB 或 mock lock
    均不能作为通过证据。Desktop 另在真实 volume/daemon coordinator 上执行同一矩阵。
42. 对可扩展存储运行真实行为矩阵：registered namespace 的新 kind/status/unknown fields 与
    unsupported schema version 在不改 SQL schema 时按 policy 完成 inline/R2-ref byte-preserving
    round-trip；`canonical-clone-cbor-v1` 覆盖 absent/null/undefined/array hole、numeric edge、
    BigInt、Date 和 typed bytes，并用同一组 normative vectors 断言 TypeScript/Rust/Browser 的
    exact encoded bytes、record digest 与拒绝集合一致；unsupported clone type 必须隔离。Unknown namespace 进入有界
    privileged quarantine 后仍计入 unknown 并阻断 cutover；未注册 handler、越权 scope、伪造
    descriptor/index、超 record/index/namespace quota 和把 partial index 声称 complete 全部失败
    关闭。对 descriptor/index version 升级、并发 CAS、tombstone、TTL、revoke、rebuild 中
	    crash/reap 做故障注入：candidate generation 不污染旧 published generation；update/delete 后
	    无 stale index row；payload-ref 同事务替换/释放且安全 projection 完成；canonical record 唯一、
	    derived index 可重建，任何 extension 都不能扩大权限或绕过 physical/throughput headroom。
	    负向 ownership 矩阵必须证明 message、reaction、attachment/content ref、control intent 与 ACL
	    等已有 canonical owner 的事实即使换 namespace/kind 也会被 domain-bound handler 拒绝，且不会
	    产生 extension row、index row、projection、权限变化或 side effect；canonical scan 与 published
	    derived index 的查询结果必须等价，partial/candidate index 永远不可参与产品读取。
	    `xmatrix.legacy-quarantine` 只允许迁移 mapper 写入上文两个 exact Profile 前缀，必须保存来源类型与
	    完整 canonical-clone 原值，且没有产品读写 handler；`obs_trace_quarantine:` 不得写入该 namespace，
	    而是仅按上文 exact reviewed session-trace `ephemeral` 规则记录 approved-discard evidence。
	    其他未知 trace/quarantine namespace 不得套用任一例外。
	    独立 `xmatrix.legacy-control-quarantine` 只允许 exact `spawnintent:` missing-or-invalid expiry mapper
	    写入，必须完整 round-trip，且 daemon intent、产品读取、Runtime handler 和 side effect 均为零。
43. 对 upload、daemon-control、Human-approval 与 OAuth/credential intent 安全分区做真实交叉矩阵：
    一个分区的 principal 即使伪造相同 kind/id 也不能 list/read/claim/cancel/transition 另一分区，
    quota、lease、cleanup 和 failure injection 不能跨分区耗尽或释放状态；generic mechanics 中不得
    出现 bearer token、credential、secret ciphertext，只有经目标安全域复核的 opaque secret ref。
    每个 reducer 只接受自己的 closed `dispatch_state` transition，未知 business kind 保持 inert。

## 十一、规模与迁出边界

Cloudflare 原生阶段覆盖当前至数千活跃主体：

- 约 5,000 活跃主体前完成外部 Postgres 适配器、压测和恢复演练；
- 达到任何 Core 容量/写吞吐 Red 时立即启动 shadow migration；
- 在约 10,000 活跃主体前完成专用数据库切换；
- Runtime、R2 object format、稳定 ID、command protocol 和 migration manifest 保持不变；
- Workers 继续作为边缘入口时，可以通过 Hyperdrive 连接外部 PostgreSQL。

人数只用于项目排期；数据库大小、增长率、写入利用率、p99 和 overload 才是执行红线。

## 附录 A：当前实测基线（非规范性）

本附录只解释方案来源，不定义长期 schema 或生产通过状态；实施时以绑定 exact git SHA、schema
digest 和 snapshot time 的生成式 evidence artifact 为准。

### A.0 Full+Slim 旧格式移除观测（2026-07-28）

生产上“约 9 GiB 旧格式”对应 **RelayRoom SQLite**（cutover 前/后物理仍约 **9.07 GiB**），
不是产品权威本身；Room→Core 后权威在 Core（约 **1.4 GiB**）。长驻 R2 `projection-*`
森林（峰值约 **2.1 GiB**）已在 owner 批准下清空，且代码默认关闭长驻 projection export，
避免再放大。保留 `objects/` + `archive/` 约 **0.56 GiB**。

完整移除情况（前后表、前缀、未删除 Room 的原因与 `LEGACY_RETIRED` 后续）见：

- `docs/architecture/relay-storage-full-slim-adr-zh.md`

### A.1 历史峰值样本（2026-07-15）

2026-07-15 08:08:17 UTC，Cloudflare `durableObjectsSqlStorageGroups` 最新可见样本为：

| 指标 | 数值 |
| --- | ---: |
| `RelayRoom/default max.storedBytes` | 10,737,414,000 B |
| 十进制 | 10.737414 GB |
| 二进制 | 9.999996 GiB |
| 事故事件出现前样本 | 3,889,668,000 B |
| `spmgmtevent:` dry-run | 4,766,587 rows |
| `spmgmtevent:` JSON value 估算 | 3.05 GiB |
| 已审阅的最老 50% 清理目标 | 2,383,290 rows |

该指标是时间窗物理高水位，不等于当前 live bytes；3.05 GiB 也只统计 JSON 编码后的 value，
不含 key、SQLite page、索引和存储层编码。删除一半记录会释放可复用页，但行数、JSON bytes
与物理文件下降不是线性关系。因此在清理完成后的全量重扫和 fresh metrics 到达前，能够
确认的是“峰值已到平台上限”，不能把 10.737414 GB 或预计删除量表述为实时剩余占用。

Legacy 库本身有明确优化空间：彻底移除运行事件持久化、将强关系/热点字段迁入原生 SQL
列、将可演进低频字段迁入有界 canonical envelope、只保留必要索引、把正文历史迁到 R2，
并删除重复派生 projection。SQLite 删除后的空闲页可供后续写复用，但可靠的紧凑基线来自迁入 fresh `RelayAuthority` 后实际测得的
`databaseSize`，不是对旧文件执行在线压缩的估算。Migration 必须分别报告：旧库分类前
bytes、迁移后的 Core long-lived current-state bytes、临时 migration journal bytes、R2 unique
referenced/retained/staging-orphan bytes、索引 bytes 与可重建数据 bytes。每个 artifact 记录
snapshot/time、数据来源、tool git SHA、`databaseSize`、page/freelist/index 口径以及清理前后水位，
不能把时间窗 metric max 当 live size。容量证据拆成两个不可互换的 artifact。激活前
cutover-candidate 给出三个时间点，所有资源分列：

1. migration 前 legacy DO live physical/logical bytes；
2. shadow copy 期间 legacy DO、Core DO long-lived、Core migration temporary 与 R2 各自峰值，
   其中 journal、index/closure candidate、seed 与 WAL/temporary page 全部计入对应资源；另给只用于成本观察的总 authority footprint；
3. projection seed 完成后、authority 仍为 `WRITE_FROZEN` 的 post-seed Core DO 与 R2 分项；
   journal、WAL/temp、candidate/staging/orphan 等尚未清理的临时物理字节必须完整计入，不得以
   “将来可清理”为由扣除。

激活后另行封存 true-steady artifact：只有在 `CORE_ACTIVE` 核验/PITR retention 结束、受保护
schema cleanup 完成且临时表不会重建后，才测量 steady-state Core DO 与 R2 分项；legacy 在独立
retirement 前仍只读保留。该 artifact 给出最终 before/after 和 retirement 证据，永远不回流为
authority activation prerequisite。这样 activation 只依赖激活前可观测事实，不形成
“必须先激活才能测 steady、又必须先有 steady 才能激活”的循环。

True-steady 不得把 A9/A10/A11/A15 的 post-seed snapshot、bytes 或 digest 冒充为清理后的
steady 值，也不得要求两者相等。`relay-v2-post-seed-to-steady-continuity-v1` 以原 post-seed
snapshot 为起点，以新的 steady snapshot 为终点，封存 `CORE_ACTIVE` 激活证据、连续且完整的
Core commit change journal、retained-fact 复核、核验/PITR window 关闭证据和受保护 cleanup
receipt；每份来源都有精确 SHA-256。业务写可使 Core/R2 bytes、表 digest 和 commit sequence
前进，连续性由 journal 与复核证明，而不是由静态值相等证明。steady 观测前 Core migration
temporary 与 R2 staging/orphan 必须实测为零。

报告同时给出前后绝对值、分类占比、重复消除量和 90 天增长曲线；不能用 logical JSON bytes
代替 physical database size，也不能把可清理临时副本计入“新设计长期占比”。目标是先用真实
copy 证明 post-seed cutover-candidate Core（包括临时物理字节）`<= 4 GB`，再用激活后清理结果
证明 true steady-state Core `<= 4 GB`。Core physical capacity headroom 与 verified sustainable
write-throughput headroom 分别计算并均至少 25%；Legacy、Core、R2 和本地存储的容量/吞吐余量
也分别报告；shadow-copy peak、post-seed candidate 和 true steady state 都必须通过各资源自己的 `<=75%` capacity 与
`<=75% verified sustainable throughput` 门（没有固定 platform ceiling 的资源使用审查通过的
quota/budget）。跨资源总 bytes 只能用于成本，不参与任何单资源 headroom 分母。

## 附录 B：参考

- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [SQLite-backed Durable Object Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Durable Objects migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- [Durable Objects WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Durable Objects metrics and analytics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)
- [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
- [R2 object lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [Cloudflare Queues](https://developers.cloudflare.com/queues/)
- [Cloudflare Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [R2 presigned URL security considerations](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [Workers Analytics Engine sampling](https://developers.cloudflare.com/analytics/analytics-engine/sampling/)
- [Workers Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
- [SQLite FTS5](https://www.sqlite.org/fts5.html)
- [Telegram: Working with Updates](https://core.telegram.org/api/updates)
- [Telegram: Search](https://core.telegram.org/api/search)
- [TDLib Getting Started](https://core.telegram.org/tdlib/getting-started)
- [TDLib Storage Optimization](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1optimize_storage.html)
- [Slack: Search at Slack](https://slack.engineering/search-at-slack/)
- [Slack: Making Slack Faster By Being Lazy](https://slack.engineering/making-slack-faster-by-being-lazy/)
- [Slack: LocalStorage cache retrospective](https://slack.engineering/making-slack-faster-by-being-lazy-part-2/)
- [Slack: Service Workers and offline support](https://slack.engineering/service-workers-at-slack-our-quest-for-faster-boot-times-and-offline-support/)
- [Slack: Real-time Messaging](https://slack.engineering/real-time-messaging/)
