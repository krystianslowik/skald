/**
 * Hashes a panel password for PANEL_PASSWORD_HASH. Only the line terminator a
 * shell pipe adds is stripped; every other character is part of the password.
 */
export async function hashPassword(input: string): Promise<string> {
  const password = input.replace(/\r?\n$/, "");
  if (!password) throw new Error("hash-password: empty password on stdin");
  return Bun.password.hash(password, { algorithm: "argon2id" });
}
