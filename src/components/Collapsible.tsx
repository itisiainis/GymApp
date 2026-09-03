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

  useEffect(() => {
    Animated.timing(anim, {
      toValue: collapsed ? 0 : 1,
      duration,
      // высота — layout-свойство, нативный драйвер её не умеет
      useNativeDriver: false,
    }).start();
  }, [collapsed, duration, anim]);

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
            : anim.interpolate({ inputRange: [0, 1], outputRange: [0, height] }),
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
