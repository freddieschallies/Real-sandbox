// The password rules, the same as the server's (it checks again).
export function passwordProblem(pw: string, email: string): string | null {
  if (pw.length < 8) return 'At least 8 characters.';
  if (pw.length > 200) return 'That password is too long.';
  const lower = pw.toLowerCase();
  const name = email.toLowerCase().split('@')[0];
  if (lower === email.toLowerCase() || (name.length >= 4 && lower.includes(name))) return 'Do not use your email in the password.';
  if (new Set(lower).size < 4) return 'Use a mix of letters and numbers, not the same few keys.';
  if (['password', '12345678', '123456789', 'qwertyui', 'qwerty123', 'password1'].includes(lower)) return 'That password is too easy to guess.';
  return null;
}
