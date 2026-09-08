import { getDb } from './index';

/* ---------------- Мышцы ---------------- */

/**
 * Роль мышцы в упражнении. Пришло на смену доле-проценту: раскладывать
 * 100% руками было мучительно, а на практике важно только, ведущая мышца
 * или помогающая.
 */
export type MuscleRole = 'primary' | 'secondary';

export interface Muscle {
  id: number;
  name: string;
  body_group: string;
}

export async function listMuscles(): Promise<Muscle[]> {
  const db = await getDb();
  return db.getAllAsync<Muscle>(
    'SELECT id, name, COALESCE(body_group, \'Прочее\') AS body_group FROM muscles ORDER BY name'
  );
}

/**
 * Правка своего упражнения. Мышцы переписываются целиком:
 * проще и надёжнее, чем сверять, что добавилось и что убралось.
 * Встроенные упражнения (is_custom = 0) редактировать нельзя.
 */
export async function updateExercise(
  exerciseId: number,
  input: {
    name: string;
    description?: string;
    measurementDefault: 'reps' | 'hold';
    equipmentId?: number | null;
    muscles: { muscleId: number; role: MuscleRole }[];
  }
): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ is_custom: number }>(
    'SELECT is_custom FROM exercises WHERE id = ?',
    [exerciseId]
  );
  if (!row) throw new Error('Exercise not found');
  if (row.is_custom !== 1) throw new Error('Built-in exercises cannot be edited');

  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE exercises SET name = ?, description = ?, measurement_default = ?,
              equipment_id = ?
       WHERE id = ?`,
      [
        input.name,
        input.description ?? null,
        input.measurementDefault,
        input.equipmentId ?? null,
        exerciseId,
      ]
    );
    await db.runAsync('DELETE FROM exercise_muscles WHERE exercise_id = ?', [exerciseId]);
    for (const m of input.muscles) {
      await db.runAsync(
        'INSERT INTO exercise_muscles (exercise_id, muscle_id, role) VALUES (?, ?, ?)',
        [exerciseId, m.muscleId, m.role]
      );
    }
  });
}

export interface ExerciseFull {
  id: number;
  name: string;
  description: string | null;
  measurement_default: 'reps' | 'hold';
  is_custom: number;
  equipment_id: number | null;
}

export async function getExercise(exerciseId: number): Promise<ExerciseFull | null> {
  const db = await getDb();
  return db.getFirstAsync<ExerciseFull>('SELECT * FROM exercises WHERE id = ?', [exerciseId]);
}

export interface ExerciseMuscle {
  muscle_id: number;
  name: string;
  role: MuscleRole;
}

export async function getExerciseMuscles(exerciseId: number): Promise<ExerciseMuscle[]> {
  const db = await getDb();
  return db.getAllAsync<ExerciseMuscle>(
    // главные впереди: 'primary' < 'secondary' по алфавиту, так что
    // обычной сортировки по role достаточно
    `SELECT em.muscle_id, m.name, em.role
     FROM exercise_muscles em
     JOIN muscles m ON m.id = em.muscle_id
     WHERE em.exercise_id = ?
     ORDER BY em.role, m.name`,
    [exerciseId]
  );
}

/** Сколько завершённых тренировок содержит это упражнение. */
export async function getExerciseUsage(exerciseId: number): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(DISTINCT s.workout_id) AS n
     FROM sets s JOIN workouts w ON w.id = s.workout_id
     WHERE s.exercise_id = ? AND w.ended_at IS NOT NULL`,
    [exerciseId]
  );
  return row?.n ?? 0;
}

/**
 * «Удаление» упражнения.
 *
 * Если на упражнение никто не ссылается — удаляем по-настоящему.
 * Если оно уже попало в историю тренировок — физически удалить нельзя,
 * подходы остались бы без имени. Тогда помечаем архивным: из библиотеки
 * и выбора оно пропадает, в истории остаётся как было.
 *
 * Из состава шаблонов убираем в любом случае — иначе тренировка стартовала бы
 * с упражнением, которого пользователь у себя больше не видит.
 */
