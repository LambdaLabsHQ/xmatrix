-- The xMatrix management agent is retired: nothing reads or writes its Space
-- configuration, snapshots, work items or action audit. Apply once every
-- serving Hub runs the release that retired it.

SET LOCAL lock_timeout = '5s';

DROP TABLE data.management_work_item_transitions;
DROP TABLE data.management_work_items;
DROP TABLE data.management_actions;
DROP TABLE data.space_management_snapshots;
DROP TABLE data.space_management_configs;
