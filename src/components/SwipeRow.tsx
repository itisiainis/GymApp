import { useRef } from 'react';
import { Animated, PanResponder, Text, View } from 'react-native';

/**
 * Свайп влево — удаление. Сделано на PanResponder из самого React Native,
 * а не на gesture-handler: у того API заметно менялся между версиями,
 * а здесь нужен один жест и никаких зависимостей.
 *
 * disabled нужен во время подхода: экран заблокирован, свайпы тоже.
 */
export function SwipeRow({
  children,
  onDelete,
  disabled = false,
  threshold = 80,
}: {
  children: React.ReactNode;
  onDelete: () => void;
  disabled?: boolean;
  threshold?: number;
}) {
  const dx = useRef(new Animated.Value(0)).current;

  // PanResponder создаётся один раз, поэтому disabled из замыкания устарел бы
  // на первом же рендере: строка осталась бы свайпаемой во время подхода.
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        !disabledRef.current && g.dx < -8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderMove: (_, g) => {
        if (g.dx < 0) dx.setValue(g.dx);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx < -threshold) {
          // уводим строку за край, потом удаляем — иначе она мигает на месте
          Animated.timing(dx, {
            toValue: -500,
            duration: 150,
            useNativeDriver: true,
          }).start(onDelete);
        } else {
          Animated.spring(dx, { toValue: 0, useNativeDriver: true }).start();
        }
      },
    })
  ).current;

  return (
    <View>
      {/* красная подложка проступает по мере сдвига */}
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          justifyContent: 'center',
          paddingRight: 18,
          opacity: dx.interpolate({
            inputRange: [-threshold, -12, 0],
            outputRange: [1, 0, 0],
            extrapolate: 'clamp',
          }),
        }}
      >
        <Text style={{ color: '#b23c3c', fontWeight: '700' }}>✕</Text>
      </Animated.View>

      <Animated.View
        {...(disabled ? {} : responder.panHandlers)}
        style={{ transform: [{ translateX: dx }] }}
      >
        {children}
      </Animated.View>
    </View>
  );
}
