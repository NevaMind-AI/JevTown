import { useMemo } from 'react';
import { Container, Graphics, Text } from '@pixi/react';
import { TextMetrics, TextStyle } from 'pixi.js';

const style = new TextStyle({
  fontSize: 12,
  fill: 0x392d28,
  wordWrap: true,
  wordWrapWidth: 180,
  align: 'center',
  lineHeight: 17,
});
export default function SpeechBubble({ text, x, y }: { text: string; x: number; y: number }) {
  const metrics = useMemo(() => TextMetrics.measureText(text, style), [text]);
  const width = metrics.width + 20,
    height = metrics.height + 16;
  return (
    <Container x={x} y={y} zIndex={10000} eventMode="none">
      <Graphics
        draw={(g) => {
          g.clear()
            .lineStyle(1, 0x7c6950)
            .beginFill(0xfff6df, 0.97)
            .drawRoundedRect(-width / 2, -height - 7, width, height, 7)
            .endFill();
          g.lineStyle(0).beginFill(0xfff6df, 0.97).drawPolygon([-5, -8, 0, 0, 5, -8]).endFill();
        }}
      />
      <Text text={text} style={style} anchor={[0.5, 0]} y={-height + 1} />
    </Container>
  );
}
