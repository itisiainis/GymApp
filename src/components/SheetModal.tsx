import { useEffect, useRef } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Модалка-шторка: выезжает снизу, закрывается протаскиванием вниз.
 *
 * Тянуть можно за всю верхнюю шапку, а не за саму полоску: полоска —
 * это визуальная подсказка, а попасть пальцем в 5 пикселей невозможно.
 * Внутри почти всегда ScrollView, поэтому область захвата ограничена
 * шапкой — иначе жесты дрались бы с прокруткой.
 */
export function SheetModal({
  visible,
  onClose,
  title,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const dy = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) dy.setValue(0);
  }, [visible, dy]);

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => g.dy > 4,
      onPanResponderMove: (_, g) => {
        if (g.dy > 0) dy.setValue(g.dy);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 110 || g.vy > 1.1) {
          Animated.timing(dy, {
            toValue: 900,
            duration: 180,
            useNativeDriver: true,
          }).start(() => {
            dy.setValue(0);
            onClose();
          });
        } else {
          Animated.spring(dy, { toValue: 0, useNativeDriver: true }).start();
        }
      },
    })
  ).current;

  // transparent обязателен: без него окно модалки само по себе белое,
  // и при протаскивании вниз из-под шторки видно не экран, а белизну.
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* Затемнение: экраны под шторкой сами белые, и без него протаскивание
          вниз открывает белое на белом — не видно, что шторка уезжает. */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: '#00000073' }]} />

      <Animated.View
        style={{
          flex: 1,
          backgroundColor: '#fff',
          transform: [{ translateY: dy }],
        }}
      >
        {/* шапка целиком — зона захвата, высота с запасом под палец */}
        <View
          {...responder.panHandlers}
          style={{
            paddingTop: 10 + insets.top,
            paddingBottom: 10,
            paddingHorizontal: 16,
          }}
        >
          <View
            style={{
              alignSelf: 'center',
              width: 48,
              height: 5,
              borderRadius: 3,
              backgroundColor: '#00000030',
            }}
          />
          {!!title && (
            <Text style={{ fontSize: 22, fontWeight: '700', marginTop: 12 }}>
              {title}
            </Text>
          )}
        </View>

        {/* клавиатура поджимает содержимое, а не накрывает поля ввода */}
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          // на Android внутри Modal системный adjustResize не работает,
          // поэтому высоту поджимаем вручную
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          {children}
        </KeyboardAvoidingView>
      </Animated.View>
    </Modal>
  );
}
