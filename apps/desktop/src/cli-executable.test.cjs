const assert = require("node:assert/strict");
const test = require("node:test");

let augmentPath;
let resolveCliExecutable;
let resolveWindowsExecutableFromPath;

test.before(async () => {
  const loaded = await import("./cli-executable.ts");
  augmentPath = loaded.augmentPath;
  resolveCliExecutable = loaded.resolveCliExecutable;
  resolveWindowsExecutableFromPath = loaded.resolveWindowsExecutableFromPath;
});

function windowsExists(paths) {
  const normalized = new Set(paths.map((candidate) => candidate.toLowerCase()));
  return (candidate) => normalized.has(candidate.toLowerCase());
}

test("Windows CLI resolver rejects the desktop executable from PATH", () => {
  const desktopExe = "C:\\Program Files\\xMatrix\\xMatrix.exe";
  const resolved = resolveCliExecutable({
    platform: "win32",
    homeDir: "C:\\Users\\Yuexi",
    envPath: "C:\\Program Files\\xMatrix",
    desktopExecPath: desktopExe,
    exists: windowsExists([desktopExe]),
  });

  assert.equal(resolved, null);
});

test("Windows CLI resolver finds the user CLI before PATH fallbacks", () => {
  const userCli = "C:\\Users\\Yuexi\\.local\\bin\\xmatrix.exe";
  const desktopExe = "C:\\Program Files\\xMatrix\\xMatrix.exe";
  const resolved = resolveCliExecutable({
    platform: "win32",
    homeDir: "C:\\Users\\Yuexi",
    envPath: "C:\\Program Files\\xMatrix",
    desktopExecPath: desktopExe,
    exists: windowsExists([desktopExe, userCli]),
  });

  assert.equal(resolved, userCli);
});

test("Windows PATH search skips desktop executable and returns later real CLI", () => {
  const desktopExe = "C:\\Program Files\\xMatrix\\xMatrix.exe";
  const userCli = "C:\\Tools\\xmatrix.exe";
  const resolved = resolveWindowsExecutableFromPath("xmatrix", {
    platform: "win32",
    homeDir: "C:\\Users\\Yuexi",
    envPath: "C:\\Program Files\\xMatrix;C:\\Tools",
    desktopExecPath: desktopExe,
    exists: windowsExists([desktopExe, userCli]),
  });

  assert.equal(resolved, userCli);
});

test("Windows PATH augmentation uses semicolons and deduplicates case-insensitively", () => {
  const value = augmentPath("C:\\Users\\Yuexi\\.local\\bin;c:\\users\\yuexi\\.LOCAL\\bin", {
    platform: "win32",
    homeDir: "C:\\Users\\Yuexi",
  });

  assert.equal(value.includes(";"), true);
  assert.equal(
    value.toLowerCase().split(";").filter((part) => part === "c:\\users\\yuexi\\.local\\bin").length,
    1
  );
});
