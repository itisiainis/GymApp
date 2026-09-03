import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import {
  getExercise,
  getExerciseMuscles,
  listMuscles,
  updateExercise,
  type Muscle,
} from '../db/library';
import { createExercise, type MeasurementType } from '../db/queries';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useT } from '../lib/i18n';
import { SheetModal } from './SheetModal';

/**
 * Создание и правка упражнения.
 * exerciseId === null  → создаём новое
 * exerciseId === число → правим существующее
 *
 * Мышцы задаются в два шага: сначала выбираем какие участвуют
 * (отдельный список с галочками), потом раскидываем проценты
 * по короткому списку выбранных.
 */
export function ExerciseForm({
  visible,
  exerciseId = null,
  onClose,
  onSaved,
}: {
  visible: boolean;
  exerciseId?: number | null;
  onClose: () => void;
  onSaved: (exerciseId: number) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [measurement, setMeasurement] = useState<MeasurementType>('reps');
  const [allMuscles, setAllMuscles] = useState<Muscle[]>([]);
  const [chosen, setChosen] = useState<number[]>([]);
  const [shares, setShares] = useState<Record<number, string>>({});
  const [selectOpen, setSelectOpen] = useState(false);
  const [error, setError] = useState('');

  const isEdit = exerciseId !== null;

  useEffect(() => {
    if (!visible) return;
    setError('');
    listMuscles().then(setAllMuscles);

    if (exerciseId === null) {
      setName('');
      setDescription('');
      setMeasurement('reps');
      setChosen([]);
      setShares({});
      return;
    }

    (async () => {
      const ex = await getExercise(exerciseId);
      if (ex) {
        setName(ex.name);
        setDescription(ex.description ?? '');
        setMeasurement(ex.measurement_default);
      }
      const ms = await getExerciseMuscles(exerciseId);
      setChosen(ms.map((m) => m.muscle_id));
      const next: Record<number, string> = {};
      ms.forEach((m) => (next[m.muscle_id] = String(Math.round(m.share * 100))));
      setShares(next);
    })();
  }, [visible, exerciseId]);

  const byId = useMemo(() => {
    const map = new Map<number, Muscle>();
    allMuscles.forEach((m) => map.set(m.id, m));
    return map;
  }, [allMuscles]);

  const total = chosen.reduce((s, id) => s + (parseFloat(shares[id] ?? '') || 0), 0);

  /** Поровну между выбранными — обычно быстрее, чем вбивать руками. */
  const spreadEvenly = () => {
    if (chosen.length === 0) return;
    const base = Math.floor(100 / chosen.length);
    const next: Record<number, string> = { ...shares };
    chosen.forEach((id, i) => {
      next[id] = String(i === 0 ? 100 - base * (chosen.length - 1) : base);
    });
    setShares(next);
  };

  const save = async () => {
    try {
      setError('');
      const picked = chosen
        .map((id) => ({ muscleId: id, share: (parseFloat(shares[id] ?? '') || 0) / 100 }))
        .filter((m) => m.share > 0);

      if (!name.trim()) throw new Error('Name is required');
      if (picked.length === 0) throw new Error('Pick muscles and set percentages');

      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        measurementDefault: measurement,
        muscles: picked,
      };

      if (isEdit) {
        await updateExercise(exerciseId!, payload);
        onSaved(exerciseId!);
      } else {
        const id = await createExercise(payload);
        onSaved(id);
      }
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <SheetModal visible={visible} onClose={onClose}>
      <ScrollView
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 120 }}
      >
        <View style={{ padding: 16, paddingTop: 48, gap: 12 }}>
          <Text style={{ fontSize: 22, fontWeight: '700' }}>
            {isEdit ? t('Edit exercise') : t('New exercise')}
          </Text>

          <TextInput placeholder={t('Name')} value={name} onChangeText={setName} style={field} />
          <TextInput
            placeholder={t('Description')}
            value={description}
            onChangeText={setDescription}
            style={field}
          />

          <View style={{ flexDirection: 'row', gap: 8 }}>
            {(['reps', 'hold'] as MeasurementType[]).map((m) => (
              <Pressable
                key={m}
                onPress={() => setMeasurement(m)}
                style={{
                  flex: 1,
                  padding: 12,
                  alignItems: 'center',
                  borderRadius: 8,
                  backgroundColor: measurement === m ? '#4aa3df' : '#00000010',
                }}
              >
                <Text style={{ color: measurement === m ? '#fff' : '#333' }}>
                  {m === 'reps' ? t('Reps') : t('Time')}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* ---- Шаг 1: какие мышцы участвуют ---- */}

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              marginTop: 8,
              gap: 10,
            }}
          >
            <Text style={{ fontWeight: '600', flex: 1 }}>{t('Muscles')}</Text>
            <Pressable
              onPress={() => setSelectOpen(true)}
              style={{
                paddingVertical: 8,
                paddingHorizontal: 12,
                backgroundColor: '#00000010',
                borderRadius: 8,
              }}
            >
              <Text style={{ fontWeight: '600' }}>
                {chosen.length === 0 ? `${t('Select')} +` : `${t('Edit')} (${chosen.length})`}
              </Text>
            </Pressable>
          </View>

          {/* ---- Шаг 2: проценты только по выбранным ---- */}

          {chosen.length === 0 ? (
            <Text style={{ color: '#999' }}>{t('No muscle selected yet')}</Text>
          ) : (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text
                  style={{
                    flex: 1,
                    color: Math.abs(total - 100) < 0.5 ? '#3aa655' : '#b23c3c',
                    fontWeight: '600',
                  }}
                >
                  {Math.round(total)}% / 100%
                </Text>
                <Pressable
                  onPress={spreadEvenly}
                  style={{
                    paddingVertical: 6,
                    paddingHorizontal: 10,
                    backgroundColor: '#00000010',
                    borderRadius: 6,
                  }}
                >
                  <Text style={{ fontSize: 13 }}>{t('Split evenly')}</Text>
                </Pressable>
              </View>

              {chosen.map((id) => {
                const m = byId.get(id);
                return (
                  <View
                    key={id}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text>{t(m?.name ?? String(id))}</Text>
                      <Text style={{ fontSize: 11, color: '#999' }}>{t(m?.body_group ?? '')}</Text>
                    </View>
                    <TextInput
                      keyboardType="numeric"
                      placeholder="0"
                      value={shares[id] ?? ''}
                      onChangeText={(v) => setShares((s) => ({ ...s, [id]: v }))}
                      style={{ ...field, width: 70, textAlign: 'right' }}
                    />
                    <Pressable
                      onPress={() => {
                        setChosen((c) => c.filter((x) => x !== id));
                        setShares((s) => {
                          const next = { ...s };
                          delete next[id];
                          return next;
                        });
                      }}
                      style={{ padding: 6 }}
                    >
                      <Text style={{ color: '#b23c3c' }}>✕</Text>
                    </Pressable>
                  </View>
                );
              })}
            </>
          )}

          {!!error && <Text style={{ color: '#b23c3c' }}>{t(error)}</Text>}

          <View style={{ flexDirection: 'row', gap: 10, marginTop: 12, marginBottom: 40 }}>
            <Pressable
              onPress={onClose}
              style={{
                flex: 1,
                padding: 14,
                alignItems: 'center',
                backgroundColor: '#eee',
                borderRadius: 8,
              }}
            >
              <Text>{t('Cancel')}</Text>
            </Pressable>
            <Pressable
              onPress={save}
              style={{
                flex: 1,
                padding: 14,
                alignItems: 'center',
                backgroundColor: '#3aa655',
                borderRadius: 8,
              }}
            >
              <Text style={{ color: '#fff', fontWeight: '600' }}>{t('Save')}</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>

      <MuscleSelect
        visible={selectOpen}
        exerciseName={name}
        muscles={allMuscles}
        chosen={chosen}
        onClose={() => setSelectOpen(false)}
        onApply={(ids) => {
          setChosen(ids);
          setShares((s) => {
            const next: Record<number, string> = {};
            ids.forEach((id) => (next[id] = s[id] ?? ''));
            return next;
          });
          setSelectOpen(false);
        }}
      />
    </SheetModal>
  );
}

