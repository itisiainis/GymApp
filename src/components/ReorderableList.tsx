import { useEffect, useRef, useState } from 'react';
import { Animated, PanResponder, View } from 'react-native';

/**
 * Список с перетаскиванием прямо на месте, без отдельного режима.
 *
 * Отличие от DragList: высота строк заранее неизвестна и разная —
 * карточка упражнения меняет размер от числа подходов и от того,
 * свёрнута она или нет. Поэтому высоты меряются через onLayout, а новая
 * позиция ищется по центру перетаскиваемой карточки, а не делением
 * смещения на фиксированный шаг.
 *
 * Смещение пальца живёт в ref и в Animated.Value, а не в состоянии:
 * состояние меняется только когда карточка переходит в другой слот.
 * Иначе каждый кадр жеста перерисовывал бы весь список — с тяжёлыми
 * карточками это заметно лагает.
 *
 * Перетаскивание начинается не по касанию, а по вызову startDrag из
 * renderItem — обычно из onLongPress на «ручке» строки. Иначе жест
 * дрался бы с прокруткой и свайпами внутри карточки.
 */
export function ReorderableList<T>({
  items,
  keyOf,
  renderItem,
  onReorder,
  onDraggingChange,
}: {
  items: T[];
  keyOf: (item: T) => string | number;
  renderItem: (
    item: T,
    index: number,
    dragging: boolean,
    startDrag: () => void
  ) => React.ReactNode;
  onReorder: (next: T[]) => void;
  /** Родитель гасит прокрутку, пока карточку тащат. */
  onDraggingChange?: (dragging: boolean) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const dy = useRef(new Animated.Value(0)).current;
  const heights = useRef<Record<string, number>>({});

  // PanResponder создаётся один раз, поэтому свежие значения отдаём через ref.
  const dragIndexRef = useRef<number | null>(null);
  const targetRef = useRef<number | null>(null);
  const itemsRef = useRef(items);
  dragIndexRef.current = dragIndex;
  targetRef.current = target;
  itemsRef.current = items;

  // Колбэки — туда же. Без этого отпущенная карточка звала onReorder с
  // первого рендера: экран тренировки монтирует список ещё до того, как
  // тренировка заведена, и в том замыкании workout был null. Новый порядок
  // успевал встать на экран, но в базу не писался — и первый же refresh
  // (RIR, ввод веса) возвращал старый.
  const onReorderRef = useRef(onReorder);
  const onDraggingChangeRef = useRef(onDraggingChange);
  onReorderRef.current = onReorder;
  onDraggingChangeRef.current = onDraggingChange;

  const heightOf = (item: T) => heights.current[String(keyOf(item))] ?? 0;

  /** В чей слот попал центр перетаскиваемой карточки при смещении offset. */
  const findTarget = (offset: number): number => {
    const list = itemsRef.current;
    const from = dragIndexRef.current;
    if (from === null || list.length === 0) return 0;

    let top = 0;
    for (let i = 0; i < from; i++) top += heightOf(list[i]);
    const center = top + heightOf(list[from]) / 2 + offset;

    if (center < 0) return 0;
    let acc = 0;
    for (let i = 0; i < list.length; i++) {
      acc += heightOf(list[i]);
      if (center < acc) return i;
    }
    return list.length - 1;
  };

  const stop = () => {
    dy.setValue(0);
    setDragIndex(null);
    setTarget(null);
    onDraggingChangeRef.current?.(false);
  };

  /**
   * Между отпусканием и приходом нового порядка сдвиги обнулять нельзя:
   * список успевал отрисоваться без них, но ещё в старом порядке — и это
   * читалось как мигание. Поэтому ждём смены порядка, держа карточки там,
   * где они уже визуально стоят.
   */
  const awaitingOrder = useRef(false);
  const orderKey = items.map((it) => String(keyOf(it))).join('|');
  const prevOrderKey = useRef(orderKey);

  // Порядок уже сменился, а состояние перетаскивания снимается только
  // эффектом — то есть после отрисовки. В этом кадре старый dragIndex
  // указывал бы на чужую карточку: она получала бы и подсветку, и сдвиг.
  // Поэтому с момента смены порядка рисуем так, будто перетаскивания нет:
  // новый порядок без сдвигов и есть конечное положение.
  const settling = awaitingOrder.current && prevOrderKey.current !== orderKey;
  const activeIndex = settling ? null : dragIndex;
  const activeTarget = settling ? null : target;

  useEffect(() => {
    if (prevOrderKey.current === orderKey) return;
    prevOrderKey.current = orderKey;
    if (!awaitingOrder.current) return;
    awaitingOrder.current = false;
    dy.setValue(0);
    setDragIndex(null);
    setTarget(null);
  }, [orderKey, dy]);

  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: () => dragIndexRef.current !== null,
      onPanResponderMove: (_, g) => {
        dy.setValue(g.dy);
        // перерисовываем только на смене слота, а не на каждом кадре
        const next = findTarget(g.dy);
        if (next !== targetRef.current) {
          targetRef.current = next;
          setTarget(next);
        }
      },
      onPanResponderRelease: () => {
        const from = dragIndexRef.current;
        const to = targetRef.current;
        if (from === null || to === null || from === to) {
          stop();
          return;
        }

        // Ставим карточку ровно в тот слот, который она займёт после
        // перестановки: соседи уже разошлись, поэтому новый порядок
        // отрисуется без единого видимого движения.
        const list = itemsRef.current;
        let delta = 0;
        if (from < to) {
          for (let i = from + 1; i <= to; i++) delta += heightOf(list[i]);
        } else {
          for (let i = to; i < from; i++) delta -= heightOf(list[i]);
        }
        dy.setValue(delta);

        awaitingOrder.current = true;
        onDraggingChangeRef.current?.(false);

        // Страховка: если порядок так и не пришёл (например, запись в базу
        // не удалась), список не должен остаться со сдвинутыми карточками.
        setTimeout(() => {
          if (!awaitingOrder.current) return;
          awaitingOrder.current = false;
          stop();
        }, 800);

        const next = [...list];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        onReorderRef.current(next);
      },
      onPanResponderTerminate: stop,
    })
  ).current;

  const draggedHeight =
    activeIndex === null ? 0 : heightOf(items[activeIndex] ?? items[0]);

  return (
    <View>
      {items.map((item, i) => {
        const dragging = activeIndex === i;

        // остальные карточки расступаются на высоту той, что несут
        let slide = 0;
        if (activeIndex !== null && activeTarget !== null && !dragging) {
          if (activeIndex < activeTarget && i > activeIndex && i <= activeTarget) {
            slide = -draggedHeight;
          }
          if (activeIndex > activeTarget && i >= activeTarget && i < activeIndex) {
            slide = draggedHeight;
          }
        }

        return (
          <Animated.View
            key={keyOf(item)}
            onLayout={(e) => {
              heights.current[String(keyOf(item))] = e.nativeEvent.layout.height;
            }}
            style={{
              transform: [{ translateY: dragging ? dy : slide }],
              zIndex: dragging ? 10 : 0,
              elevation: dragging ? 6 : 0,
            }}
            {...(dragging ? responder.panHandlers : {})}
          >
            {renderItem(item, i, dragging, () => {
              dy.setValue(0);
              targetRef.current = i;
              setTarget(i);
              setDragIndex(i);
              onDraggingChange?.(true);
            })}
          </Animated.View>
        );
      })}
    </View>
  );
}
