/**
 * RIR — сколько повторов осталось в запасе к концу подхода.
 *
 * Заменил секундомер как способ засчитать подход на повторы: время подхода
 * на повторы почти ничего не говорит о нагрузке, а «сколько ещё мог» —
 * говорит. Секундомер никуда не делся, но стал необязательным режимом
 * (`advancedReps` в db/settings.ts); холды меряются временем всегда.
 *
 * В базе это две колонки, а не одна: `rir` — честное число, которое можно
 * усреднять, `rir_missed` — отдельный факт «не дотянул», когда назвать
 * число нечестно. Здесь они сводятся в одно значение для интерфейса.
 */

/** Число 0–5 либо «не дотянул». */
export type RirValue = number | 'missed';

/** Значение «не дотянул» — отдельное от шкалы, не её край. */
export const RIR_MISSED = 'missed';

/**
 * Порядок в барабане. «Не дотянул» стоит перед нулём: это край шкалы со
 * стороны «совсем не осталось», продолжение того же направления.
 */
export const RIR_OPTIONS: RirValue[] = [RIR_MISSED, 0, 1, 2, 3, 4, 5];

/** Строка подхода в той части, что касается RIR. */
export interface RirRow {
  rir: number | null;
  rir_missed: number;
}

/** Значение подхода для интерфейса. null — RIR не проставлен. */
export function rirOf(row: RirRow): RirValue | null {
  if (row.rir_missed === 1) return RIR_MISSED;
  return row.rir;
}

/** Проставлен ли RIR — то же, что «подход записан» в режиме без секундомера. */
export function hasRir(row: RirRow): boolean {
  return rirOf(row) !== null;
}

/** Подпись значения в барабане. */
export function rirLabel(v: RirValue, t: (key: string) => string): string {
  return v === RIR_MISSED ? t("Didn't reach") : String(v);
}

/**
 * Подпись для истории: там подход показан одной строкой, места хватает,
 * и RIR нужен с пояснением, что это за число. null — показывать нечего.
 */
export function rirBadge(row: RirRow, t: (key: string) => string): string | null {
  const v = rirOf(row);
  if (v === null) return null;
  return v === RIR_MISSED ? t("Didn't reach") : `${t('RIR')} ${v}`;
}

/**
 * То же для узкого столбца в разборе — там, где у подхода с секундомером
 * стоит время. «Не дотянул» целиком туда не влезает, а сокращать его до
 * числа нельзя: это не значение шкалы.
 */
export function rirCompact(row: RirRow, t: (key: string) => string): string | null {
  const v = rirOf(row);
  if (v === null) return null;
  return v === RIR_MISSED ? `${t('RIR')} ✕` : `${t('RIR')} ${v}`;
}
