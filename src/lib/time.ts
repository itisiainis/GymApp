import { useEffect, useState } from 'react';

/** Секунды → 12:46. Для сводок: там доли секунды только мешают. */
export function fmt(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${m}:${String(rest).padStart(2, '0')}`;
}

/**
 * Секунды → 12:46.31. Для всего, что меряется и потом вычитается:
 * длительность подхода и общее время.
 *
 * Целые секунды врали при вычитании, и это сбивало с толку: между 0:07 и
 * 0:12 на экране ровно пять секунд, а на деле от 4.01 до 5.99 — обе
 * границы округлены в свою сторону. Двух знаков для этого достаточно:
 * зал не лаборатория, а третий знак только мельтешит.
 */
export function fmtMs(totalSeconds: number): string {
  // Округляем всё значение сразу, а не отрезаем дробную часть: 766.4 в
  // двоичном виде чуть меньше себя, и (766.4 - 766) * 100 даёт 39.9999…,
  // то есть «12:46.39» вместо «12:46.40». Заодно переполнение сотых само
  // переходит в секунды: 5.999 → 0:06.00.
  const hundredths = Math.round(Math.max(0, totalSeconds) * 100);
  return `${fmt(Math.floor(hundredths / 100))}.${String(hundredths % 100).padStart(2, '0')}`;
}

/**
 * Как fmtMs, но отрицательное время остаётся отрицательным: -0:04.31.
 *
 * Нужно отсчётам перед стартом — подхода и всей тренировки. Иначе таймер
 * молча стоит на 0:00, и непонятно, что это отсчёт, а не зависание.
 */
export function fmtSignedMs(totalSeconds: number): string {
  if (totalSeconds < 0) return `-${fmtMs(-totalSeconds)}`;
  return fmtMs(totalSeconds);
}

/**
 * Возвращает текущее время, обновляясь раз в секунду.
 *
 * Важно, что это именно значение, а не счётчик: React Compiler мемоизирует
 * компоненты по их входам, и Date.now() внутри рендера для него невидим —
 * зависимость от времени должна быть явной, иначе строка «замерзает».
 */
export function useNow(active: boolean, intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);

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
