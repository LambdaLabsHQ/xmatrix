-- Repository mounts are removed from Pages (#3497): no Hub release since the
-- one that shipped it reads or writes data.page_repository_mounts. Apply once
-- every serving Hub runs that release or later.

SET LOCAL lock_timeout = '5s';

DROP TABLE data.page_repository_mounts;
