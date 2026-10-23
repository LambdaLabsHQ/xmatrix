export function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sameValue(left[index], right[index])) return false;
    }
    return true;
  }
  if (left instanceof Map) {
    if (!(right instanceof Map) || left.size !== right.size) return false;
    for (const [key, value] of left) {
      if (!right.has(key) || !sameValue(value, right.get(key))) return false;
    }
    return true;
  }
  if (left instanceof Set) {
    if (!(right instanceof Set) || left.size !== right.size) return false;
    for (const member of left) if (!right.has(member)) return false;
    return true;
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  // `for…in` rather than Object.keys: timelines compare every row on every
  // rebuild, and it walks a plain object's own keys without a copy of them.
  let defined = 0;
  for (const key in left) {
    if (left[key] === undefined) continue;
    defined += 1;
    if (!sameValue(left[key], right[key])) return false;
  }
  for (const key in right) {
    if (right[key] !== undefined) defined -= 1;
  }
  return defined === 0;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