export async function deleteExercise(exerciseId: number): Promise<void> {
  const db = await getDb();

  const row = await db.getFirstAsync<{ is_custom: number }>(
    'SELECT is_custom FROM exercises WHERE id = ?',
    [exerciseId]
  );
  if (!row) throw new Error('Exercise not found');
  if (row.is_custom !== 1) throw new Error('Built-in exercises cannot be edited');

  const used = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM sets WHERE exercise_id = ?',
    [exerciseId]
  );

  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM routine_exercises WHERE exercise_id = ?', [exerciseId]);

    if ((used?.n ?? 0) > 0) {
      await db.runAsync('UPDATE exercises SET is_archived = 1 WHERE id = ?', [exerciseId]);
    } else {
      await db.runAsync('DELETE FROM exercise_muscles WHERE exercise_id = ?', [exerciseId]);
      await db.runAsync('DELETE FROM exercises WHERE id = ?', [exerciseId]);
    }
  });
}

/* ---------------- Снаряжение ---------------- */

/**
 * Снаряд упражнения. Кроме поиска по тегу несёт правила веса: множитель
 * (пара гантелей — 2) и признак «грузится собственным телом».
 */
export interface Equipment {
  id: number;
  name: string;
  weight_factor: number;
  adds_bodyweight: number;
}

export async function listEquipment(): Promise<Equipment[]> {
  const db = await getDb();
  return db.getAllAsync<Equipment>('SELECT * FROM equipment ORDER BY id');
}

/* ---------------- Состав шаблона ---------------- */

export interface RoutineExercise {
  exercise_id: number;
  name: string;
  measurement_default: 'reps' | 'hold';
  position: number;
}

export async function getRoutineExercises(routineId: number): Promise<RoutineExercise[]> {
  const db = await getDb();
  return db.getAllAsync<RoutineExercise>(
    `SELECT re.exercise_id, e.name, e.measurement_default, re.position
     FROM routine_exercises re
     JOIN exercises e ON e.id = re.exercise_id
     WHERE re.routine_id = ?
     ORDER BY re.position`,
    [routineId]
  );
}

export async function addExerciseToRoutine(
  routineId: number,
  exerciseId: number
): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ next: number }>(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM routine_exercises WHERE routine_id = ?',
    [routineId]
  );
  await db.runAsync(
    `INSERT OR IGNORE INTO routine_exercises (routine_id, exercise_id, position)
     VALUES (?, ?, ?)`,
    [routineId, exerciseId, row?.next ?? 0]
  );
}

export async function removeExerciseFromRoutine(
  routineId: number,
  exerciseId: number
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'DELETE FROM routine_exercises WHERE routine_id = ? AND exercise_id = ?',
    [routineId, exerciseId]
  );
}

export async function renameRoutine(routineId: number, name: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE routines SET name = ? WHERE id = ?', [name, routineId]);
}

/**
 * Удалить шаблон.
 *
 * Раньше это запрещалось, если по шаблону есть тренировки: routine_id был
 * NOT NULL, и история осталась бы без ссылки. Теперь шаблон — вторичная
 * вещь, и держать его вечно из-за одной старой тренировки незачем: перед
 * удалением проставляем этим тренировкам имя шаблона своим полем, а ссылку
 * обнуляем. История сохраняет и название, и подходы — теряется только
 * связь с планом, которого больше нет.
 */
