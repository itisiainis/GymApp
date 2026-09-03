import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { getWorkoutDetail, type HistorySet, type WorkoutSummary } from '../db/library';
import { useT } from '../lib/i18n';
import { fmt } from '../lib/time';
import { SheetModal } from './SheetModal';

/** Как показать подход: 8 × 60 kg / 8 reps / 0:25 */
function setLabel(s: HistorySet, t: (k: string) => string): string {
  if (s.measurement_default === 'hold' && s.active_seconds > 0) return fmt(s.active_seconds);
  if (s.reps != null && s.weight_kg != null) return `${s.reps} × ${s.weight_kg} ${t('kg')}`;
  if (s.reps != null) return `${s.reps} ${t('reps')}`;
  if (s.active_seconds > 0) return fmt(s.active_seconds);
  return '—';
}

function groupByExercise(sets: HistorySet[]) {
  const out: { exerciseId: number; name: string; sets: HistorySet[] }[] = [];
  for (const s of sets) {
    let g = out.find((x) => x.exerciseId === s.exercise_id);
    if (!g) {
      g = { exerciseId: s.exercise_id, name: s.exercise_name, sets: [] };
      out.push(g);
    }
    g.sets.push(s);
  }
  return out;
}

/**
 * Быстрая карточка тренировки — открывается тапом по записи в календаре,
 * без перехода на отдельный экран истории.
 */
export function WorkoutDetail({
  workout,
  onClose,
}: {
  workout: WorkoutSummary | null;
  onClose: () => void;
}) {
  const { t } = useT();
  const [sets, setSets] = useState<HistorySet[]>([]);

  useEffect(() => {
    if (!workout) return;
    getWorkoutDetail(workout.id).then(setSets);
  }, [workout]);

  return (
    <SheetModal visible={workout !== null} onClose={onClose} title={workout?.routine_name}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {workout && (
          <Text style={{ color: '#666', fontSize: 13, marginBottom: 12 }}>
            {new Date(workout.started_at).toLocaleDateString()} · {fmt(workout.total_seconds)} ·{' '}
            {t('sets')}: {workout.set_count}
          </Text>
        )}

        {groupByExercise(sets).map((g) => (
          <View key={g.exerciseId} style={{ marginBottom: 12 }}>
            <Text style={{ fontWeight: '600', fontSize: 15 }}>{g.name}</Text>
            {g.sets.map((s) => (
              <Text key={s.id} style={{ color: '#444', fontSize: 14 }}>
                {setLabel(s, t)}
              </Text>
            ))}
          </View>
        ))}
      </ScrollView>
    </SheetModal>
  );
}
