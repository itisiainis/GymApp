import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { getWorkoutRecap, type RecapSet } from '../db/library';
import { getExerciseNotes } from '../db/workout-session';
import { useT } from '../lib/i18n';
import { fmt, restBySet } from '../lib/time';
import {
  CARD_BG,
  PR_BG,
  PR_TEXT,
  RECAP_FIELD_BG,
  RECAP_HEADER,
  RECAP_HEADER_TEXT,
  RECAP_SET_BG,
  REST_HINT,
} from '../lib/theme';
import { SheetModal } from './SheetModal';

/**
 * Итоги тренировки.
 *
 * Это тот же экран тренировки, а не отдельная сводка: те же карточки
 * упражнений с шапкой, те же строки подходов с весом, повторами и временем,
 * тот же отдых между ними, та же нижняя панель с общим временем. Разбирать
 * тренировку проще всего, когда она выглядит ровно так же, как выглядела,
 * пока шла, — искать глазами ничего не нужно.
 *
 * Отличается ровно тем, что говорит «это уже записано, а не пишется»:
 * шапки холодно-синие вместо рабочего серого и зелёного, поля ввода стали
 * плашками, кнопок записи нет вовсе, а рекорды подсвечены золотом.
 */
export function WorkoutRecap({
  workoutId,
  totalSeconds,
  onClose,
}: {
  workoutId: number | null;
  totalSeconds: number;
  onClose: () => void;
}) {
  const { t } = useT();
  const [sets, setSets] = useState<RecapSet[]>([]);
  const [notes, setNotes] = useState<Record<number, string>>({});

  useEffect(() => {
    if (workoutId === null) return;
    // Сбрасываем перед загрузкой: иначе на мгновение видны подходы прошлой
    // тренировки под заголовком текущей.
    setSets([]);
    setNotes({});
    getWorkoutRecap(workoutId).then(setSets);
    getExerciseNotes(workoutId).then(setNotes);
  }, [workoutId]);

  const prs = sets.filter((s) => s.is_pr === 1);
  const restBefore = restBySet(sets);

  const groups: { id: number; name: string; sets: RecapSet[] }[] = [];
  for (const s of sets) {
    let g = groups.find((x) => x.id === s.exercise_id);
    if (!g) {
      g = { id: s.exercise_id, name: s.exercise_name, sets: [] };
      groups.push(g);
    }
    g.sets.push(s);
  }

  const label = (s: RecapSet) => {
    if (s.measurement_default === 'hold' && s.active_seconds > 0) return fmt(s.active_seconds);
    if (s.reps != null && s.weight_kg != null) return `${s.reps} × ${s.weight_kg} ${t('kg')}`;
    if (s.reps != null) return `${s.reps} ${t('reps')}`;
    if (s.active_seconds > 0) return fmt(s.active_seconds);
    return '—';
  };

  return (
    <SheetModal visible={workoutId !== null} onClose={onClose} title={t('Workout done')}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: 24 }}>
        {/* Плашка «разбор» — единственная подпись, объясняющая, почему экран
            выглядит как тренировка, но ничего не нажимается. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <View
            style={{
              backgroundColor: RECAP_HEADER,
              borderRadius: 999,
              paddingHorizontal: 10,
              paddingVertical: 4,
            }}
          >
            <Text style={{ color: RECAP_HEADER_TEXT, fontSize: 12, fontWeight: '700' }}>
              {t('Recap')}
            </Text>
          </View>
          <Text style={{ color: '#666', fontSize: 13 }}>
            {t('sets')}: {sets.length}
          </Text>
        </View>

        {prs.length > 0 && (
          <View
            style={{
              backgroundColor: PR_BG,
              borderRadius: 10,
              padding: 12,
              marginBottom: 12,
            }}
          >
            <Text style={{ fontWeight: '700', color: PR_TEXT, fontSize: 16 }}>
              ★ {t('New personal records')}: {prs.length}
            </Text>
            {prs.map((p) => (
              <Text key={p.id} style={{ color: PR_TEXT, marginTop: 2 }}>
                {p.exercise_name} — {label(p)}
              </Text>
            ))}
          </View>
        )}

        {groups.map((g) => (
          <View
            key={g.id}
            style={{
              marginBottom: 10,
              backgroundColor: CARD_BG,
              borderRadius: 10,
              padding: 10,
            }}
          >
            {/* та же шапка, что у карточки на тренировке — но синяя и без
                кнопок «свернуть» и «изменить»: править уже нечего */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: RECAP_HEADER,
                borderRadius: 8,
                paddingHorizontal: 10,
                paddingVertical: 10,
              }}
            >
              <Text
                style={{
                  flex: 1,
                  fontSize: 18,
                  fontWeight: '600',
                  color: RECAP_HEADER_TEXT,
                }}
              >
                {g.name}
              </Text>
              <Text style={{ color: RECAP_HEADER_TEXT, opacity: 0.7, fontWeight: '600' }}>
                {g.sets.length}
              </Text>
            </View>

            <View style={{ gap: 6, marginTop: 8 }}>
              {g.sets.map((s) => (
                <View key={s.id}>
                  {restBefore[s.id] !== undefined && (
                    <Text
                      style={{
                        fontSize: 11,
                        color: REST_HINT,
                        paddingLeft: 14,
                        paddingBottom: 2,
                      }}
                    >
                      ⏱ {t('rest')} {fmt(restBefore[s.id])}
                    </Text>
                  )}
                  <RecapSetLine set={s} />
                </View>
              ))}

              {!!notes[g.id] && (
                <Text
                  style={{
                    backgroundColor: '#0000000a',
                    borderRadius: 6,
                    padding: 8,
                    fontSize: 13,
                    color: '#555',
                    fontStyle: 'italic',
                  }}
                >
                  {notes[g.id]}
                </Text>
              )}
            </View>
          </View>
        ))}
      </ScrollView>

      {/* нижняя панель повторяет панель тренировки: слева общее время,
          справа действие — только вместо «Завершить» здесь выход */}
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
        <Text style={{ flex: 1, fontSize: 16 }}>
          {t('Total')}: {fmt(totalSeconds)}
        </Text>
        <Pressable
          onPress={onClose}
          style={{
            paddingVertical: 10,
            paddingHorizontal: 18,
            backgroundColor: '#3aa655',
            borderRadius: 8,
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>{t('Nice work')}</Text>
        </Pressable>
      </View>
    </SheetModal>
  );
}

