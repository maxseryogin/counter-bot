export function parseAccess(env) {
  const parseId = value => {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
      throw new Error('OWNER_ID и ALLOWED_USER_IDS должны содержать положительные числовые Telegram ID');
    }
    return Number(value);
  };
  const ownerId = parseId(env.OWNER_ID?.trim() || '1252270301');
  const extra = (env.ALLOWED_USER_IDS || '').trim().split(/[,\s]+/).filter(Boolean).map(parseId);
  return { ownerId, allowedUserIds: new Set([ownerId, ...extra]) };
}
