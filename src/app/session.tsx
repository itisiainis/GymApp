import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { LiveTimer } from '../components/LiveTimer';
import { ExerciseForm } from '../components/ExerciseForm';
import { ExercisePicker } from '../components/ExercisePicker';
import { Collapsible } from '../components/Collapsible';
import { ReorderableList } from '../components/ReorderableList';
import { RirDrum } from '../components/RirDrum';
import { SwipeRow } from '../components/SwipeRow';
import { WorkoutRecap } from '../components/WorkoutRecap';
import {
  addSetDraft,
  cancelWorkoutClock,
  deleteSet,
  deleteWorkoutExercise,
  discardWorkout,
  endWorkout,
  getActiveWorkout,
  getWorkoutTotalSeconds,
  pauseWorkout,
  resumeWorkout,
  setExerciseNote,
  setExerciseSetOrder,
  setSetRir,
  startSet,
  startWorkoutClock,
  stopSet,
  recordSetSeconds,
  unrecordSet,
  updateSetValues,
  type ActiveWorkout,
} from '../db/queries';
import {
  addExerciseToWorkout,
  copyRoutineInto,
  copyWorkoutInto,
  createDraftWorkout,
  getExerciseNotes,
  getWorkoutSetsLive,
  listRecentWorkouts,
  listRoutines,
  refreshWorkoutName,
  setWorkoutExerciseOrder,
  type RecentWorkout,
  type Routine,
  type SetRowLive,
} from '../db/workout-session';
import { DEFAULT_RECORDING, getRecordingSettings, type RecordingSettings } from '../db/settings';
import { useT } from '../lib/i18n';
import { hasRir, rirOf } from '../lib/rir';
import { localizeWorkoutName } from '../lib/workoutName';
import { fmtMs, lastEndedAt, liveSeconds, restBySet, useNow } from '../lib/time';
import {
  HEADER_DONE,
  HEADER_DONE_PAUSED,
  HEADER_DONE_TEXT,
  HEADER_GREY,
  HEADER_GREY_TEXT,
  RED,
  RED_DARK,
  REST_BG,
  REST_HINT,
  REST_TEXT,
  REST_VALUE,
  SET_DONE_BG,
} from '../lib/theme';
import { setWorkoutActive } from '../lib/workoutLock';

/** Секунда на сворачивание: движение должно читаться, а не мигать. */
const COLLAPSE_MS = 1000;
/** Сколько закрытое упражнение ещё стоит открытым, прежде чем свернуться. */
const AUTO_COLLAPSE_DELAY_MS = 10_000;
/** Отсчёт перед стартом тренировки — время дойти до снаряда. */
const COUNTDOWN_SECONDS = 5;
/** Во время реордеринга сворачиваем быстрее — это техническая пауза, а не
 *  «упражнение закрыто», задерживать взгляд на ней незачем. */
const COLLAPSE_FAST_MS = 200;

/** Записан ли подход — единственное определение на весь экран. */
type Recorded = (s: SetRowLive) => boolean;

/** Все подходы записаны и ни один не идёт — упражнение можно считать закрытым. */
function isGroupDone(sets: SetRowLive[], recorded: Recorded): boolean {
  return sets.length > 0 && sets.every((s) => recorded(s) && s.is_running !== 1);
}

/**
 * Готово к авто-сворачиванию — то же самое, но с единственным подходом не
 * считается: обычно сначала записывают один подход, а потом дописывают
 * ещё, и сворачивать в этот момент рано - только мешает добавить следующий.
 */
function shouldAutoCollapse(sets: SetRowLive[], recorded: Recorded): boolean {
  return sets.length > 1 && isGroupDone(sets, recorded);
}

