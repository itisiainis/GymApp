import { useEffect, useState } from 'react';

/** Секунды → 12:46 */
export function fmt(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${m}:${String(rest).padStart(2, '0')}`;
}

/**
 * Как fmt, но отрицательное время остаётся отрицательным: -0:05.
 *
 * Нужно для отсчёта prepSeconds перед стартом подхода — иначе таймер
 * молча стоит на 0:00, и непонятно, что это отсчёт, а не зависание.
 */
export function fmtSigned(totalSeconds: number): string {
  if (totalSeconds < 0) return `-${fmt(-totalSeconds)}`;
  return fmt(totalSeconds);
}

/**
 * Возвращает текущее время, обновляясь раз в секунду.
 *
 * Важно, что это именно значение, а не счётчик: React Compiler мемоизирует
 * компоненты по их входам, и Date.now() внутри рендера для него невидим —
 * зависимость от времени должна быть явной, иначе строка «замерзает».
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [active]);

  return now;
}

/**
 * Сколько секунд идёт подход. now передаётся снаружи, чтобы значение
 * пересчитывалось при каждом тике, а не бралось из скрытого Date.now().
 */
export function liveSeconds(
  activeSeconds: number,
  runningSince: string | null,
  now: number
): number {
  if (!runningSince) return activeSeconds;
  return activeSeconds + (now - Date.parse(runningSince)) / 1000;
}

/* ------------------------------------------------------------------ */
/* Отдых между подходами                                               */
/* ------------------------------------------------------------------ */

/** Минимум, который подход должен дать таймингу, чтобы считаться за точку
 *  отсчёта отдыха. Строка без времени — это заготовка, её ещё не делали. */
export interface Timed {
  id: number;
  started_at: string | null;
  ended_at: string | null;
}

/**
 * Сколько отдыхали ПЕРЕД каждым подходом: от конца предыдущего записанного
 * подхода до начала этого.
 *
 * Считается по всей тренировке сразу, а не внутри упражнения: отдыхаешь-то
 * от всего разом, и пауза между последним подходом жима и первым подходом
 * тяги — такой же отдых, как между двумя подходами жима.
 *
 * Ключ — id подхода, поэтому перестановка карточек на экране ничего не
 * ломает: связь идёт по подходу, а не по позиции в списке.
 */
export function restBySet(rows: Timed[]): Record<number, number> {
  const done = rows
    .filter((r) => r.started_at !== null)
    .sort((a, b) => Date.parse(a.started_at!) - Date.parse(b.started_at!));

  const out: Record<number, number> = {};
  for (let i = 1; i < done.length; i++) {
    const prevEnd = done[i - 1].ended_at;
    if (!prevEnd) continue; // предыдущий подход ещё идёт — отдых не начался
    const gap = (Date.parse(done[i].started_at!) - Date.parse(prevEnd)) / 1000;
    // Срезка prepSeconds/reachSeconds сдвигает границы подхода внутрь, из-за
    // чего очень короткая пауза может выйти отрицательной. Ноль честнее.
    out[done[i].id] = Math.max(0, gap);
  }
  return out;
}

/** Когда закончился последний записанный подход — начало текущего отдыха. */
export function lastEndedAt(rows: Timed[]): string | null {
  let best: string | null = null;
  for (const r of rows) {
    if (!r.ended_at) continue;
    if (best === null || Date.parse(r.ended_at) > Date.parse(best)) best = r.ended_at;
  }
  return best;
}
