// Factory imports may resolve these platform classes, but injected test ports
// must never construct them. A file URL also supports tsx namespace queries.
export class DurableObject {
  constructor() { throw new Error("unexpected platform construction"); }
}
export class EmailMessage {
  constructor() { throw new Error("unexpected email construction"); }
}
