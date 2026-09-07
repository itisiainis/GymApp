import { RIR_MISSED, type RirValue } from '../lib/rir';
import { getDb, now } from './index';
import type { MuscleRole } from './library';
import { getRecordingSettings } from './settings';

function shifted(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/* ------------------------------------------------------------------ */
/* Типы                                                                */
/* ------------------------------------------------------------------ */

export type MeasurementType = 'reps' | 'hold';

export interface Exercise {
  id: number;
  name: string;
  description: string | null;
  measurement_default: MeasurementType;
  is_custom: number;
}

export interface SetRow {
  id: number;
  workout_id: number;
  exercise_id: number;
  reps: number | null;
  weight_kg: number | null;
  /** Повторов в запасе, 0–5. NULL при rir_missed = 0 — не проставлен. */
  rir: number | null;
  /** 1 — «не дотянул»: честного числа у подхода нет. */
  rir_missed: number;
  started_at: string | null;
  ended_at: string | null;
  active_seconds: number;
  is_running: number;
}

export interface ActiveWorkout {
  id: number;
  /** NULL — тренировку собрали с нуля, без шаблона. */
  routine_id: number | null;
  /** Имя тренировки: своё или, если она по шаблону, имя шаблона. */
  title: string | null;
  /** Когда тренировку завели — то есть открыли черновик. */
  started_at: string;
  /**
   * Когда пошло время. NULL — тренировку ещё собирают.
   *
   * Может быть в БУДУЩЕМ: «Let's start» ставит его на пять секунд вперёд,
   * и эти пять секунд — обычный отсчёт по стенным часам. Поэтому всё
   * время на экране считается из него, а не из таймера в приложении:
   * свёрнутое приложение ничего не останавливает.
   */
  began_at: string | null;
  /** Секунды уже закрытых пауз. */
  paused_seconds: number;
  /** Начало открытой паузы. NULL — тренировка не на паузе. */
  paused_since: string | null;
  is_paused: number;
}

/* ------------------------------------------------------------------ */
/* Тренировка                                                          */
/* ------------------------------------------------------------------ */

export async function getActiveWorkout(): Promise<ActiveWorkout | null> {
  const db = await getDb();
  // LEFT JOIN, а не JOIN: у тренировки с нуля шаблона нет, и обычное
  // соединение просто не вернуло бы её.
  //
  // Пауза отдаётся не одним флагом, а разложенной на слагаемые
  // (накоплено + идёт с такого-то момента): по ним экран тикает сам, без
  // запроса к базе на каждый кадр. С миллисекундами это уже принципиально
  // — иначе на каждый показанный знак приходился бы поход в базу.
  return db.getFirstAsync<ActiveWorkout>(`
    SELECT w.id, w.routine_id, w.started_at, w.began_at,
           COALESCE(w.name, r.name) AS title,
           COALESCE((
             SELECT SUM(MAX(0.0,
               (julianday(p.ended_at) - julianday(p.started_at)) * 86400.0))
             FROM workout_pauses p
             WHERE p.workout_id = w.id AND p.ended_at IS NOT NULL
           ), 0) AS paused_seconds,
           (SELECT p.started_at FROM workout_pauses p
            WHERE p.workout_id = w.id AND p.ended_at IS NULL
            LIMIT 1) AS paused_since,
           EXISTS (SELECT 1 FROM workout_pauses p
                   WHERE p.workout_id = w.id AND p.ended_at IS NULL) AS is_paused
    FROM workouts w
    LEFT JOIN routines r ON r.id = w.routine_id
    WHERE w.ended_at IS NULL
    ORDER BY w.started_at DESC
    LIMIT 1
  `);
}

/**
 * Запустить время тренировки — с задержкой на отсчёт перед стартом.
 *
 * began_at сразу ставится в БУДУЩЕЕ, а не по истечении отсчёта: тогда
 * отсчёт живёт в базе как обычное время, а не как таймер в приложении.
 * Экран показывает его отрицательным, и свернуть приложение на эти пять
 * секунд можно без последствий — именно на это и жаловались.
 *
 * Повторное нажатие ничего не сдвигает: WHERE began_at IS NULL.
 */
export async function startWorkoutClock(
  workoutId: number,
  delaySeconds: number
): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE workouts SET began_at = ? WHERE id = ? AND began_at IS NULL', [
    shifted(delaySeconds),
    workoutId,
  ]);
}

