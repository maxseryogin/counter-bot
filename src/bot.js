import { parseAccess } from './config.js';
import { Store } from './store.js';
import { localTime } from './model.js';
import { handleUpdate, tick, drain, migrateOwner } from './service.js';
import { setTimeout as sleep } from 'node:timers/promises';

const token = process.env.BOT_TOKEN;
const access = parseAccess(process.env);
const zone = process.env.TZ || 'Europe/Kyiv';
if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Добавь корректный BOT_TOKEN в Variables Railway или .env');
localTime(new Date(), zone);
const store = new Store(process.env.DB_PATH || './data/counter.sqlite');
migrateOwner(store, access.ownerId);
const stop = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => stop.abort());

async function api(method, body = {}) {
  let response;
  try {
    response = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(35000)]),
    });
  } catch {
    // Do not log fetch errors: their request URLs contain the secret token.
    throw new Error('Telegram connection failed');
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('Invalid Telegram response'); }
  if (!data.ok) {
    const error = new Error('Telegram API rejected request');
    error.code = data.error_code;
    error.retryAfter = data.parameters?.retry_after;
    throw error;
  }
  return data.result;
}

try {
  // Polling cannot coexist with a webhook; keep all pending updates.
  await api('deleteWebhook', { drop_pending_updates: false });
  await api('setMyCommands', { commands: [
    { command: 'start', description: 'Начать учёт' },
    { command: 'done', description: 'Готова ещё одна тема +1' },
    { command: 'status', description: 'Остаток и прогресс' },
    { command: 'forecast', description: 'Когда догоню программу' },
    { command: 'undo', description: 'Отменить отметку' },
    { command: 'help', description: 'Настройки и команды' },
  ] });
  console.log('Counter bot running; private allowlist access only.');
  while (!stop.signal.aborted) {
    try {
      tick(store, access, localTime(new Date(), zone));
      await drain(store, api, access.allowedUserIds);
      const updates = await api('getUpdates', {
        offset: store.get('offset', 0), timeout: 20, allowed_updates: ['message'],
      });
      for (const update of updates) {
        if (stop.signal.aborted) break;
        handleUpdate(store, update, access, localTime(new Date(), zone));
      }
      await drain(store, api, access.allowedUserIds);
    } catch (error) {
      if (stop.signal.aborted) break;
      if ([401, 409].includes(error.code)) {
        console.error(error.code === 401 ? 'Invalid BOT_TOKEN.' : 'Another bot instance is polling. Run exactly one instance.');
        process.exitCode = 1;
        break;
      }
      console.error(error.message, error.code ?? '');
      const delay = Math.max(3, Math.min(error.retryAfter || 3, 3600)) * 1000;
      await sleep(delay, undefined, { signal: stop.signal }).catch(() => {});
    }
  }
} catch (error) {
  if (!stop.signal.aborted) {
    console.error(error.message, error.code ?? '');
    process.exitCode = 1;
  }
} finally {
  store.close();
}
