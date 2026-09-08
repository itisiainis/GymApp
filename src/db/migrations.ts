import type { SQLiteDatabase } from 'expo-sqlite';

/**
 * Схема хранится версиями. При старте приложение смотрит PRAGMA user_version
 * и догоняет базу до LATEST_VERSION, применяя недостающие шаги по порядку.
 *
 * Добавляя новую миграцию: увеличь LATEST_VERSION и допиши блок `if (version < N)`.
 * Уже применённые блоки НИКОГДА не редактируются — на устройствах с установленным
 * приложением они выполнялись давно и повторно не запустятся.
 */

const LATEST_VERSION = 14;

/** Есть ли колонка в таблице — по фактической схеме, а не по номеру версии. */
async function hasColumn(
  db: SQLiteDatabase,
  table: string,
  column: string
): Promise<boolean> {
  const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  return cols.some((c) => c.name === column);
}

export async function migrate(db: SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let version = row?.user_version ?? 0;

  if (version < 1) {
    await db.execAsync(V1);
    version = 1;
  }

  if (version < 2) {
    // Подход без интервалов ошибочно считался идущим:
    // LEFT JOIN отдаёт строку с NULL в ended_at даже когда интервалов нет.
    await db.execAsync(`
      DROP VIEW IF EXISTS set_times;
      CREATE VIEW set_times AS
      SELECT
          s.id AS set_id,
          MIN(i.started_at) AS started_at,
          MAX(i.ended_at)   AS ended_at,
          COALESCE(SUM(
              CASE WHEN i.ended_at IS NOT NULL
                   THEN strftime('%s', i.ended_at) - strftime('%s', i.started_at)
                   ELSE 0 END
          ), 0) AS active_seconds,
          MAX(CASE WHEN i.id IS NOT NULL AND i.ended_at IS NULL THEN 1 ELSE 0 END)
              AS is_running
      FROM sets s
      LEFT JOIN set_intervals i ON i.set_id = s.id
      GROUP BY s.id;
    `);
    version = 2;
  }

  if (version < 3) {
    await db.execAsync(V3);
    version = 3;
  }

  if (version < 4) {
    await db.execAsync(V4);
    version = 4;
  }

  if (version < 5) {
    // Упражнение, на которое ссылается история, физически удалить нельзя —
    // строки подходов остались бы без имени. Прячем его вместо удаления.
    await db.execAsync(
      `ALTER TABLE exercises ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0`
    );
    version = 5;
  }

  if (version < 6) {
    // Старт и стоп сдвигаются на несколько секунд (дойти до снаряда,
    // дотянуться до телефона), поэтому короткий подход может дать
    // отрицательную длительность — обрезаем по нулю.
    await db.execAsync(`
      DROP VIEW IF EXISTS set_times;
      CREATE VIEW set_times AS
      SELECT
          s.id AS set_id,
          MIN(i.started_at) AS started_at,
          MAX(i.ended_at)   AS ended_at,
          COALESCE(SUM(
              CASE WHEN i.ended_at IS NOT NULL
                   THEN MAX(0, strftime('%s', i.ended_at) - strftime('%s', i.started_at))
                   ELSE 0 END
          ), 0) AS active_seconds,
          MAX(CASE WHEN i.id IS NOT NULL AND i.ended_at IS NULL THEN 1 ELSE 0 END)
              AS is_running
      FROM sets s
      LEFT JOIN set_intervals i ON i.set_id = s.id
      GROUP BY s.id;
    `);
    version = 6;
  }

  if (version < 7) {
    // Порядок упражнений внутри тренировки — это данные: их добавляют,
    // убирают и переставляют по ходу, и восстановить порядок из времени
    // подходов нельзя (у заготовок времени ещё нет).
    await db.execAsync(`
      CREATE TABLE workout_exercise_order (
          workout_id  INTEGER NOT NULL REFERENCES workouts(id)  ON DELETE CASCADE,
          exercise_id INTEGER NOT NULL REFERENCES exercises(id),
          position    INTEGER NOT NULL,
          PRIMARY KEY (workout_id, exercise_id)
      );
    `);
    version = 7;
  }

  if (version < 8) {
    // Порядок подходов внутри упражнения — раньше это был просто порядок
    // вставки (id), теперь данные: подходы тоже можно переставить руками.
    await db.execAsync(`ALTER TABLE sets ADD COLUMN position INTEGER NOT NULL DEFAULT 0`);
    // Бэкафилл без оконных функций (совместимость): позиция = сколько
    // более ранних подходов того же упражнения в той же тренировке уже есть.
    await db.execAsync(`
      UPDATE sets SET position = (
        SELECT COUNT(*) FROM sets s2
        WHERE s2.workout_id = sets.workout_id
          AND s2.exercise_id = sets.exercise_id
          AND s2.id < sets.id
      );
      CREATE INDEX idx_sets_position ON sets(workout_id, exercise_id, position);
    `);
    version = 8;
  }

  // Условие не только по номеру версии, но и по фактической схеме: база
  // могла получить отметку «версия 9» без самой миграции, если LATEST_VERSION
  // подняли раньше, чем дописали блок (строка ниже штампует версию, а
  // приложение перезагружается на каждое сохранение файла). Проверка по
  // колонке чинит такие базы вместо того, чтобы навсегда их пропускать.
  const hasShare = await hasColumn(db, 'exercise_muscles', 'share');
  if (version < 9 || hasShare) {
   if (hasShare) {
    // Доля мышцы в упражнении заменяется ролью: главная или вторичная.
    // Проценты не сходились с тем, как упражнение выбирают на практике,
    // и требовали от пользователя раскладывать 100% руками.
    //
    // Колонку не удаляем, а пересобираем таблицу: вместе с share уходит
    // и её CHECK, а менять ограничения ALTER TABLE в SQLite не умеет.
    await db.execAsync(`
      -- остаток от прошлой неудачной попытки, если она была
      DROP TABLE IF EXISTS exercise_muscles_new;

      CREATE TABLE exercise_muscles_new (
          exercise_id INTEGER NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
          muscle_id   INTEGER NOT NULL REFERENCES muscles(id)   ON DELETE CASCADE,
          role        TEXT    NOT NULL DEFAULT 'secondary'
              CHECK (role IN ('primary', 'secondary')),
          PRIMARY KEY (exercise_id, muscle_id)
      );

      INSERT INTO exercise_muscles_new (exercise_id, muscle_id, role)
      SELECT em.exercise_id, em.muscle_id,
             CASE
               WHEN em.share >= 0.3 THEN 'primary'
               -- Ни одна доля не дотянула до порога (например, пять мышц
               -- по 20% из кнопки «Поровну») — главной делаем наибольшую.
               -- Иначе упражнение осталось бы совсем без главной мышцы, а
               -- по ним потом считается имя тренировки.
               --
               -- Берём именно одну строку через ORDER BY + LIMIT, а не
               -- сравнение с MAX(share): при равных долях под MAX подходят
               -- сразу все, и главными становилось бы всё упражнение целиком.
               WHEN em.muscle_id = (
                        SELECT e2.muscle_id FROM exercise_muscles e2
                        WHERE e2.exercise_id = em.exercise_id
                        ORDER BY e2.share DESC, e2.muscle_id
                        LIMIT 1
                    )
                    AND NOT EXISTS (
                        SELECT 1 FROM exercise_muscles e3
                        WHERE e3.exercise_id = em.exercise_id AND e3.share >= 0.3
                    )
                 THEN 'primary'
               ELSE 'secondary'
             END
      FROM exercise_muscles em;

      DROP TABLE exercise_muscles;
      ALTER TABLE exercise_muscles_new RENAME TO exercise_muscles;
    `);
   }
    version = 9;
  }

  // Проверка по колонке — по той же причине, что и в блоке выше.
  const hasRirColumn = await hasColumn(db, 'sets', 'rir');
  if (version < 10 || !hasRirColumn) {
    // Подход на повторы засчитывается не секундомером, а RIR — сколько
    // повторов осталось в запасе.
    //
    // Две колонки, а не одна с числом-заглушкой: rir остаётся честным
    // числом, которое можно усреднять, а «не дотянул» — отдельный факт.
    // Смешать их в одной колонке (например, -1 = не дотянул) значило бы
    // испортить любую агрегацию, а бэкап тут формат выгрузки для анализа,
    // а не только резервная копия (см. db/backup.ts).
    //
    // Старым подходам RIR задним числом не проставляем: он не выводится
    // из секунд, и придумывать его за пользователя нечестно. NULL при
    // rir_missed = 0 и значит «не проставлен».
    if (!hasRirColumn) {
      await db.execAsync(`
        ALTER TABLE sets ADD COLUMN rir INTEGER
            CHECK (rir IS NULL OR (rir >= 0 AND rir <= 5));
      `);
    }
    if (!(await hasColumn(db, 'sets', 'rir_missed'))) {
      await db.execAsync(`
        ALTER TABLE sets ADD COLUMN rir_missed INTEGER NOT NULL DEFAULT 0
            CHECK (rir_missed IN (0, 1));
      `);
    }
    version = 10;
  }

  const needsWorkoutRebuild = !(await hasColumn(db, 'workouts', 'name'));
  if (version < 11 || needsWorkoutRebuild) {
    // Тренировка больше не обязана начинаться с шаблона: её собирают с
    // нуля, а шаблон при желании сохраняют уже потом. Значит routine_id
    // становится необязательным, а имя — своим полем: у тренировки с нуля
    // шаблона нет, и брать название неоткуда (его собирают по главным
    // мышцам входящих упражнений, см. db/workout-session.ts).
    //
    // Снять NOT NULL в SQLite можно только пересборкой таблицы, а у
    // workouts есть дети (sets, set_intervals через них, workout_pauses,
    // workout_exercise_notes, workout_exercise_order). Отсюда два условия:
    //
    // 1. Внешние ключи на время пересборки ВЫКЛЮЧАЕМ. При включённых
    //    DROP TABLE workouts выполняет неявный DELETE и запускает
    //    ON DELETE CASCADE у sets — то есть тихо стирает всю историю
    //    подходов. PRAGMA внутри транзакции не действует, поэтому она
    //    отдельным вызовом, до и после.
    // 2. Имя новой таблице даём временное и переименовываем в конце:
    //    дети ссылаются на «workouts» по имени, и к моменту переименования
    //    старой таблицы с этим именем уже не существует.
    if (needsWorkoutRebuild) {
      await db.execAsync('PRAGMA foreign_keys = OFF');
      try {
        await db.execAsync(`
        -- остаток от прошлой неудачной попытки, если она была
        DROP TABLE IF EXISTS workouts_new;

        CREATE TABLE workouts_new (
            id         INTEGER PRIMARY KEY,
            -- NULL = собрана с нуля, без шаблона
            routine_id INTEGER REFERENCES routines(id),
            -- NULL = показывать имя шаблона (тренировки, начатые по нему)
            name       TEXT,
            started_at TEXT NOT NULL,   -- ISO-8601 UTC
            ended_at   TEXT             -- NULL = тренировка идёт
        );

        INSERT INTO workouts_new (id, routine_id, name, started_at, ended_at)
        SELECT id, routine_id, NULL, started_at, ended_at FROM workouts;

        DROP TABLE workouts;
        ALTER TABLE workouts_new RENAME TO workouts;

        CREATE INDEX idx_workouts_started ON workouts(started_at);
        `);
      } finally {
        await db.execAsync('PRAGMA foreign_keys = ON');
      }
    }
    version = 11;
  }

  const hasBeganAt = await hasColumn(db, 'workouts', 'began_at');
  if (version < 12 || !hasBeganAt) {
    // 1. Тренировку сначала СОБИРАЮТ, и только потом запускают. Между
    //    этими моментами она уже существует (упражнения куда-то надо
    //    складывать), но время ещё не идёт. Отсюда разделение:
    //      started_at — когда тренировку завели (черновик открыт),
    //      began_at   — когда пошло время. NULL = ещё собирают.
    //
    //    began_at ставится СРАЗУ на пять секунд вперёд, когда нажали
    //    «Let's start»: отсчёт перед стартом получается обычным временем
    //    по стенным часам, а не таймером внутри приложения. Свёрнутое
    //    приложение его больше не останавливает — просто вернувшись,
    //    видишь то, что и должно быть.
    //
    // 2. Длительности считались целыми секундами (strftime('%s')), и
    //    показанные значения не сходились при вычитании: между 0:07 и
    //    0:12 на экране «пять секунд», а на деле от 4.01 до 5.99.
    //    julianday() даёт дробные сутки, отсюда честные доли секунды.
    //    Сами времена в базе всегда хранились с миллисекундами
    //    (ISO-8601 из Date.toISOString), так что точность появляется и у
    //    всего, что уже записано, — пересчитывать ничего не нужно.
    //
    // Колонку добавляем, только если её ещё нет: сюда можно попасть и с
    // уже добавленной (версия отштамповалась ниже, чем есть на самом
    // деле), а повторный ALTER — это ошибка, которая остановит всю
    // миграцию. Пересоздание представления ниже повторный прогон
    // переживает само.
    if (!hasBeganAt) {
      await db.execAsync(`
        ALTER TABLE workouts ADD COLUMN began_at TEXT;
        -- всё, что записано раньше, стартовало сразу: черновиков не было
        UPDATE workouts SET began_at = started_at;
      `);
    }
    await db.execAsync(`
      DROP VIEW IF EXISTS set_times;
      CREATE VIEW set_times AS
      SELECT
          s.id AS set_id,
          MIN(i.started_at) AS started_at,
          MAX(i.ended_at)   AS ended_at,
          COALESCE(SUM(
              CASE WHEN i.ended_at IS NOT NULL
                   THEN MAX(0.0, (julianday(i.ended_at) - julianday(i.started_at)) * 86400.0)
                   ELSE 0 END
          ), 0) AS active_seconds,
          MAX(CASE WHEN i.id IS NOT NULL AND i.ended_at IS NULL THEN 1 ELSE 0 END)
              AS is_running
      FROM sets s
      LEFT JOIN set_intervals i ON i.set_id = s.id
      GROUP BY s.id;
    `);
    version = 12;
  }

  // Условие наоборот: мигрировать надо, пока колонка ЕЩЁ есть. И сама
  // пересборка — тоже под этим условием: досюда можно дойти с уже
  // перестроенной таблицей (версия отштамповалась ниже, чем есть), и
  // тогда копировать из несуществующей колонки было бы ошибкой, которая
  // остановит миграцию.
  const hasLegacyRir = await hasColumn(db, 'sets', 'rir_missed');
  if (version < 13 || hasLegacyRir) {
    // Шкала RIR стала «>5, 5, 4, 3, 2, 1, 0»: сколько повторов осталось в
    // запасе, до нуля. Отдельного «не дотянул» больше нет — на шкале для
    // него нет места, а нулевой запас это уже и есть край.
    //
    // «>5» хранится числом 6: это не отдельная категория, а тот же счёт,
    // просто с открытым верхом (шесть и больше). Для анализа это цензура
    // сверху, а не пропуск, и в выгрузке (db/backup.ts) колонка остаётся
    // обычным числом, которое можно усреднять.
    //
    // Ни расширить CHECK, ни убрать колонку rir_missed в SQLite нельзя
    // без пересборки таблицы, поэтому пересобираем — по тому же рецепту,
    // что и workouts в версии 11:
    //   1. внешние ключи выключены: у set_intervals стоит ON DELETE
    //      CASCADE, и DROP TABLE при включённых стёр бы все интервалы;
    //   2. представление set_times снимается заранее. ALTER TABLE RENAME
    //      перечитывает схему целиком и спотыкается о представление,
    //      которое ссылается на уже удалённую таблицу.
    if (hasLegacyRir) {
      await db.execAsync('PRAGMA foreign_keys = OFF');
      try {
        await db.execAsync(`
        -- остаток от прошлой неудачной попытки, если она была
        DROP TABLE IF EXISTS sets_new;
        DROP VIEW IF EXISTS set_times;

        CREATE TABLE sets_new (
            id          INTEGER PRIMARY KEY,
            workout_id  INTEGER NOT NULL REFERENCES workouts(id)  ON DELETE CASCADE,
            exercise_id INTEGER NOT NULL REFERENCES exercises(id),
            reps        INTEGER,
            weight_kg   REAL,
            position    INTEGER NOT NULL DEFAULT 0,
            -- NULL = не проставлен, 0..5 = запас, 6 = «>5»
            rir         INTEGER CHECK (rir IS NULL OR (rir >= 0 AND rir <= 6))
        );

        INSERT INTO sets_new (id, workout_id, exercise_id, reps, weight_kg, position, rir)
        SELECT id, workout_id, exercise_id, reps, weight_kg, position,
               -- «не дотянул» ближе всего к нулевому запасу: сил не осталось
               CASE WHEN rir_missed = 1 THEN 0 ELSE rir END
        FROM sets;

        DROP TABLE sets;
        ALTER TABLE sets_new RENAME TO sets;

        CREATE INDEX idx_sets_workout  ON sets(workout_id);
        CREATE INDEX idx_sets_exercise ON sets(exercise_id);
        CREATE INDEX idx_sets_position ON sets(workout_id, exercise_id, position);

        CREATE VIEW set_times AS
        SELECT
            s.id AS set_id,
            MIN(i.started_at) AS started_at,
            MAX(i.ended_at)   AS ended_at,
            COALESCE(SUM(
                CASE WHEN i.ended_at IS NOT NULL
                     THEN MAX(0.0, (julianday(i.ended_at) - julianday(i.started_at)) * 86400.0)
                     ELSE 0 END
            ), 0) AS active_seconds,
            MAX(CASE WHEN i.id IS NOT NULL AND i.ended_at IS NULL THEN 1 ELSE 0 END)
                AS is_running
        FROM sets s
        LEFT JOIN set_intervals i ON i.set_id = s.id
        GROUP BY s.id;
        `);
      } finally {
        await db.execAsync('PRAGMA foreign_keys = ON');
      }
    }
    version = 13;
  }

  const hasEquipment = await hasColumn(db, 'exercises', 'equipment_id');
  if (version < 14 || !hasEquipment) {
    // Снаряжение — вторая половина тегов упражнения (первая, мышцы, уже
    // есть): «бицепс + штанга» ищется по любому из слов.
    //
    // Кроме поиска у снаряжения есть смысл в арифметике веса, и он
    // хранится прямо здесь, а не зашит в код по названиям:
    //   weight_factor   — на что умножить введённый вес. У пары гантелей
    //                     это 2: в подходе пишут вес ОДНОЙ, потому что
    //                     именно он написан на самой гантеле;
    //   adds_bodyweight — прибавлять ли вес тела. Подтягивания с блином
    //                     нагружают телом плюс блином, и вес тела берётся
    //                     из его же истории (таблица bodyweight).
    //
    // Пара и одна гантель — разные строки, а не флаг: на практике это
    // просто разные снаряды, и выбирать «гантель + галочку пара» дольше,
    // чем выбрать нужное из списка.
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS equipment (
          id              INTEGER PRIMARY KEY,
          name            TEXT NOT NULL UNIQUE,
          weight_factor   REAL    NOT NULL DEFAULT 1,
          adds_bodyweight INTEGER NOT NULL DEFAULT 0
              CHECK (adds_bodyweight IN (0, 1))
      );

      INSERT OR IGNORE INTO equipment (id, name, weight_factor, adds_bodyweight) VALUES
          (1, 'Barbell',            1, 0),
          (2, 'Dumbbells (pair)',   2, 0),
          (3, 'Dumbbell (single)',  1, 0),
          (4, 'Kettlebell',         1, 0),
          (5, 'Machine',            1, 0),
          (6, 'Cable',              1, 0),
          (7, 'Band',               1, 0),
          -- Отдельной строки «с довесом» нет: это то же самое снаряжение,
          -- просто в подходе вписан ещё и вес блина. Пустой вес и есть
          -- «только своим телом».
          (8, 'Bodyweight',         1, 1);
    `);
    if (!hasEquipment) {
      await db.execAsync(
        `ALTER TABLE exercises ADD COLUMN equipment_id INTEGER REFERENCES equipment(id)`
      );
    }
    version = 14;
  }

  // Штампуем версию, до которой реально догнали, а не LATEST_VERSION.
  // Разница видна ровно в одном, зато неприятном случае: LATEST_VERSION уже
  // подняли, а блок под него ещё не дописан (или дописан в другом файле и
  // не сохранён). Со старой безусловной записью база в этот момент получала
  // отметку о миграции, которой не было, и блок пропускался уже навсегда.
  await db.execAsync(`PRAGMA user_version = ${version}`);
}

const V1 = `
-- ---------- Справочники ----------

CREATE TABLE muscles (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE exercises (
    id                  INTEGER PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    description         TEXT,
    -- какой ввод показывать по умолчанию: 'reps' | 'hold'
    measurement_default TEXT NOT NULL DEFAULT 'reps'
        CHECK (measurement_default IN ('reps', 'hold')),
    -- 0 = встроенное (нельзя редактировать), 1 = созданное пользователем
    is_custom           INTEGER NOT NULL DEFAULT 1
);

-- Вклад мышцы в упражнение. share — доля от 1.0, сумма по упражнению = 1.0
CREATE TABLE exercise_muscles (
    exercise_id INTEGER NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
    muscle_id   INTEGER NOT NULL REFERENCES muscles(id)   ON DELETE CASCADE,
    share       REAL    NOT NULL CHECK (share > 0 AND share <= 1),
    PRIMARY KEY (exercise_id, muscle_id)
);

-- ---------- Шаблоны (планы тренировок) ----------

CREATE TABLE routines (
    id        INTEGER PRIMARY KEY,
    name      TEXT NOT NULL,
    is_custom INTEGER NOT NULL DEFAULT 1
);

-- У шаблона нет времени, поэтому порядок упражнений — это данные.
CREATE TABLE routine_exercises (
    routine_id  INTEGER NOT NULL REFERENCES routines(id)  ON DELETE CASCADE,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    position    INTEGER NOT NULL,
    PRIMARY KEY (routine_id, exercise_id)
);

-- ---------- Факт: тренировки, подходы, интервалы ----------

CREATE TABLE workouts (
    id         INTEGER PRIMARY KEY,
    routine_id INTEGER NOT NULL REFERENCES routines(id),
    started_at TEXT NOT NULL,   -- ISO-8601 UTC
    ended_at   TEXT             -- NULL = тренировка идёт
);

-- Подход НЕ хранит времена: они складываются из интервалов.
CREATE TABLE sets (
    id          INTEGER PRIMARY KEY,
    workout_id  INTEGER NOT NULL REFERENCES workouts(id)  ON DELETE CASCADE,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    reps        INTEGER,
    weight_kg   REAL
);

-- Обычно ровно один интервал на подход. Больше одного — если подход
-- поставили на паузу и продолжили.
CREATE TABLE set_intervals (
    id         INTEGER PRIMARY KEY,
    set_id     INTEGER NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    ended_at   TEXT             -- NULL = интервал идёт прямо сейчас
);

-- Пауза всей тренировки. Открытая строка (ended_at IS NULL) = тренировка на паузе.
CREATE TABLE workout_pauses (
    id         INTEGER PRIMARY KEY,
    workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    ended_at   TEXT
);

-- Заметка про ощущения: относится к паре (тренировка, упражнение).
CREATE TABLE workout_exercise_notes (
    workout_id  INTEGER NOT NULL REFERENCES workouts(id)  ON DELETE CASCADE,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    note        TEXT,
    PRIMARY KEY (workout_id, exercise_id)
);

-- ---------- Вес тела: история, а не настройка ----------

CREATE TABLE bodyweight (
    id          INTEGER PRIMARY KEY,
    measured_at TEXT NOT NULL,
    weight_kg   REAL NOT NULL
);

-- ---------- Индексы ----------

CREATE INDEX idx_sets_workout        ON sets(workout_id);
CREATE INDEX idx_sets_exercise       ON sets(exercise_id);
CREATE INDEX idx_intervals_set       ON set_intervals(set_id, started_at);
CREATE INDEX idx_pauses_workout      ON workout_pauses(workout_id);
CREATE INDEX idx_workouts_started    ON workouts(started_at);
CREATE INDEX idx_bodyweight_measured ON bodyweight(measured_at);

-- ---------- Производные времена ----------
-- Единственное место, где считается длительность подхода.

CREATE VIEW set_times AS
SELECT
    s.id AS set_id,
    MIN(i.started_at) AS started_at,
    MAX(i.ended_at)   AS ended_at,
    COALESCE(SUM(
        CASE WHEN i.ended_at IS NOT NULL
             THEN strftime('%s', i.ended_at) - strftime('%s', i.started_at)
             ELSE 0 END
    ), 0) AS active_seconds,
    MAX(CASE WHEN i.ended_at IS NULL THEN 1 ELSE 0 END) AS is_running
FROM sets s
LEFT JOIN set_intervals i ON i.set_id = s.id
GROUP BY s.id;

-- ---------- Базовые мышцы ----------

INSERT INTO muscles (name) VALUES
    ('Chest'), ('Lats'), ('Traps'), ('Rhomboids'), ('Lower back'),
    ('Front delts'), ('Side delts'), ('Rear delts'),
    ('Biceps'), ('Triceps'), ('Forearms'),
    ('Abs'), ('Obliques'),
    ('Glutes'), ('Quads'), ('Hamstrings'), ('Calves'), ('Adductors');
`;

const V3 = `
ALTER TABLE muscles ADD COLUMN body_group TEXT;

UPDATE muscles SET name = 'Грудь',           body_group = 'Грудь' WHERE name = 'Chest';
UPDATE muscles SET name = 'Широчайшие',      body_group = 'Спина' WHERE name = 'Lats';
UPDATE muscles SET name = 'Трапеции',        body_group = 'Спина' WHERE name = 'Traps';
UPDATE muscles SET name = 'Ромбовидные',     body_group = 'Спина' WHERE name = 'Rhomboids';
UPDATE muscles SET name = 'Поясница',        body_group = 'Спина' WHERE name = 'Lower back';
UPDATE muscles SET name = 'Передние дельты', body_group = 'Плечи' WHERE name = 'Front delts';
UPDATE muscles SET name = 'Средние дельты',  body_group = 'Плечи' WHERE name = 'Side delts';
UPDATE muscles SET name = 'Задние дельты',   body_group = 'Плечи' WHERE name = 'Rear delts';
UPDATE muscles SET name = 'Бицепс',          body_group = 'Руки'  WHERE name = 'Biceps';
UPDATE muscles SET name = 'Трицепс',         body_group = 'Руки'  WHERE name = 'Triceps';
UPDATE muscles SET name = 'Предплечья',      body_group = 'Руки'  WHERE name = 'Forearms';
UPDATE muscles SET name = 'Пресс',           body_group = 'Кор'   WHERE name = 'Abs';
UPDATE muscles SET name = 'Косые',           body_group = 'Кор'   WHERE name = 'Obliques';
UPDATE muscles SET name = 'Ягодицы',         body_group = 'Ноги'  WHERE name = 'Glutes';
UPDATE muscles SET name = 'Квадрицепс',      body_group = 'Ноги'  WHERE name = 'Quads';
UPDATE muscles SET name = 'Бицепс бедра',    body_group = 'Ноги'  WHERE name = 'Hamstrings';
UPDATE muscles SET name = 'Икры',            body_group = 'Ноги'  WHERE name = 'Calves';
UPDATE muscles SET name = 'Приводящие',      body_group = 'Ноги'  WHERE name = 'Adductors';

INSERT OR IGNORE INTO muscles (name, body_group) VALUES
    ('Верх груди',              'Грудь'),
    ('Низ груди',               'Грудь'),
    ('Передняя зубчатая',       'Грудь'),
    ('Круглые мышцы спины',     'Спина'),
    ('Подостная',               'Спина'),
    ('Разгибатели спины',       'Спина'),
    ('Ротаторная манжета',      'Плечи'),
    ('Шея',                     'Плечи'),
    ('Плечевая (брахиалис)',    'Руки'),
    ('Разгибатели запястья',    'Руки'),
    ('Сгибатели запястья',      'Руки'),
    ('Поперечная живота',       'Кор'),
    ('Сгибатели бедра',         'Кор'),
    ('Отводящие',               'Ноги'),
    ('Средняя ягодичная',       'Ноги'),
    ('Передняя большеберцовая', 'Ноги'),
    ('Камбаловидная',           'Ноги');

UPDATE muscles SET body_group = 'Прочее' WHERE body_group IS NULL;
`;

const V4 = `
-- Канонические названия мышц — английские. Перевод живёт в src/lib/i18n.ts,
-- чтобы не плодить колонки под каждый язык.

UPDATE muscles SET name = 'Chest',              body_group = 'Chest'     WHERE name = 'Грудь';
UPDATE muscles SET name = 'Upper chest',        body_group = 'Chest'     WHERE name = 'Верх груди';
UPDATE muscles SET name = 'Lower chest',        body_group = 'Chest'     WHERE name = 'Низ груди';
UPDATE muscles SET name = 'Serratus anterior',  body_group = 'Chest'     WHERE name = 'Передняя зубчатая';
UPDATE muscles SET name = 'Lats',               body_group = 'Back'      WHERE name = 'Широчайшие';
UPDATE muscles SET name = 'Traps',              body_group = 'Back'      WHERE name = 'Трапеции';
UPDATE muscles SET name = 'Rhomboids',          body_group = 'Back'      WHERE name = 'Ромбовидные';
UPDATE muscles SET name = 'Lower back',         body_group = 'Back'      WHERE name = 'Поясница';
UPDATE muscles SET name = 'Teres major',        body_group = 'Back'      WHERE name = 'Круглые мышцы спины';
UPDATE muscles SET name = 'Infraspinatus',      body_group = 'Back'      WHERE name = 'Подостная';
UPDATE muscles SET name = 'Erector spinae',     body_group = 'Back'      WHERE name = 'Разгибатели спины';
UPDATE muscles SET name = 'Front delts',        body_group = 'Shoulders' WHERE name = 'Передние дельты';
UPDATE muscles SET name = 'Side delts',         body_group = 'Shoulders' WHERE name = 'Средние дельты';
UPDATE muscles SET name = 'Rear delts',         body_group = 'Shoulders' WHERE name = 'Задние дельты';
UPDATE muscles SET name = 'Rotator cuff',       body_group = 'Shoulders' WHERE name = 'Ротаторная манжета';
UPDATE muscles SET name = 'Neck',               body_group = 'Shoulders' WHERE name = 'Шея';
UPDATE muscles SET name = 'Biceps',             body_group = 'Arms'      WHERE name = 'Бицепс';
UPDATE muscles SET name = 'Triceps',            body_group = 'Arms'      WHERE name = 'Трицепс';
UPDATE muscles SET name = 'Forearms',           body_group = 'Arms'      WHERE name = 'Предплечья';
UPDATE muscles SET name = 'Brachialis',         body_group = 'Arms'      WHERE name = 'Плечевая (брахиалис)';
UPDATE muscles SET name = 'Wrist extensors',    body_group = 'Arms'      WHERE name = 'Разгибатели запястья';
UPDATE muscles SET name = 'Wrist flexors',      body_group = 'Arms'      WHERE name = 'Сгибатели запястья';
UPDATE muscles SET name = 'Abs',                body_group = 'Core'      WHERE name = 'Пресс';
UPDATE muscles SET name = 'Obliques',           body_group = 'Core'      WHERE name = 'Косые';
UPDATE muscles SET name = 'Transverse abdominis', body_group = 'Core'    WHERE name = 'Поперечная живота';
UPDATE muscles SET name = 'Hip flexors',        body_group = 'Core'      WHERE name = 'Сгибатели бедра';
UPDATE muscles SET name = 'Glutes',             body_group = 'Legs'      WHERE name = 'Ягодицы';
UPDATE muscles SET name = 'Glute medius',       body_group = 'Legs'      WHERE name = 'Средняя ягодичная';
UPDATE muscles SET name = 'Quads',              body_group = 'Legs'      WHERE name = 'Квадрицепс';
UPDATE muscles SET name = 'Hamstrings',         body_group = 'Legs'      WHERE name = 'Бицепс бедра';
UPDATE muscles SET name = 'Calves',             body_group = 'Legs'      WHERE name = 'Икры';
UPDATE muscles SET name = 'Soleus',             body_group = 'Legs'      WHERE name = 'Камбаловидная';
UPDATE muscles SET name = 'Tibialis anterior',  body_group = 'Legs'      WHERE name = 'Передняя большеберцовая';
UPDATE muscles SET name = 'Adductors',          body_group = 'Legs'      WHERE name = 'Приводящие';
UPDATE muscles SET name = 'Abductors',          body_group = 'Legs'      WHERE name = 'Отводящие';

UPDATE muscles SET body_group = 'Other' WHERE body_group IS NULL OR body_group = 'Прочее';

-- Настройки приложения: язык и всё, что появится дальше.
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;