/**
 * Отменить запуск, пока идёт отсчёт: время ещё не пошло, и тренировка
 * возвращается в состояние «собираем состав».
 *
 * Условие began_at > now важно: у уже начавшейся тренировки отменять
 * нечего, и подходы в ней трогать нельзя.
 */
export async function cancelWorkoutClock(workoutId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE workouts SET began_at = NULL WHERE id = ? AND began_at > ?', [
    workoutId,
    now(),
  ]);
}

/**
 * Выбросить черновик целиком — «Go back» до старта.
 *
 * Только пока время не пошло: у начатой тренировки для этого есть Finish,
 * и молча стирать записанные подходы нельзя.
 */
export async function discardWorkout(workoutId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM workouts WHERE id = ? AND began_at IS NULL', [workoutId]);
}

/**
 * Начать тренировку. routineId = null — с нуля, без шаблона: это обычный
 * случай, шаблон стал необязательным.
 */
export async function startWorkout(
  routineId: number | null,
  name: string | null = null
): Promise<number> {
  const active = await getActiveWorkout();
  if (active) throw new Error('A workout is already in progress');

  const db = await getDb();
  const res = await db.runAsync(
    'INSERT INTO workouts (routine_id, name, started_at) VALUES (?, ?, ?)',
    [routineId, name, now()]
  );
  return res.lastInsertRowId;
}

/** Завершить: закрыть открытый интервал и паузу, проставить ended_at. */
export async function endWorkout(workoutId: number): Promise<void> {
  const db = await getDb();
  const ts = now();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE set_intervals SET ended_at = ?
       WHERE ended_at IS NULL
         AND set_id IN (SELECT id FROM sets WHERE workout_id = ?)`,
      [ts, workoutId]
    );
    await db.runAsync(
      'UPDATE workout_pauses SET ended_at = ? WHERE workout_id = ? AND ended_at IS NULL',
      [ts, workoutId]
    );
    await db.runAsync('UPDATE workouts SET ended_at = ? WHERE id = ?', [ts, workoutId]);
  });
}

export async function pauseWorkout(workoutId: number): Promise<void> {
  const db = await getDb();
  const open = await db.getFirstAsync<{ id: number }>(
    'SELECT id FROM workout_pauses WHERE workout_id = ? AND ended_at IS NULL',
    [workoutId]
  );
  if (open) return;
  await db.runAsync(
    'INSERT INTO workout_pauses (workout_id, started_at) VALUES (?, ?)',
    [workoutId, now()]
  );
}

export async function resumeWorkout(workoutId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'UPDATE workout_pauses SET ended_at = ? WHERE workout_id = ? AND ended_at IS NULL',
    [now(), workoutId]
  );
}

/**
 * Общее время тренировки за вычетом пауз, в секундах с долями.
 *
 * Считается от began_at, а не от started_at: сборка тренировки временем
 * тренировки не является. У черновика (began_at IS NULL) времени нет.
 */
export async function getWorkoutTotalSeconds(workoutId: number): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ total: number | null }>(
    `
    SELECT
      (julianday(COALESCE(w.ended_at, ?)) - julianday(w.began_at)) * 86400.0
      - COALESCE((
          SELECT SUM((julianday(COALESCE(p.ended_at, ?)) - julianday(p.started_at)) * 86400.0)
          FROM workout_pauses p WHERE p.workout_id = w.id
        ), 0) AS total
    FROM workouts w WHERE w.id = ?
    `,
    [now(), now(), workoutId]
  );
  return Math.max(0, row?.total ?? 0);
}

/* ------------------------------------------------------------------ */
/* Подходы                                                             */
/* ------------------------------------------------------------------ */

export async function getWorkoutSets(workoutId: number): Promise<SetRow[]> {
  const db = await getDb();
  return db.getAllAsync<SetRow>(
    `
    SELECT s.*, t.started_at, t.ended_at, t.active_seconds, t.is_running
    FROM sets s
    JOIN set_times t ON t.set_id = s.id
    WHERE s.workout_id = ?
    ORDER BY t.started_at IS NULL, t.started_at, s.id
    `,
    [workoutId]
  );
}

/**
 * Пустая строка подхода — заготовка. В базе есть, но времени нет,
 * пока не нажат старт. Сюда же подставляются веса из прошлой тренировки.
 */
export async function addSetDraft(
  workoutId: number,
  exerciseId: number,
  reps?: number | null,
  weightKg?: number | null
): Promise<number> {
  const db = await getDb();
  const posRow = await db.getFirstAsync<{ next: number }>(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM sets
     WHERE workout_id = ? AND exercise_id = ?`,
    [workoutId, exerciseId]
  );
  const res = await db.runAsync(
    'INSERT INTO sets (workout_id, exercise_id, reps, weight_kg, position) VALUES (?, ?, ?, ?, ?)',
    [workoutId, exerciseId, reps ?? null, weightKg ?? null, posRow?.next ?? 0]
  );
  return res.lastInsertRowId;
}

