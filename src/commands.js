import { initialState, accrue, complete, undo, status, lessons, nextDay } from './model.js';

export const HELP = `📚 Счётчик уроков
+1 или /done — отметить тему (можно 4/3, 5/3 и больше)
/undo — отменить одну сегодняшнюю отметку
/status — прогресс и дата, когда догонишь
/forecast — сравнить темп 2, 3, 4, 5 тем в день
/history — последние 7 дней
/schedule — расписание новых тем
/goal 3 — дневная цель
/setleft 16 — установить текущий остаток
/add 2 — вручную добавить пропущенные темы
/remind 12:00 18:00 21:00 — время напоминаний
/lesson_time 18:00 — время появления новых тем
/pause и /resume — выключить/включить напоминания
Все часы — по Киеву. Начальные 16 тем не включают новые уроки дня первого /start.
Уже появившиеся сегодня уроки добавляются сразу. /setleft задаёт остаток на текущую минуту.`;

export const KEYBOARD = { keyboard: [
  [{ text: '✅ +1' }, { text: '↩️ Отменить' }],
  [{ text: '📊 Прогресс' }, { text: '🎯 Прогноз' }],
  [{ text: '🗓 Расписание' }, { text: '❓ Помощь' }],
], resize_keyboard: true };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const positive = (text, max) => /^\d+$/.test(text ?? '') && Number(text) >= 1 && Number(text) <= max;
export function command(state, text, clock) {
  const aliases = {
    '✅ +1': '/done', '+1': '/done', '↩️ Отменить': '/undo',
    '📊 Прогресс': '/status', '🎯 Прогноз': '/forecast',
    '🗓 Расписание': '/schedule', '❓ Помощь': '/help',
  };
  const [raw, ...args] = (aliases[text] ?? text).trim().split(/\s+/);
  const cmd = raw.toLowerCase().split('@')[0];
  if (!state && cmd !== '/start') return { state: null, text: 'Нажми /start, чтобы начать с 16 тем.' };
  const first = !state;
  state ??= initialState(clock);
  accrue(state, clock);
  let response;
  switch (cmd) {
    case '/start':
      response = (first ? 'Готово! Считаем с 16 тем, цель — 3 в день.\n' : 'Ты уже ведёшь учёт — данные сохранены.\n') + status(state, clock) + '\n\n' + HELP;
      break;
    case '/help': response = HELP; break;
    case '/status': response = status(state, clock); break;
    case '/done': response = complete(state, clock) + '\n\n' + status(state, clock); break;
    case '/undo': response = undo(state, clock) + '\n\n' + status(state, clock); break;
    case '/goal':
      if (args.length !== 1 || !positive(args[0], 100)) response = 'Пример: /goal 3 (от 1 до 100).';
      else { state.goal = Number(args[0]); response = status(state, clock); }
      break;
    case '/setleft':
      if (args.length !== 1 || !/^\d+$/.test(args[0]) || Number(args[0]) > 100000) response = 'Пример: /setleft 16 (от 0 до 100000).';
      else { state.backlog = Number(args[0]); response = 'Текущий остаток установлен. Будущие уроки ещё добавятся.\n' + status(state, clock); }
      break;
    case '/add':
      if (args.length !== 1 || !positive(args[0], 10000)) response = 'Пример: /add 2 (от 1 до 10000).';
      else {
        state.backlog += Number(args[0]);
        response = status(state, clock);
      }
      break;
    case '/lesson_time':
      if (args.length !== 1 || !TIME.test(args[0])) response = 'Пример: /lesson_time 18:00';
      else {
        state.lessonTime = args[0];
        accrue(state, clock);
        response = 'Время новых тем изменено. Уже учтённые темы повторно не добавляются.\n' + status(state, clock);
      }
      break;
    case '/remind':
      if (!args.length || args.length > 8 || args.some(t => !TIME.test(t))) response = 'Пример: /remind 12:00 18:00 21:00 (до 8 времён).';
      else { state.reminders = [...new Set(args)].sort(); state.paused = false; response = status(state, clock); }
      break;
    case '/pause': state.paused = true; response = '🔕 Напоминания выключены. Включить: /resume'; break;
    case '/resume': state.paused = false; response = status(state, clock); break;
    case '/schedule':
      response = 'Новые темы каждую неделю:\nПн — история (1)\nВт — математика (1)\nСр — украинский + английский (2)\nЧт — история (1)\nПт — математика (1)\nСб — нет (0)\nВс — украинский + английский (2)\nВсего: 8 тем/неделю.\nПоявляются в ' + state.lessonTime + ' по Киеву. Изменить: /lesson_time 19:00';
      break;
    case '/history': {
      const days = [];
      let date = new Date(clock.day + 'T12:00:00Z');
      date.setUTCDate(date.getUTCDate() - 6);
      let day = date.toISOString().slice(0, 10);
      for (let i = 0; i < 7; i++, day = nextDay(day)) {
        const entry = state.history[day];
        days.push(day + ': сделано ' + (entry?.done ?? 0) + ', новых по расписанию ' + (entry?.added ?? 0));
      }
      response = '📆 Последние 7 дней\n' + days.join('\n');
      break;
    }
    case '/forecast': response = forecastText(state, clock); break;
    default: response = 'Не понял команду. Нажми «✅ +1» после темы или /help.';
  }
  return { state, text: response };
}
import { forecast } from './model.js';
function forecastText(state, clock) {
  return '🎯 Если начать с текущего остатка и учитывать будущие уроки:\n' +
    [2, 3, 4, 5].map(goal => {
      const plan = forecast(state, clock, goal);
      return goal + '/день → ' + (plan ? plan.day + ' (' + plan.days + ' дн., включая сегодня)' : 'не догонишь за 10 лет');
    }).join('\n') + '\nСегодняшние выполненные темы уже учтены. Это прогноз, цель не меняется.';
}