/**
 * Строка подхода в разборе — копия строки с тренировки по раскладке
 * (вес, повторы, отметка, время), но плашками вместо полей ввода.
 */
function RecapSetLine({ set }: { set: RecapSet }) {
  const { t } = useT();
  const isPr = set.is_pr === 1;
  const done = set.started_at !== null;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: isPr ? PR_BG : RECAP_SET_BG,
        borderRadius: 6,
        paddingVertical: 4,
        paddingHorizontal: 6,
        // заготовка, до которой так и не дошли: видно, но не в полный голос
        opacity: done ? 1 : 0.45,
      }}
    >
      <Field value={set.weight_kg} unit={t('kg')} bold={isPr} />
      <Field value={set.reps} unit={t('reps')} bold={isPr} />

      {/* та же кнопка по месту и размеру, но плашка: нажимать нечего */}
      <View
        style={{
          paddingVertical: 8,
          paddingHorizontal: 12,
          backgroundColor: done ? (isPr ? PR_TEXT : '#2c8746') : '#00000015',
          borderRadius: 6,
        }}
      >
        <Text style={{ color: '#fff', fontWeight: '700' }}>
          {isPr ? '★' : done ? '✓' : '○'}
        </Text>
      </View>

      <Text
        style={{
          width: 56,
          textAlign: 'right',
          fontSize: 15,
          color: isPr ? PR_TEXT : '#2c8746',
          fontWeight: '600',
        }}
      >
        {set.active_seconds > 0 ? fmt(set.active_seconds) : ''}
      </Text>
    </View>
  );
}

/** Плашка на месте поля ввода: та же рамка и высота, но только значение. */
function Field({
  value,
  unit,
  bold,
}: {
  value: number | null;
  unit: string;
  bold: boolean;
}) {
  return (
    <View
      style={{
        flex: 1,
        borderWidth: 1,
        borderColor: '#00000015',
        borderRadius: 6,
        paddingVertical: 6,
        paddingHorizontal: 8,
        backgroundColor: RECAP_FIELD_BG,
      }}
    >
      <Text
        style={{
          fontSize: 15,
          color: value == null ? '#bbb' : bold ? PR_TEXT : '#333',
          fontWeight: bold ? '700' : '400',
        }}
      >
        {value == null ? '—' : `${value} ${unit}`}
      </Text>
    </View>
  );
}
