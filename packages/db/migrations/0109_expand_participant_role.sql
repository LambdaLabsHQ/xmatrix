-- Open-project governance (docs/design/open-project-governance.md §2): a
-- participant takes part in a Space without a member's reach. Widen the role
-- vocabulary atomically; every existing value stays valid.
ALTER TABLE data.space_members
  DROP CONSTRAINT space_members_role_check,
  ADD CONSTRAINT space_members_role_check
    CHECK (role IN ('owner', 'admin', 'member', 'viewer', 'participant')) NOT VALID;

ALTER TABLE control.user_space_memberships
  DROP CONSTRAINT user_space_memberships_role_check,
  ADD CONSTRAINT user_space_memberships_role_check
    CHECK (role IN ('owner', 'admin', 'member', 'viewer', 'participant')) NOT VALID;

ALTER TABLE control.user_space_membership_routes
  DROP CONSTRAINT user_space_membership_routes_role_check,
  ADD CONSTRAINT user_space_membership_routes_role_check
    CHECK (role IN ('owner', 'admin', 'member', 'viewer', 'participant')) NOT VALID;
