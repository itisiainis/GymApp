import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useT } from '../lib/i18n';
import { RIR_MISSED, RIR_OPTIONS, rirLabel, type RirValue } from '../lib/rir';
import {
  RIR_ACTIVE,
  RIR_ACTIVE_TEXT,
  RIR_IDLE_BG,
  RIR_IDLE_TEXT,
  RIR_NONE,
} from '../lib/theme';

/**
 * Ввод RIR — барабан: свободный свайп со снапом по значениям.
 *
 * Не кнопки и не клавиатура: значений семь, они на одной шкале, и выбор
 * из шкалы — это движение вдоль неё, а не попадание пальцем в одну из
 * семи мелких мишеней.
 *
 * ВАЖНО, где он стоит. Барабан горизонтальный, и строка подхода завёрнута
 * в SwipeRow, который ловит горизонтальный свайп для удаления. Вложить
 * одно в другое — тот самый конфликт жестов, из-за которого свайп подхода
 * когда-то удалял всё упражнение. Поэтому барабан живёт на СВОЕЙ строке,
 * снаружи SwipeRow (см. session.tsx), а не внутри SetLine. Не переносить
 * внутрь в надежде, что жесты договорятся сами — не договорятся.
 *
 * Сделан на обычном ScrollView со snapToOffsets: reanimated в проект
 * ставить нельзя (v4 не работает в Expo Go, см. REDESIGN.md).
 */

/** Слот «не проставлен». Формально не значение шкалы, но нужен барабану:
 *  свежий подход должен где-то стоять, и с него же должен быть путь
 *  обратно — снять отметку, не удаляя сам подход. */
const NONE = 'none';
type Slot = RirValue | typeof NONE;

const SLOTS: Slot[] = [NONE, ...RIR_OPTIONS];

/** Ширины разные: «не дотянул» — слово, остальные — один символ.
 *  Поэтому снап идёт по snapToOffsets, а не по snapToInterval. */
const WIDTH_NUMBER = 42;
const WIDTH_MISSED = 96;
const WIDTH_NONE = 42;

function slotWidth(s: Slot): number {
  if (s === NONE) return WIDTH_NONE;
  if (s === RIR_MISSED) return WIDTH_MISSED;
  return WIDTH_NUMBER;
}

const WIDTHS = SLOTS.map(slotWidth);

function indexOfValue(value: RirValue | null): number {
  if (value === null) return 0;
  const i = SLOTS.indexOf(value);
  return i === -1 ? 0 : i;
}

export function RirDrum({
  value,
  onChange,
  disabled = false,
}: {
  /** null — RIR не проставлен. */
  value: RirValue | null;
  /** null означает «снять отметку». */
  onChange: (next: RirValue | null) => void;
  disabled?: boolean;
}) {
  const { t } = useT();
  const scroller = useRef<ScrollView>(null);
  const [width, setWidth] = useState(0);

  const selected = indexOfValue(value);

  /** Что уже отдано наружу: и чтобы не писать в базу одно и то же, и чтобы
   *  отличить «значение пришло снаружи» от «его только что выбрали здесь». */
  const committed = useRef(selected);
  /** Инерция после броска ещё не началась — см. onScrollEndDrag. */
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Смещение, при котором i-й слот стоит по центру. Крайние слоты тоже
  // должны доезжать до центра, отсюда боковые отступы у контента.
  const padLeft = width > 0 ? (width - WIDTHS[0]) / 2 : 0;
  const padRight = width > 0 ? (width - WIDTHS[WIDTHS.length - 1]) / 2 : 0;
  const offsets: number[] = [];
  let left = padLeft;
  for (const w of WIDTHS) {
    offsets.push(left + w / 2 - width / 2);
    left += w;
  }

  const scrollTo = (index: number, animated: boolean) => {
    if (width === 0) return;
    scroller.current?.scrollTo({ x: offsets[index], y: 0, animated });
  };

  // Значение пришло снаружи (обновление после записи, чужая правка,
  // первая отрисовка) — подводим барабан к нему. Свой же выбор сюда тоже
  // попадает, но там позиция уже верная, и scrollTo ничего не двигает.
  useEffect(() => {
    if (committed.current === selected) return;
    committed.current = selected;
    scrollTo(selected, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, width]);

  // Первая отрисовка: ширина известна только после layout, до неё
  // scrollTo молчит — поэтому ставим позицию, как только она появилась.
  useEffect(() => {
    if (width === 0) return;
    scrollTo(indexOfValue(value), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width]);

  const commit = (index: number) => {
    if (settle.current) {
      clearTimeout(settle.current);
      settle.current = null;
    }
    if (index === committed.current) return;
    committed.current = index;
    const slot = SLOTS[index];
    onChange(slot === NONE ? null : slot);
  };

  /** Ближайший слот к текущему положению. */
  const nearest = (x: number): number => {
    let best = 0;
    for (let i = 1; i < offsets.length; i++) {
      if (Math.abs(offsets[i] - x) < Math.abs(offsets[best] - x)) best = i;
    }
    return best;
  };

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, opacity: disabled ? 0.35 : 1 }}>
      <Text style={{ fontSize: 12, fontWeight: '700', color: RIR_IDLE_TEXT, width: 30 }}>
        {t('RIR')}
      </Text>

      <View style={{ flex: 1 }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        <ScrollView
          ref={scroller}
          horizontal
          scrollEnabled={!disabled}
          showsHorizontalScrollIndicator={false}
          decelerationRate="fast"
          snapToOffsets={width > 0 ? offsets : undefined}
          contentContainerStyle={{ paddingLeft: padLeft, paddingRight: padRight }}
          // Инерция начинается не всегда: медленно отпущенный барабан
          // доезжает до снапа без неё, и momentum-события не будет. Ждём
          // его чуть-чуть, а если не пришло — записываем сами.
          onScrollEndDrag={(e) => {
            const x = e.nativeEvent.contentOffset.x;
            if (settle.current) clearTimeout(settle.current);
            settle.current = setTimeout(() => commit(nearest(x)), 120);
          }}
          onMomentumScrollBegin={() => {
            if (settle.current) {
              clearTimeout(settle.current);
              settle.current = null;
            }
          }}
          onMomentumScrollEnd={(e) => commit(nearest(e.nativeEvent.contentOffset.x))}
        >
          {SLOTS.map((slot, i) => {
            const isSelected = i === selected;
            const isNone = slot === NONE;
            return (
              <Pressable
                key={String(slot)}
                disabled={disabled}
                // Тап — тот же барабан, просто подвинутый пальцем в одно
                // касание: значение всё равно приезжает в центр.
                onPress={() => {
                  scrollTo(i, true);
                  commit(i);
                }}
                style={{
                  width: WIDTHS[i],
                  paddingHorizontal: 3,
                  paddingVertical: 4,
                }}
              >
                <View
                  style={{
                    borderRadius: 999,
                    paddingVertical: 5,
                    alignItems: 'center',
                    backgroundColor: isSelected
                      ? isNone
                        ? RIR_NONE
                        : RIR_ACTIVE
                      : RIR_IDLE_BG,
                  }}
                >
                  <Text
                    numberOfLines={1}
                    style={{
                      fontSize: isNone || slot === RIR_MISSED ? 11 : 14,
                      fontWeight: isSelected ? '700' : '500',
                      color: isSelected ? RIR_ACTIVE_TEXT : RIR_IDLE_TEXT,
                    }}
                  >
                    {isNone ? '—' : rirLabel(slot, t)}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </View>
  );
}
