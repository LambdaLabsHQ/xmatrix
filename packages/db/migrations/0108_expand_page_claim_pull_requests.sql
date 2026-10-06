-- The pull request doing a claim's work (docs/design/pages-and-conversations.md
-- §5.6): recorded when the GitHub claim check passes, completed on merge.
ALTER TABLE data.page_claims ADD COLUMN pull_request_url TEXT
  CHECK (pull_request_url IS NULL OR char_length(pull_request_url) <= 500);

CREATE INDEX page_claims_pull_request_idx ON data.page_claims (space_id, pull_request_url)
  WHERE pull_request_url IS NOT NULL;