/**
 * Переставить подходы одного упражнения в заданном порядке — так же,
 * как setWorkoutExerciseOrder переставляет упражнения.
 */
export async function setExerciseSetOrder(
  workoutId: number,
  exerciseId: number,
  setIds: number[]
): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (let i = 0; i < setIds.length; i++) {
      await db.runAsync(
        'UPDATE sets SET position = ? WHERE id = ? AND workout_id = ? AND exercise_id = ?',
        [i, setIds[i], workoutId, exerciseId]
      );
    }
  });
}

/**
 * Старт подхода. Снимает паузу тренировки, если она стояла.
 * Нельзя запустить, пока в тренировке есть другой открытый интервал.
 */
export async function startSet(setId: number): Promise<void> {
  const db = await getDb();
  const ctx = await db.getFirstAsync<{ workout_id: number; open_count: number }>(
    `
    SELECT s.workout_id,
           (SELECT COUNT(*) FROM set_intervals i
            JOIN sets s2 ON s2.id = i.set_id
            WHERE s2.workout_id = s.workout_id AND i.ended_at IS NULL) AS open_count
    FROM sets s WHERE s.id = ?
    `,
    [setId]
  );
  if (!ctx) throw new Error('Set not found');
  if (ctx.open_count > 0) throw new Error('Another set is already running');

  const ts = now();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'UPDATE workout_pauses SET ended_at = ? WHERE workout_id = ? AND ended_at IS NULL',
      [ts, ctx.workout_id]
    );
    await db.runAsync(
      'INSERT INTO set_intervals (set_id, started_at) VALUES (?, ?)',
      [setId, shifted((await getRecordingSettings()).prepSeconds)]
    );
  });
}

/**
 * Отметить подход выполненным без таймера: интервал нулевой длины.
 *
 * Момент времени всё равно сохраняется, поэтому порядок подходов и
 * отдых между ними считаются как раньше — теряется только длительность.
 *
 * Зовётся уже изнутри чужой транзакции, поэтому своей не открывает.
 */
async function stampRecorded(
  db: Awaited<ReturnType<typeof getDb>>,
  setId: number,
  workoutId: number,
  ts: string
): Promise<void> {
  // отметка снимает паузу: раз подход записан, тренировка снова идёт
  await db.runAsync(
    'UPDATE workout_pauses SET ended_at = ? WHERE workout_id = ? AND ended_at IS NULL',
    [ts, workoutId]
  );
  await db.runAsync(
    'INSERT INTO set_intervals (set_id, started_at, ended_at) VALUES (?, ?, ?)',
    [setId, ts, ts]
  );
}

/**
 * Проставить RIR — то, чем засчитывается подход на повторы вместо
 * секундомера. null снимает отметку целиком.
 *
 * Вместе со значением записывается и МОМЕНТ выполнения: подход без времени
 * — это заготовка, а по временам считаются и порядок подходов, и отдых
 * между ними (lib/time.ts). То есть выбор значения на барабане делает ровно
 * то же, что раньше делал одиночный тап по кнопке записи, плюс сохраняет
 * само значение — отдельный recordSet после этого не нужен.
 *
 * Момент ставится один раз. Поправленный через минуту RIR не должен
 * сдвигать подход во времени: иначе отдых перед следующим подходом
 * пересчитался бы задним числом, хотя отдыхали ровно столько же.
 */