/* ------------------------------------------------------------------ */
/* Выбор мышц: галочки, поиск, группировка                             */
/* ------------------------------------------------------------------ */

function MuscleSelect({
  visible,
  exerciseName,
  muscles,
  chosen,
  onApply,
  onClose,
}: {
  visible: boolean;
  exerciseName: string;
  muscles: Muscle[];
  chosen: number[];
  onApply: (ids: number[]) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const [local, setLocal] = useState<number[]>(chosen);
  const [query, setQuery] = useState('');
  const [groupMode, setGroupMode] = useState(true);

  useEffect(() => {
    if (visible) {
      setLocal(chosen);
      setQuery('');
    }
  }, [visible, chosen]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return muscles;
    return muscles.filter(
      (m) =>
        m.name.toLowerCase().includes(q) || m.body_group.toLowerCase().includes(q)
    );
  }, [muscles, query]);

  const sections = useMemo(() => {
    if (!groupMode) {
      return [
        {
          title: '',
          items: [...filtered].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
        },
      ];
    }
    const map = new Map<string, Muscle[]>();
    filtered.forEach((m) => {
      if (!map.has(m.body_group)) map.set(m.body_group, []);
      map.get(m.body_group)!.push(m);
    });
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'ru'))
      .map(([title, items]) => ({
        title,
        items: items.sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      }));
  }, [filtered, groupMode]);

  const toggle = (id: number) =>
    setLocal((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  return (
    <SheetModal visible={visible} onClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#fff' }}>
        <View style={{ padding: 16, paddingTop: 48, gap: 10 }}>
          <Text style={{ fontSize: 20, fontWeight: '700' }}>
            {exerciseName.trim()
              ? `${t('Which muscles are involved in')} ${exerciseName.trim()}`
              : t('Which muscles are involved')}
          </Text>

          <TextInput
            placeholder={t('Search')}
            value={query}
            onChangeText={setQuery}
            style={field}
          />

          <View style={{ flexDirection: 'row', gap: 8 }}>
            {[
              { key: true, label: t('By group') },
              { key: false, label: t('Alphabetical') },
            ].map((opt) => (
              <Pressable
                key={String(opt.key)}
                onPress={() => setGroupMode(opt.key)}
                style={{
                  flex: 1,
                  padding: 10,
                  alignItems: 'center',
                  borderRadius: 8,
                  backgroundColor: groupMode === opt.key ? '#4aa3df' : '#00000010',
                }}
              >
                <Text
                  style={{ color: groupMode === opt.key ? '#fff' : '#333', fontSize: 13 }}
                >
                  {opt.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <ScrollView style={{ flex: 1, paddingHorizontal: 16 }}>
          {sections.map((sec) => (
            <View key={sec.title || 'all'}>
              {!!sec.title && (
                <Text style={{ fontWeight: '700', marginTop: 12, color: '#555' }}>
                  {t(sec.title)}
                </Text>
              )}
              {sec.items.map((m) => {
                const on = local.includes(m.id);
                return (
                  <Pressable
                    key={m.id}
                    onPress={() => toggle(m.id)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      paddingVertical: 10,
                    }}
                  >
                    <View
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 5,
                        borderWidth: 2,
                        borderColor: on ? '#3aa655' : '#00000030',
                        backgroundColor: on ? '#3aa655' : 'transparent',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {on && <Text style={{ color: '#fff', fontSize: 14 }}>✓</Text>}
                    </View>
                    <Text style={{ fontSize: 15 }}>{t(m.name)}</Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
          <View style={{ height: 20 }} />
        </ScrollView>

        <View
          style={{
            flexDirection: 'row',
            gap: 10,
            padding: 16,
            paddingBottom: 16 + insets.bottom,
            borderTopWidth: 1,
            borderTopColor: '#00000015',
          }}
        >
          <Pressable
            onPress={onClose}
            style={{
              flex: 1,
              padding: 14,
              alignItems: 'center',
              backgroundColor: '#eee',
              borderRadius: 8,
            }}
          >
            <Text>{t('Cancel')}</Text>
          </Pressable>
          <Pressable
            onPress={() => onApply(local)}
            style={{
              flex: 1,
              padding: 14,
              alignItems: 'center',
              backgroundColor: '#3aa655',
              borderRadius: 8,
            }}
          >
            <Text style={{ color: '#fff', fontWeight: '600' }}>
              {t('Done')} ({local.length})
            </Text>
          </Pressable>
        </View>
      </View>
    </SheetModal>
  );
}

const field = {
  borderWidth: 1,
  borderColor: '#00000020',
  borderRadius: 8,
  padding: 10,
  fontSize: 15,
} as const;