export async function deleteRoutine(routineId: number): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE workouts
       SET name = COALESCE(name, (SELECT r.name FROM routines r WHERE r.id = ?)),
           routine_id = NULL
       WHERE routine_id = ?`,
      [routineId, routineId]
    );
    await db.runAsync('DELETE FROM routines WHERE id = ?', [routineId]);
  });
}

/* ---------------- История тренировок ---------------- */

export interface WorkoutSummary {
  id: number;
  /**
   * Имя тренировки: своё (собранной с нуля — по главным мышцам) или имя
   * шаблона. NULL бывает у пустой тренировки, которую нечем назвать.
   */
  title: string | null;
  started_at: string;
  ended_at: string | null;
  total_seconds: number;
  set_count: number;
  exercises: string; // имена через запятую
}

export async function listWorkouts(limit = 50): Promise<WorkoutSummary[]> {
  const db = await getDb();
  return db.getAllAsync<WorkoutSummary>(
    `
    -- Время тренировки идёт от began_at: сборка состава, которая была до
    -- него, тренировкой не считается. started_at остаётся у черновиков,
    -- но их в истории нет — здесь только завершённые.
    SELECT w.id, COALESCE(w.name, r.name) AS title,
           COALESCE(w.began_at, w.started_at) AS started_at, w.ended_at,
           (julianday(w.ended_at) - julianday(COALESCE(w.began_at, w.started_at))) * 86400.0
             - COALESCE((SELECT SUM((julianday(p.ended_at) - julianday(p.started_at)) * 86400.0)
                         FROM workout_pauses p
                         WHERE p.workout_id = w.id AND p.ended_at IS NOT NULL), 0)
             AS total_seconds,
           (SELECT COUNT(*) FROM sets s WHERE s.workout_id = w.id) AS set_count,
           (SELECT GROUP_CONCAT(name, ', ') FROM (
              SELECT DISTINCT e.name
              FROM sets s JOIN exercises e ON e.id = s.exercise_id
              WHERE s.workout_id = w.id
           )) AS exercises
    FROM workouts w
    -- LEFT JOIN: тренировка с нуля шаблона не имеет, и обычное соединение
    -- просто выкинуло бы её из истории
    LEFT JOIN routines r ON r.id = w.routine_id
    WHERE w.ended_at IS NOT NULL
    ORDER BY w.started_at DESC
    LIMIT ?
    `,
    [limit]
  );
}

export interface HistorySet {
  id: number;
  exercise_id: number;
  exercise_name: string;
  measurement_default: 'reps' | 'hold';
  reps: number | null;
  weight_kg: number | null;
  /** У подходов, записанных до перехода на RIR, его нет и не будет. */
  rir: number | null;
  active_seconds: number;
  started_at: string | null;
  /** Правила веса из снаряжения — чтобы показать настоящую нагрузку. */
  weight_factor: number | null;
  adds_bodyweight: number | null;
  /** Вес тела на момент ТОЙ тренировки, а не сегодняшний. */
  bodyweight_kg: number | null;
}

export async function getWorkoutDetail(workoutId: number): Promise<HistorySet[]> {
  const db = await getDb();
  return db.getAllAsync<HistorySet>(
    `
    SELECT s.id, s.exercise_id, e.name AS exercise_name, e.measurement_default,
           s.reps, s.weight_kg, s.rir, t.active_seconds, t.started_at,
           q.weight_factor, q.adds_bodyweight,
           (SELECT b.weight_kg FROM bodyweight b
            WHERE b.measured_at <= COALESCE(w.began_at, w.started_at)
            ORDER BY b.measured_at DESC LIMIT 1) AS bodyweight_kg
    FROM sets s
    JOIN exercises e  ON e.id = s.exercise_id
    JOIN workouts w   ON w.id = s.workout_id
    LEFT JOIN equipment q ON q.id = e.equipment_id
    JOIN set_times t  ON t.set_id = s.id
    WHERE s.workout_id = ?
    ORDER BY t.started_at IS NULL, t.started_at, s.id
    `,
    [workoutId]
  );
}

/** Моменты начала завершённых тренировок — для календаря. */
export async function getWorkoutDates(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ started_at: string }>(
    'SELECT COALESCE(began_at, started_at) AS started_at FROM workouts WHERE ended_at IS NOT NULL'
  );
  return rows.map((r) => r.started_at);
}

export async function deleteWorkout(workoutId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM workouts WHERE id = ?', [workoutId]);
}

/**
 * Переписать состав шаблона целиком, в переданном порядке.
 * Проще, чем сверять что добавилось и что убралось.
 */
export async function setRoutineExercises(
  routineId: number,
  exerciseIds: number[]
): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM routine_exercises WHERE routine_id = ?', [routineId]);
    for (let i = 0; i < exerciseIds.length; i++) {
      await db.runAsync(
        `INSERT INTO routine_exercises (routine_id, exercise_id, position)
         VALUES (?, ?, ?)`,
        [routineId, exerciseIds[i], i]
      );
    }
  });
}

export async function getRoutine(
  routineId: number
): Promise<{ id: number; name: string; is_custom: number } | null> {
  const db = await getDb();
  return db.getFirstAsync('SELECT id, name, is_custom FROM routines WHERE id = ?', [
    routineId,
  ]);
}

/* ---------------- Итоги тренировки ---------------- */

/** Шапка тренировки: чем её назвать и была ли она по шаблону. */
export interface WorkoutMeta {
  id: number;
  routine_id: number | null;
  title: string | null;
}

export async function getWorkoutMeta(workoutId: number): Promise<WorkoutMeta | null> {
  const db = await getDb();
  return db.getFirstAsync<WorkoutMeta>(
    `SELECT w.id, w.routine_id, COALESCE(w.name, r.name) AS title
     FROM workouts w
     LEFT JOIN routines r ON r.id = w.routine_id
     WHERE w.id = ?`,
    [workoutId]
  );
}

export interface RecapSet {
  /** id подхода: разбор повторяет раскладку тренировки, и отдых там тоже
   *  привязан к подходу, а не к его номеру в списке. */
  id: number;
  exercise_id: number;
  exercise_name: string;
  measurement_default: 'reps' | 'hold';
  reps: number | null;
  weight_kg: number | null;
  rir: number | null;
  active_seconds: number;
  started_at: string | null;
  ended_at: string | null;
  weight_factor: number | null;
  adds_bodyweight: number | null;
  bodyweight_kg: number | null;
  /** Рекорд: результат лучше всего, что было по этому упражнению раньше. */
  is_pr: number;
}

/**
 * Разбор завершённой тренировки: подходы и рекорды.
 *
 * Рекорд считаем по трём меркам, в зависимости от того, чем меряется
 * упражнение: вес, число повторов при своём весе, время удержания.
 * Сравниваем только с тренировками, которые были ДО этой.
 *
 * Сравнение идёт по ВВЕДЁННОМУ весу, а не по настоящей нагрузке, и это
 * не упущение: снаряжение у упражнения одно, множитель с обеих сторон
 * одинаков, а вес тела между тренировками меняется — рекорды по жиму
 * прыгали бы от того, что человек поел.
 */
export async function getWorkoutRecap(workoutId: number): Promise<RecapSet[]> {
  const db = await getDb();
  return db.getAllAsync<RecapSet>(
    `
    WITH prior AS (
      SELECT s.exercise_id,
             MAX(COALESCE(s.weight_kg, 0)) AS best_weight,
             MAX(COALESCE(s.reps, 0))      AS best_reps,
             MAX(t.active_seconds)         AS best_seconds
      FROM sets s
      JOIN workouts w  ON w.id = s.workout_id
      JOIN set_times t ON t.set_id = s.id
      WHERE w.ended_at IS NOT NULL
        AND w.started_at < (SELECT started_at FROM workouts WHERE id = ?)
      GROUP BY s.exercise_id
    )
    SELECT s.id, s.exercise_id, e.name AS exercise_name, e.measurement_default,
           s.reps, s.weight_kg, s.rir,
           t.active_seconds, t.started_at, t.ended_at,
           q.weight_factor, q.adds_bodyweight,
           (SELECT b.weight_kg FROM bodyweight b
            WHERE b.measured_at <= COALESCE(w2.began_at, w2.started_at)
            ORDER BY b.measured_at DESC LIMIT 1) AS bodyweight_kg,
           CASE
             WHEN e.measurement_default = 'hold'
               THEN CASE WHEN t.active_seconds > COALESCE(p.best_seconds, 0) THEN 1 ELSE 0 END
             WHEN s.weight_kg IS NOT NULL
               THEN CASE WHEN s.weight_kg > COALESCE(p.best_weight, 0) THEN 1 ELSE 0 END
             ELSE CASE WHEN COALESCE(s.reps, 0) > COALESCE(p.best_reps, 0) THEN 1 ELSE 0 END
           END AS is_pr
    FROM sets s
    JOIN exercises e ON e.id = s.exercise_id
    JOIN workouts w2 ON w2.id = s.workout_id
    LEFT JOIN equipment q ON q.id = e.equipment_id
    JOIN set_times t ON t.set_id = s.id
    LEFT JOIN prior p ON p.exercise_id = s.exercise_id
    LEFT JOIN workout_exercise_order o
           ON o.workout_id = s.workout_id AND o.exercise_id = s.exercise_id
    WHERE s.workout_id = ?
    -- тот же порядок, что и на экране тренировки (getWorkoutSetsLive):
    -- разбор повторяет её раскладку, значит и упражнения должны идти так же
    ORDER BY COALESCE(o.position, 999999), s.exercise_id, s.position, s.id
    `,
    [workoutId, workoutId]
  );
}
