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
