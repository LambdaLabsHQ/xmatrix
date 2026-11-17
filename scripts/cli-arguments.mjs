/** The value after a `--flag`, or the fallback when the flag is absent. */
export function argumentValue(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index >= 0 && index < argv.length - 1 ? argv[index + 1] : fallback;
}

/** Every value after each occurrence of a repeated `--flag`. */
export function argumentValues(argv, flag) {
  const values = [];
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === flag) values.push(argv[index + 1]);
  }
  return values;
}
