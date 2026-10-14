export const GMAIL_WATCH_KEYS = ["GMAIL_WATCH_CLIENT_ID","GMAIL_WATCH_CLIENT_SECRET","GMAIL_WATCH_TOPIC",
  "GMAIL_WATCH_PUSH_EMAIL","GMAIL_WATCH_PUSH_AUDIENCE","GMAIL_WATCH_SUBSCRIPTION"] as const;

/** One atomic native app configuration shared by release validation and the Hub. */
export function parseGmailWatchConfig(env: Record<string,unknown>) {
  if(!GMAIL_WATCH_KEYS.some(key=>env[key]))return undefined;
  const values=GMAIL_WATCH_KEYS.map(key=>env[key]);
  if(values.some(value=>typeof value!=="string" || !value || value!==value.trim() || value.length>1024 || /\s/u.test(value))) {
    throw new Error("Incomplete or invalid Gmail notification configuration");
  }
  const [clientId,clientSecret,topic,pushEmail,audience,subscription]=values as string[];
  const project=/^projects\/([a-z][a-z0-9-]{4,61}[a-z0-9])\/topics\/[A-Za-z][A-Za-z0-9._~-]{2,254}$/u.exec(topic!);
  let url:URL;try{url=new URL(audience!);}catch{throw new Error("Invalid Gmail notification audience");}
  if(!project || !/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/u.test(clientId!) ||
    !/^[A-Za-z0-9_-]{10,1024}$/u.test(clientSecret!) ||
    !new RegExp(`^[A-Za-z0-9._-]+@${project[1]}\\.iam\\.gserviceaccount\\.com$`,"u").test(pushEmail!) ||
    !subscription!.startsWith(`projects/${project[1]}/subscriptions/`) ||
    !/^[A-Za-z][A-Za-z0-9._~-]{2,254}$/u.test(subscription!.split("/subscriptions/")[1] ?? "") ||
    url.protocol!=="https:" || url.username || url.password || url.port || url.search || url.hash ||
    url.pathname!=="/api/connectors/gmail-watch/events" || !url.hostname.includes(".") ||
    /^\d|\[/u.test(url.hostname) || /(?:localhost|\.internal)$/u.test(url.hostname)) {
    throw new Error("Invalid Gmail notification application identity");
  }
  return {clientId:clientId!,clientSecret:clientSecret!,topic:topic!,pushEmail:pushEmail!,audience:audience!,subscription:subscription!};
}
