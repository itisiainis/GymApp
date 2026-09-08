/**
 * Палитра экрана тренировки.
 *
 * Лежит отдельно, потому что разбор (WorkoutRecap) — это тот же экран
 * тренировки, только без записи: он обязан совпадать с ним по цветам,
 * иначе «то же самое, но после» читается как другой экран.
 */

/** Заливка экрана, когда идёт подход или стоит пауза. */
export const RED = '#e8c4c4';
export const RED_DARK = '#b23c3c';

/** Шапка упражнения: серая, пока есть незакрытые подходы, и зелёная, когда все готовы. */
export const HEADER_GREY = '#4a5054';
export const HEADER_GREY_TEXT = '#ffffff';
/** Светлая заливка, а не насыщенная: насыщенный зелёный читается как кнопка. */
export const HEADER_DONE = '#cfe9d8';
export const HEADER_DONE_TEXT = '#1f6b38';
/** Готовая плашка на паузе: тот же зелёный, но с красным подмесом — иначе
 *  плашка выглядит так же, как во время обычной записи, и паузу не видно. */
export const HEADER_DONE_PAUSED = '#dcb3b0';

/** Карточка упражнения и записанный подход внутри неё. */
export const CARD_BG = '#00000008';
export const SET_DONE_BG = '#e3f4e9';

/**
 * Значения подхода. Серое — то, что подставилось из прошлого раза и ещё
 * не подтверждено; чёрное — то, что записано в этой тренировке. Одно
 * правило на всё: вес, повторы, время, RIR.
 */
export const VALUE_PENDING = '#9aa0a6';
export const VALUE_DONE = '#1c1f21';

/**
 * Разбор: тот же силуэт карточек, но холодный синий вместо рабочего серого
 * и зелёного. Читается как «просмотр записанного», а не «идёт запись» —
 * при том, что раскладка совпадает один в один.
 */
export const RECAP_HEADER = '#3f5b73';
export const RECAP_HEADER_TEXT = '#ffffff';
export const RECAP_SET_BG = '#f2f6f9';
export const RECAP_FIELD_BG = '#ffffff';

/**
 * Барабан RIR подчиняется тому же правилу: пока подход не записан,
 * выбранное значение серое — это «>5» по умолчанию, а не ответ. Как
 * только значение выбрали, плашка темнеет.
 */
export const RIR_ACTIVE = '#2f3437';
export const RIR_ACTIVE_TEXT = '#ffffff';
export const RIR_PENDING = '#d3d8db';
export const RIR_PENDING_TEXT = '#7b8287';
export const RIR_IDLE_BG = '#00000008';
export const RIR_IDLE_TEXT = '#6b7278';

/** Личный рекорд. */
export const PR_BG = '#fbf1d3';
export const PR_TEXT = '#a3790f';
