import type { AuthorityDatabase } from "./contracts.js";
import { accountRevokedSql } from "./account-deletion.js";

/**
 * Who an operator email campaign may still reach. A person who unsubscribed
 * or deleted their account is never mailed, and a campaign mails each person
 * at most once: a send is claimed before it is made, and a claim is kept even
 * when the send fails, so a retry never doubles a message.
 */
export class PostgresEmailCampaignRepository {
  constructor(private readonly database: AuthorityDatabase) {}

  async unsubscribe(requestId: string, userId: string): Promise<void> {
    await this.database.transaction({ requestId, operation: "email.unsubscribe" }, (tx) => tx.query({
      name: "email_unsubscribe_v1",
      text: "INSERT INTO control.email_unsubscribes (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
      values: [userId], maxRows: 0,
    }));
  }

  async unsubscribed(requestId: string, userId: string): Promise<boolean> {
    return this.database.transaction({ requestId, operation: "email.unsubscribed" }, async (tx) =>
      (await tx.query({ name: "email_unsubscribed_v1",
        text: "SELECT 1 FROM control.email_unsubscribes WHERE user_id=$1 LIMIT 1", values: [userId], maxRows: 1 })).length > 0);
  }

  /** Of these people, the ones this campaign may mail now; with `claim`, they are claimed. */
  async eligible(requestId: string, campaign: string, userIds: readonly string[], claim: boolean): Promise<{
    eligible: string[]; skipped: { unsubscribed: number; deleted: number; alreadySent: number };
  }> {
    const ids = [...new Set(userIds)];
    return this.database.transaction({ requestId, operation: "email.campaign.eligible" }, async (tx) => {
      const rows = await tx.query<{ user_id: string; unsubscribed: boolean; deleted: boolean; sent: boolean }>({
        name: "email_campaign_eligible_v1",
        text: `SELECT id.user_id,
            EXISTS (SELECT 1 FROM control.email_unsubscribes u WHERE u.user_id=id.user_id) AS unsubscribed,
            ${accountRevokedSql("id.user_id")} AS deleted,
            EXISTS (SELECT 1 FROM control.email_campaign_sends s WHERE s.campaign=$1 AND s.user_id=id.user_id) AS sent
          FROM unnest($2::text[]) AS id(user_id)`,
        values: [campaign, ids], maxRows: ids.length,
      });
      const eligible = rows.filter(r => !r.unsubscribed && !r.deleted && !r.sent).map(r => r.user_id);
      if (claim && eligible.length) {
        const claimed = await tx.query<{ user_id: string }>({
          name: "email_campaign_claim_v1",
          text: `INSERT INTO control.email_campaign_sends (campaign,user_id,status)
            SELECT $1, unnest($2::text[]), 'sending' ON CONFLICT DO NOTHING RETURNING user_id`,
          values: [campaign, eligible], maxRows: eligible.length,
        });
        eligible.splice(0, eligible.length, ...claimed.map(r => r.user_id));
      }
      return { eligible, skipped: {
        unsubscribed: rows.filter(r => r.unsubscribed).length,
        deleted: rows.filter(r => !r.unsubscribed && r.deleted).length,
        alreadySent: rows.filter(r => !r.unsubscribed && !r.deleted && r.sent).length,
      } };
    });
  }

  async record(requestId: string, campaign: string, userId: string, status: "sent" | "failed"): Promise<void> {
    await this.database.transaction({ requestId, operation: "email.campaign.record" }, (tx) => tx.query({
      name: "email_campaign_record_v1",
      text: "UPDATE control.email_campaign_sends SET status=$3, updated_at=clock_timestamp() WHERE campaign=$1 AND user_id=$2",
      values: [campaign, userId, status], maxRows: 0,
    }));
  }
}
