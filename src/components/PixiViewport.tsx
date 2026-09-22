// Based on https://codepen.io/inlet/pen/yLVmPWv.
// Copyright (c) 2018 Patrick Brouwer, distributed under the MIT license.

import { PixiComponent } from '@pixi/react';
import { Viewport } from 'pixi-viewport';
import { Application } from 'pixi.js';
import { MutableRefObject, ReactNode } from 'react';
import { viewportScale } from './viewportScale';

export type ViewportProps = {
  app: Application;
  viewportRef?: MutableRefObject<Viewport | undefined>;

  screenWidth: number;
  screenHeight: number;
  worldWidth: number;
  worldHeight: number;
  children?: ReactNode;
};

// https://davidfig.github.io/pixi-viewport/jsdoc/Viewport.html
export default PixiComponent('Viewport', {
  create(props: ViewportProps) {
    const { app, children, viewportRef, ...viewportProps } = props;
    // Stage may destroy its EventSystem before React disposes the viewport.
    // Keep this viewport's DOM target so its wheel listener can still be removed.
    const events = Object.create(app.renderer.events) as typeof app.renderer.events;
    events.domElement = app.renderer.events.domElement;
    const viewport = new Viewport({
      events,
      passiveWheel: false,
      ...viewportProps,
    });
    if (viewportRef) {
      viewportRef.current = viewport;
    }
    // Activate plugins
    viewport
      .drag()
      .pinch({})
      .wheel()
      .decelerate()
      .clamp({ direction: 'all', underflow: 'center' })
      .clampZoom(
        viewportScale(props.screenWidth, props.screenHeight, props.worldWidth, props.worldHeight),
      )
      .setZoom(
        Math.max(
          1,
          viewportScale(props.screenWidth, props.screenHeight, props.worldWidth, props.worldHeight)
            .minScale,
        ),
      );
    return viewport;
  },
  applyProps(viewport, oldProps: any, newProps: any) {
    if (
      ['screenWidth', 'screenHeight', 'worldWidth', 'worldHeight'].some(
        (key) => oldProps[key] !== newProps[key],
      )
    ) {
      viewport.resize(
        newProps.screenWidth,
        newProps.screenHeight,
        newProps.worldWidth,
        newProps.worldHeight,
      );
      viewport.clampZoom(
        viewportScale(
          newProps.screenWidth,
          newProps.screenHeight,
          newProps.worldWidth,
          newProps.worldHeight,
        ),
      );
      viewport.plugins.get('clamp')?.update();
    }
    Object.keys(newProps).forEach((p) => {
      if (p !== 'app' && p !== 'viewportRef' && p !== 'children' && oldProps[p] !== newProps[p]) {
        // @ts-expect-error Ignoring TypeScript here
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        viewport[p] = newProps[p];
      }
    });
  },
});
