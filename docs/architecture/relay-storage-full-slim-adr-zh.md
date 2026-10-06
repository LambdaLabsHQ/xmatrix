# ADR: Relay V2 全量双端文本预算与 R2 GC 发现≠删除

| 字段 | 值 |
| --- | --- |
| 状态 | Accepted（设计 Draft r6.1 + Codex approve-with-changes；实现分期） |
| 日期 | 2026-07-28 |
| 关联 | `scratch/design-3ae1348f/design-doc.md`、`docs/architecture/relay-storage-summary-zh.md` §8.9 |

## 背景

Room→Core cutover 后，长驻 R2 projection 树（identity pack、中间 export 页、30d hold）成为存储放大主因。产品要求授权范围内**全量**可搜索历史，且双端文本面目标为数十 MiB；本地应从 Core/archive 鉴权填充，而非依赖长驻 projection forest。

## 决策

1. **产品全量 ≠ Core 热层维护水位** — 160 rows / 4 MiB 只触发后台批量归档并回落到 100 rows，不得阻塞消息确认；4,096 rows / 256 MiB 只提升同一维护任务的调度优先级，不是频道 admission cap。消息准入只能在独立计量的全局/物理存储安全边界失败。
2. **双端 physical hard 目标** — 云端 `SpaceTextPhysicalBytes`、本地 checkpoint 后 `P_search`；并保留 §8.9 `P_search ≤ 32+3C_v / 64+4C_v` 放大 envelope。超限默认 admission backpressure；**禁止**用 partial/pin 伪称 `complete`。
3. **服务端授权扩大准入** — `PrincipalLocalCompleteUpper = ceil(C_v_authorized × LOCAL_AMP) + FIXED`（非 gzip 云端字节和）；同事务 reservation/CAS。
4. **R2 角色** — `objects/` 附件 CAS + 可选 `archive/` 冷段；稳态长驻 `projection/*` 目标为 0。
5. **GC 发现 ≠ 删除** — LIST/metrics/discover-only **不得** claim 或条件删除。Projection orphan 删除、archive 删除、export-off 默认开、hard budget enforce 均须独立前置证据与审批后启用。
6. **Projection object safety** — 未引用 projection 对象 GC safety 为 **1 小时**（与 30 天 root retention 分离）。
7. **任意迁移（owner）** — Phase 1 fail 或架构收敛时允许任意经审批的迁移；仍禁静默热尾截断与伪 complete。
8. **管理 Agent channel-tree 文本 mirror** — 必须保留 grep/cat 可用的 text/file mirror；物化预算与双端文本 hard 同属 **数十 MiB**（alert 32 / hard 64），禁止无界第二份正文林。

## 后果

- 实现按 PR 图分期；默认生产路径不得开启不可逆 purge / hard enforce。
- 长驻 `projection/*` export 默认关闭（`RELAY_V2_LONG_LIVED_PROJECTION_EXPORT_ENABLED` 非 `"true"` 即 off）；`objects/` 与 `archive/` 不受影响。
- 指标必须可对账 R2 前缀（objects / archive / projection-*）字节与个数。
- 变更本 ADR 边界须同步 `docs/guardrails/project-guardrails.md` 与 `review-sources.md`。
