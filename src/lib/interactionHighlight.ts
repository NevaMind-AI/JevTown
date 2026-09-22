import { Filter } from 'pixi.js';

const outline = new Filter(
  undefined,
  `
  varying vec2 vTextureCoord;
  uniform sampler2D uSampler;
  uniform vec4 inputPixel;
  uniform vec4 inputClamp;

  void main(void) {
    vec4 color = texture2D(uSampler, vTextureCoord);
    float alpha = 0.0;
    for (int i = 0; i < 8; i++) {
      float angle = float(i) * 0.78539816339;
      vec2 offset = vec2(cos(angle), sin(angle)) * 2.0 * inputPixel.zw;
      vec2 uv = clamp(vTextureCoord + offset, inputClamp.xy, inputClamp.zw);
      alpha = max(alpha, texture2D(uSampler, uv).a);
    }
    gl_FragColor = color + vec4(alpha * (1.0 - color.a));
  }
`,
);
outline.padding = 2;
export const interactionHighlight = [outline];