export default function Session() {
  const { t } = useT();

  const [workout, setWorkout] = useState<ActiveWorkout | null>(null);
  const [rows, setRows] = useState<SetRowLive[]>([]);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [routines, setRoutines] = useState<Routine[]>([]);

  // что предложить на пустом экране: чем занимались на этой неделе
  const [recent, setRecent] = useState<RecentWorkout[]>([]);

  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editExerciseId, setEditExerciseId] = useState<number | null>(null);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [recapId, setRecapId] = useState<number | null>(null);
  const [recapTotal, setRecapTotal] = useState(0);
  // прокрутка гасится, пока карточку тащат: иначе список едет вместе с ней
  const [dragging, setDragging] = useState(false);
  // отдельно от dragging: перетаскивание ПОДХОДОВ внутри упражнения не
  // должно сворачивать все карточки, как это делает драг упражнений -
  // тогда были бы не видны сами подходы, которые тащишь
  const [setsDragging, setSetsDragging] = useState(false);
  // высота нижней панели: облако вешается над ней, а процентами это не
  // выразить — у панели высота auto, и bottom: '100%' не резолвится
  const [barHeight, setBarHeight] = useState(0);
  const [rec, setRec] = useState<RecordingSettings>(DEFAULT_RECORDING);

  const running = rows.find((r) => r.is_running === 1) ?? null;
  const paused = workout?.is_paused === 1;

  /*
   * Три состояния одного экрана, а не три экрана.
   *
   * Тренировка сначала собирается (черновик: began_at ещё нет), потом
   * запускается. Отдельного экрана выбора и отдельного экрана «состав
   * перед стартом» больше нет: состав виден там же, где потом идёт
   * работа, и добавление упражнения ничего никуда не перекидывает.
   */
  const beganAt = workout?.began_at ?? null;
  /** Часы запущены — но, возможно, ещё идёт отсчёт перед стартом. */
  const clockSet = beganAt !== null;
  const beganMs = beganAt === null ? 0 : Date.parse(beganAt);

  /**
   * Запирает экран только ИДУЩИЙ подход: пока таймер тикает, править веса и
   * переставлять карточки нечего — это тот подход, который прямо сейчас
   * делают.
   *
   * Пауза сюда больше не входит. Раньше она запирала всё то же самое, и на
   * паузе нельзя было ни добавить упражнение, ни поправить вес — а пауза как
   * раз для этого и нужна. Теперь она меняет только фон.
   */
  const locked = running !== null;
  /** Красная заливка — и на идущем подходе, и на паузе. */
  const redBackground = running !== null || paused;

  /**
   * Чем засчитывается подход. Холды меряются временем всегда, повторы —
   * только если включён секундомер; иначе повторы засчитывает RIR.
   */
  const isTimed = useCallback(
    (s: SetRowLive) => rec.advancedReps || s.measurement_default === 'hold',
    [rec.advancedReps]
  );

  /**
   * Записан ли подход. У подхода с секундомером это время, у подхода на
   * повторы — проставленный RIR. Одно определение на весь экран: по нему
   * считаются и «незаписанные» для кнопки Finish, и готовность упражнения
   * к сворачиванию, и подсветка при «Finish anyway». Разъедься они — и
   * карточка сворачивалась бы как готовая, пока Finish пересчитывает её
   * подходы в незаписанные.
   */
  const recorded = useCallback(
    (s: SetRowLive) => (isTimed(s) ? s.started_at !== null : hasRir(s)),
    [isTimed]
  );

  const unrecorded = rows.filter((s) => !recorded(s)).length;

  // во время перетаскивания тикающий таймер перерисовывал бы весь список
  const now = useNow(workout !== null && !dragging);

  /** Отсчёт перед стартом ещё идёт: began_at стоит в будущем. */
  const counting = clockSet && beganMs > now;
  /** Тренировка идёт по-настоящему: отсчёт позади. */
  const live = clockSet && !counting;

  /**
   * Момент окончания отсчёта надо поймать точно, а общий тик идёт раз в
   * полсекунды — на глаз это заметная задержка смены подписей на кнопках.
   * Отдельный таймер ровно на остаток отсчёта перерисовывает экран в тот
   * самый момент.
   */
  const [, setCountdownTick] = useState(0);
  useEffect(() => {
    if (!counting) return;
    const id = setTimeout(() => setCountdownTick((n) => n + 1), Math.max(0, beganMs - Date.now()));
    return () => clearTimeout(id);
  }, [counting, beganMs]);

  // Отдых, который уже сложился между записанными подходами: подписывается
  // к каждому из них и дальше не меняется.
  const restBefore = restBySet(rows);
  /**
   * Идущий отдых: время с конца последнего записанного подхода. Пока подход
   * идёт, отдыха нет — там тикает свой таймер, и два счётчика рядом сбивали
   * бы с толку. На паузе отдых считается: пауза — это тоже отдых, просто
   * объявленный.
   */
  const lastEnd = lastEndedAt(rows);
  const restSince = running === null ? lastEnd : null;

  // Каждый await рвёт автобатчинг React 18 - если звать setState между
  // ними, экран перерисовывался бы отдельно на каждый запрос к базе, и
  // нижняя панель на мгновение показывала бы промежуточное состояние
  // (это и читалось как мигание, например при добавлении упражнения).
  // Поэтому сначала дочитываем всё нужное в переменные, а стейт выставляем
  // одним синхронным проходом - React соберёт его в один рендер.
  /**
   * Значения, набранные прямо сейчас, — до того как они доедут до базы и
   * вернутся в rows. Нужны «Добавить подход»: он копирует повторы и вес с
   * предыдущего подхода, и копировать надо именно набранное, а не то, что
   * успело сохраниться. Ref, а не состояние: перерисовка здесь не нужна и
   * сбила бы каретку в поле, из которого сейчас печатают.
   */
  const typed = useRef<Record<number, { reps?: number | null; weightKg?: number | null }>>({});

  const onTyped = useCallback(
    (setId: number, patch: { reps?: number | null; weightKg?: number | null }) => {
      typed.current[setId] = { ...typed.current[setId], ...patch };
      updateSetValues(setId, patch);
    },
    []
  );

  /** Значения подхода с учётом того, что в него как раз печатают. */
  const currentValues = (s: SetRowLive) => ({
    reps: typed.current[s.id]?.reps ?? s.reps,
    weightKg: typed.current[s.id]?.weightKg ?? s.weight_kg,
  });

  const refresh = useCallback(async () => {
    const w = await getActiveWorkout();
    if (!w) {
      // Предлагать что-то есть смысл только на пустом экране, поэтому
      // подсказки грузятся здесь, а не вместе с тренировкой.
      const [routineList, recentList] = await Promise.all([
        listRoutines(),
        listRecentWorkouts(),
      ]);
      setWorkout(null);
      setRows([]);
      setNotes({});
      setRoutines(routineList);
      setRecent(recentList);
      return;
    }
    const [recSettings, liveRows, exerciseNotes, routineList, recentList] = await Promise.all([
      getRecordingSettings(),
      getWorkoutSetsLive(w.id),
      getExerciseNotes(w.id),
      listRoutines(),
      listRecentWorkouts(),
    ]);
    // Набранное, но ещё не доехавшее до базы, держим только для живых
    // подходов: SQLite переиспользует id удалённых строк, и оставленная
    // запись однажды подставила бы чужие цифры в новый подход.
    const alive = new Set(liveRows.map((r) => r.id));
    for (const key of Object.keys(typed.current)) {
      if (!alive.has(Number(key))) delete typed.current[Number(key)];
    }

    setWorkout(w);
    setRec(recSettings);
    setRows(liveRows);
    setNotes(exerciseNotes);
    setRoutines(routineList);
    setRecent(recentList);
  }, []);

  /**
   * Черновик заводится по первому действию, а не при заходе на вкладку:
   * иначе каждое открытие «Тренировки» оставляло бы за собой пустую.
   */
  const ensureDraft = useCallback(
    async (routineId: number | null = null): Promise<number> => {
      if (workout) return workout.id;
      return createDraftWorkout(routineId);
    },
    [workout]
  );

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );

  /*
   * Общее время больше не спрашивается у базы на каждый тик: оно
   * складывается из began_at и слагаемых паузы, которые пришли вместе с
   * тренировкой. С миллисекундами прежний способ означал бы поход в базу
   * на каждый показанный знак.
   */

  // Свайп между вкладками (_layout.tsx) выключаем на время тренировки:
  // иначе он конфликтует со свайпами удаления сета/упражнения на этом же
  // экране. Сбрасываем и при уходе с экрана - иначе флаг остался бы
  // включённым навсегда, если тренировку закончили не через Finish
  // (например, свернули приложение).
  const hasWorkout = workout !== null;
  useEffect(() => {
    setWorkoutActive(hasWorkout);
    return () => setWorkoutActive(false);
  }, [hasWorkout]);

  // Отметил подход — предупреждение о незаписанных больше не про текущее
  // состояние: и его число, и «Finish anyway» устарели. Возвращаем спокойный
  // вид. Считаем по любому изменению: добавленный подход тоже делает
  // прежнее предупреждение неверным.
  const prevUnrecorded = useRef(unrecorded);
  useEffect(() => {
    if (prevUnrecorded.current === unrecorded) return;
    prevUnrecorded.current = unrecorded;
    setConfirmFinish(false);
  }, [unrecorded]);

  /**
   * Сворачивание — сам флаг только фиксирует, что пользователь тронул
   * карточку руками. Показываем ли её свёрнутой на самом деле — решает
   * displayCollapsed ниже: пока пользователь не вмешался явно, это
   * вычисляется заново на каждый рендер из «все подходы готовы?».
   *
   * Раньше «авто-сворачивание, когда всё готово» и «авто-раскрытие при
   * снятой отметке» были отдельным эффектом, который вручную отслеживал,
   * что сам свернул, а что нет, через ref-множество. Это заводило два
   * источника правды (collapsed и autoCollapsed) и легко расходилось —
   * например, после реордеринга, который тоже трогает collapsed. Здесь же
   * то, что не задано явно, всегда пересчитывается из текущего состояния
   * подходов, разъехаться нечему.
   */
  const toggleCollapsed = (exerciseId: number, next: boolean) => {
    setCollapsed((c) => ({ ...c, [exerciseId]: next }));
  };

  /**
   * "manual" в collapsed держится, пока его не тронут заново — а тронуть
   * его могли ещё ДО того, как упражнение стало готовым (раскрыл, чтобы
   * поправить вес перед подходом). После этого override навсегда
   * перекрывал бы allDone, и авто-сворачивание переставало бы работать
   * для любого упражнения, которое хоть раз открывали руками. Поэтому
   * снимаем override именно в момент перехода в «готово» — раскрытие уже
   * ПОСЛЕ этого момента (например, чтобы что-то поправить в готовом
   * упражнении) остаётся раскрытием и повторно не схлопывается.
   */
  const wasDoneRef = useRef<Record<number, boolean>>({});
  useEffect(() => {
    const byExercise = new Map<number, SetRowLive[]>();
    for (const row of rows) {
      const arr = byExercise.get(row.exercise_id);
      if (arr) arr.push(row);
      else byExercise.set(row.exercise_id, [row]);
    }
    const wasDone = wasDoneRef.current;
    const nowDone: Record<number, boolean> = {};
    const justFinished: number[] = [];
    byExercise.forEach((sets, exerciseId) => {
      const done = shouldAutoCollapse(sets, recorded);
      nowDone[exerciseId] = done;
      if (done && !wasDone[exerciseId]) justFinished.push(exerciseId);
    });
    wasDoneRef.current = nowDone;

    if (justFinished.length === 0) return;
    // Не сразу: закрытое упражнение ещё десять секунд остаётся открытым.
    // Записал последний подход — и обычно тут же смотришь, что получилось,
    // или правишь опечатку в весе; мгновенно схлопнувшаяся карточка это
    // отнимала, и её приходилось открывать обратно руками.
    const id = setTimeout(() => {
      setCollapsed((c) => {
        const next = { ...c };
        for (const exerciseId of justFinished) {
          // за эти секунды подход могли раззаписать — тогда сворачивать
          // уже нечего, упражнение снова в работе
          if (wasDoneRef.current[exerciseId]) delete next[exerciseId];
        }
        return next;
      });
    }, AUTO_COLLAPSE_DELAY_MS);
    return () => clearTimeout(id);
  }, [rows, recorded]);

  /**
   * Показывать ли карточку свёрнутой. dragging — то, что видно прямо
   * сейчас, пока идёт перетаскивание; наружу (в collapsed) он не
   * записывается, поэтому по окончании драга ничего не нужно
   * восстанавливать — оно и не менялось.
   */
  const displayCollapsed = (exerciseId: number, allDone: boolean): boolean => {
    if (dragging) return true;
    const manual = collapsed[exerciseId];
    return manual ?? allDone;
  };

  /** Повторить тренировку недельной давности — прямо здесь, без перехода. */
  const useRecentWorkout = async (sourceId: number) => {
    const id = await ensureDraft();
    await copyWorkoutInto(id, sourceId);
    // добавленные упражнения показываем раскрытыми: их состав как раз и
    // надо посмотреть, прежде чем начинать
    setCollapsed({});
    await refresh();
  };

  /** То же самое из шаблона: он тоже просто раскладывает упражнения. */
  const useRoutine = async (routineId: number) => {
    const id = await ensureDraft(routineId);
    // ensureDraft создаёт черновик уже с составом шаблона, а вот если
    // черновик был — состав надо доложить
    if (workout) await copyRoutineInto(id, routineId);
    setCollapsed({});
    await refresh();
  };

  /**
   * Запуск: время ставится сразу, но на пять секунд вперёд. Эти пять
   * секунд — обычный отсчёт по часам, а не таймер внутри приложения,
   * поэтому свернуть приложение на них можно без последствий.
   */
  const startClock = async () => {
    if (!workout) return;
    await startWorkoutClock(workout.id, COUNTDOWN_SECONDS);
    await refresh();
  };

  /**
   * «Go back». До запуска — выбросить собранное; во время отсчёта —
   * отменить запуск, вернувшись к сборке. Кнопка одна и подписана
   * одинаково, потому что и делает одно и то же: шаг назад.
   */
  const goBack = async () => {
    if (!workout) return;
    if (counting) {
      await cancelWorkoutClock(workout.id);
    } else {
      await discardWorkout(workout.id);
    }
    setCollapsed({});
    setConfirmFinish(false);
    await refresh();
  };

  const togglePause = async () => {
    if (!workout) return;
    if (paused) await resumeWorkout(workout.id);
    else await pauseWorkout(workout.id);
    await refresh();
  };

  const finishWorkout = async () => {
    if (!workout) return;
    if (unrecorded > 0 && !confirmFinish) {
      setConfirmFinish(true);
      // раскрываем упражнения с невыполненными сетами, если их свернули
      // руками - иначе пульсацию просто не видно
      const withUnrecorded = new Set(
        rows.filter((s) => !recorded(s)).map((s) => s.exercise_id)
      );
      setCollapsed((c) => {
        const next = { ...c };
        for (const id of withUnrecorded) next[id] = false;
        return next;
      });
      return;
    }
    const id = workout.id;
    const secs = await getWorkoutTotalSeconds(id);
    await endWorkout(id);
    setConfirmFinish(false);
    setRecapTotal(secs);
    setRecapId(id);
    await refresh();
  };

  /**
   * Плавный переход «собираем» → «идёт»: за те же пять секунд, что идёт
   * отсчёт, проявляется таймер и зелёная кнопка становится красной.
   *
   * Значение восстанавливается из began_at, а не копится с нуля: вернулся
   * в приложение на третьей секунде отсчёта — увидишь цвет и таймер
   * такими, какими они должны быть к этому моменту, а не начало анимации.
   */
  const startAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!clockSet) {
      startAnim.setValue(0);
      return;
    }
    const total = COUNTDOWN_SECONDS * 1000;
    const left = Math.max(0, beganMs - Date.now());
    startAnim.setValue(Math.min(1, Math.max(0, 1 - left / total)));
    if (left === 0) return;
    const anim = Animated.timing(startAnim, {
      toValue: 1,
      duration: left,
      easing: Easing.linear,
      // цвет нативным драйвером не прогнать
      useNativeDriver: false,
    });
    anim.start();
    return () => anim.stop();
  }, [clockSet, beganMs, startAnim]);

  const primaryColor = startAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['#3aa655', RED_DARK],
  });

  /*
   * Один экран на все состояния: пустой, собранный черновик, отсчёт и
   * идущая тренировка отличаются только содержимым списка и нижними
   * кнопками. Отдельных экранов выбора и предпросмотра больше нет —
   * состав виден там же, где потом идёт работа.
   */
  const groups: { exerciseId: number; name: string; sets: SetRowLive[] }[] = [];
  for (const row of rows) {
    let g = groups.find((x) => x.exerciseId === row.exercise_id);
    if (!g) {
      g = { exerciseId: row.exercise_id, name: row.exercise_name, sets: [] };
      groups.push(g);
    }
    g.sets.push(row);
  }

  const body = (
    <View style={{ flex: 1, backgroundColor: redBackground ? RED : '#fff' }}>
      <ScrollView
        style={{ flex: 1 }}
        scrollEnabled={!dragging && !setsDragging}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 12, paddingTop: 48 }}
      >
        {/* Имя тренировки, собранной с нуля, пересобирается по мере
            добавления упражнений — показываем его здесь, иначе увидеть
            его можно было бы только потом, в истории. */}
        <Text
          style={{
            fontSize: 20,
            fontWeight: '700',
            paddingHorizontal: 2,
            paddingBottom: 10,
            color: workout?.title ? '#000' : '#aaa',
          }}
        >
          {localizeWorkoutName(workout?.title ?? null, t) ?? t('Workout')}
        </Text>

        <ReorderableList
          items={groups}
          keyOf={(g) => g.exerciseId}
          onDraggingChange={setDragging}
          onReorder={async (next) => {
            setRows((prev) => {
              const order = next.map((g) => g.exerciseId);
              return [...prev].sort(
                (a, b) =>
                  order.indexOf(a.exercise_id) - order.indexOf(b.exercise_id) ||
                  a.id - b.id
              );
            });
            await setWorkoutExerciseOrder(
              workout!.id,
              next.map((g) => g.exerciseId)
            );
          }}
          renderItem={(g, _i, isBeingDragged, startDrag) => {
          const hasRunning = g.sets.some((s) => s.is_running === 1);
          const allDone = isGroupDone(g.sets, recorded);
          const isCollapsed = displayCollapsed(
            g.exerciseId,
            shouldAutoCollapse(g.sets, recorded)
          );
          const headerText = allDone ? HEADER_DONE_TEXT : HEADER_GREY_TEXT;

          return (
            <View
              style={{
                marginBottom: 10,
                backgroundColor: isBeingDragged
                  ? '#e2eef7'
                  : locked && !hasRunning
                    ? '#00000010'
                    : '#00000008',
                borderRadius: 10,
                padding: 10,
              }}
            >
              {/* Свайп висит на строке названия, а не на всей карточке:
                  иначе он оказывался снаружи свайпов подходов, ловил их жест
                  и удалял упражнение целиком вместо одного подхода. */}
              <SwipeRow
                disabled={locked}
                onDelete={async () => {
                  await deleteWorkoutExercise(workout!.id, g.exerciseId);
                  // имя собрано по мышцам упражнений — с уходом упражнения
                  // оно может стать другим
                  await refreshWorkoutName(workout!.id);
                  refresh();
                }}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: allDone
                      ? paused
                        ? HEADER_DONE_PAUSED
                        : HEADER_DONE
                      : HEADER_GREY,
                    borderRadius: 8,
                    paddingLeft: 10,
                    paddingRight: 4,
                  }}
                >
                  <Pressable
                    // dragging — не только эта карточка: пока тащат любую,
                    // остальные тоже временно не реагируют на тап.
                    disabled={locked || dragging}
                    onPress={() => toggleCollapsed(g.exerciseId, !isCollapsed)}
                    // Зажал имя — карточка едет за пальцем прямо здесь,
                    // без отдельного экрана со списком.
                    onLongPress={() => {
                      if (groups.length > 1) startDrag();
                    }}
                    delayLongPress={280}
                    style={{ flex: 1, paddingVertical: 10 }}
                  >
                    <Text style={{ fontSize: 18, fontWeight: '600', color: headerText }}>
                      {isCollapsed ? '▾' : '▴'} {g.name}
                    </Text>
                  </Pressable>

                  <Pressable
                    disabled={locked}
                    onPress={() => setEditExerciseId(g.exerciseId)}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 10,
                      opacity: locked ? 0.3 : 1,
                    }}
                  >
                    <Text style={{ color: headerText, fontWeight: '600' }}>{t('Edit')}</Text>
                  </Pressable>
                </View>
              </SwipeRow>

              {/* Во время перетаскивания сворачивание быстрое: это не
                  «упражнение закрыто», а просто временно убрано с глаз,
                  чтобы видеть порядок карточек. */}
              <Collapsible
                collapsed={isCollapsed}
                duration={dragging ? COLLAPSE_FAST_MS : COLLAPSE_MS}
              >
                  <View style={{ gap: 6, marginTop: 8 }}>
                    <ReorderableList
                      items={g.sets}
                      keyOf={(s) => s.id}
                      onDraggingChange={setSetsDragging}
                      onReorder={async (nextSets) => {
                        const order = nextSets.map((s) => s.id);
                        // те же id, что уже были в rows, просто внутри
                        // одного упражнения переставлены; остальные строки
                        // не трогаем - sort с компаратором "0" стабилен
                        // (гарантия ES2019, Hermes её соблюдает)
                        setRows((prev) =>
                          [...prev].sort((a, b) => {
                            if (
                              a.exercise_id !== g.exerciseId ||
                              b.exercise_id !== g.exerciseId
                            ) {
                              return 0;
                            }
                            return order.indexOf(a.id) - order.indexOf(b.id);
                          })
                        );
                        await setExerciseSetOrder(workout!.id, g.exerciseId, order);
                      }}
                      renderItem={(s, _i, isSetBeingDragged, startSetDrag) => (
                        <View>
                          {/* Сколько отдыхали перед этим подходом. Стоит над
                              ним, а не под предыдущим: отдых — это то, с чем
                              подход подошёл к штанге, и читается он вместе
                              со строкой, к которой относится. */}
                          {restBefore[s.id] !== undefined && (
                            <Text
                              style={{
                                fontSize: 11,
                                color: REST_HINT,
                                paddingLeft: 14,
                                paddingBottom: 2,
                              }}
                            >
                              ⏱ {t('rest')} {fmtMs(restBefore[s.id])}
                            </Text>
                          )}

                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                            {/* Отдельная зона для драга: сама строка подхода
                                почти целиком из полей ввода, зажать точно
                                на них не выйдет - а тут выделенная ручка. */}
                            <Pressable
                              disabled={locked || s.is_running === 1 || g.sets.length < 2}
                              onLongPress={startSetDrag}
                              delayLongPress={200}
                              hitSlop={8}
                              style={{
                                paddingHorizontal: 4,
                                opacity: locked || s.is_running === 1 ? 0.2 : 1,
                              }}
                            >
                              <Text style={{ color: '#bbb', fontSize: 16 }}>≡</Text>
                            </Pressable>

                            <View
                              style={{
                                flex: 1,
                                backgroundColor: isSetBeingDragged ? '#e2eef7' : 'transparent',
                                borderRadius: 6,
                              }}
                            >
                              <SwipeRow
                                disabled={locked || s.is_running === 1}
                                onDelete={async () => {
                                  await deleteSet(s.id);
                                  refresh();
                                }}
                              >
                                <SetLine
                                  row={s}
                                  locked={locked && s.is_running !== 1}
                                  timed={isTimed(s)}
                                  seconds={liveSeconds(s.active_seconds, s.running_since, now)}
                                  onChanged={refresh}
                                  onTyped={onTyped}
                                  // при «Finish anyway» показываем, каких
                                  // именно подходов не хватает
                                  flagged={confirmFinish && !recorded(s)}
                                />
                              </SwipeRow>

                              {/* Барабан снаружи SwipeRow, отдельной строкой:
                                  оба жеста горизонтальные, и вложенные они
                                  дерутся друг с другом — свайп по барабану
                                  уезжал бы в удаление подхода. */}
                              {!isTimed(s) && (
                                <View style={{ paddingTop: 2, paddingBottom: 2 }}>
                                  <RirDrum
                                    value={rirOf(s)}
                                    disabled={locked}
                                    onChange={async (next) => {
                                      await setSetRir(s.id, next);
                                      refresh();
                                    }}
                                  />
                                </View>
                              )}
                            </View>
                          </View>
                        </View>
                      )}
                    />

                    <Pressable
                      disabled={locked}
                      onPress={async () => {
                        // Копируем значения предыдущего подхода вместе с
                        // тем, что в него печатают прямо сейчас: обычно
                        // новый подход добавляют сразу после того, как
                        // вписали повторы в предыдущий, и заставлять
                        // сначала «закрыть» поле незачем. Фокус при этом
                        // не сбивается — за это отвечает
                        // keyboardShouldPersistTaps у списка.
                        const last = g.sets[g.sets.length - 1];
                        const from = last
                          ? currentValues(last)
                          : { reps: null, weightKg: null };
                        await addSetDraft(
                          workout!.id,
                          g.exerciseId,
                          from.reps,
                          from.weightKg
                        );
                        refresh();
                      }}
                      style={{ paddingVertical: 8, opacity: locked ? 0.3 : 1 }}
                    >
                      <Text style={{ fontWeight: '600' }}>{t('Add set +')}</Text>
                    </Pressable>

                    <TextInput
                      editable={!locked}
                      placeholder={t('Pain or sensations during the sets')}
                      defaultValue={notes[g.exerciseId] ?? ''}
                      onEndEditing={(e) =>
                        setExerciseNote(workout!.id, g.exerciseId, e.nativeEvent.text)
                      }
                      style={{
                        backgroundColor: '#0000000a',
                        borderRadius: 6,
                        padding: 8,
                        fontSize: 13,
                      }}
                    />
                  </View>
              </Collapsible>
            </View>
          );
          }}
        />

        {running !== null &&
          liveSeconds(running.active_seconds, running.running_since, now) > 300 && (
            <Text
              style={{
                color: RED_DARK,
                fontWeight: '600',
                textAlign: 'center',
                paddingVertical: 8,
              }}
            >
              {t('Set is still running')}
            </Text>
          )}

        <Pressable
          disabled={locked}
          onPress={() => setPickerOpen(true)}
          style={{
            paddingVertical: 14,
            alignItems: 'center',
            opacity: locked ? 0.3 : 1,
          }}
        >
          <Text style={{ fontSize: 16, fontWeight: '600' }}>{t('Add exercise +')}</Text>
        </Pressable>

        {groups.length > 1 && !locked && (
          <Text
            style={{
              color: '#999',
              fontSize: 12,
              textAlign: 'center',
              paddingVertical: 6,
            }}
          >
            {t('Hold an exercise name to reorder')}
          </Text>
        )}

        {/* Подсказки — только пока в тренировке пусто. Как только состав
            начали собирать, они перестают быть предложением и становятся
            помехой: список упражнений уже есть, и он тут главный. */}
        {groups.length === 0 && (
          <View style={{ gap: 8, paddingTop: 4 }}>
            {recent.length > 0 && (
              <>
                <Text style={{ fontWeight: '700', fontSize: 15, textAlign: 'center' }}>
                  {t('Or copy a previous workout')}
                </Text>
                {recent.map((w) => (
                  <Pressable
                    key={w.id}
                    onPress={() => useRecentWorkout(w.id)}
                    style={{
                      padding: 12,
                      backgroundColor: '#00000010',
                      borderRadius: 10,
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Text style={{ flex: 1, fontSize: 16, fontWeight: '600' }}>
                        {localizeWorkoutName(w.title, t) ?? t('Workout')}
                      </Text>
                      <Text style={{ color: '#666', fontSize: 13 }}>
                        {new Date(w.started_at).toLocaleDateString()}
                      </Text>
                    </View>
                    {!!w.exercises && (
                      <Text style={{ color: '#777', fontSize: 12, marginTop: 2 }}>
                        {w.exercises}
                      </Text>
                    )}
                  </Pressable>
                ))}
              </>
            )}

            {routines.length > 0 && (
              <>
                <Text
                  style={{
                    fontWeight: '600',
                    fontSize: 14,
                    textAlign: 'center',
                    marginTop: 8,
                    color: '#666',
                  }}
                >
                  {t('Or start from a template')}
                </Text>
                {routines.map((r) => (
                  <Pressable
                    key={r.id}
                    onPress={() => useRoutine(r.id)}
                    style={{ padding: 12, backgroundColor: '#00000008', borderRadius: 10 }}
                  >
                    <Text style={{ fontSize: 15, fontWeight: '600' }}>{r.name}</Text>
                    <Text style={{ color: '#888', fontSize: 12 }}>
                      {t('Exercises')}: {r.exercise_count}
                    </Text>
                  </Pressable>
                ))}
              </>
            )}
          </View>
        )}
      </ScrollView>

      {/* insets.bottom здесь не нужен: панель стоит над таббаром, а он уже
          учитывает системный отступ — вдвоём они давали пустую полосу. */}
      {confirmFinish && (
        <Cloud
          text={`${t('Unrecorded sets')}: ${unrecorded}`}
          bottom={barHeight + 8}
        />
      )}

      {/* Полоса отдыха и панель меряются вместе: облако с предупреждением
          висит над ними обеими, и по высоте одной панели оно наезжало бы
          на отдых. */}
      <View onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)}>
        {restSince !== null && (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'baseline',
              justifyContent: 'center',
              gap: 8,
              paddingVertical: 6,
              backgroundColor: REST_BG,
              borderTopWidth: 1,
              borderTopColor: '#00000010',
            }}
          >
            <Text style={{ color: REST_TEXT, fontSize: 13, fontWeight: '600' }}>
              {t('Rest')}
            </Text>
            <LiveTimer
              since={restSince}
              style={{ color: REST_VALUE, fontSize: 22, fontWeight: '700' }}
            />
          </View>
        )}

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            padding: 12,
            borderTopWidth: 1,
            borderTopColor: '#00000015',
            backgroundColor: '#fff',
          }}
        >
          {/* Таймер проявляется за те же пять секунд, что идёт отсчёт:
              до старта показывать нечего, а появиться разом в момент
              старта — значит мигнуть. Пока идёт отсчёт, он показывает
              время до начала со знаком минус. */}
          {/* Подпись над значением, а не рядом: с миллисекундами строка
              времени стала заметно длиннее, и в одну строку с ней подпись
              съедала бы ширину у кнопок. */}
          <Animated.View style={{ flex: 2, opacity: startAnim }}>
            <Text style={{ fontSize: 11, color: '#888' }} numberOfLines={1}>
              {t('Total')}
            </Text>
            <LiveTimer
              since={beganAt}
              base={-(workout?.paused_seconds ?? 0)}
              until={workout?.paused_since ?? null}
              signed
              style={{ fontSize: 15, fontWeight: '700' }}
            />
          </Animated.View>

          {/* Слева — то, что запускает и завершает: одна и та же кнопка,
              которая за время отсчёта перекрашивается из зелёной в
              красную. Подпись при этом не меняется до самого конца
              отсчёта: пока идут пять секунд, отменить старт ещё можно,
              и «Finish» на кнопке был бы обещанием другого действия. */}
          <Animated.View style={{ flex: 3, borderRadius: 8, overflow: 'hidden', backgroundColor: primaryColor }}>
            <Pressable
              disabled={locked || (!clockSet && groups.length === 0)}
              onPress={live ? finishWorkout : startClock}
              style={{
                paddingVertical: 14,
                alignItems: 'center',
                // до старта кнопка приглушена, пока в тренировке пусто:
                // начинать нечего
                opacity: locked || (!clockSet && groups.length === 0) ? 0.4 : 1,
              }}
            >
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 16 }}>
                {!live
                  ? t("Let's start")
                  : confirmFinish
                    ? t('Finish anyway')
                    : t('Finish')}
              </Text>
            </Pressable>
          </Animated.View>

          {/* Справа — серая кнопка: сначала выход из сборки, потом пауза.
              Синей она становится только когда на паузе, то есть когда
              нажата: цвет тут показывает состояние, а не приглашение. */}
          <Pressable
            disabled={locked}
            onPress={live ? togglePause : goBack}
            style={{
              flex: 2,
              paddingVertical: 14,
              alignItems: 'center',
              backgroundColor: paused ? '#4aa3df' : '#eee',
              borderRadius: 8,
              opacity: locked ? 0.4 : 1,
            }}
          >
            <Text
              style={{
                color: paused ? '#fff' : '#333',
                fontWeight: '600',
                fontSize: 16,
              }}
            >
              {!live ? t('Go back') : paused ? t('Resume') : t('Pause')}
            </Text>
          </Pressable>
        </View>
      </View>

      <ExercisePicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={async (exerciseId) => {
          // Первое добавленное упражнение и заводит черновик: до этого
          // момента тренировки в базе нет вовсе.
          const id = await ensureDraft();
          // упражнение приходит со своей заготовкой подходов из прошлого
          // исполнения и пересчитывает имя тренировки
          await addExerciseToWorkout(id, exerciseId);
          // без await шторка закрывалась бы до того, как экран под ней
          // обновится, - см. комментарий в ExercisePicker.confirm
          await refresh();
        }}
      />

      <ExerciseForm
        visible={editExerciseId !== null}
        exerciseId={editExerciseId}
        onClose={() => setEditExerciseId(null)}
        onSaved={() => {
          setEditExerciseId(null);
          refresh();
        }}
      />
    </View>
  );

  // WorkoutRecap стоит снаружи body: он должен пережить смену состояния
  // экрана, иначе финальный отчёт всплывал бы только когда начнётся
  // следующая тренировка, а не сразу после этой.
  return (
    <>
      {body}
      <WorkoutRecap
        workoutId={recapId}
        totalSeconds={recapTotal}
        onClose={() => setRecapId(null)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Всплывающее облако над нижней панелью                               */
/* ------------------------------------------------------------------ */

/**
 * Предупреждение висит над панелью, а не занимает строку под ней:
 * оно появляется редко, и постоянное место под него оставлять незачем.
 */
function Cloud({ text, bottom }: { text: string; bottom: number }) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [anim]);

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        // отсчёт от низа экрана: панель уже измерена, проценты не годятся
        bottom,
        right: 12,
        zIndex: 20,
        opacity: anim,
        transform: [
          { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) },
        ],
      }}
    >
      <View
        style={{
          backgroundColor: RED_DARK,
          borderRadius: 12,
          paddingHorizontal: 12,
          paddingVertical: 8,
          elevation: 4,
          shadowColor: '#000',
          shadowOpacity: 0.2,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 2 },
        }}
      >
        <Text style={{ color: '#fff', fontWeight: '600' }}>{text}</Text>
      </View>
    </Animated.View>
  );
}