export async function setSetRir(setId: number, value: RirValue | null): Promise<void> {
  const db = await getDb();
  const ctx = await db.getFirstAsync<{ workout_id: number; recorded: number }>(
    `SELECT s.workout_id,
            EXISTS (SELECT 1 FROM set_intervals i WHERE i.set_id = s.id) AS recorded
     FROM sets s WHERE s.id = ?`,
    [setId]
  );
  if (!ctx) throw new Error('Set not found');

  const ts = now();
  await db.withTransactionAsync(async () => {
    if (value === null) {
      await db.runAsync('UPDATE sets SET rir = NULL, rir_missed = 0 WHERE id = ?', [setId]);
      await db.runAsync('DELETE FROM set_intervals WHERE set_id = ?', [setId]);
      return;
    }

    await db.runAsync('UPDATE sets SET rir = ?, rir_missed = ? WHERE id = ?', [
      value === RIR_MISSED ? null : value,
      value === RIR_MISSED ? 1 : 0,
      setId,
    ]);
    if (!ctx.recorded) await stampRecorded(db, setId, ctx.workout_id, ts);
  });
}

/**
 * Отменить отметку — убирает и время подхода, и проставленный RIR.
 *
 * Одно без другого не бывает: подход с RIR, но без времени, выпал бы из
 * расчёта отдыха, а подход со временем, но без RIR, не дал бы завершить
 * тренировку — незаписанные для кнопки Finish считаются именно по RIR.
 */
export async function unrecordSet(setId: number): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM set_intervals WHERE set_id = ?', [setId]);
    await db.runAsync('UPDATE sets SET rir = NULL, rir_missed = 0 WHERE id = ?', [setId]);
  });
}

/**
 * Записать длительность подхода вручную, введённую с внешнего секундомера,
 * а не встроенным таймером.
 *
 * Срезаем prepSeconds/reachSeconds так же, как при старте/стопе таймером -
 * иначе один и тот же подход считался бы по-разному в зависимости от
 * способа записи, а этого быть не должно.
 */
export async function recordSetSeconds(setId: number, seconds: number): Promise<void> {
  const db = await getDb();
  const ts = now();
  const ctx = await db.getFirstAsync<{ workout_id: number }>(
    'SELECT workout_id FROM sets WHERE id = ?',
    [setId]
  );
  if (!ctx) throw new Error('Set not found');

  const { prepSeconds, reachSeconds } = await getRecordingSettings();
  const trimmed = Math.max(0, seconds - prepSeconds - reachSeconds);

  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'UPDATE workout_pauses SET ended_at = ? WHERE workout_id = ? AND ended_at IS NULL',
      [ts, ctx.workout_id]
    );
    await db.runAsync('DELETE FROM set_intervals WHERE set_id = ?', [setId]);
    await db.runAsync(
      'INSERT INTO set_intervals (set_id, started_at, ended_at) VALUES (?, ?, ?)',
      [setId, shifted(-trimmed), ts]
    );
  });
}

