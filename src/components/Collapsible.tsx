import { useEffect, useRef, useState } from 'react';
import { Animated, View } from 'react-native';

/**
 * Разворачивается и сворачивается по высоте за заданное время.
 *
 * LayoutAnimation здесь не подходит: на новой архитектуре RN он no-op,
 * и сворачивание происходило мгновенно. Высоту приходится мерить самим —
 * анимировать от 'auto' нельзя, нужно конкретное число.
 *
 * Содержимое остаётся смонтированным и в свёрнутом виде: иначе его нечем
 * измерить, и разворачивать было бы не из чего.
 *
 * Анимированная высота живёт только на время самого движения, а в покое
 * отдаётся обычным числом через React. Анимация без нативного драйвера
 * двигает вид в обход React, и React помнит высоту с момента её начала.
 * Пока вид никто не трогает, разницы не видно; но карточку, которую
 * передвинули в списке (например, порядок упражнений пришёл из базы
 * другим), нативная сторона пересобирает по тому, что помнит React, —
 * и доехавший до конца разворот откатывался: передвинутая карточка
 * мгновенно схлопывалась.
 */
export function Collapsible({
  collapsed,
  duration = 500,
  children,
}: {
  collapsed: boolean;
  duration?: number;
  children: React.ReactNode;
}) {
  const [height, setHeight] = useState<number | null>(null);
  const anim = useRef(new Animated.Value(collapsed ? 0 : 1)).current;
  const [animating, setAnimating] = useState(false);
  // К какому положению уже едем или уже приехали. На первом рендере
  // совпадает с collapsed — двигать нечего.
  const shown = useRef(collapsed);
  const current = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (shown.current === collapsed) return;
    shown.current = collapsed;
    current.current?.stop();
    const a = Animated.timing(anim, {
      toValue: collapsed ? 0 : 1,
      duration,
      // высота — layout-свойство, нативный драйвер её не умеет
      useNativeDriver: false,
    });
    current.current = a;
    setAnimating(true);
    a.start(({ finished }) => {
      // прерванную анимацию сменила новая — флаг снимет уже она
      if (finished) setAnimating(false);
    });
  }, [collapsed, duration, anim]);

  useEffect(() => () => current.current?.stop(), []);

  // Рендер, в котором collapsed уже сменился, а эффект ещё не запустил
  // анимацию, тоже считается движением: обычным числом здесь сразу вышло
  // бы конечное положение, и карточка прыгала бы туда, а потом ехала
  // обратно от старого.
  const moving = animating || shown.current !== collapsed;

  // Пока не было ни одного замера и карточка свёрнута с самого монтирования
  // (типичный случай: открыл экран, а упражнение уже отмечено готовым) -
  // родитель ниже стоит с явной height: 0. Обычный дочерний View внутри
  // такого родителя меряется Yoga'ой ПО ЭТИМ рамкам, а не по контенту, и
  // onLayout поймает 0 - высота застрянет неправильной навсегда, разворот
  // будет показывать пустоту. Единственное исключение, где меряющий View
  // оставляем в потоке, - самый первый рендер уже развёрнутой карточки:
  // так родитель сразу принимает точный размер без короткой вспышки пустоты
  // перед первым onLayout.
  const measureAbsolute = height !== null || collapsed;

  return (
    <Animated.View
      style={{
        // до первого замера высота неизвестна: разворачиваем по содержимому,
        // а свёрнутое держим в нуле — вложенный View всё равно измерится
        height:
          height === null
            ? collapsed
              ? 0
              : undefined
            : moving
              ? anim.interpolate({ inputRange: [0, 1], outputRange: [0, height] })
              : collapsed
                ? 0
                : height,
        overflow: 'hidden',
      }}
    >
      <View
        style={measureAbsolute ? { position: 'absolute', left: 0, right: 0, top: 0 } : undefined}
        onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
      >
        {children}
      </View>
    </Animated.View>
  );
}