/* ------------------------------------------------------------------ */
/* Строка подхода                                                      */
/* ------------------------------------------------------------------ */

/** Пустое поле — это «стереть значение», а не ноль. */
function parseField(text: string): number | null {
  const v = text.trim();
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function SetLine({
  row,
  locked,
  timed,
  seconds,
  onChanged,
  onTyped,
  flagged,
}: {
  row: SetRowLive;
  locked: boolean;
  /** Мерить время подхода или просто отмечать выполнение. */
  timed: boolean;
  /** Уже посчитанное время: родитель пересчитывает его каждые полсекунды. */
  seconds: number;
  onChanged: () => void;
  /** Введённое прямо сейчас — до того, как оно доедет до базы и обратно. */
  onTyped: (setId: number, patch: { reps?: number | null; weightKg?: number | null }) => void;
  /** Подход мешает завершить тренировку — пульсируем, чтобы его нашли. */
  flagged: boolean;
}) {
  const { t } = useT();
  const isRunning = row.is_running === 1;
  const isDone = !isRunning && row.started_at !== null;
  const prepping = timed && row.started_at !== null && seconds < 0;

  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!flagged) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        // цвет — не transform, нативным драйвером его не прогнать
        Animated.timing(pulse, { toValue: 1, duration: 650, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0, duration: 650, useNativeDriver: false }),
      ]),
      // 3 раза достаточно, чтобы привлечь внимание - дальше это не тревога,
      // а фон, который просто мешает
      { iterations: 3 }
    );
    loop.start();
    return () => loop.stop();
  }, [flagged, pulse]);

  const background = flagged
    ? pulse.interpolate({
        inputRange: [0, 1],
        // тот же светло-красный, что заливает экран во время подхода
        outputRange: ['rgba(232,196,196,0)', 'rgba(232,196,196,1)'],
      })
    : isRunning
      ? '#ffffff'
      : isDone
        ? SET_DONE_BG
        : 'transparent';

  return (
    <Animated.View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        opacity: locked ? 0.3 : 1,
        backgroundColor: background,
        borderRadius: 6,
        paddingVertical: 4,
      }}
    >
      {/* Значения пишутся на каждый введённый знак, а не по уходу из
          поля. Так «Добавить подход» видит только что набранные повторы,
          не заставляя сначала где-то нажать, чтобы поле закрылось, — и
          набранное не теряется, если приложение закроют прямо сейчас.
          Экран при этом не обновляется: поля неуправляемые, и обновление
          сбило бы каретку. */}
      <TextInput
        editable={!locked}
        keyboardType="numeric"
        placeholder={t('kg')}
        defaultValue={row.weight_kg == null ? '' : String(row.weight_kg)}
        onChangeText={(v) => onTyped(row.id, { weightKg: parseField(v) })}
        onEndEditing={onChanged}
        style={[inputStyle, { backgroundColor: locked ? 'transparent' : '#fff' }]}
      />

      <TextInput
        editable={!locked}
        keyboardType="numeric"
        placeholder={t('reps')}
        defaultValue={row.reps == null ? '' : String(row.reps)}
        onChangeText={(v) => onTyped(row.id, { reps: parseField(v) })}
        onEndEditing={onChanged}
        style={[inputStyle, { backgroundColor: locked ? 'transparent' : '#fff' }]}
      />

      {/* Кнопка записи осталась только у секундомера. Подход на повторы
          засчитывает барабан RIR — он стоит отдельной строкой под этой,
          снаружи SwipeRow (см. session.tsx выше и RirDrum). */}
      {timed && (
        <Pressable
          disabled={locked}
          onPress={async () => {
            if (isRunning) await stopSet(row.id);
            else await startSet(row.id);
            onChanged();
          }}
          style={{
            paddingVertical: 8,
            paddingHorizontal: 12,
            backgroundColor: isRunning
              ? RED_DARK
              : locked
                ? '#00000020'
                : isDone
                  ? '#2c8746'
                  : '#3aa655',
            borderRadius: 6,
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>
            {isRunning ? '❚❚' : isDone ? '✓' : '▶'}
          </Text>
        </Pressable>
      )}

      {timed &&
        (isRunning ? (
          // Во время самого подхода значение тикает — редактировать
          // нечего. Тикает оно у себя внутри, с миллисекундами: общий
          // счётчик экрана для такой частоты не годится, он тянул бы за
          // собой весь список.
          <LiveTimer
            since={row.running_since}
            base={row.active_seconds}
            signed
            style={{
              width: 78,
              textAlign: 'right',
              color: prepping ? '#999' : undefined,
              fontWeight: prepping ? '600' : undefined,
            }}
          />
        ) : (
          // ручной ввод секунд — для тех, кто засекает внешним секундомером
          // и не хочет держаться за прижимной таймер приложения
          <TextInput
            editable={!locked}
            keyboardType="numeric"
            placeholder={t('sec')}
            defaultValue={row.started_at ? String(Math.round(seconds)) : ''}
            onEndEditing={async (e) => {
              const v = e.nativeEvent.text.trim();
              if (v === '') {
                if (row.started_at) {
                  await unrecordSet(row.id);
                  onChanged();
                }
                return;
              }
              const n = Number(v);
              if (!Number.isFinite(n) || n < 0) return;
              await recordSetSeconds(row.id, Math.round(n));
              onChanged();
            }}
            style={[
              inputStyle,
              {
                flex: 0,
                width: 78,
                textAlign: 'right',
                backgroundColor: locked ? 'transparent' : '#fff',
                color: isDone ? '#2c8746' : undefined,
                fontWeight: isDone ? '600' : undefined,
              },
            ]}
          />
        ))}
    </Animated.View>
  );
}

const inputStyle = {
  flex: 1,
  borderWidth: 1,
  borderColor: '#00000020',
  borderRadius: 6,
  paddingVertical: 6,
  paddingHorizontal: 8,
  fontSize: 15,
} as const;