/** Стоп/пауза подхода — закрывает текущий интервал. */
export async function stopSet(setId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE set_intervals SET ended_at = ?
     WHERE set_id = ? AND ended_at IS NULL`,
    [shifted(-(await getRecordingSettings()).reachSeconds), setId]
  );
}

/**
 * Продолжить подход. Разрешено только для последнего подхода тренировки:
 * если после него уже начат другой, подход считается закрытым окончательно.
 */
export async function resumeSet(setId: number): Promise<void> {
  const db = await getDb();
  const check = await db.getFirstAsync<{ is_last: number }>(
    `
    SELECT CASE WHEN (
      SELECT s2.id FROM sets s2
      JOIN set_times t2 ON t2.set_id = s2.id
      WHERE s2.workout_id = (SELECT workout_id FROM sets WHERE id = ?)
        AND t2.started_at IS NOT NULL
      ORDER BY t2.started_at DESC, s2.id DESC LIMIT 1
    ) = ? THEN 1 ELSE 0 END AS is_last
    `,
    [setId, setId]
  );
  if (!check?.is_last) throw new Error('Only the last set can be resumed');

  await db.runAsync(
    'INSERT INTO set_intervals (set_id, started_at) VALUES (?, ?)',
    [setId, now()]
  );
}

/**
 * Правка повторов и веса. Пишутся только переданные поля — те, которых в
 * values нет, остаются как были.
 *
 * Раньше здесь был COALESCE(?, reps), и «поле не передали» было неотличимо
 * от «поле очистили»: стереть ошибочно введённый вес было невозможно,
 * старое значение возвращалось обратно. Смотрим на наличие ключа, а не на
 * его значение — тогда null однозначно значит «стереть».
 */
export async function updateSetValues(
  setId: number,
  values: { reps?: number | null; weightKg?: number | null }
): Promise<void> {
  const assignments: string[] = [];
  const args: (number | null)[] = [];

  if ('reps' in values) {
    assignments.push('reps = ?');
    args.push(values.reps ?? null);
  }
  if ('weightKg' in values) {
    assignments.push('weight_kg = ?');
    args.push(values.weightKg ?? null);
  }
  if (assignments.length === 0) return;

  const db = await getDb();
  await db.runAsync(`UPDATE sets SET ${assignments.join(', ')} WHERE id = ?`, [
    ...args,
    setId,
  ]);
}

export async function deleteSet(setId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM sets WHERE id = ?', [setId]);
}

export async function deleteWorkoutExercise(
  workoutId: number,
  exerciseId: number
): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM sets WHERE workout_id = ? AND exercise_id = ?', [
      workoutId,
      exerciseId,
    ]);
    await db.runAsync(
      'DELETE FROM workout_exercise_notes WHERE workout_id = ? AND exercise_id = ?',
      [workoutId, exerciseId]
    );
  });
}

/* ------------------------------------------------------------------ */
/* Заметки про ощущения                                                */
/* ------------------------------------------------------------------ */

export async function setExerciseNote(
  workoutId: number,
  exerciseId: number,
  note: string
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO workout_exercise_notes (workout_id, exercise_id, note)
     VALUES (?, ?, ?)
     ON CONFLICT (workout_id, exercise_id) DO UPDATE SET note = excluded.note`,
    [workoutId, exerciseId, note]
  );
}

/* ------------------------------------------------------------------ */
/* Заготовка: что подставить в подходы упражнения                      */
/* ------------------------------------------------------------------ */

export interface PrefillRow {
  exercise_id: number;
  name: string;
  measurement_default: MeasurementType;
  /** Порядок упражнения в будущей тренировке. */
  position: number;
  reps: number | null;
  weight_kg: number | null;
  /** Длительность — для холдов; у подходов на повторы 0. */
  active_seconds: number;
  /** Когда это было. NULL — упражнение ещё ни разу не делали. */
  workout_started: string | null;
}

/**
 * Заготовка по списку упражнений: подходы из последнего исполнения
 * КАЖДОГО упражнения — в какой бы тренировке оно ни делалось.
 *
 * Раньше значения брались из прошлой тренировки по тому же шаблону. С тех
 * пор шаблон перестал быть обязательным: то же упражнение могло делаться
 * вчера в тренировке, собранной с нуля, и подставлять надо именно те веса,
 * а не полугодовой давности «по шаблону». Заодно это работает и когда
 * шаблона нет вовсе — упражнение добавили руками посреди тренировки.
 *
 * Порядок и position — по переданному списку: он и задаёт раскладку.
 */
export async function getExercisePrefill(exerciseIds: number[]): Promise<PrefillRow[]> {
  if (exerciseIds.length === 0) return [];

  const db = await getDb();
  const holes = exerciseIds.map(() => '?').join(', ');

  const meta = await db.getAllAsync<{
    exercise_id: number;
    name: string;
    measurement_default: MeasurementType;
  }>(
    `SELECT id AS exercise_id, name, measurement_default
     FROM exercises WHERE id IN (${holes})`,
    exerciseIds
  );

  const previous = await db.getAllAsync<{
    exercise_id: number;
    reps: number | null;
    weight_kg: number | null;
    active_seconds: number;
    workout_started: string;
  }>(
    `
    SELECT s.exercise_id, s.reps, s.weight_kg, t.active_seconds,
           w.started_at AS workout_started
    FROM sets s
    JOIN workouts w  ON w.id = s.workout_id
    JOIN set_times t ON t.set_id = s.id
    WHERE s.exercise_id IN (${holes})
      AND w.id = (
            SELECT w2.id FROM workouts w2
            JOIN sets s2 ON s2.workout_id = w2.id
            WHERE s2.exercise_id = s.exercise_id AND w2.ended_at IS NOT NULL
            ORDER BY w2.started_at DESC LIMIT 1
          )
    ORDER BY s.position, s.id
    `,
    exerciseIds
  );

  const byExercise = new Map<number, typeof previous>();
  for (const row of previous) {
    const arr = byExercise.get(row.exercise_id);
    if (arr) arr.push(row);
    else byExercise.set(row.exercise_id, [row]);
  }

  const out: PrefillRow[] = [];
  exerciseIds.forEach((exerciseId, position) => {
    const info = meta.find((m) => m.exercise_id === exerciseId);
    if (!info) return;
    const done = byExercise.get(exerciseId);

    // Упражнение ещё ни разу не делали — одна пустая строка: подход в
    // тренировке всё равно нужен, просто подставить в него нечего.
    if (!done || done.length === 0) {
      out.push({
        ...info,
        position,
        reps: null,
        weight_kg: null,
        active_seconds: 0,
        workout_started: null,
      });
      return;
    }
    for (const s of done) {
      out.push({
        ...info,
        position,
        reps: s.reps,
        weight_kg: s.weight_kg,
        active_seconds: s.active_seconds,
        workout_started: s.workout_started,
      });
    }
  });
  return out;
}

