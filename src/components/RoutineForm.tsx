import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import {
  getExercise,
  getRoutine,
  getRoutineExercises,
  renameRoutine,
  setRoutineExercises,
} from '../db/library';
import { createRoutine } from '../db/workout-session';
import { useT } from '../lib/i18n';
import { DragList } from './DragList';
import { SheetModal } from './SheetModal';
import { ExercisePicker } from './ExercisePicker';

interface Item {
  exercise_id: number;
  name: string;
}

/**
 * Карточка шаблона: название + состав.
 * routineId === null  → создаём новый
 * routineId === число → правим существующий
 *
 * Состав держим в локальном состоянии и записываем разом при сохранении —
 * тогда «Отмена» действительно отменяет, а не оставляет полусобранный шаблон.
 */
export function RoutineForm({
  visible,
  routineId = null,
  onClose,
  onSaved,
}: {
  visible: boolean;
  routineId?: number | null;
  onClose: () => void;
  onSaved: (routineId: number) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState('');

  const isEdit = routineId !== null;

  useEffect(() => {
    if (!visible) return;
    setError('');

    if (routineId === null) {
      setName('');
      setItems([]);
      return;
    }

    (async () => {
      const r = await getRoutine(routineId);
      setName(r?.name ?? '');
      const rows = await getRoutineExercises(routineId);
      setItems(rows.map((x) => ({ exercise_id: x.exercise_id, name: x.name })));
    })();
  }, [visible, routineId]);


  const save = async () => {
    try {
      setError('');
      if (!name.trim()) throw new Error('Name is required');

      let id = routineId;
      if (id === null) {
        id = await createRoutine(name.trim());
      } else {
        await renameRoutine(id, name.trim());
      }
      await setRoutineExercises(
        id,
        items.map((i) => i.exercise_id)
      );
      onSaved(id);
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
            {isEdit ? t('Edit workout') : t('New workout')}
          </Text>

          <TextInput
            placeholder={t('Name')}
            value={name}
            onChangeText={setName}
            style={{
              borderWidth: 1,
              borderColor: '#00000020',
              borderRadius: 8,
              padding: 10,
              fontSize: 16,
            }}
          />

          <Text style={{ fontWeight: '600', marginTop: 8 }}>
            {t('Exercises')} ({items.length})
          </Text>

          {items.length === 0 && (
            <Text style={{ color: '#999' }}>{t('Nothing')}</Text>
          )}

          {items.length > 0 && (
            <Text style={{ color: '#999', fontSize: 12 }}>
              {t('Hold and drag to reorder')}
            </Text>
          )}

          <DragList
            items={items}
            keyOf={(it) => it.exercise_id}
            onReorder={setItems}
            renderItem={(it, i, dragging) => (
              <View
                style={{
                  flex: 1,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  backgroundColor: dragging ? '#e2eef7' : '#00000008',
                  borderRadius: 8,
                  paddingHorizontal: 12,
                }}
              >
                <Text style={{ color: '#bbb', fontSize: 18 }}>≡</Text>
                <Text style={{ flex: 1 }}>{it.name}</Text>
                <Pressable
                  onPress={() =>
                    setItems((c) => c.filter((x) => x.exercise_id !== it.exercise_id))
                  }
                  style={{ padding: 6 }}
                >
                  <Text style={{ color: '#b23c3c' }}>✕</Text>
                </Pressable>
              </View>
            )}
          />

          <Pressable
            onPress={() => setPickerOpen(true)}
            style={{
              paddingVertical: 12,
              alignItems: 'center',
              backgroundColor: '#00000010',
              borderRadius: 8,
            }}
          >
            <Text style={{ fontWeight: '600' }}>{t('Add exercise +')}</Text>
          </Pressable>

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

      <ExercisePicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={async (exerciseId) => {
          if (items.some((i) => i.exercise_id === exerciseId)) return;
          const ex = await getExercise(exerciseId);
          setItems((c) => [
            ...c,
            { exercise_id: exerciseId, name: ex?.name ?? String(exerciseId) },
          ]);
        }}
      />
    </SheetModal>
  );
}
