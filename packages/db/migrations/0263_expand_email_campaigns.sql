-- Operator email campaigns (for now, the feedback-for-Pro invitation).
-- An unsubscribe is per person and permanent for every campaign; a send is
-- recorded once per person per campaign, so a campaign never mails anyone twice.
CREATE TABLE control.email_unsubscribes (
  user_id TEXT PRIMARY KEY CHECK (length(user_id) BETWEEN 1 AND 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE control.email_campaign_sends (
  campaign TEXT NOT NULL CHECK (length(campaign) BETWEEN 1 AND 80),
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 300),
  status TEXT NOT NULL CHECK (status IN ('sending','sent','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (campaign, user_id)
);
