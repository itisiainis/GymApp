import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { getWorkoutRecap, type RecapSet } from '../db/library';
import { useT } from '../lib/i18n';
import { fmt } from '../lib/time';
import { SheetModal } from './SheetModal';

/** Итоги тренировки: что сделано и какие рекорды побиты. */
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

  useEffect(() => {
    if (workoutId === null) return;
    getWorkoutRecap(workoutId).then(setSets);
  }, [workoutId]);

  const prs = sets.filter((s) => s.is_pr === 1);

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
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      >
        <Text style={{ fontSize: 16, marginBottom: 4 }}>
          {t('Total')}: {fmt(totalSeconds)} · {t('sets')}: {sets.length}
        </Text>

        {prs.length > 0 && (
          <View
            style={{
              backgroundColor: '#fbf1d3',
              borderRadius: 10,
              padding: 12,
              marginVertical: 12,
            }}
          >
            <Text style={{ fontWeight: '700', color: '#a3790f', fontSize: 16 }}>
              {t('New personal records')}: {prs.length}
            </Text>
            {prs.map((p, i) => (
              <Text key={i} style={{ color: '#a3790f', marginTop: 2 }}>
                {p.exercise_name} — {label(p)}
              </Text>
            ))}
          </View>
        )}

        {groups.map((g) => (
          <View key={g.id} style={{ marginTop: 12 }}>
            <Text style={{ fontWeight: '600', fontSize: 15 }}>{g.name}</Text>
            {g.sets.map((s, i) => (
              <Text
                key={i}
                style={{
                  color: s.is_pr ? '#a3790f' : '#444',
                  fontWeight: s.is_pr ? '700' : '400',
                  fontSize: 14,
                }}
              >
                {label(s)}
                {s.is_pr ? '  ★' : ''}
              </Text>
            ))}
          </View>
        ))}

        <Pressable
          onPress={onClose}
          style={{
            marginTop: 24,
            padding: 16,
            alignItems: 'center',
            backgroundColor: '#3aa655',
            borderRadius: 10,
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 16 }}>
            {t('Nice work')}
          </Text>
        </Pressable>
      </ScrollView>
    </SheetModal>
  );
}
