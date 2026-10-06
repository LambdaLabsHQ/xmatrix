CREATE INDEX space_members_billable_seat_idx
  ON data.space_members (space_id)
  WHERE role IN ('owner', 'admin', 'member');
