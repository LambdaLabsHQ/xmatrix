/** Remove account profile fields without changing the retained Human/Agent identity. */
export function erasedAccountMessageSender(snapshot: Record<string,unknown>|null,kind:string,authorId:string,userId:string):Record<string,unknown> {
  if(kind==='user') {
    if(authorId!==userId) throw new Error("Message profile owner does not match deleted identity");
    return {identityId:`user:${userId}`,kind:"user",userId,label:"Deleted account",email:""};
  }
  if(kind!=='agent'||(snapshot && snapshot.userId!==userId)) throw new Error("Message profile owner does not match deleted identity");
  if(!snapshot) return {identityId:authorId,kind:"agent",userId,label:"Unknown agent",email:""};
  const fields=new Set(["identityId","kind","agentId","label","name","agentName","runtime","userId","registration",
    "instanceId","channelInstanceId","instanceLabel","originChannelId","originMessageId","avatarUrl","profileVersion",
    "goal","gitBranch","model","effort","statusChips"]);
  return Object.fromEntries(Object.entries(snapshot).filter(([key])=>fields.has(key)));
}

