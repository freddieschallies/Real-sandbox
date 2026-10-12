// A white box to sign on with a finger. capture() saves it as a picture for upload.
import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { PanResponder, Platform, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { captureRef } from 'react-native-view-shot';
import { Button } from './ui.tsx';

export interface SignaturePadHandle {
  /** True once there is enough ink to count as a signature. */
  signed(): boolean;
  /** Saves the signature as a PNG and returns where it is on the phone. */
  capture(): Promise<string>;
  clear(): void;
}

export const SignaturePad = forwardRef<SignaturePadHandle, { hint: string; height?: number }>(function SignaturePad({ hint, height = 200 }, ref) {
  const [paths, setPaths] = useState<string[]>([]);
  const box = useRef<View>(null);
  const live = useRef('');

  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,   // don't let the page scroll steal the pen
    onPanResponderGrant: e => {
      const { locationX: x, locationY: y } = e.nativeEvent;
      live.current = `M${x.toFixed(1)},${y.toFixed(1)}`;
      setPaths(p => [...p, live.current]);
    },
    onPanResponderMove: e => {
      const { locationX: x, locationY: y } = e.nativeEvent;
      live.current += ` L${x.toFixed(1)},${y.toFixed(1)}`;
      setPaths(p => [...p.slice(0, -1), live.current]);
    },
  })).current;

  useImperativeHandle(ref, () => ({
    signed: () => paths.join('').length >= 60,
    capture: () => captureRef(box, { format: 'png', quality: 1, result: Platform.OS === 'web' ? 'data-uri' : 'tmpfile' }),
    clear: () => setPaths([]),
  }), [paths]);

  return (
    <View style={{ gap: 6 }}>
      <View ref={box} collapsable={false} {...responder.panHandlers}
        style={{ height, backgroundColor: '#FFFFFF', borderRadius: 10, overflow: 'hidden' }}>
        <Svg width="100%" height="100%">
          {paths.map((d, i) => <Path key={i} d={d} stroke="#111" strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />)}
        </Svg>
        {paths.length === 0 ? <Text pointerEvents="none" style={{ position: 'absolute', bottom: 12, left: 14, color: '#888' }}>{hint}</Text> : null}
      </View>
      <Button label="Clear" kind="quiet" onPress={() => setPaths([])} />
    </View>
  );
});