/** Заготовка по шаблону: его состав плюс подстановка по каждому упражнению. */
export async function getRoutinePrefill(routineId: number): Promise<PrefillRow[]> {
  const db = await getDb();
  const ids = await db.getAllAsync<{ exercise_id: number }>(
    `SELECT re.exercise_id
     FROM routine_exercises re
     JOIN exercises e ON e.id = re.exercise_id
     WHERE re.routine_id = ? AND e.is_archived = 0
     ORDER BY re.position`,
    [routineId]
  );
  return getExercisePrefill(ids.map((r) => r.exercise_id));
}

/* ------------------------------------------------------------------ */
/* Восстановление после падения приложения                             */
/* ------------------------------------------------------------------ */

export interface DanglingSet {
  set_id: number;
  interval_id: number;
  exercise_name: string;
  started_at: string;
}

export async function findDanglingIntervals(): Promise<DanglingSet[]> {
  const db = await getDb();
  return db.getAllAsync<DanglingSet>(`
    SELECT i.set_id, i.id AS interval_id, e.name AS exercise_name, i.started_at
    FROM set_intervals i
    JOIN sets s      ON s.id = i.set_id
    JOIN exercises e ON e.id = s.exercise_id
    WHERE i.ended_at IS NULL
    ORDER BY i.started_at
  `);
}

export async function closeInterval(intervalId: number, endedAt: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE set_intervals SET ended_at = ? WHERE id = ?', [
    endedAt,
    intervalId,
  ]);
}

/* ------------------------------------------------------------------ */
/* Вес тела                                                            */
/* ------------------------------------------------------------------ */

export async function recordBodyweight(weightKg: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO bodyweight (measured_at, weight_kg) VALUES (?, ?)',
    [now(), weightKg]
  );
}

export async function getLatestBodyweight(): Promise<number | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ weight_kg: number }>(
    'SELECT weight_kg FROM bodyweight ORDER BY measured_at DESC LIMIT 1'
  );
  return row?.weight_kg ?? null;
}

/* ------------------------------------------------------------------ */
/* Справочник упражнений                                               */
/* ------------------------------------------------------------------ */

export async function searchExercises(query = ''): Promise<Exercise[]> {
  const db = await getDb();
  return db.getAllAsync<Exercise>(
    `SELECT * FROM exercises
     WHERE name LIKE ? AND is_archived = 0
     ORDER BY is_custom DESC, name`,
    [`%${query}%`]
  );
}

export async function createExercise(input: {
  name: string;
  description?: string;
  measurementDefault: MeasurementType;
  muscles: { muscleId: number; role: MuscleRole }[];
}): Promise<number> {
  const db = await getDb();
  let id = 0;
  await db.withTransactionAsync(async () => {
    const res = await db.runAsync(
      `INSERT INTO exercises (name, description, measurement_default, is_custom)
       VALUES (?, ?, ?, 1)`,
      [input.name, input.description ?? null, input.measurementDefault]
    );
    id = res.lastInsertRowId;
    for (const m of input.muscles) {
      await db.runAsync(
        'INSERT INTO exercise_muscles (exercise_id, muscle_id, role) VALUES (?, ?, ?)',
        [id, m.muscleId, m.role]
      );
    }
  });
  return id;
}
